"""Conversion preparation and cleanup failures must not damage existing sessions."""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager

import pytest

from atlas import convert, convert_write, index
from tests import xresume_corpus as X
from tests.test_xresume import corpus as corpus


def test_serialization_finishes_before_writer_lock(corpus, monkeypatch):
    locked = False
    observed = []
    original_lock = index.writer_lock
    original_dumps = convert_write.json.dumps

    @contextmanager
    def lock():
        nonlocal locked
        with original_lock():
            locked = True
            try:
                yield
            finally:
                locked = False

    def dumps(*args, **kwargs):
        observed.append(locked)
        return original_dumps(*args, **kwargs)

    monkeypatch.setattr(index, "writer_lock", lock)
    monkeypatch.setattr(convert_write.json, "dumps", dumps)
    convert.resume_with(corpus["conn"], X.CLAUDE_ID, "codex")
    assert observed and not any(observed)


@pytest.mark.parametrize("sid,target", [(X.CLAUDE_ID, "codex"), (X.CODEX_ID, "claude")])
def test_serialization_failure_writes_no_link_or_transcript(corpus, monkeypatch, sid, target):
    from pathlib import Path

    projects = Path(corpus["projects"])
    codex_home = Path(corpus["codex_home"])
    before = set(projects.rglob("*.jsonl")) | set(codex_home.rglob("*.jsonl"))
    monkeypatch.setattr(convert_write, target + "_records", lambda *a: [{"bad": object()}])
    with pytest.raises(TypeError):
        convert.resume_with(corpus["conn"], sid, target)
    assert corpus["conn"].execute("SELECT count(*) FROM conversions").fetchone()[0] == 0
    assert set(projects.rglob("*.jsonl")) | set(codex_home.rglob("*.jsonl")) == before


def test_failed_unlink_preserves_write_error_and_logs_cleanup(tmp_path, monkeypatch, caplog):
    original = os.fdopen
    write_error = OSError("disk full")

    @contextmanager
    def broken(fd, *args, **kwargs):
        with original(fd, *args, **kwargs) as fh:
            fh.write("partial")
            raise write_error
            yield fh

    def no_unlink(path):
        raise PermissionError("cleanup denied")

    monkeypatch.setattr(os, "fdopen", broken)
    monkeypatch.setattr(os, "unlink", no_unlink)
    with pytest.raises(OSError) as caught:
        convert_write.write_new(str(tmp_path / "copy.jsonl"), convert_write.serialize([{"a": 1}]))
    assert caught.value is write_error
    assert "cleanup denied" in caplog.text


def test_failed_link_cleanup_preserves_write_error_and_logs_cleanup(corpus, monkeypatch, caplog):
    conn = corpus["conn"]
    write_error = OSError("disk full")

    class Connection:
        def __getattr__(self, name):
            return getattr(conn, name)

        def execute(self, sql, *args):
            if sql.startswith("DELETE FROM conversions"):
                conn.execute(sql, *args)
                raise sqlite3.OperationalError("link cleanup failed")
            return conn.execute(sql, *args)

        def __enter__(self):
            conn.__enter__()
            return self

        def __exit__(self, *args):
            return conn.__exit__(*args)

    def no_write(*args):
        raise write_error

    monkeypatch.setattr(convert_write, "write_new", no_write)
    with pytest.raises(OSError) as caught:
        convert.resume_with(Connection(), X.CLAUDE_ID, "codex")
    assert caught.value is write_error
    assert "link cleanup failed" in caplog.text
    assert not conn.in_transaction
    assert conn.execute("SELECT count(*) FROM conversions").fetchone()[0] == 1
