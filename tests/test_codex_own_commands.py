"""Rename and delete of a Codex thread go through Codex's own commands (a stand-in `codex`):
Codex updates its own state, Atlas never writes Codex's databases or rollouts."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from atlas import actions, active, codex_app, db, delete, index, messages, search
from tests.conftest import cx_agent, cx_meta, cx_user, write_codex_state

TID = "019e0000-7777-7000-8000-000000000007"
SUB = "019e0000-7777-7000-8000-000000000008"
OTHER, OTHER_SUB = "019e0000-7777-7000-8000-000000000009", "019e0000-7777-7000-8000-00000000000a"


@pytest.fixture
def thread(atlas_env, write_rollout, codex_home, monkeypatch):
    lines = [cx_meta(TID, cwd=str(atlas_env["home"])), cx_user("переименуй меня"), cx_agent("ок")]
    live = write_rollout(lines, thread_id=TID)
    archived = write_rollout(lines, thread_id=TID, archived=True)
    state = write_codex_state(codex_home, {TID: ("t", None)})
    monkeypatch.setattr(active, "process_table", lambda: {})
    conn = db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))
    index.index_all(conn, root=str(atlas_env["projects"]))
    return {"conn": conn, "live": live, "archived": archived, "state": state, "home": codex_home}


def test_rename_asks_codex_to_set_the_thread_name(thread, codex_cli):
    rollout, state = Path(thread["live"]).read_bytes(), Path(thread["state"]).read_bytes()
    result = actions.rename_session(thread["conn"], TID, "  Новое   имя ")
    assert result == {"title": "Новое имя", "written_to_transcript": True, "error": None}
    run, = codex_cli["runs"]()
    assert run["argv"] == ["app-server"] and run["home"] == thread["home"]
    assert [c["method"] for c in run["calls"]] == ["initialize", "initialized", "thread/name/set"]
    assert run["calls"][-1]["params"] == {"threadId": TID, "name": "Новое имя"}
    # Atlas wrote neither the rollout nor Codex's database: Codex does that itself.
    assert Path(thread["live"]).read_bytes() == rollout and Path(thread["state"]).read_bytes() == state
    assert search.load_session(thread["conn"], TID)["title"] == "Новое имя"


def test_rename_only_in_the_catalog_skips_codex(thread, codex_cli):
    result = actions.rename_session(thread["conn"], TID, "Только каталог", write_to_transcript=False)
    assert result["written_to_transcript"] is False and result["error"] is None
    assert codex_cli["runs"]() == []


@pytest.mark.parametrize("mode,key", [("old", "rename.codex_old"), ("no_thread", "rename.codex_failed")])
def test_rename_falls_back_to_the_catalog_with_a_reason(thread, codex_cli, mode, key):
    codex_cli["mode"](mode)
    with messages.use_lang("ru"):
        result = actions.rename_session(thread["conn"], TID, "Имя")
    assert result["written_to_transcript"] is False
    head = messages.MESSAGES[key]["ru"].split("{")[0]
    assert result["error"].startswith(head)
    if mode == "no_thread":
        assert "no rollout found" in result["error"]
    assert search.load_session(thread["conn"], TID)["title"] == "Имя"


def test_rename_without_codex_installed_says_so(thread):
    result = actions.rename_session(thread["conn"], TID, "Имя")
    assert result["written_to_transcript"] is False and "codex not found" in result["error"]


def test_a_hung_app_server_is_cut_off(thread, codex_cli):
    codex_cli["mode"]("hang")
    with pytest.raises(codex_app.CodexError, match="in time"):
        codex_app.set_thread_name(thread["home"], TID, "x", timeout=1.5)


def test_delete_lets_codex_delete_the_thread_first(thread, codex_cli):
    plan = delete.footprint(thread["conn"], TID)
    assert plan["notes"] == [messages.MESSAGES["delete.codex_by_codex"]["en"]]
    state = Path(thread["state"]).read_bytes()
    out = delete.delete_session(thread["conn"], TID)
    assert out["codex_deleted"] is True and out["codex_error"] is None
    run, = codex_cli["runs"]()
    assert run["argv"] == ["delete", "--force", TID] and run["home"] == thread["home"]
    assert not os.path.exists(thread["live"]) and not os.path.exists(thread["archived"])
    assert Path(thread["state"]).read_bytes() == state          # the stand-in Codex left its DB alone
    assert thread["conn"].execute("SELECT count(*) FROM sessions WHERE session_id=?", (TID,)).fetchone()[0] == 0


@pytest.mark.parametrize("mode", ["delete_fails", "old"])
def test_delete_still_removes_the_files_when_codex_cannot(thread, codex_cli, mode):
    codex_cli["mode"](mode)
    out = delete.delete_session(thread["conn"], TID)
    assert out["codex_deleted"] is False
    assert out["codex_error"].startswith(messages.MESSAGES["delete.codex_failed"]["en"].split("{")[0])
    assert not os.path.exists(thread["live"]) and not os.path.exists(thread["archived"])


def test_delete_without_codex_keeps_the_old_note(thread):
    assert delete.footprint(thread["conn"], TID)["notes"] == [messages.MESSAGES["delete.codex_app_note"]["en"]]
    out = delete.delete_session(thread["conn"], TID)
    assert out["codex_deleted"] is False and out["codex_error"] is None and not os.path.exists(thread["live"])


def test_a_running_thread_never_reaches_codex_delete(thread, codex_cli, monkeypatch):
    monkeypatch.setattr(delete, "_codex_running", lambda sid, table=None: True)
    with pytest.raises(delete.DeleteError):
        delete.delete_session(thread["conn"], TID)
    assert codex_cli["runs"]() == [] and os.path.exists(thread["live"])


@pytest.mark.parametrize("mode", ["ok", "delete_fails"])
def test_delete_takes_the_subagent_threads_with_it(thread, codex_cli, atlas_env, write_rollout, mode):
    # A subagent thread is part of its root's session; left behind it would come back as a session of
    # its own. Real codex 0.167 deletes it with the root; this stand-in removes only the root's files.
    def subagent(tid, parent):
        meta = json.loads(cx_meta(tid, cwd=str(atlas_env["home"])))
        meta["payload"].update(parent_thread_id=parent, thread_source="subagent",
                               source={"subagent": {"thread_spawn": {"parent_thread_id": parent, "depth": 1}}})
        return write_rollout([json.dumps(meta) + "\n", cx_user("помоги"), cx_agent("subfinding")], thread_id=tid)
    sub = subagent(SUB, TID)
    write_rollout([cx_meta(OTHER, cwd=str(atlas_env["home"])), cx_user("другая"), cx_agent("ок")], thread_id=OTHER)
    other_sub = subagent(OTHER_SUB, OTHER)
    index.index_all(thread["conn"], root=str(atlas_env["projects"]))
    plan = delete.footprint(thread["conn"], TID)
    assert [i["path"] for i in plan["items"] if i["kind"] == "rollout_subagent"] == [sub]
    if mode != "ok":
        codex_cli["mode"](mode)
    delete.delete_session(thread["conn"], TID)
    assert not os.path.exists(sub)
    index.index_all(thread["conn"], root=str(atlas_env["projects"]))
    assert os.path.exists(other_sub)                          # another thread's subagent stays
    assert [r[0] for r in thread["conn"].execute("SELECT session_id FROM sessions")] == [OTHER]
    assert [r["session_id"] for r in search.search(thread["conn"], "subfinding", scope="all")] == [OTHER]
