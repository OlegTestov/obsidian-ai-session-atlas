"""Search reads session ids through fts_rows: the same results as reading the FTS content."""
from __future__ import annotations

import os

import pytest

from atlas import db, index, search
from tests.conftest import assistant_text, assistant_tool, user_text

QUERIES = ["alpha", "alpha beta", "alpha OR gamma", "alpha -gamma", "\"beta gamma\"", "deploy-release.mjs",
           "release.mjs", "scripts/deploy", "delta"]


def _conn(atlas_env):
    return db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))


def _append(path, lines):
    with open(path, "a", encoding="utf-8") as fh:
        fh.write("".join(lines))
    st = os.stat(path)
    os.utime(path, (st.st_atime, st.st_mtime + 5))


@pytest.fixture
def corpus(atlas_env, write_session):
    """Sessions with equal dates and scores, tied snippets, rowids of one session interleaved with
    others (turns appended after a pass) and more path matches than the trigram limit."""
    paths = []
    for i in range(10):
        same = "2026-09-01T10:00:00.000Z" if i % 3 else f"2026-09-0{1 + i % 9}T11:00:00.000Z"
        paths.append(write_session("p", [
            user_text(f"alpha beta session {i}", ts=same),
            assistant_tool("Bash", {"command": f"node scripts/deploy-release.mjs --n {i}"}, ts=same),
            assistant_text("beta gamma alpha" if i % 2 else "alpha beta", ts=same),
        ], session_id=f"s{i:02d}"))
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    for i, path in enumerate(paths[::2]):
        _append(path, [user_text(f"alpha again {i} delta", ts="2026-09-05T10:00:00.000Z"),
                       assistant_text("alpha beta", ts="2026-09-05T10:01:00.000Z")])
    index.index_all(conn, root=str(atlas_env["projects"]))
    return conn


def _both(conn, query, **kw):
    # _run's positional order: limit, projects, domains, kinds, since, include_automation, topics, scope,
    # order, agents.
    args = (kw.get("limit", 3), None, None, None, None, False, None, kw.get("scope", "prompts"),
            kw.get("order", "date"), None)
    old = search._run(conn, query, *args, mapped=False)
    new = search._run(conn, query, *args, mapped=True)
    return old, new


@pytest.mark.parametrize("query", QUERIES)
@pytest.mark.parametrize("scope", ["prompts", "all"])
@pytest.mark.parametrize("order", ["date", "relevance"])
def test_mapped_path_returns_the_same_results(corpus, query, scope, order):
    old, new = _both(corpus, query, scope=scope, order=order)
    assert new == old
    assert old["results"] or old["total"] == 0          # the matrix is not empty by accident


def test_corpus_has_interleaved_rowids_and_a_capped_trigram(corpus):
    turns = [r[0] for r in corpus.execute(
        "SELECT session_id FROM fts_rows WHERE index_name='fts' ORDER BY row_id")]
    assert turns.index("s00", turns.index("s01")) > turns.index("s01")   # s00 has rows after s01
    # Only the substring index finds `ploy-release.mjs` (inside `deploy-release.mjs`): 10 sessions
    # match, the trigram addition takes the first limit × 2 of them.
    old, new = _both(corpus, "ploy-release.mjs", scope="all", limit=2)
    assert new == old and old["total"] == 4


def test_run_takes_the_content_path_while_the_mapping_is_untrusted(corpus, monkeypatch):
    seen = []
    real = search._run
    monkeypatch.setattr(search, "_run", lambda *a, **kw: seen.append(kw["mapped"]) or real(*a, **kw))
    search.run(corpus, "alpha")
    corpus.execute("UPDATE fts_guard SET dirty=1 WHERE id=1")     # an old writer touched the index
    corpus.commit()
    search.run(corpus, "alpha")
    assert seen == [True, False]
    assert not corpus.in_transaction                              # the read snapshot was ended


def test_run_keeps_a_caller_transaction_open(corpus):
    corpus.execute("BEGIN")
    search.run(corpus, "alpha")
    assert corpus.in_transaction
    corpus.rollback()


def _filtered(conn, query, kinds=None, since=None, agents=None, scope="all", order="date", limit=3):
    args = (limit, None, None, kinds, since, False, None, scope, order, agents)
    return search._run(conn, query, *args, mapped=False), search._run(conn, query, *args, mapped=True)


@pytest.mark.parametrize("query", ["alpha", "alpha beta", "deploy-release.mjs", "ploy-release.mjs"])
@pytest.mark.parametrize("order", ["date", "relevance"])
@pytest.mark.parametrize("filters", ["kinds", "since", "agents", "all three"])
def test_filters_keep_the_same_results(corpus, query, order, filters):
    """Filters add a sessions condition to the row queries: the order rows come in must still match."""
    kind = corpus.execute("SELECT session_kind FROM sessions WHERE session_kind IS NOT NULL LIMIT 1").fetchone()[0]
    kw = {"kinds": {"kinds": [kind]}, "since": {"since": "2026-09-04"}, "agents": {"agents": ["claude"]},
          "all three": {"kinds": [kind], "since": "2026-09-04", "agents": ["claude"]}}[filters]
    old, new = _filtered(corpus, query, order=order, **kw)
    assert new == old


def test_a_filter_narrows_the_results(corpus):
    """The filter matrix above is not vacuous: since drops the sessions without the later turns."""
    everything, _ = _filtered(corpus, "alpha", limit=50)
    recent, _ = _filtered(corpus, "alpha", since="2026-09-04", limit=50)
    assert 0 < recent["total"] < everything["total"]
