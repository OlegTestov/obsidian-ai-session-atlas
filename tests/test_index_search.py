"""Incremental indexing, source state transitions, search by Russian word forms."""
from __future__ import annotations

import os
from pathlib import Path

from atlas import db, index, search
from tests.conftest import assistant_text, assistant_tool, user_text


def _conn(atlas_env):
    return db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))


def test_append_is_picked_up_and_unchanged_files_are_skipped(atlas_env, write_session):
    path = write_session("p", [user_text("замер моделей ревьюера")])
    conn = _conn(atlas_env)
    first = index.index_all(conn, root=str(atlas_env["projects"]))
    assert first["indexed"] == 1

    again = index.index_all(conn, root=str(atlas_env["projects"]))
    assert again["skipped"] == 1 and again["indexed"] == 0

    with open(path, "a", encoding="utf-8") as fh:
        fh.write(user_text("добавили префиксный поиск", ts="2026-09-02T10:00:00.000Z"))
    os.utime(path, (os.stat(path).st_atime, os.stat(path).st_mtime + 5))
    third = index.index_all(conn, root=str(atlas_env["projects"]))
    assert third["indexed"] == 1
    row = conn.execute("SELECT human_turns FROM sessions").fetchone()
    assert row["human_turns"] == 2


def test_growth_is_noticed_even_when_mtime_did_not_move(atlas_env, write_session):
    """The size check must work on its own, not hide behind the mtime check."""
    path = write_session("p", [user_text("первое сообщение")])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    frozen = os.stat(path).st_mtime

    with open(path, "a", encoding="utf-8") as fh:
        fh.write(user_text("дописали ещё", ts="2026-09-02T10:00:00.000Z"))
    os.utime(path, (frozen, frozen))          # mtime restored, only the size grew

    stats = index.index_all(conn, root=str(atlas_env["projects"]))
    assert stats["indexed"] == 1
    assert conn.execute("SELECT human_turns FROM sessions").fetchone()["human_turns"] == 2


def test_truncate_and_replace_drop_stale_derived_rows(atlas_env, write_session):
    path = write_session("p", [user_text("исходный текст про ревьюера")])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert search.search(conn, "ревьюера")

    # File recreated with different content — old FTS rows must not survive it.
    os.remove(path)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(user_text("совсем другая работа про деплой"))
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert search.search(conn, "ревьюера") == []
    assert search.search(conn, "деплой")


def test_deleted_source_disappears_from_the_catalog(atlas_env, write_session):
    path = write_session("p", [user_text("временная сессия")])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    os.remove(path)
    stats = index.index_all(conn, root=str(atlas_env["projects"]))
    assert stats["removed"] == 1
    assert conn.execute("SELECT count(*) c FROM sessions").fetchone()["c"] == 0
    assert conn.execute("SELECT count(*) c FROM fts").fetchone()["c"] == 0


def test_rebuild_keeps_manual_overrides(atlas_env, write_session):
    write_session("p", [user_text("работа")], session_id="11111111-1111-1111-1111-111111111111")
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("INSERT INTO user_overrides(session_id, domain, sensitivity, updated_at) "
                 "VALUES(?,?,?,?)",
                 ("11111111-1111-1111-1111-111111111111", "personal", "sensitive", "2026-09-13"))
    conn.commit()

    db.drop_derived(conn)
    index.index_all(conn, root=str(atlas_env["projects"]), full=True)
    kept = conn.execute("SELECT * FROM user_overrides").fetchone()
    assert kept["sensitivity"] == "sensitive"
    meta = search.load_session(conn, "11111111-1111-1111-1111-111111111111")
    assert meta["sensitivity"] == "sensitive" and meta["domains"] == ["personal"]


def test_russian_word_forms_are_found_via_prefix_rewriting(atlas_env, write_session):
    write_session("p", [user_text("замер моделей ревьюера на подложенных дефектах")])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    for query in ("ревьюер", "ревьюера", "моделям", "дефект"):
        assert search.search(conn, query), f"no match for query {query!r}"


def test_short_words_are_searched_exactly():
    assert search.build_match("на", scope="all") == '"на"'
    assert search.build_match('"точная фраза" api', scope="all") == '"точная фраза" AND "api"'


def test_inflected_forms_collapse_onto_one_stem():
    """A plain prefix is not enough: «моделям*» would miss «моделей» — they diverge before the word ends."""
    assert search.stem_prefix("моделям") == search.stem_prefix("моделей")
    assert search.stem_prefix("ревьюер") == search.stem_prefix("ревьюера")
    assert search.stem_prefix("сессию") == search.stem_prefix("сессии")


def test_stem_never_shrinks_below_the_floor():
    assert len(search.stem_prefix("замер")) >= search.STEM_FLOOR
    assert search.stem_prefix("код") == "код"


def test_match_builder_escapes_quotes():
    # Words keep input order; a lone quote is noise, not a search term.
    assert search.build_match('он сказал "стоп"', scope="all") == '"он" AND "сказ"* AND "стоп"'
    assert search.build_match('кавычка " внутри', scope="all") == '"кавычк"* AND "внутр"*'
    assert search.build_match('say "a""b"', scope="all") == '"say" AND "a" AND "b"'


def test_stemming_does_not_collapse_unrelated_words(atlas_env, write_session):
    write_session("p", [user_text("правим деплой релиза")])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert search.search(conn, "деплою")
    assert search.search(conn, "депрессия") == []


def test_matches_report_the_field_that_matched(atlas_env, write_session):
    write_session("p", [
        user_text("почини пайплайн"),
        assistant_tool("Bash", {"command": "npm run deploy-release"}),
    ])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    hit = search.search(conn, "deploy-release", scope="all")[0]
    fields = {m["field"] for m in hit["matches"]}
    assert "commands" in fields
    assert all(m["fragment"] for m in hit["matches"])


def test_subagent_transcript_folds_into_its_parent_session(atlas_env, write_session):
    """A subagent is not a separate session: its work must be found via the parent."""
    sid = "22222222-2222-2222-2222-222222222222"
    path = write_session("p", [user_text("разберись с новостным окном")], session_id=sid)
    sub_dir = os.path.join(os.path.dirname(path), sid, "subagents")
    os.makedirs(sub_dir)
    with open(os.path.join(sub_dir, "agent-a1.jsonl"), "w", encoding="utf-8") as fh:
        fh.write(assistant_text("нашёл причину в календаре торговых сессий"))
        fh.write(assistant_tool("Bash", {"command": "pytest tests/test_calendar.py"}))

    conn = _conn(atlas_env)
    stats = index.index_all(conn, root=str(atlas_env["projects"]))
    assert stats["seen"] == 1 and stats["subagent_files"] == 1

    assert conn.execute("SELECT count(*) c FROM sessions").fetchone()["c"] == 1
    assert search.search(conn, "календаре") == []            # not in the user's prompts
    hit = search.search(conn, "календаре", scope="all")
    assert hit and hit[0]["session_id"] == sid
    assert hit[0]["matches"][0]["field"] == "subagent_text"
    assert search.search(conn, "test_calendar.py", scope="all")  # the subagent's command is searchable too
    assert conn.execute("SELECT subagent_turns FROM sessions").fetchone()["subagent_turns"] == 2


def test_subagent_change_reindexes_the_parent(atlas_env, write_session):
    sid = "33333333-3333-3333-3333-333333333333"
    path = write_session("p", [user_text("исходная задача")], session_id=sid)
    sub_dir = os.path.join(os.path.dirname(path), sid, "subagents")
    os.makedirs(sub_dir)
    sub = os.path.join(sub_dir, "agent-b1.jsonl")
    Path(sub).write_text(assistant_text("первый вывод"), encoding="utf-8")

    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert index.index_all(conn, root=str(atlas_env["projects"]))["skipped"] == 1

    with open(sub, "a", encoding="utf-8") as fh:
        fh.write(assistant_text("второй вывод про пагинацию"))
    assert index.index_all(conn, root=str(atlas_env["projects"]))["indexed"] == 1
    assert search.search(conn, "пагинацию", scope="all")


def test_automation_sessions_are_indexed_and_marked(atlas_env, write_session):
    from tests.conftest import rec
    write_session("p", [
        rec(type="assistant", timestamp="2026-09-01T03:00:00.000Z", cwd="/Users/u/Code/demo",
            entrypoint="sdk-cli",
            message={"role": "assistant", "model": "claude-sonnet-5",
                     "content": [{"type": "text", "text": "ночной прогон завершён"}]}),
    ])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    row = conn.execute("SELECT session_kind, started_at, human_turns FROM sessions").fetchone()
    assert row["session_kind"] == "automation"
    assert row["human_turns"] == 0
    assert row["started_at"] is not None      # real time, not a fake prompt


def test_automation_is_hidden_from_search_unless_asked(atlas_env, write_session):
    from tests.conftest import rec
    write_session("p", [
        rec(type="assistant", timestamp="2026-09-01T03:00:00.000Z", cwd="/Users/u/Code/demo",
            entrypoint="sdk-cli",
            message={"role": "assistant", "model": "claude-sonnet-5",
                     "content": [{"type": "text", "text": "ночной прогон про пагинацию"}]}),
    ])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert search.search(conn, "пагинацию") == []
    assert search.search(conn, "пагинацию", include_automation=True)


def test_identifiers_are_searched_exactly_not_stemmed():
    """«ABC-1548» truncated to «ABC-1*» would match any ticket of the project."""
    assert search.build_match("ABC-1548", scope="all") == '"ABC-1548"'
    assert search.build_match("deploy-release.mjs", scope="all") == '"deploy-release.mjs"'
    assert search.build_match("ревьюера", scope="all") == '"ревьюер"*'


def test_ticket_query_does_not_drag_in_neighbouring_tickets(atlas_env, write_session):
    write_session("p", [user_text("работаем над ABC-1548 и прокси")])
    write_session("p", [user_text("а тут совсем другое: ABC-1592 и новости")])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    hits = search.search(conn, "ABC-1548")
    assert len(hits) == 1
    assert "1548" in (hits[0]["tickets"] or [""])[0]


def test_schema_upgrade_rebuilds_derived_but_keeps_manual_values(atlas_env, write_session):
    """A live database outlived a column addition: the old schema must be recreated, not fixed by hand."""
    write_session("p", [user_text("работа")], session_id="44444444-4444-4444-4444-444444444444")
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("INSERT INTO user_overrides(session_id, domain, updated_at) VALUES(?,?,?)",
                 ("44444444-4444-4444-4444-444444444444", "personal", "2026-09-13"))
    # Simulate a database created by a previous schema version.
    conn.execute("UPDATE meta SET value='1' WHERE key='schema_version'")
    conn.execute("ALTER TABLE sessions DROP COLUMN content_hash")
    conn.commit()
    conn.close()

    conn = _conn(atlas_env)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
    assert "content_hash" in cols
    assert conn.execute("SELECT count(*) c FROM user_overrides").fetchone()["c"] == 1
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert conn.execute("SELECT count(*) c FROM sessions").fetchone()["c"] == 1


def test_schema_version_never_goes_backwards(atlas_env, write_session, monkeypatch):
    """An old process must not roll the version back — otherwise the new one drops the derived tables."""
    write_session("p", [user_text("работа")])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert db.get_meta(conn, "schema_version") == str(db.SCHEMA_VERSION)
    conn.close()

    # Simulate a connection from a process running older code.
    monkeypatch.setattr(db, "SCHEMA_VERSION", db.SCHEMA_VERSION - 1)
    old = _conn(atlas_env)
    assert db.get_meta(old, "schema_version") == str(db.SCHEMA_VERSION + 1)
    assert old.execute("SELECT count(*) c FROM sessions").fetchone()["c"] == 1
    old.close()


def test_classifier_domain_outranks_the_path_rule(atlas_env, write_session):
    """The rule sees only the path: touching a file in ~/.claude does not make the work cross-cutting."""
    sid = "55555555-5555-5555-5555-555555555555"
    write_session("p", [user_text("правим клиентский репозиторий")], session_id=sid)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("INSERT INTO session_domains VALUES (?,?)", (sid, "tools"))
    conn.execute("INSERT INTO classification (session_id, domain, topic, confidence, "
                 "content_hash, classifier_version, model, backend, created_at) "
                 "VALUES (?,?,?,?,?,?,?,?,?)",
                 (sid, "work", "News Pipeline", 0.9, "h", 1, "m", "b", "t"))
    conn.commit()
    meta = search.load_session(conn, sid)
    assert meta["domains"] == ["work"] and meta["domain_source"] == "llm"
    assert meta["topic"] == "News Pipeline"

    conn.execute("INSERT INTO user_overrides(session_id, domain, updated_at) VALUES (?,?,?)",
                 (sid, "personal", "t"))
    conn.commit()
    assert search.load_session(conn, sid)["domain_source"] == "manual"


def test_schema_upgrade_leaves_a_reindex_flag_that_readers_honour(atlas_env, write_session):
    """Otherwise the UI is empty after an upgrade: tables are dropped and nothing rebuilds them."""
    write_session("p", [user_text("работа")])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("UPDATE meta SET value='1' WHERE key='schema_version'")
    conn.commit()
    conn.close()

    conn = _conn(atlas_env)                       # connecting with the new version drops derived data
    assert db.get_meta(conn, "needs_reindex") == "1"
    assert conn.execute("SELECT count(*) c FROM sessions").fetchone()["c"] == 0

    index.ensure_indexed(conn, root=str(atlas_env["projects"]))
    assert conn.execute("SELECT count(*) c FROM sessions").fetchone()["c"] == 1
    assert db.get_meta(conn, "needs_reindex") == "0"
    assert index.ensure_indexed(conn, root=str(atlas_env["projects"])) is None


def test_rebuild_keeps_paid_llm_results_and_purge_cache_drops_them(atlas_env, write_session):
    """Classification costs a model call — rebuild must not lose it."""
    sid = "66666666-6666-6666-6666-666666666666"
    write_session("p", [user_text("работа")], session_id=sid)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("INSERT INTO classification (session_id, domain, topic, confidence, "
                 "content_hash, classifier_version, model, backend, created_at) "
                 "VALUES (?,?,?,?,?,?,?,?,?)",
                 (sid, "work", "News Pipeline", 0.9, "h", 1, "m", "b", "t"))
    conn.commit()

    db.drop_derived(conn)
    index.index_all(conn, root=str(atlas_env["projects"]), full=True)
    assert conn.execute("SELECT count(*) c FROM classification").fetchone()["c"] == 1

    dropped = db.purge_cache(conn)
    assert dropped["classification"] == 1
    assert conn.execute("SELECT count(*) c FROM classification").fetchone()["c"] == 0
    assert conn.execute("SELECT count(*) c FROM sessions").fetchone()["c"] == 1


def test_manual_topic_beats_the_classifier(atlas_env, write_session):
    sid = "88888888-8888-8888-8888-888888888888"
    write_session("p", [user_text("работа")], session_id=sid)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("INSERT INTO classification (session_id, domain, topic, confidence, "
                 "content_hash, classifier_version, model, backend, created_at) "
                 "VALUES (?,?,?,?,?,?,?,?,?)",
                 (sid, "personal", "разное", 0.3, "h", 1, "m", "b", "t"))
    conn.execute("INSERT INTO user_overrides(session_id, topic, updated_at) VALUES (?,?,?)",
                 (sid, "Мой Проект", "t"))
    conn.commit()
    meta = search.load_session(conn, sid)
    assert meta["topic"] == "Мой Проект"
    assert meta["topic_source"] == "manual"
    assert meta["topic_stale"] is False        # manual values do not go stale with the content


def test_repeated_artifact_links_collapse_to_one(atlas_env, write_session):
    """frame-link is written on every artifact update — 64 rows for one link."""
    from tests.conftest import rec
    lines = [user_text("рисуем артефакт")]
    for _ in range(20):
        lines.append(rec(type="frame-link", sessionId="x", frameUrl="", title=""))
        lines.append(rec(type="frame-link", sessionId="x",
                         frameUrl="https://claude.ai/code/artifact/abc", title="Кубики"))
    write_session("p", lines)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    rows = list(conn.execute("SELECT kind, url FROM session_links"))
    assert len(rows) == 1
    assert rows[0]["url"].endswith("abc")


def test_results_are_ordered_by_date_not_relevance(atlas_env, write_session):
    """Relevance order looks random: a recent session sinks below an old one."""
    write_session("p", [user_text("figma макет", ts="2026-01-10T10:00:00.000Z")])
    write_session("p", [user_text("figma figma figma везде", ts="2026-05-10T10:00:00.000Z")])
    write_session("p", [user_text("правки по figma", ts="2026-09-10T10:00:00.000Z")])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    hits = search.search(conn, "figma")
    dates = [h["last_activity_at"][:7] for h in hits]
    assert dates == ["2026-09", "2026-05", "2026-01"]
    assert search.search(conn, "figma", order="relevance")[0]["last_activity_at"][:7] == "2026-05"


def test_automation_noise_does_not_crowd_real_sessions_out_of_the_limit(atlas_env,
                                                                       write_session):
    """The kind filter must run in SQL: otherwise background runs eat the limit before filtering."""
    from tests.conftest import rec
    # Background runs are NEWER than the real session: otherwise it fits the limit by date and the
    # test passes even without the SQL filter.
    for i in range(30):
        write_session("p", [rec(
            type="assistant", timestamp=f"2026-10-{i % 27 + 1:02d}T10:00:00.000Z",
            cwd="/Users/u/Code/demo", entrypoint="sdk-cli",
            message={"role": "assistant", "model": "m",
                     "content": [{"type": "text", "text": "figma figma figma"}]})])
    write_session("p", [user_text("правки по figma", ts="2026-09-10T10:00:00.000Z")])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))

    hits = search.search(conn, "figma", limit=5, scope="all")
    assert len(hits) == 1
    assert hits[0]["session_kind"] == "interactive"
    assert len(search.search(conn, "figma", limit=5, scope="all",
                             include_automation=True)) == 5


def test_local_state_needs_no_model_call(atlas_env, write_session):
    """The card's main block is built from the transcript: without it the screen is empty without an external call."""
    from tests.conftest import assistant_text, rec
    write_session("p", [
        rec(type="user", timestamp="2026-09-01T10:00:00.000Z", cwd="/Users/u/Code/demo",
            entrypoint="cli", gitBranch="feature",
            message={"role": "user", "content": "This session is being continued from a "
                     "previous conversation. Summary: чинили деплой"}),
        user_text("продолжи с того места"),
        assistant_text("починил, тесты зелёные"),
        assistant_tool("Bash", {"command": "pytest -q"}),
    ])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    sid = conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]
    st = search.local_state(conn, sid)
    assert st["last_prompt"] == "продолжи с того места"
    assert "починил" in st["last_answer"]
    assert st["compaction_summary"].startswith("чинили деплой")   # preamble stripped
    assert st["compactions"] == 1
    assert st["branch"] == "main"          # the last branch is taken, not the first
    assert st["commands"] == 1


def test_state_quote_is_capped_and_keeps_line_structure(atlas_env, write_session):
    """The prompt in «where we left off» is capped like every other field — uncapped it put 8891 chars in the card."""
    write_session("p", [user_text("шаг один\n\n\nтаблица | " + "и очень длинный путь " * 120)])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    sid = conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]

    quote = search.local_state(conn, sid)["last_prompt"]
    assert len(quote) <= search.QUOTE_LIMIT + 2
    assert quote.startswith("шаг один\n\nтаблица")    # one blank line, not three
    assert "\n\n\n" not in quote
    assert quote.endswith("…")


def test_fragment_comes_from_the_turn_with_most_query_words(atlas_env, write_session):
    """Index rows are turns: the excerpt comes from the turn with the most query words, not the first one."""
    write_session("p", [
        user_text("посмотри логи сервера", ts="2026-09-01T10:00:00.000Z"),
        assistant_text("смотрю", ts="2026-09-01T10:01:00.000Z"),
        user_text("сервер падает при загрузке картинки", ts="2026-09-01T11:00:00.000Z"),
        assistant_text("чиню", ts="2026-09-01T11:01:00.000Z"),
    ])
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    hit = search.search(conn, "сервер картинки", scope="prompts")[0]
    prompt = next(m for m in hit["matches"] if m["field"] == "user_text")
    assert "картинки" in prompt["fragment"] and "логи" not in prompt["fragment"]
