"""Дочитывание дописанного: тот же индекс, что и полный проход, но без переписывания сессии."""
from __future__ import annotations

import os

from atlas import db, index, search
from tests.conftest import assistant_text, assistant_tool, rec, user_text


def _conn(home, name="atlas.sqlite3"):
    return db.connect(os.path.join(str(home), name))


def _dump(conn):
    """Всё, что видит пользователь: карточки, поиск и строки индекса."""
    sessions = [dict(r) for r in conn.execute(
        "SELECT session_id, title, human_turns, machine_turns, last_activity_at, last_prompt "
        "FROM sessions ORDER BY session_id")]
    rows = sorted(tuple(r) for r in conn.execute(
        "SELECT session_id, turn, title, user_text, assistant_text, commands, paths, tickets, "
        "summaries FROM fts"))
    tickets = sorted(tuple(r) for r in conn.execute("SELECT * FROM session_tickets"))
    return sessions, rows, tickets


def test_appended_turns_are_read_from_where_the_last_pass_stopped(atlas_env, write_session,
                                                                   tmp_path):
    path = write_session("p", [user_text("первый запрос про прокси", ts="2026-09-27T09:00:00.000Z"),
                               assistant_text("ответ про прокси", ts="2026-09-27T09:01:00.000Z")],
                         session_id="live")
    conn = _conn(atlas_env["home"])
    index.index_all(conn, root=str(atlas_env["projects"]))
    with open(path, "a", encoding="utf-8") as fh:        # сессия живёт дальше
        fh.write(assistant_text("ещё ответ на первый", ts="2026-09-27T09:02:00.000Z"))
        fh.write(user_text("второй запрос ABC-1359", ts="2026-09-27T09:03:00.000Z"))
        fh.write(assistant_tool("Bash", {"command": "pytest -q"}, ts="2026-09-27T09:04:00.000Z"))
        fh.write(assistant_text("тесты зелёные", ts="2026-09-27T09:05:00.000Z"))
    stats = index.index_all(conn, root=str(atlas_env["projects"]))
    assert stats["tail"] == 1 and stats["full"] == 0

    fresh = _conn(tmp_path, "fresh.sqlite3")
    index.index_all(fresh, root=str(atlas_env["projects"]), full=True)
    assert _dump(conn) == _dump(fresh)
    # второй запрос — отдельный ход, первый дописан ответом
    turns = dict(conn.execute("SELECT turn, user_text FROM fts WHERE turn>0 ORDER BY turn"))
    assert turns == {1: "первый запрос про прокси", 2: "второй запрос ABC-1359"}
    assert search.search(conn, "1359") and search.search(conn, "зелёные", scope="all")


def test_unfinished_last_line_is_left_for_the_next_pass(atlas_env, write_session):
    path = write_session("p", [user_text("старт", ts="2026-09-27T09:00:00.000Z")], session_id="s")
    conn = _conn(atlas_env["home"])
    index.index_all(conn, root=str(atlas_env["projects"]))
    with open(path, "a") as fh:
        fh.write('{"type":"user","timestamp":"2026-09-27T09:01')     # запись ещё пишется
    index.index_all(conn, root=str(atlas_env["projects"]))
    with open(path, "a") as fh:
        fh.write(':00.000Z","message":{"role":"user","content":"продолжение"},'
                 '"cwd":"/Users/u/Code/demo","entrypoint":"cli"}\n')
    stats = index.index_all(conn, root=str(atlas_env["projects"]))
    assert stats["tail"] == 1
    assert search.search(conn, "продолжение")


def test_rewritten_file_is_indexed_from_scratch(atlas_env, write_session):
    path = write_session("p", [user_text("первая версия файла")], session_id="s")
    conn = _conn(atlas_env["home"])
    index.index_all(conn, root=str(atlas_env["projects"]))
    with open(path, "w") as fh:                           # тот же файл, другое начало
        fh.write(user_text("совсем другое содержимое") + user_text("и ещё строка"))
    stats = index.index_all(conn, root=str(atlas_env["projects"]))
    assert stats["full"] == 1 and stats["tail"] == 0
    assert not search.search(conn, "версия") and search.search(conn, "содержимое")


def test_subagent_change_goes_through_a_full_pass(atlas_env, write_session):
    path = write_session("p", [user_text("родитель")], session_id="parent")
    conn = _conn(atlas_env["home"])
    index.index_all(conn, root=str(atlas_env["projects"]))
    sub = os.path.join(os.path.dirname(path), "parent", "subagents")
    os.makedirs(sub)
    with open(os.path.join(sub, "agent-a.jsonl"), "w") as fh:
        fh.write(assistant_text("сабагент нашёл деплой"))
    stats = index.index_all(conn, root=str(atlas_env["projects"]))
    assert stats["full"] == 1
    assert search.search(conn, "деплой", scope="all")


def test_words_in_two_neighbouring_prompts_are_not_near(atlas_env, write_session):
    """Запросы в индексе больше не склеены: близость через границу сообщений не засчитывается."""
    write_session("p", [user_text("про другое"), user_text("открыли окно"),
                        user_text("новостей стало больше")], session_id="apart")
    write_session("p", [user_text("начнём"), user_text("сломалось окно новостей")],
                  session_id="together")
    conn = _conn(atlas_env["home"])
    index.index_all(conn, root=str(atlas_env["projects"]))
    order = [h["session_id"] for h in search.search(conn, "окно новостей", order="relevance")]
    assert order[0] == "together"
    near = search._sessions_matching(conn, 'NEAR("окно" "новост"*, 10)', ["apart", "together"])
    assert "apart" not in near and "together" in near


def test_column_weights_line_up_with_columns():
    """session_id — первая колонка: без нуля впереди веса съезжали на соседнюю колонку."""
    w = search._weights()
    assert w[0] == 0.0 and w[1] == search.COLUMN_WEIGHTS["title"]
    assert w[2] == search.COLUMN_WEIGHTS["user_text"] and w[-1] == 0.0
    assert len(w) == len(search.FTS_COLUMNS) + 2              # + session_id и turn


def test_compaction_summary_starts_its_own_turn(atlas_env, write_session):
    from atlas.parse import COMPACT_PREFIX
    write_session("p", [user_text("до компактации"),
                        rec(type="user", timestamp="2026-09-27T09:00:00.000Z", cwd="/Users/u/Code/demo",
                            entrypoint="cli", message={"role": "user",
                                                       "content": COMPACT_PREFIX + " сводка"}),
                        user_text("после компактации")], session_id="c")
    conn = _conn(atlas_env["home"])
    index.index_all(conn, root=str(atlas_env["projects"]))
    rows = list(conn.execute("SELECT turn, user_text, summaries FROM fts WHERE turn>0 ORDER BY turn"))
    assert [(r[1], bool(r[2])) for r in rows] == [("до компактации", False), ("", True),
                                                  ("после компактации", False)]


def test_reindex_flag_is_rechecked_under_the_lock(atlas_env, write_session, monkeypatch):
    """Сервер ждал лок, пока пересборку делал CLI, — и потом пересобирал всё второй раз."""
    write_session("p", [user_text("что-то")])
    conn = _conn(atlas_env["home"])
    index.index_all(conn, root=str(atlas_env["projects"]))
    db.set_meta(conn, "needs_reindex", "1")
    conn.commit()
    real_lock = index.writer_lock

    from contextlib import contextmanager

    @contextmanager
    def lock_after_someone_rebuilt():
        with real_lock():
            db.set_meta(conn, "needs_reindex", "0")      # другой процесс успел раньше
            conn.commit()
            yield
    monkeypatch.setattr(index, "writer_lock", lock_after_someone_rebuilt)
    stats = index.ensure_indexed(conn, root=str(atlas_env["projects"]))
    assert stats["indexed"] == 0
