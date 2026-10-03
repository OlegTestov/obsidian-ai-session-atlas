"""Full session deletion: Claude Code files, input history, catalog data — and nothing else."""
from __future__ import annotations

import json
import os

import pytest

from atlas import active, db, delete, index
from tests.conftest import assistant_text, user_text

SID = "11111111-2222-3333-4444-555555555555"
OTHER = "99999999-2222-3333-4444-555555555555"


def _conn(atlas_env):
    return db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))


@pytest.fixture
def claude(atlas_env, write_session, monkeypatch, tmp_path):
    """Two transcripts and session traces in every Claude Code location; no session processes."""
    monkeypatch.setattr(active, "SESSIONS_DIR", str(tmp_path / "sessions"))
    (tmp_path / "sessions").mkdir()
    for sid in (SID, OTHER):
        write_session("-Users-u-Code-demo", [user_text(f"работа {sid[:4]}"), assistant_text("ок")],
                      session_id=sid)
    home = tmp_path                                  # claude_home = folder above projects
    sub = atlas_env["projects"] / "-Users-u-Code-demo" / SID / "subagents"
    sub.mkdir(parents=True)
    (sub / "agent-a.jsonl").write_text("{}\n")
    for part in ("file-history", "session-env", "tasks"):
        (home / part / SID).mkdir(parents=True)
        (home / part / SID / "x").write_text("x")
        (home / part / OTHER).mkdir(parents=True)
    (home / "todos").mkdir()
    (home / "todos" / f"{SID}-agent-{SID}.json").write_text("[]")
    (home / "todos" / f"{OTHER}-agent-{OTHER}.json").write_text("[]")
    history = [{"display": "мой запрос", "sessionId": SID}, {"display": "чужой", "sessionId": OTHER},
               {"display": f"упоминает {SID} в тексте", "sessionId": OTHER}]
    (home / "history.jsonl").write_text("".join(json.dumps(h, ensure_ascii=False) + "\n" for h in history)
                                        + "не json\n")
    handoffs = atlas_env["home"] / "handoffs"
    handoffs.mkdir(parents=True)
    (handoffs / f"2026-10-01-{SID[:8]}.md").write_text("# хендофф")
    (handoffs / f"launch-{OTHER[:8]}.md").write_text("# чужой")
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("INSERT INTO user_overrides (session_id, title, updated_at) VALUES (?, 'моё', 'now')", (SID,))
    conn.commit()
    return {"home": home, "conn": conn, "projects": atlas_env["projects"]}


def test_preview_lists_everything_and_changes_nothing(claude):
    plan = delete.footprint(claude["conn"], SID)
    kinds = sorted(i["kind"] for i in plan["items"])
    assert kinds == ["file_history", "handoff", "session_env", "subagents", "tasks", "todos", "transcript"]
    assert plan["history_lines"] == 1 and plan["indexed"] and not plan["running"]
    assert all(os.path.exists(i["path"]) for i in plan["items"])


def test_delete_removes_this_session_and_only_it(claude):
    conn, home = claude["conn"], claude["home"]
    result = delete.delete_session(conn, SID)
    assert result["removed"] == 7 and result["history_lines"] == 1
    assert not list(claude["projects"].glob(f"*/{SID}*"))
    for part in ("file-history", "session-env", "tasks"):
        assert not (home / part / SID).exists() and (home / part / OTHER).exists()
    assert not (home / "todos" / f"{SID}-agent-{SID}.json").exists()
    assert (home / "todos" / f"{OTHER}-agent-{OTHER}.json").exists()
    lines = (home / "history.jsonl").read_text().splitlines()
    assert len(lines) == 3 and "мой запрос" not in "".join(lines) and lines[-1] == "не json"
    assert (home / "history.jsonl").read_text().count(SID) == 1      # the mention in another session's record stays
    for table in ("sessions", "sources", "fts", "user_overrides", "activity"):
        assert conn.execute(f"SELECT COUNT(*) FROM {table} WHERE session_id=?", (SID,)).fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM sessions WHERE session_id=?", (OTHER,)).fetchone()[0] == 1
    assert (claude["home"] / "atlas-home" / "handoffs" / f"launch-{OTHER[:8]}.md").exists()


def test_reindex_does_not_bring_it_back(claude):
    delete.delete_session(claude["conn"], SID)
    index.index_all(claude["conn"], root=str(claude["projects"]))
    assert claude["conn"].execute("SELECT COUNT(*) FROM sessions WHERE session_id=?", (SID,)).fetchone()[0] == 0


def test_running_session_is_refused_and_untouched(claude, monkeypatch):
    monkeypatch.setattr(delete, "is_running", lambda sid, *a, **k: sid == SID)
    with pytest.raises(delete.DeleteError):
        delete.delete_session(claude["conn"], SID)
    assert list(claude["projects"].glob(f"*/{SID}.jsonl"))


def test_live_process_is_detected_from_session_files(claude, tmp_path):
    (tmp_path / "sessions" / "4242.json").write_text(json.dumps({"pid": 4242, "sessionId": SID}))
    assert delete.is_running(SID, table={4242: (1, "start")})
    assert not delete.is_running(SID, table={})                 # process is dead — deletion allowed


def test_bad_id_never_reaches_the_disk(claude):
    with pytest.raises(delete.DeleteError):
        delete.footprint(claude["conn"], "../../*")


def test_shared_handoff_prefix_is_not_deleted(claude, write_session, atlas_env):
    twin = SID[:8] + "-0000-0000-0000-000000000000"
    write_session("-Users-u-Code-demo", [user_text("двойник"), assistant_text("ок")], session_id=twin)
    index.index_all(claude["conn"], root=str(atlas_env["projects"]))
    assert not [i for i in delete.footprint(claude["conn"], SID)["items"] if i["kind"] == "handoff"]


def test_route_needs_token_and_confirmation(claude, monkeypatch):
    import threading
    import urllib.error
    from http.server import ThreadingHTTPServer

    from atlas import server
    from tests.test_actions_security import _post
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    monkeypatch.setattr(server, "ALLOWED_HOSTS", {f"127.0.0.1:{port}"})
    monkeypatch.setattr(server, "ALLOWED_ORIGINS", {f"http://127.0.0.1:{port}"})
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base, token = f"http://127.0.0.1:{port}", server.csrf_token()
    try:
        with pytest.raises(urllib.error.HTTPError) as no_token:
            _post(f"{base}/api/delete", {"session_id": SID, "confirmed": True}, {"Origin": base})
        assert no_token.value.code == 403
        with pytest.raises(urllib.error.HTTPError) as unconfirmed:
            _post(f"{base}/api/delete", {"session_id": SID}, {"Origin": base, "X-Atlas-Token": token})
        assert unconfirmed.value.code == 400
        assert list(claude["projects"].glob(f"*/{SID}.jsonl"))
        preview = json.loads(_post(f"{base}/api/delete/preview", {"session_id": SID},
                                   {"Origin": base, "X-Atlas-Token": token}).read())
        assert preview["history_lines"] == 1
        done = json.loads(_post(f"{base}/api/delete", {"session_id": SID, "confirmed": True},
                                {"Origin": base, "X-Atlas-Token": token}).read())
        assert done["removed"] == 7 and not list(claude["projects"].glob(f"*/{SID}.jsonl"))
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_symlink_out_of_claude_folder_is_refused(claude, tmp_path_factory):
    """The project folder is a symlink outward: no file is deleted through it, the whole deletion is cancelled."""
    outside = tmp_path_factory.mktemp("outside")
    victim = outside / f"{SID}.jsonl"
    victim.write_text("{}\n")
    os.symlink(outside, claude["projects"] / "-linked")
    with pytest.raises(delete.DeleteError):
        delete.delete_session(claude["conn"], SID)
    assert victim.exists() and list(claude["projects"].glob(f"-Users-u-Code-demo/{SID}.jsonl"))
