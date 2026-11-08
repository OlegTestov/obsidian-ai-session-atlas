"""The optimization changes rendering cost only: complete search responses remain identical."""
from __future__ import annotations

import os
import random
import sqlite3
from pathlib import Path

import pytest

from atlas import db, highlight_chunks, index, query, search
from tests.conftest import assert_same, assistant_text, user_text


@pytest.fixture
def large_corpus(atlas_env, write_session):
    text = ("test testing claude code error alpha café Текст\n" * 1600)
    for n in range(2):
        file = write_session("large", [user_text(f"test claude code {n}"), assistant_text(text)],
                             session_id=f"large-{n}")
        agents = Path(file).with_suffix("") / "subagents"
        agents.mkdir(parents=True)
        (agents / "agent-one.jsonl").write_text(assistant_text(text), encoding="utf-8")
    conn = db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert conn.execute("SELECT max(length(subagent_text)) FROM fts").fetchone()[0] >= 65536
    yield conn
    conn.close()


@pytest.mark.parametrize("phrase", ["test", "claude code", "error OR alpha", '"claude code"'])
@pytest.mark.parametrize("order", ["date", "relevance"])
@pytest.mark.parametrize("mapped", [False, True])
def test_large_search_is_identical(large_corpus, monkeypatch, phrase, order, mapped):
    conn = large_corpus
    args = (2, None, None, None, None, False, None, "all", order, None)
    changes = conn.total_changes
    with monkeypatch.context() as baseline:
        baseline.setattr(search, "LARGE_FIELD", 10**12)
        old = search._run(conn, phrase, *args, mapped=mapped)
    new = search._run(conn, phrase, *args, mapped=mapped)
    assert_same(new, old)
    assert new["total"] == 2
    assert conn.total_changes == changes


@pytest.fixture
def dated_corpus(atlas_env, write_session):
    text = "test testing claude code error alpha plain\n" * 1800
    for session, date in (("new-0", "2026-09-01"), ("old-0", "2026-07-01")):
        write_session("dated", [user_text("test prompt", ts=f"{date}T10:00:00.000Z"),
                                assistant_text(text, ts=f"{date}T10:01:00.000Z")], session_id=session)
    conn = _index(atlas_env)
    conn.execute("UPDATE sessions SET agent='codex' WHERE session_id='old-0'")
    conn.commit()
    yield conn
    conn.close()


@pytest.mark.parametrize("filters,total,results,renders", [
    ({"scope": "prompts"}, 2, 2, False),
    ({"scope": "all", "agents": ["claude"]}, 1, 1, True),
    ({"scope": "all", "since": "2026-08-01"}, 1, 1, True),
    ({"scope": "all", "limit": 1}, 2, 1, True),
], ids=["prompts", "agent", "since", "limit"])
def test_large_search_filters_and_default_scope_are_unchanged(
        dated_corpus, monkeypatch, filters, total, results, renders):
    with monkeypatch.context() as baseline:
        baseline.setattr(search, "LARGE_FIELD", 10**12)
        expected = search.run(dated_corpus, "test", **filters)
    calls = []
    original = highlight_chunks.ChunkHighlighter.render
    monkeypatch.setattr(highlight_chunks.ChunkHighlighter, "render",
                        lambda self, text: calls.append(1) or original(self, text))
    actual = search.run(dated_corpus, "test", **filters)
    assert_same(actual, expected)
    assert (actual["total"], len(actual["results"])) == (total, results)
    assert bool(calls) is renders


def test_the_response_is_made_of_the_rendered_chunks(dated_corpus, monkeypatch):
    monkeypatch.setattr(highlight_chunks.ChunkHighlighter, "render",
                        lambda self, text: f"{query.MARK_OPEN}sentinel{query.MARK_CLOSE}")
    assert "sentinel" in str(search.run(dated_corpus, "test", scope="all")["results"])


@pytest.mark.parametrize("failure", ["sqlite", "unsafe"])
def test_scratch_failure_falls_back_to_original_sqlite(large_corpus, monkeypatch, failure):
    import sqlite3
    with monkeypatch.context() as baseline:
        baseline.setattr(search, "LARGE_FIELD", 10**12)
        expected = search.run(large_corpus, "test", scope="all")
    def unavailable(self, text):
        if failure == "sqlite":
            raise sqlite3.OperationalError("scratch unavailable")
        return None
    monkeypatch.setattr(search.ChunkHighlighter, "render", unavailable)
    assert search.run(large_corpus, "test", scope="all") == expected


def _sparse_session(write_session, session_id, hits):
    words = ["test"] * hits + ["plain"] * 20000
    random.Random(7).shuffle(words)
    return write_session("sparse", [user_text("short"), assistant_text(" ".join(words))], session_id=session_id)


def _fallbacks(conn):
    """Single-row highlight() queries: the path taken when a rendered field is not used."""
    seen = []
    conn.set_trace_callback(lambda sql: seen.append(sql) if " AND rowid=" in sql else None)
    return seen


def _index(atlas_env):
    conn = db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))
    index.index_all(conn, root=str(atlas_env["projects"]))
    return conn


def test_sparse_large_fields_stay_on_the_original_highlight(atlas_env, write_session, monkeypatch):
    _sparse_session(write_session, "sparse-0", 511)
    conn = _index(atlas_env)
    args = (5, None, None, None, None, False, None, "all", "date", None)
    calls = []
    original = highlight_chunks.ChunkHighlighter.render
    monkeypatch.setattr(highlight_chunks.ChunkHighlighter, "render",
                        lambda self, text: calls.append(len(text)) or original(self, text))
    assert search._run(conn, "test", *args, mapped=False)["total"] == 1
    assert calls == []
    conn.close()


def test_dense_large_fields_use_the_chunks(atlas_env, write_session, monkeypatch):
    _sparse_session(write_session, "dense-0", 512)
    conn = _index(atlas_env)
    args = (5, None, None, None, None, False, None, "all", "date", None)
    calls = []
    original = highlight_chunks.ChunkHighlighter.render
    monkeypatch.setattr(highlight_chunks.ChunkHighlighter, "render",
                        lambda self, text: calls.append(len(text)) or original(self, text))
    fallbacks = _fallbacks(conn)
    dense = search._run(conn, "test", *args, mapped=False)
    conn.set_trace_callback(None)
    assert calls and min(calls) >= 65536
    assert fallbacks == []                          # the rendered chunks are what the response is made of
    with monkeypatch.context() as baseline:
        baseline.setattr(search, "LARGE_FIELD", 10**12)
        assert_same(search._run(conn, "test", *args, mapped=False), dense)
    conn.close()


@pytest.mark.parametrize("size,hits,chunked", [
    (65535, 600, False),
    (65536, 600, True),
    (70000, 511, False),
    (70000, 512, True),
], ids=["one-short-of-large", "exactly-large", "one-short-of-dense", "exactly-dense"])
def test_routing_thresholds(atlas_env, write_session, monkeypatch, size, hits, chunked):
    body = "test " * hits
    padding = "plain " * ((size - len(body) - 1) // 6)     # the tail keeps a final space from being trimmed
    text = body + padding + "x" * (size - len(body) - len(padding))
    assert len(text) == size
    write_session("route", [user_text("short"), assistant_text(text)], session_id="route-0")
    conn = _index(atlas_env)
    assert conn.execute("SELECT max(length(assistant_text)) FROM fts").fetchone()[0] == size
    calls = []
    original = highlight_chunks.ChunkHighlighter.render
    monkeypatch.setattr(highlight_chunks.ChunkHighlighter, "render",
                        lambda self, field: calls.append(1) or original(self, field))
    search._run(conn, "test", 5, None, None, None, None, False, None, "all", "date", None, mapped=False)
    assert bool(calls) is chunked
    conn.close()


def test_large_is_counted_in_characters_not_bytes(atlas_env, write_session, monkeypatch):
    text = "тест test " * 600
    text += "плейн " * ((65535 - len(text) - 1) // 6)
    text += "ы" * (65535 - len(text))
    assert len(text) == 65535 and len(text.encode()) > 65536
    write_session("wide", [user_text("short"), assistant_text(text)], session_id="wide-0")
    conn = _index(atlas_env)
    assert conn.execute("SELECT max(length(assistant_text)) FROM fts").fetchone()[0] == 65535
    calls = []
    monkeypatch.setattr(highlight_chunks.ChunkHighlighter, "render", lambda self, field: calls.append(1))
    search._run(conn, "test", 5, None, None, None, None, False, None, "all", "date", None, mapped=False)
    assert calls == []
    conn.close()


def test_active_statement_keeps_the_original_path(large_corpus, monkeypatch):
    conn = large_corpus
    args = (2, None, None, None, None, False, None, "all", "date", None)
    expected = search._run(conn, "test", *args, mapped=False)
    active = conn.execute("SELECT rowid FROM fts")     # not exhausted: blocks re-registering the function
    assert active.fetchone()
    calls = []
    monkeypatch.setattr(highlight_chunks.ChunkHighlighter, "render",
                        lambda self, text: calls.append(1) or None)
    assert_same(search._run(conn, "test", *args, mapped=False), expected)
    assert calls == []
    active.close()


def test_field_with_a_null_character_keeps_the_original_path(atlas_env, write_session, monkeypatch):
    # length() stops at the first NUL, so the NUL sits past the size where chunks would begin.
    text = "test plain " * 7000 + "\x00" + " test" * 600
    write_session("nul", [user_text("short"), assistant_text(text)], session_id="nul-0")
    conn = _index(atlas_env)
    assert conn.execute("SELECT max(instr(assistant_text, char(0))) FROM fts").fetchone()[0] > 65536
    args = (5, None, None, None, None, False, None, "all", "date", None)
    calls = []
    original = highlight_chunks.ChunkHighlighter.render
    monkeypatch.setattr(highlight_chunks.ChunkHighlighter, "render",
                        lambda self, field: calls.append(1) or original(self, field))
    assert search._run(conn, "test", *args, mapped=False)["total"] == 1
    assert calls == []
    conn.close()


def test_small_fields_are_never_measured(atlas_env, write_session, monkeypatch):
    write_session("small", [user_text("short test")], session_id="small-0")
    _sparse_session(write_session, "big-0", 512)
    conn = _index(atlas_env)
    sizes = []
    original = highlight_chunks.ChunkHighlighter.dense
    monkeypatch.setattr(highlight_chunks.ChunkHighlighter, "dense",
                        lambda self, field: sizes.append(len(field)) or original(self, field))
    search._run(conn, "test", 5, None, None, None, None, False, None, "all", "date", None, mapped=False)
    assert sizes and min(sizes) >= 65536
    conn.close()


def test_unsplittable_fields_highlight_their_own_row(atlas_env, write_session, monkeypatch):
    # A token longer than a chunk sends the field to the fallback query, which must read this row, not the first.
    for n in range(3):
        text = "x" * 20000 + f" row{n} " + "test plain " * 7000
        write_session("long", [user_text("short"), assistant_text(text)], session_id=f"long-{n}")
    conn = _index(atlas_env)
    args = (5, None, None, None, None, False, None, "all", "date", None)
    fallbacks = []
    original = highlight_chunks.ChunkHighlighter.render

    def render(self, field):
        result = original(self, field)
        fallbacks.append(result is None)
        return result
    monkeypatch.setattr(highlight_chunks.ChunkHighlighter, "render", render)
    queries = _fallbacks(conn)
    new = search._run(conn, "row0 OR row1 OR row2 OR test", *args, mapped=False)
    conn.set_trace_callback(None)
    assert len(fallbacks) >= 3 and all(fallbacks)
    assert len(queries) == len(fallbacks)
    with monkeypatch.context() as baseline:
        baseline.setattr(search, "LARGE_FIELD", 10**12)
        assert_same(search._run(conn, "row0 OR row1 OR row2 OR test", *args, mapped=False), new)
    conn.close()


def test_scratch_is_closed_after_the_search_and_after_its_failure(large_corpus, monkeypatch):
    conn = large_corpus
    args = (2, None, None, None, None, False, None, "all", "date", None)
    made = []
    original_init = highlight_chunks.ChunkHighlighter.__init__
    monkeypatch.setattr(highlight_chunks.ChunkHighlighter, "__init__",
                        lambda self, *a, **k: (made.append(self), original_init(self, *a, **k))[1])
    expected = search._run(conn, "test", *args, mapped=False)
    assert made and all(renderer.connection is None for renderer in made)

    closes = []
    original_close = highlight_chunks.ChunkHighlighter.close
    monkeypatch.setattr(highlight_chunks.ChunkHighlighter, "close",
                        lambda self: closes.append(self.connection is not None) or original_close(self))
    original_render = highlight_chunks.ChunkHighlighter.render

    def failing(self, field):
        original_render(self, "test plain " * 10)   # the scratch connection is open when it fails
        raise sqlite3.OperationalError("scratch failed")
    monkeypatch.setattr(highlight_chunks.ChunkHighlighter, "render", failing)
    assert_same(search._run(conn, "test", *args, mapped=False), expected)
    assert closes.count(True) > 1                   # every failure closes it, not only the end of the search
