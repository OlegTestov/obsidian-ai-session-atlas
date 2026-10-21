"""A live update must touch its session, not scan the entire FTS catalog under a write lock."""
from __future__ import annotations

import json
import os
import sqlite3

import pytest

from atlas import db, index, search, store
from atlas.parse import SessionFacts
from tests.conftest import assistant_tool, user_text


def _catalog():
    conn = db.connect()
    facts = SessionFacts(session_id="unused", source_path="unused")
    for i in range(1200):
        sid = f"unrelated-{i}"
        store._insert_row(conn, sid, 1, user_text="background catalogue text " * 15)
        store._write_meta_row(conn, sid, "title", facts, [("p", f"/code/{i}/file.py")])
    conn.commit()
    return conn


@pytest.mark.parametrize("operation", ["purge", "tail", "meta"])
def test_session_update_has_a_bounded_sql_workload(operation):
    conn = _catalog()
    facts = SessionFacts(session_id="target", source_path="unused")
    facts.turns = [{"user_text": ["target text"], "paths": ["/code/target.py"],
                    "assistant_text": [], "commands": [], "tickets": [], "summaries": []}]
    store._write_turns(conn, "target", facts)
    conn.commit()
    steps = 0

    def progress():
        nonlocal steps
        steps += 100
        return steps > 10000

    conn.set_progress_handler(progress, 100)
    try:
        if operation == "purge":
            store.purge(conn, "target")
        elif operation == "tail":
            store._write_turns(conn, "target", facts)
        else:
            store._write_meta_row(conn, "target", "new title", facts, [])
        conn.commit()
    finally:
        conn.set_progress_handler(None, 0)
        conn.close()
    assert steps <= 10000


def test_existing_catalog_gains_row_lookup_without_reindex(write_session, atlas_env):
    path = write_session("p", [user_text("original unique prompt"),
                               assistant_tool("Bash", {"command": "cat /code/unique.py"})])
    sid = os.path.basename(path)[:-6]
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    before = [tuple(r) for r in conn.execute("SELECT * FROM fts")]
    conn.execute("INSERT INTO user_overrides(session_id,title,updated_at) VALUES (?,?,?)", (sid,"mine","now"))
    conn.execute("INSERT INTO classification(session_id,topic,content_hash,classifier_version,created_at) "
                 "VALUES (?,?,?,?,?)", (sid,"paid topic","h",4,"now"))
    conn.execute("DROP TABLE IF EXISTS fts_rows")
    conn.execute("UPDATE meta SET value='12' WHERE key='schema_version'")
    conn.commit()
    conn.close()
    conn = db.connect()
    assert [tuple(r) for r in conn.execute("SELECT * FROM fts")] == before
    assert db.get_meta(conn,"needs_reindex") == "0"
    assert conn.execute("SELECT title FROM user_overrides").fetchone()[0] == "mine"
    assert conn.execute("SELECT topic FROM classification").fetchone()[0] == "paid topic"
    for table in ("fts", "fts_paths"):
        actual = sorted(tuple(r) for r in conn.execute(f"SELECT rowid,session_id,turn FROM {table}"))
        mapped = sorted(tuple(r) for r in conn.execute(
            "SELECT row_id,session_id,turn FROM fts_rows WHERE index_name=?", (table,)))
        assert actual == mapped
    with open(path,"a") as f:
        f.write(user_text("new unique tail",ts="2026-09-02T10:00:00.000Z"))
    assert index.index_all(conn,root=str(atlas_env["projects"]))["tail"] == 1
    assert search.search(conn,"unique")
    conn.close()


def test_migration_failure_is_atomic(write_session, atlas_env, monkeypatch):
    write_session("p", [user_text("preserved original")])
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("DROP TABLE fts_rows")
    conn.execute("UPDATE meta SET value='12' WHERE key='schema_version'")
    conn.commit()
    conn.close()
    with monkeypatch.context() as m:
        m.setattr(db, "SCHEMA", db.SCHEMA + "\nTHIS IS NOT SQL;")
        with pytest.raises(sqlite3.OperationalError):
            db.connect()
    raw = sqlite3.connect(db.db_path())
    assert raw.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0] == "12"
    assert raw.execute("SELECT 1 FROM sqlite_master WHERE name='fts_rows'").fetchone() is None
    assert raw.execute("SELECT count(*) FROM sessions").fetchone()[0] == 1
    raw.close()
    db.connect().close()


def test_classification_finishes_while_the_index_and_manual_edits_change(
        atlas_env, write_session, monkeypatch):
    from atlas import actions, classify, runner, server

    path = write_session("p", [user_text("classify target")])
    sid = os.path.basename(path)[:-6]
    conn = _catalog()
    index.index_all(conn, root=str(atlas_env["projects"]))
    job, _ = actions.claim_job(conn, "batch", "classification", "test")
    conn.close()
    calls = []

    def model(_prompt, **_kwargs):
        calls.append(True)
        # Another connection must be able to index and save a manual edit during the model call.
        other = db.connect()
        other.execute("PRAGMA busy_timeout=100")
        try:
            with open(path, "a") as f:
                f.write(user_text("new work", ts="2026-09-02T10:00:00.000Z"))
            steps = []
            other.set_progress_handler(lambda: steps.append(1) or len(steps) > 180, 100)
            result = index.index_all(other, root=str(atlas_env["projects"]))
            other.set_progress_handler(None, 0)
            assert result["indexed"] == 1 and result["errors"] == 0
            other.execute("INSERT INTO user_overrides(session_id,topic,updated_at) VALUES (?,?,?)",
                          (sid, "manual topic", "now"))
            other.commit()
        finally:
            other.close()
        return '[{"n":1,"domain":"work","topic":"model topic","confidence":0.9}]'

    monkeypatch.setattr(runner, "run_isolated", model)
    server._run_classify(job, [sid])
    conn = db.connect()
    result = actions.get_job(conn, job)
    assert result["state"] == "done", result
    assert json.loads(result["result"])["classified"] == 1
    assert search.load_session(conn, sid)["topic"] == "manual topic"
    assert calls == [True]
    assert sid in classify.pending(conn)  # the newly appended content still needs its own verdict
    conn.close()
