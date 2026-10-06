"""Search from the user's view: what is found, what is highlighted, how the query is understood."""
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request

import pytest

from atlas import db, index, messages, query, search
from tests.conftest import assistant_text, user_text


def _conn(atlas_env):
    return db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))


def _indexed(atlas_env, write_session, *sessions):
    for lines in sessions:
        write_session("p", lines)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    return conn


def _hit_texts(match: dict) -> list[str]:
    return [s["t"] for s in match["segments"] if s["hit"]]


# --- numbers and identifiers ----------------------------------------------

def test_number_does_not_match_numbers_it_starts_with(atlas_env, write_session):
    """Owner complaint: «1359» returned sessions containing «13»."""
    conn = _indexed(atlas_env, write_session,
                    [user_text("переделываем фронт ABC-1359")],
                    [user_text("адрес: Лихоборская наб., 13, стр.71")],
                    [user_text("в отчёте 135 алёртов")])
    only = search.search(conn, "1359")
    assert [h["tickets"] for h in only] == [["ABC-1359"]]
    assert _hit_texts(only[0]["matches"][0]) == ["1359"]
    assert len(search.search(conn, "13")) == 1
    assert len(search.search(conn, "135")) == 1


def test_ticket_and_its_bare_number_find_the_same_session(atlas_env, write_session):
    conn = _indexed(atlas_env, write_session,
                    [user_text("ревью ABC-1359, потом ABC-1360")],
                    [user_text("совсем про другое")])
    assert len(search.search(conn, "ABC-1359")) == 1
    assert len(search.search(conn, "abc-1359")) == 1


# --- highlighting ----------------------------------------------------------

def test_russian_quotes_in_text_are_not_mistaken_for_highlight(atlas_env, write_session):
    """«» markers collided with quotes in the text and highlighted chunks of whole phrases."""
    conn = _indexed(atlas_env, write_session, [user_text(
        "это «снимок до перезаписи», сейчас там ABC-1359 и «ещё что-то» рядом")])
    match = search.search(conn, "1359")[0]["matches"][0]
    assert _hit_texts(match) == ["1359"]
    plain = "".join(s["t"] for s in match["segments"])
    assert "«снимок до перезаписи»" in plain


def test_fragment_prefers_the_place_where_all_words_meet(atlas_env, write_session):
    filler = "обсуждали разное " * 40
    conn = _indexed(atlas_env, write_session, [user_text(
        "открой окно терминала. " + filler + "потом окно новостей сломалось")])
    match = search.search(conn, "окно новостей")[0]["matches"][0]
    hits = [t.lower() for t in _hit_texts(match)]
    assert "окно" in hits and any(h.startswith("новост") for h in hits)


def test_fragment_edges_do_not_cut_words(atlas_env, write_session):
    words = " ".join(f"слово{i}" for i in range(200))
    conn = _indexed(atlas_env, write_session, [user_text(words + " искомое " + words)])
    segs = search.search(conn, "искомое")[0]["matches"][0]["segments"]
    body = "".join(s["t"] for s in segs).strip("…").strip()
    assert all(w.startswith("слово") or w == "искомое" for w in body.split())


def test_hits_are_counted_per_field(atlas_env, write_session):
    conn = _indexed(atlas_env, write_session, [
        user_text("фильтр по дате, фильтр по домену и ещё раз фильтр"),
        assistant_text("фильтр добавлен"),
    ])
    hit = search.search(conn, "фильтр", scope="all")[0]
    assert hit["hit_fields"]["user_text"] == 3
    assert hit["hit_fields"]["assistant_text"] == 1
    assert hit["hits"] == 4


# --- operators -------------------------------------------------------------

@pytest.fixture
def windows(atlas_env, write_session):
    return _indexed(atlas_env, write_session,
                    [user_text("окно новостей не грузится")],
                    [user_text("окно настроек слишком узкое")],
                    [user_text("новости приходят без окна")])


def test_minus_excludes_a_word(windows):
    titles = {h["title"] for h in search.search(windows, "окно -настроек")}
    assert titles and not any("настроек" in t for t in titles)


def test_quotes_keep_a_phrase_together(windows):
    assert len(search.search(windows, '"окно новостей"')) == 1
    assert len(search.search(windows, "окно новостей")) == 2  # «новости … окна» too


def test_or_joins_alternatives(windows):
    assert len(search.search(windows, "настроек ИЛИ новостей")) == 3
    assert len(search.search(windows, "настроек новостей")) == 0


def test_only_exclusions_explain_instead_of_failing(windows):
    res = search.run(windows, "-окно")
    assert res["results"] == [] and "without a minus" in res["error"]       # no header — en
    with messages.use_lang("ru"):
        res = search.run(windows, "-окно")
    assert res["results"] == [] and "без минуса" in res["error"]


def test_noise_tokens_do_not_break_the_query(windows):
    for noisy in ('окно "', "окно —", "окно -", "(окно)", "окно «новостей»"):
        assert search.search(windows, noisy), noisy


def test_short_russian_words_match_their_forms(atlas_env, write_session):
    """«окно» is shorter than the stem floor — without enumerating forms «окна» would not be found."""
    conn = _indexed(atlas_env, write_session,
                    [user_text("перенесли окна настроек")],
                    [user_text("новый план релиза")],
                    [user_text("поставили плагин")])
    assert len(search.search(conn, "окно")) == 1
    assert len(search.search(conn, "плана")) == 1   # and not «плагин»
    assert len(search.search(conn, "план")) == 1


def test_consonant_final_word_is_not_cut_into_a_different_word(atlas_env, write_session):
    """«замер» truncated to «заме*» would find «заметки» and «замечания»."""
    conn = _indexed(atlas_env, write_session,
                    [user_text("сделали замеры скорости")],
                    [user_text("записал заметки после звонка")])
    assert len(search.search(conn, "замер")) == 1
    assert query.stem_prefix("замер") == "замер"
    assert query.stem_prefix("новостей") == "новост"
    assert query.stem_prefix("дефектах") == "дефект"
    assert query.stem_prefix("models") == "model"


def test_quoted_single_word_is_matched_exactly():
    assert query.build_match('"моделей"', scope="all") == '"моделей"'
    assert query.build_match("моделей", scope="all") == '"модел"*'


def test_plan_explains_how_each_word_was_read():
    with messages.use_lang("ru"):
        plan = query.describe(query.parse('1359 моделям "окно новостей" -figma'))
    assert [(p["text"], p["how"], p["negate"]) for p in plan] == [
        ("1359", "точно", False),
        ("модел…", "любая форма слова", False),
        ("окно новостей", "фраза целиком", False),
        ("figma…", "любая форма слова", True),
    ]
    assert query.describe(query.parse("a1 или b2"))[1]["or_with_previous"] is True
    en = query.describe(query.parse('1359 моделям "окно новостей"'))
    assert [p["how"] for p in en] == ["exact", "any word form", "whole phrase"]


# --- result size and the neighbouring scope -------------------------------

def test_total_counts_everything_not_only_the_page(atlas_env, write_session):
    conn = _indexed(atlas_env, write_session,
                    *[[user_text(f"сессия про прокси номер {i}")] for i in range(5)])
    res = search.run(conn, "прокси", limit=2)
    assert len(res["results"]) == 2 and res["total"] == 5


def test_sessions_found_only_outside_prompts_are_announced(atlas_env, write_session):
    conn = _indexed(atlas_env, write_session,
                    [user_text("почини сборку"), assistant_text("поправил webpack конфиг")],
                    [user_text("обнови webpack")])
    res = search.run(conn, "webpack")
    assert res["total"] == 1 and res["elsewhere"] == 1
    assert search.run(conn, "webpack", scope="all")["elsewhere"] is None


# --- server ----------------------------------------------------------------

def test_server_list_carries_plan_total_and_segments(atlas_env, write_session, live_server):
    _indexed(atlas_env, write_session,
             [user_text("фронт ABC-1359 «с кавычками»")],
             [user_text("дом 13")])
    base, _ = live_server
    url = f"{base}/api/sessions?" + urllib.parse.urlencode({"q": "1359"})
    with urllib.request.urlopen(url, timeout=5) as r:
        data = json.loads(r.read())
    assert data["count"] == 1 and data["shown"] == 1
    assert data["plan"][0]["how"] == "exact"                # no header — English
    ru = urllib.request.Request(url, headers={"X-Atlas-Lang": "ru"})
    with urllib.request.urlopen(ru, timeout=5) as r:
        assert json.loads(r.read())["plan"][0]["how"] == "точно"
    assert _hit_texts(data["results"][0]["matches"][0]) == ["1359"]


# --- server-side index catch-up ---------------------------------------------

def _list(base, **params):
    url = f"{base}/api/sessions?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read())


@pytest.fixture
def fresh_catch_up(monkeypatch, atlas_env):
    from atlas import db, index, server
    # The full pass a new database is due for is done here: these tests count the passes requests start.
    conn = db.connect()
    index.ensure_indexed(conn, root=str(atlas_env["projects"]))
    conn.close()
    monkeypatch.setattr(server, "_catchup_at", 0.0)
    monkeypatch.setattr(server, "_catchup_proc", None)
    return server


class _FakePass:
    """A pass controlled by the test: how many times it started and when it finishes."""
    started = 0

    def __init__(self):
        import threading
        type(self).started += 1
        self.done = threading.Event()
        if type(self).instant:
            self.done.set()

    def is_alive(self):
        return not self.done.is_set()

    def join(self, timeout=None):
        self.done.wait(timeout)


def test_transcript_written_after_indexing_reaches_the_server_list(
        atlas_env, write_session, live_server, fresh_catch_up):
    """Without catch-up the UI shows a four-day-old index until you press «refresh».

    A real pass: a separate `atlas index` process with the same ATLAS_HOME.
    """
    import time
    _indexed(atlas_env, write_session, [user_text("старая сессия про прокси")])
    base, _ = live_server
    write_session("p", [user_text("новая сессия про webpack")])
    deadline = time.monotonic() + 15
    data = _list(base, q="webpack")
    while data["indexing"] and time.monotonic() < deadline:
        time.sleep(0.2)
        data = _list(base, q="webpack")
    assert data["indexing"] is False and data["count"] == 1
    assert _list(base)["count"] == 2


def test_catch_up_is_throttled_between_keystrokes(atlas_env, live_server, fresh_catch_up,
                                                  monkeypatch):
    fake = type("Instant", (_FakePass,), {"instant": True, "started": 0})
    monkeypatch.setattr(fresh_catch_up, "_Pass", fake)
    base, _ = live_server
    for q in ("w", "we", "web", "webp"):
        _list(base, q=q)
    assert fake.started == 1


def test_long_catch_up_does_not_hold_the_answer(atlas_env, live_server, fresh_catch_up,
                                                monkeypatch):
    import time
    fake = type("Slow", (_FakePass,), {"instant": False, "started": 0})
    monkeypatch.setattr(fresh_catch_up, "_Pass", fake)
    base, _ = live_server
    started = time.monotonic()
    assert _list(base)["indexing"] is True
    assert time.monotonic() - started < fresh_catch_up.CATCHUP_WAIT + 1.0
    again = time.monotonic()
    assert _list(base)["indexing"] is True and fake.started == 1  # a running pass is not restarted
    assert time.monotonic() - again < fresh_catch_up.CATCHUP_WAIT  # and is not waited for
    fresh_catch_up._catchup_proc.done.set()
    assert _list(base)["indexing"] is False


def test_connect_does_not_wait_for_a_running_writer(atlas_env):
    """Each server request opens a connection; the background indexer holds the write lock for seconds."""
    import sqlite3
    import time
    path = os.path.join(str(atlas_env["home"]), "atlas.sqlite3")
    db.connect(path).close()
    writer = sqlite3.connect(path)
    writer.execute("BEGIN IMMEDIATE")
    try:
        started = time.monotonic()
        conn = db.connect(path)
        conn.execute("SELECT count(*) FROM sessions").fetchone()
        assert time.monotonic() - started < 1.0
    finally:
        writer.rollback()


# --- relevance order and substring search in paths --------------------------

def test_relevance_prefers_title_then_words_side_by_side(atlas_env, write_session):
    """Plain bm25 ranks huge sessions high where query words are scattered across the text."""
    noise = "шум " * 40
    # Noise at the edges: prompts are joined in the index, so one's end abuts the next one's start.
    scattered = [user_text(f"{noise} окно {noise} новостей {noise} окно {noise} новостей {noise}")
                 for _ in range(8)]
    write_session("p", [user_text("про другое"), *scattered], session_id="scattered")
    write_session("p", [user_text("начнём"), user_text(noise * 20 + " сломалось окно новостей")],
                  session_id="together")
    write_session("p", [user_text("Окно новостей: переделка"), user_text(noise * 20)],
                  session_id="titled")
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    order = [h["session_id"] for h in search.search(conn, "окно новостей", order="relevance")]
    assert order == ["titled", "together", "scattered"]


def test_path_substring_respects_the_automation_filter(atlas_env, write_session):
    from tests.conftest import assistant_tool, rec
    write_session("p", [rec(
        type="assistant", timestamp="2026-09-01T10:00:00.000Z", cwd="/Users/u/Code/demo",
        entrypoint="sdk-cli", message={"role": "assistant", "model": "m", "content": [
            {"type": "tool_use", "id": "t", "name": "Bash",
             "input": {"command": "node deploy-release.mjs"}}]})])
    write_session("p", [user_text("почини релиз"),
                        assistant_tool("Bash", {"command": "node deploy-release.mjs"})])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert len(search.search(conn, "release.mjs", scope="all")) == 1
    assert len(search.search(conn, "release.mjs", scope="all", include_automation=True)) == 2


def test_a_due_full_pass_runs_in_the_background(atlas_env, live_server, fresh_catch_up, monkeypatch):
    """After a schema upgrade the full pass takes minutes on a large corpus: requests must not wait."""
    import time

    from atlas import db
    fake = type("SlowPass", (_FakePass,), {"started": 0, "instant": False})
    monkeypatch.setattr(fresh_catch_up, "_Pass", fake)
    conn = db.connect()
    db.set_meta(conn, "needs_reindex", "1")
    conn.commit()
    conn.close()
    base, _ = live_server
    started = time.monotonic()
    assert _list(base)["indexing"] is True
    assert time.monotonic() - started < fresh_catch_up.CATCHUP_WAIT + 1.0
    assert fake.started == 1
    assert _list(base)["indexing"] is True and fake.started == 1      # the running pass is reused
    conn = db.connect()
    assert db.get_meta(conn, "needs_reindex") == "1"     # the request left the full pass to the background
    conn.close()
    fresh_catch_up._catchup_proc.done.set()


def test_the_index_command_runs_a_due_full_pass(atlas_env, write_session):
    """`atlas index` is the server's background pass: it does the full pass that is due."""
    import os
    import subprocess
    import sys

    from atlas import db
    from tests.conftest import write_config
    _indexed(atlas_env, write_session, [user_text("чиню ZZZ-77 до смены настроек")])
    conn = db.connect()
    assert conn.execute("SELECT COUNT(*) FROM session_tickets WHERE ticket='ZZZ-77'").fetchone()[0] == 0
    # A new ticket prefix changes what the unchanged transcript yields: only a full pass sees it.
    write_config(os.environ["ATLAS_HOME"], {"ticket_prefixes": ["ZZZ"]})
    env = dict(os.environ, ATLAS_PROJECTS_ROOT=str(atlas_env["projects"]))
    subprocess.run([sys.executable, "-m", "atlas.cli", "index"], check=True, capture_output=True, env=env,
                   cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))), timeout=60)
    assert conn.execute("SELECT COUNT(*) FROM session_tickets WHERE ticket='ZZZ-77'").fetchone()[0] == 1
    assert db.get_meta(conn, "needs_reindex") == "0"
    conn.close()
