"""Historical writers must not make new code delete another session's search rows."""
from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import sys
import zipfile
from contextlib import closing
from pathlib import Path

import pytest

from atlas import db, index, opencode_actions, search, search_rows, stats, store
from tests.conftest import assistant_text, user_text
from tests.test_opencode_actions import FORK, TOKEN, native  # noqa: F401


@pytest.fixture(params=["2.4.1", "2.4.2"])
def legacy(request, tmp_path, atlas_env):
    package = tmp_path / "legacy"
    shutil.copytree(Path(db.__file__).parent, package / "atlas", ignore=shutil.ignore_patterns("__pycache__"))
    fixture = Path(__file__).parent / "fixtures" / "legacy-writers" / (request.param + ".zip")
    with zipfile.ZipFile(fixture) as archive:
        archive.extractall(package)

    def run(*, rebuild=False, version=None):
        script = ("from atlas import db,index; c=db.connect(); "
                  + ("db.drop_derived(c); " if rebuild else "")
                  + "print(index.index_all(c)); print(db.get_meta(c, 'schema_version')); c.close()")
        env = dict(os.environ, PYTHONPATH=str(package), PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run([sys.executable, "-c", script], cwd=package, env=env,
                                capture_output=True, text=True, timeout=30, check=True)
        assert "'errors': 0" in result.stdout, result.stdout + result.stderr
        if version is not None:
            assert result.stdout.splitlines()[-1] == str(version)

    return run


@pytest.mark.parametrize("legacy", ["v14"], indirect=True)
@pytest.mark.parametrize("rebuild", [False, True])
@pytest.mark.parametrize("old_first", [True, False])
def test_v14_writer_recovers_opencode(legacy, rebuild, old_first, tmp_path, monkeypatch):
    source = tmp_path / "opencode"
    source.mkdir()
    shutil.copyfile(Path(__file__).parent / "fixtures/opencode/opencode.db", source / "opencode.db")
    monkeypatch.setenv("ATLAS_OPENCODE_HOME", str(source))
    if old_first:
        legacy(rebuild=rebuild, version=14)
    else:
        with closing(db.connect()) as conn:
            assert index.index_all(conn)["indexed"] == 8
        legacy(rebuild=rebuild, version=15)
    with closing(db.connect()) as conn:
        assert db.get_meta(conn, "schema_version") == "15"
        assert stats.summary(conn, "all")["totals"]["answers"] == 0
        assert index.index_all(conn)["indexed"] == 8
        assert stats.summary(conn, "all")["totals"]["answers"] == 15
        assert_lookup(conn)



@pytest.mark.parametrize("legacy", ["v14"], indirect=True)
@pytest.mark.parametrize("rebuild", [False, True])
@pytest.mark.parametrize("old_first", [True, False])
def test_v14_writer_and_fork_intents(legacy, request, rebuild, old_first):
    # Close the fixture's initial writer and start with a v14 or a current catalog.
    fixture = request.getfixturevalue("native")
    fixture.conn.close()
    os.unlink(db.db_path())
    if old_first:
        legacy(rebuild=rebuild, version=14)
    with closing(db.connect()) as conn:
        assert db.get_meta(conn, "schema_version") == "15"
        assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='ix_opencode_fork_pending'").fetchone()
        with conn:
            conn.execute("INSERT INTO opencode_fork_intents(request_id,source_id,baseline,state) "
                         "VALUES (?,?,?,'unknown')", (TOKEN, fixture.sid, "[]"))
        if not old_first:
            legacy(rebuild=rebuild, version=15)
        token = "fixture-request-002"
        assert opencode_actions.fork(conn, fixture.sid, token, confirm_unknown=TOKEN)["session_id"] == FORK
        assert opencode_actions.fork(conn, fixture.sid, token)["session_id"] == FORK
        intents = conn.execute("SELECT state,fork_id FROM opencode_fork_intents ORDER BY request_id")
        assert [tuple(row) for row in intents] == [("superseded", None), ("confirmed", FORK)]
        assert sum(method == "POST" for method, *_ in fixture.seen) == 1


def assert_lookup(conn):
    for table in ("fts", "fts_paths"):
        actual = sorted(tuple(r) for r in conn.execute(f"SELECT rowid,session_id,turn FROM {table}"))
        mapped = sorted(tuple(r) for r in conn.execute(
            "SELECT row_id,session_id,turn FROM fts_rows WHERE index_name=?", (table,)))
        assert mapped == actual
        assert conn.execute(f"SELECT COUNT(*) FROM {table} WHERE session_id NOT IN "
                            "(SELECT session_id FROM sessions)").fetchone()[0] == 0


@pytest.mark.parametrize("rebuild", [False, True])
def test_old_writer_then_new_writer_recovers_search(legacy, rebuild, write_session, atlas_env):
    a = write_session("p", [user_text("alphabefore"), assistant_text("first"),
                             user_text("alphatail")], session_id="aa")
    b = write_session("p", [user_text("betabefore"), assistant_text("first"),
                             user_text("betatail")], session_id="bb")
    write_session("p", [user_text("gammakept")], session_id="cc")
    conn = db.connect()
    index.ensure_indexed(conn)
    conn.execute("INSERT INTO user_overrides(session_id,title,updated_at) VALUES ('cc','mine','now')")
    conn.execute("INSERT INTO classification(session_id,topic,content_hash,classifier_version,created_at) "
                 "VALUES ('cc','paid','h',4,'now')")
    conn.commit()
    Path(b).write_text(user_text("betashort"))
    legacy()
    Path(a).write_text(user_text("alphanew"))
    legacy(rebuild=rebuild)
    # Keep the connection opened before the old writer: connect-time validation is insufficient.
    Path(b).write_text(user_text("betanew"))
    result = index.index_all(conn)
    assert result["errors"] == 0
    assert_lookup(conn)
    for query, sid in (("alphanew", "aa"), ("betanew", "bb"), ("gammakept", "cc")):
        assert {r["session_id"] for r in search.search(conn, query)} == {sid}
    assert not search.search(conn, "betabefore")
    Path(a).unlink()
    index.index_all(conn)
    assert_lookup(conn)
    assert not search.search(conn, "alphanew")
    assert conn.execute("SELECT title FROM user_overrides WHERE session_id='cc'").fetchone()[0] == "mine"
    assert conn.execute("SELECT topic FROM classification WHERE session_id='cc'").fetchone()[0] == "paid"
    assert index.index_all(conn)["indexed"] == 0  # recovery is not repeated on every pass
    assert not index.reindex_due(conn)
    conn.close()


def test_legacy_deletion_is_detected_even_if_no_transcript_changed(legacy, write_session):
    a = write_session("p", [user_text("deletealpha")], session_id="aa")
    write_session("p", [user_text("keepbeta")], session_id="bb")
    conn = db.connect()
    index.index_all(conn)
    Path(a).unlink()
    legacy()
    index.index_all(conn)
    assert_lookup(conn)
    assert not search.search(conn, "deletealpha")
    conn.close()


def test_unmanaged_write_requests_recovery_even_after_old_pass_clears_flag(legacy, write_session):
    path = write_session("p", [user_text("original")])
    conn = db.connect()
    index.ensure_indexed(conn)
    Path(path).write_text(user_text("legacyupdated"))
    legacy()
    assert db.get_meta(conn, "needs_reindex") == "0"
    assert index.reindex_due(conn)
    assert index.ensure_indexed(conn)["indexed"] == 1
    assert not index.reindex_due(conn)
    conn.close()


def test_failed_managed_operation_cannot_leave_committed_bypass(write_session):
    write_session("p", [user_text("preserved")], session_id="aa")
    conn = db.connect()
    index.index_all(conn)
    with pytest.raises(ValueError, match="injected"), search_rows.writing(conn):
        store.purge(conn, "aa")
        raise ValueError("injected")
    conn.commit()  # even a caller that commits after catching the exception cannot commit managed=1
    assert conn.execute("SELECT managed FROM fts_guard").fetchone()[0] == 0
    assert search.search(conn, "preserved")
    conn.execute("DELETE FROM sessions WHERE session_id='aa'")
    conn.commit()
    assert index.reindex_due(conn)
    conn.close()


def test_sqlite_interrupt_keeps_original_error_and_rolls_back_marker(write_session):
    write_session("p", [user_text("preserved")], session_id="aa")
    conn = db.connect()
    index.ensure_indexed(conn)
    with pytest.raises(sqlite3.OperationalError, match="interrupted"), search_rows.writing(conn):
        conn.set_progress_handler(lambda: 1, 1)
        try:
            conn.execute("DELETE FROM sessions")
        finally:
            conn.set_progress_handler(None, 0)
    conn.commit()
    assert conn.execute("SELECT managed FROM fts_guard").fetchone()[0] == 0
    assert search.search(conn, "preserved")
    conn.close()


def test_normal_pass_never_repairs_or_repeats_recovery(write_session, monkeypatch):
    path = write_session("p", [user_text("original")])
    conn = db.connect()
    index.ensure_indexed(conn)

    def unexpected(_conn):
        pytest.fail("normal writer performed a full FTS scan")

    monkeypatch.setattr(search_rows, "backfill", unexpected)
    with open(path, "a") as fh:
        fh.write(user_text("appended", ts="2026-09-02T10:00:00.000Z"))
    assert index.index_all(conn)["tail"] == 1
    Path(path).unlink()
    assert index.index_all(conn)["removed"] == 1
    assert not index.reindex_due(conn)
    assert index.index_all(conn)["indexed"] == 0
    conn.close()


def test_upgrade_repairs_already_corrupted_v13_catalog(write_session):
    write_session("p", [user_text("alpharestore")], session_id="aa")
    write_session("p", [user_text("betarestore")], session_id="bb")
    conn = db.connect()
    index.ensure_indexed(conn)
    # The state left by 2.4.2 after trusting a stale rowid: a real turn is gone and an orphan remains.
    for name in search_rows.TRIGGERS:
        conn.execute(f"DROP TRIGGER {name}")
    conn.execute("DROP TABLE fts_guard")
    conn.execute("UPDATE meta SET value='13' WHERE key='schema_version'")
    conn.execute("DELETE FROM fts WHERE session_id='aa' AND turn=1")
    conn.execute("INSERT INTO fts(session_id,turn,user_text) VALUES ('removed',1,'orphanedtext')")
    conn.commit()
    conn.close()
    conn = db.connect()
    assert index.reindex_due(conn)
    assert index.ensure_indexed(conn)["errors"] == 0
    assert conn.execute("SELECT user_text FROM fts WHERE session_id='aa' AND turn=1").fetchone()[0] == "alpharestore"
    assert {r["session_id"] for r in search.search(conn, "alpharestore")} == {"aa"}
    assert {r["session_id"] for r in search.search(conn, "betarestore")} == {"bb"}
    assert not search.search(conn, "orphanedtext")
    assert_lookup(conn)
    assert index.ensure_indexed(conn) is None
    conn.close()


def test_legacy_pass_cannot_clear_a_pending_upgrade_recovery(legacy, write_session):
    write_session("p", [user_text("restoreturn")], session_id="aa")
    conn = db.connect()
    index.ensure_indexed(conn)
    for name in search_rows.TRIGGERS:
        conn.execute(f"DROP TRIGGER {name}")
    conn.execute("DROP TABLE fts_guard")
    conn.execute("UPDATE meta SET value='13' WHERE key='schema_version'")
    conn.execute("DELETE FROM fts WHERE session_id='aa' AND turn=1")
    conn.commit()
    conn.close()
    conn = db.connect()  # upgrade schedules a full refresh, source signatures are unchanged
    legacy()  # an older pass finishes: skips unchanged files and clears the shared needs_reindex
    assert db.get_meta(conn, "needs_reindex") == "0"
    assert index.reindex_due(conn)
    assert index.ensure_indexed(conn)["indexed"] == 1
    assert conn.execute("SELECT user_text FROM fts WHERE session_id='aa' AND turn=1").fetchone()[0] == "restoreturn"
    assert not index.reindex_due(conn)
    conn.close()


def test_failed_recovery_retries_only_failed_source_and_eventually_restores_it(write_session, monkeypatch):
    write_session("p", [user_text("keepgood")], session_id="good")
    bad = write_session("p", [user_text("lostfirst"), assistant_text("reply"),
                              user_text("lastturn")], session_id="bad")
    conn = db.connect()
    index.ensure_indexed(conn)
    for name in search_rows.TRIGGERS:
        conn.execute(f"DROP TRIGGER {name}")
    conn.execute("DROP TABLE fts_guard")
    conn.execute("UPDATE meta SET value='13' WHERE key='schema_version'")
    conn.execute("DELETE FROM fts WHERE session_id='bad' AND turn=1")
    conn.commit()
    conn.close()
    conn = db.connect()
    from atlas import parse

    read = parse.parse_file

    def unreadable(path, *args, **kwargs):
        if path == bad:
            raise PermissionError("temporarily unreadable")
        return read(path, *args, **kwargs)

    with monkeypatch.context() as m:
        m.setattr(parse, "parse_file", unreadable)
        first = index.ensure_indexed(conn)
        assert first["errors"] == 1 and first["indexed"] == 1
        assert not index.reindex_due(conn)
        again = index.index_all(conn)
        assert again["errors"] == 1 and again["full"] == 0 and again["skipped"] == 1
    # File metadata did not change: the failed source still needs a full parse, not a tail append.
    fixed = index.index_all(conn)
    assert fixed["errors"] == 0 and fixed["indexed"] == 1 and fixed["skipped"] == 1
    assert conn.execute("SELECT user_text FROM fts WHERE session_id='bad' AND turn=1").fetchone()[0] == "lostfirst"
    assert not index.reindex_due(conn)
    assert_lookup(conn)
    conn.close()


def _commit_then_write(conn):
    conn.commit()
    conn.execute("UPDATE sessions SET title='later' WHERE session_id='aa'")


def _commit_then_raise(conn):
    conn.commit()
    raise ValueError("injected")


@pytest.mark.parametrize("body,error", [
    (lambda conn: conn.commit(), RuntimeError),
    (_commit_then_write, RuntimeError),
    (_commit_then_raise, ValueError),
], ids=["commit", "commit-then-write", "commit-then-raise"])
def test_commit_inside_managed_block_cannot_publish_bypass(write_session, body, error):
    write_session("p", [user_text("preserved")], session_id="aa")
    conn = db.connect()
    index.ensure_indexed(conn)
    with pytest.raises(error), search_rows.writing(conn):
        store.purge(conn, "aa")
        body(conn)  # a commit would publish managed=1 and silence the triggers for every writer
    conn.rollback()
    conn.close()
    other = db.connect()
    assert other.execute("SELECT managed FROM fts_guard").fetchone()[0] == 0
    other.execute("DELETE FROM sources")
    other.commit()
    assert index.reindex_due(other)
    other.close()


def test_failed_cleanup_never_replaces_the_original_error(write_session):
    write_session("p", [user_text("preserved")], session_id="aa")
    conn = db.connect()
    index.ensure_indexed(conn)
    with pytest.raises(ValueError, match="injected"), search_rows.writing(conn):
        conn.commit()
        conn.set_progress_handler(lambda: 1, 1)  # the marker cleanup is interrupted
        raise ValueError("injected")
    conn.set_progress_handler(None, 0)
    conn.close()
    other = db.connect()
    with search_rows.writing(other):  # the next guarded write resets the leftover marker
        pass
    other.commit()
    assert other.execute("SELECT managed FROM fts_guard").fetchone()[0] == 0
    other.close()
