"""Temporary FTS highlighting must be byte-for-byte the same as the stored row's highlighting."""
from __future__ import annotations

import random
import sqlite3

import pytest

from atlas import query
from atlas.highlight_chunks import ChunkHighlighter
from tests.conftest import assert_same

REAL_SCHEMA = "CREATE VIRTUAL TABLE sample USING fts5(text, prefix='2 3 4')"


def marked(conn, text, expression):
    conn.execute("DELETE FROM sample")
    conn.execute("INSERT INTO sample(text) VALUES (?)", (text,))
    row = conn.execute("SELECT highlight(sample, 0, ?, ?) FROM sample WHERE sample MATCH ?",
                       (query.MARK_OPEN, query.MARK_CLOSE, expression)).fetchone()
    return row[0] if row else text


@pytest.mark.parametrize("phrase", ["test", "error", "claude code", "session atlas",
                                  '"test"', "error OR test", "test -debug"])
def test_large_text_matches_sqlite_exactly(phrase):
    parsed = query.parse(phrase)
    expression = " OR ".join(t.fts() for t in parsed.positive)
    conn = sqlite3.connect(":memory:")
    conn.execute(REAL_SCHEMA)
    # Boundaries include accents, Unicode, CRLF, markers and prefix forms, not just plain English.
    text = (("test testing testé te\u0301st claude code ERROR session atlas "
             "Тестовый error-code \x02plain\x03\r\n") * 1000)
    with ChunkHighlighter(parsed) as renderer:
        result = renderer.render(text)
    assert_same(result, marked(conn, text, expression))
    conn.close()


def test_random_boundaries_are_identical():
    rng = random.Random(90210)
    words = ["test", "testing", "code", "Claude", "TEST", "érrôr", "тест", "plain",
             "\x02marker\x03", "café", "te\u0301st"]
    whitespace = [" ", "\n", "\r\n", "\t", "\f", "\v"]
    parsed = query.parse("test code error")
    conn = sqlite3.connect(":memory:")
    conn.execute(REAL_SCHEMA)
    expression = " OR ".join(t.fts() for t in parsed.positive)
    with ChunkHighlighter(parsed, chunk_size=80) as renderer:
        for _ in range(100):
            text = "".join(rng.choice(words) + rng.choice(whitespace) for _ in range(300))
            assert_same(renderer.render(text), marked(conn, text, expression))
    conn.close()


@pytest.mark.parametrize("text", ["test\x00 code" * 1000, "x" * 20000 + " test"], ids=["null", "oversized-token"])
def test_unsafe_text_requires_the_original_path(text):
    with ChunkHighlighter(query.parse("test")) as renderer:
        assert renderer.render(text) is None


@pytest.mark.parametrize("phrase", ['"test code"', "код", "deploy-release.mjs", "foo_bar", "a/b", "érrôr",
                                    'test "claude code"', "test код", "test foo_bar"])
def test_unsupported_queries_keep_the_original_path(phrase):
    with ChunkHighlighter(query.parse(phrase)) as renderer:
        assert not renderer.eligible
        assert renderer.render("test code" * 1000) is None


@pytest.mark.parametrize("phrase,text,hits", [
    ("testing", "test plain words " * 3, 3),        # the stem, not the whole word, is what a chunk must hold
    ("TEST", "test plain words " * 3, 3),           # the query's case
    ("test", "TEST plain words " * 3, 3),           # the text's case
    ("cat", "c\u1eaft plain words cat " * 3, 3),     # a double diacritic stays a different word
    ("test", "test_x plain test-y words " * 3, 3),  # "_" joins nothing in the default tokenizer
])
def test_pure_ascii_and_tokenizer_edges_match_sqlite(phrase, text, hits):
    parsed = query.parse(phrase)
    conn = sqlite3.connect(":memory:")
    conn.execute(REAL_SCHEMA)
    with ChunkHighlighter(parsed, chunk_size=40) as renderer:
        result = renderer.render(text)
    assert_same(result, marked(conn, text, " OR ".join(t.fts() for t in parsed.positive)))
    assert result.count(query.MARK_OPEN) >= hits
    conn.close()


def test_excluded_words_do_not_decide_what_a_chunk_can_hold():
    parsed = query.parse("test -debug")
    text = "debug only here " * 8 + "test plain " * 8
    conn = sqlite3.connect(":memory:")
    conn.execute(REAL_SCHEMA)
    with ChunkHighlighter(parsed, chunk_size=40) as renderer:
        assert renderer.needles == ["test"]
        assert_same(renderer.render(text), marked(conn, text, " OR ".join(t.fts() for t in parsed.positive)))
    conn.close()


def test_close_forgets_the_scratch_connection():
    renderer = ChunkHighlighter(query.parse("test"))
    assert renderer.render("test plain " * 100)
    renderer.close()
    assert renderer.connection is None
    renderer.close()


def test_scratch_is_request_local_and_closed():
    with ChunkHighlighter(query.parse("test")) as first:
        assert first.render("test plain" * 1000)
        scratch = first.connection
        with ChunkHighlighter(query.parse("code")) as second:
            assert second.render("code plain" * 1000)
            assert second.connection is not scratch
    with pytest.raises(sqlite3.ProgrammingError):
        scratch.execute("SELECT 1")


def test_sparse_ascii_fast_path_keeps_accent_only_matches():
    parsed = query.parse("error")
    text = "plain words " * 1500 + "érrôr " + "unrelated text " * 1500
    conn = sqlite3.connect(":memory:")
    conn.execute(REAL_SCHEMA)
    with ChunkHighlighter(parsed) as renderer:
        result = renderer.render(text)
    assert_same(result, marked(conn, text, parsed.positive[0].fts()))
    assert query.MARK_OPEN + "érrôr" + query.MARK_CLOSE in result
    conn.close()


def test_dense_counts_case_forms_of_every_word_once():
    with ChunkHighlighter(query.parse("test code")) as renderer:
        assert renderer.dense("test " * 256 + "Code " * 256)
        assert renderer.dense("TEST " * 512)
        assert not renderer.dense("test " * 511)
        assert not renderer.dense("tEsT " * 512)
        assert not renderer.dense(b"test " * 512)
    with ChunkHighlighter(query.parse("1234")) as digits:
        assert not digits.dense("1234 " * 511)   # one form, not three identical ones
