"""Deleting a Codex thread and moving a live one into an Obsidian tab."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

import pytest

from atlas import active, codex_procs, db, delete, index, messages, relocate
from tests.conftest import cx_agent, cx_meta, cx_user, write_codex_state

TID = "019e0000-dddd-7000-8000-000000000004"
OTHER = "019e0000-eeee-7000-8000-000000000005"
CODEX = "/opt/homebrew/bin/codex"
ITERM = "/Applications/iTerm.app/Contents/MacOS/iTerm2"
OBSIDIAN = "/Applications/Obsidian.app/Contents/MacOS/Obsidian"


def _conn(atlas_env):
    return db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))


def lsof(open_files):
    def run(cmd, **kw):
        pids = [int(p) for p in cmd[cmd.index("-p") + 1].split(",")]
        out = "".join(f"p{pid}\n" + "".join(f"n{p}\n" for p in open_files.get(pid, [])) for pid in pids)
        return subprocess.CompletedProcess(cmd, 0, out, "")
    return run


@pytest.fixture(autouse=True)
def _fresh():
    codex_procs._map_cache.clear()
    codex_procs._find_cache.clear()
    yield


@pytest.fixture
def codex(atlas_env, write_rollout, codex_home, monkeypatch):
    """A thread with a live and an archived rollout, input history and a Codex state database."""
    lines = [cx_meta(TID, cwd=str(atlas_env["home"])), cx_user("удали меня"), cx_agent("ок")]
    live = write_rollout(lines, thread_id=TID)
    archived = write_rollout(lines, thread_id=TID, archived=True)
    other = write_rollout([cx_meta(OTHER), cx_user("останься")], thread_id=OTHER)
    history = [{"session_id": TID, "ts": 1, "text": "удали меня"},
               {"session_id": OTHER, "ts": 2, "text": f"упоминает {TID}"},
               {"session_id": TID, "ts": 3, "text": "ещё"}]
    hist = os.path.join(codex_home, "history.jsonl")
    with open(hist, "w", encoding="utf-8") as fh:
        fh.write("".join(json.dumps(h, ensure_ascii=False) + "\n" for h in history) + "не json\n")
    os.chmod(hist, 0o600)
    state = write_codex_state(codex_home, {TID: ("t", None)})
    monkeypatch.setattr(active, "process_table", lambda: {})
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("INSERT INTO user_overrides (session_id, title, updated_at) VALUES (?, 'моё', 'now')", (TID,))
    conn.commit()
    return {"conn": conn, "live": live, "archived": archived, "other": other, "history": hist,
            "state": state, "home": codex_home}


def test_preview_lists_rollouts_history_and_the_codex_note(codex):
    plan = delete.footprint(codex["conn"], TID)
    assert plan["agent"] == "codex" and not plan["running"] and plan["indexed"]
    assert sorted(i["path"] for i in plan["items"]) == sorted([codex["live"], codex["archived"]])
    assert {i["kind"] for i in plan["items"]} == {"rollout"} and plan["history_lines"] == 2
    assert plan["notes"] == [messages.MESSAGES["delete.codex_app_note"]["en"]]
    with messages.use_lang("ru"):
        assert "Codex" in delete.footprint(codex["conn"], TID)["notes"][0]
        assert delete.footprint(codex["conn"], TID)["notes"][0] == messages.MESSAGES["delete.codex_app_note"]["ru"]
    assert os.path.exists(codex["live"]) and os.path.exists(codex["archived"])


def test_delete_removes_files_history_lines_and_catalog_but_not_codex_state(codex):
    state_before = Path(codex["state"]).read_bytes()
    out = delete.delete_session(codex["conn"], TID)
    assert out["removed"] == 2 and out["history_lines"] == 2
    assert not os.path.exists(codex["live"]) and not os.path.exists(codex["archived"])
    assert os.path.exists(codex["other"])
    lines = Path(codex["history"]).read_text(encoding="utf-8").splitlines()
    assert lines == [json.dumps({"session_id": OTHER, "ts": 2, "text": f"упоминает {TID}"}, ensure_ascii=False),
                     "не json"]
    assert os.stat(codex["history"]).st_mode & 0o777 == 0o600
    assert Path(codex["state"]).read_bytes() == state_before
    conn = codex["conn"]
    for table in ("sessions", "user_overrides", "sources"):
        assert conn.execute(f"SELECT count(*) FROM {table} WHERE session_id=?", (TID,)).fetchone()[0] == 0
    index.index_all(conn, root=str(codex["home"]))       # nothing brings it back
    assert conn.execute("SELECT count(*) FROM sessions WHERE session_id=?", (TID,)).fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM sessions WHERE session_id=?", (OTHER,)).fetchone()[0] == 1


def test_running_thread_is_refused(codex, monkeypatch):
    monkeypatch.setattr(active, "process_table", lambda: {77: (1, "x", CODEX)})
    monkeypatch.setattr(codex_procs, "_run", lsof({77: [codex["live"]]}))
    assert delete.footprint(codex["conn"], TID)["running"]
    with pytest.raises(delete.DeleteError, match="running"):
        delete.delete_session(codex["conn"], TID)
    assert os.path.exists(codex["live"])


def test_rollout_reached_through_a_link_outside_the_codex_home_is_refused(atlas_env, codex_home, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / f"rollout-2026-09-02T10-00-00-{TID}.jsonl").write_text(cx_meta(TID) + cx_user("x"))
    day = os.path.join(codex_home, "sessions", "2026", "09")
    os.makedirs(day)
    os.symlink(outside, os.path.join(day, "02"))
    conn = _conn(atlas_env)
    with pytest.raises(delete.DeleteError, match="outside the Codex folder"):
        delete.delete_session(conn, TID)
    assert (outside / f"rollout-2026-09-02T10-00-00-{TID}.jsonl").exists()


def test_not_indexed_thread_is_still_found_as_codex(atlas_env, write_rollout):
    path = write_rollout([cx_meta(TID), cx_user("свежий")], thread_id=TID)
    plan = delete.footprint(_conn(atlas_env), TID)
    assert plan["agent"] == "codex" and [i["path"] for i in plan["items"]] == [path] and not plan["indexed"]


def test_delete_route_needs_confirmation_and_speaks_russian(codex, live_server):
    base, token = live_server
    headers = {"Origin": base, "X-Atlas-Token": token, "X-Atlas-Lang": "ru", "Content-Type": "application/json"}

    def post(path, body):
        req = urllib.request.Request(f"{base}{path}", data=json.dumps(body).encode(), headers=headers)
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    preview = post("/api/delete/preview", {"session_id": TID})
    assert preview["notes"] == [messages.MESSAGES["delete.codex_app_note"]["ru"]]
    with pytest.raises(urllib.error.HTTPError):
        post("/api/delete", {"session_id": TID})
    assert os.path.exists(codex["live"])
    assert post("/api/delete", {"session_id": TID, "confirmed": True})["removed"] == 2
    assert not os.path.exists(codex["live"])


# --- moving a live thread into an Obsidian tab ---

@pytest.fixture
def child():
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    yield proc
    if proc.poll() is None:
        proc.kill()
    proc.wait()


def codex_table(child_pid, app):
    """The real table, with the child dressed as an interactive `codex` under an app."""
    def table_fn():
        table = dict(active.process_table())
        if child_pid in table:                    # an exited child shows as <defunct> until reaped
            _, start, command = table[child_pid]
            table[child_pid] = (900001, start, command if "defunct" in command else CODEX)
        table[900001] = (1, "x", app)
        return table
    return table_fn


def test_relocate_stops_the_codex_process_that_holds_the_thread(atlas_env, write_rollout, child, tmp_path):
    path = write_rollout([cx_meta(TID, cwd=str(tmp_path)), cx_user("перенеси")], thread_id=TID)
    out = relocate.stop_for_move(TID, child.pid, sessions_dir=str(tmp_path), table_fn=codex_table(child.pid, ITERM),
                                 run=lsof({child.pid: [path]}))
    assert out["stopped"] and out["agent"] == "codex" and out["host_app"] == "iTerm"
    assert out["cwd"] == str(tmp_path)
    assert child.wait(timeout=5) != 0


@pytest.mark.parametrize("case", ["other-thread", "obsidian", "not-codex", "gone"])
def test_relocate_guards_for_codex(atlas_env, write_rollout, child, tmp_path, case):
    path = write_rollout([cx_meta(TID), cx_user("x")], thread_id=TID)
    other = write_rollout([cx_meta(OTHER), cx_user("y")], thread_id=OTHER)
    table_fn = codex_table(child.pid, OBSIDIAN if case == "obsidian" else ITERM)
    run = lsof({child.pid: [other if case == "other-thread" else path]})
    pid = child.pid
    if case == "not-codex":
        def table_fn():
            table = dict(active.process_table())
            table[child.pid] = (1, table[child.pid][1], "/usr/bin/python3 sleep.py")
            return table
    if case == "gone":
        pid = 2 ** 22 + 7                         # no such process
    with pytest.raises(relocate.RelocateError):
        relocate.stop_for_move(TID, pid, sessions_dir=str(tmp_path), table_fn=table_fn, run=run, wait=0.5)
    assert child.poll() is None, "a process that is not this thread outside Obsidian keeps running"


def test_relocate_route_answers_codex_resume(atlas_env, live_server, monkeypatch, tmp_path):
    from atlas import server
    monkeypatch.setattr(server.relocate, "stop_for_move",
                        lambda sid, pid: {"stopped": True, "host_app": "iTerm", "waited": 0.25,
                                          "agent": "codex", "cwd": str(tmp_path)})
    base, token = live_server
    req = urllib.request.Request(f"{base}/api/relocate", data=json.dumps({"session_id": TID, "pid": 5}).encode(),
                                 headers={"Origin": base, "X-Atlas-Token": token,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        out = json.loads(r.read())
    assert out["command"] == f"cd {tmp_path} && codex resume {TID}" and out["cwd"] == str(tmp_path)
