"""Схема и подключение. Производные таблицы пересоздаются, авторитетные — никогда."""
from __future__ import annotations

import os
import re
import sqlite3

SCHEMA_VERSION = 10

# Три уровня, и путать их нельзя.
# 1) Правится вручную и из транскриптов не восстанавливается.
AUTHORITATIVE = ("user_overrides", "pending_launches", "egress_grants")

# 2) Восстановимо, но дорого: за каждую строку заплачено вызовом модели. При смене схемы
# колонки дописываются, а таблица не сносится. Чистится только явным purge-cache.
EXPENSIVE = ("enrichment", "classification")

# 3) Пересобирается из транскриптов за секунды — сносится свободно.
DERIVED = (
    "sources", "sessions", "session_projects", "session_files",
    "session_links", "session_tickets", "session_domains", "fts", "fts_paths", "parse_state",
    "activity",
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS user_overrides (
  session_id   TEXT PRIMARY KEY,
  domain       TEXT,
  sensitivity  TEXT,
  work_outcome TEXT,
  project_id   TEXT,
  topic        TEXT,
  title        TEXT,
  note         TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  path           TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  inode          INTEGER,
  size           INTEGER,
  mtime          REAL,
  sig            TEXT,
  complete_bytes INTEGER,
  indexed_at     TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id       TEXT PRIMARY KEY,
  source_path      TEXT NOT NULL,
  title            TEXT,
  title_source     TEXT,
  session_kind     TEXT,
  workspace_kind   TEXT,
  started_at       TEXT,
  last_activity_at TEXT,
  human_turns      INTEGER DEFAULT 0,
  machine_turns    INTEGER DEFAULT 0,
  subagent_turns   INTEGER DEFAULT 0,
  cost_usd         REAL,
  lines_added      INTEGER,
  lines_removed    INTEGER,
  models           TEXT,
  entrypoint       TEXT,
  version          TEXT,
  cwd_last         TEXT,
  cwds             TEXT,
  branch_last      TEXT,
  last_prompt      TEXT,
  leaf_uuid        TEXT,
  sensitivity_rule TEXT,
  records          INTEGER,
  bad_lines        INTEGER,
  content_hash     TEXT
);

CREATE TABLE IF NOT EXISTS session_projects (
  session_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL,
  PRIMARY KEY (session_id, project_id)
);
CREATE TABLE IF NOT EXISTS session_domains (
  session_id TEXT NOT NULL, domain TEXT NOT NULL,
  PRIMARY KEY (session_id, domain)
);
CREATE TABLE IF NOT EXISTS session_tickets (
  session_id TEXT NOT NULL, ticket TEXT NOT NULL,
  PRIMARY KEY (session_id, ticket)
);
CREATE TABLE IF NOT EXISTS session_files (
  session_id TEXT NOT NULL, raw_path TEXT NOT NULL,
  resolved_path TEXT, project_id TEXT
);
CREATE TABLE IF NOT EXISTS session_links (
  session_id TEXT NOT NULL, kind TEXT NOT NULL, url TEXT, title TEXT
);

-- «Статистика»: ответ модели или запрос человека. Ключ — message.id / uuid записи: копии
-- в возобновлённых сессиях схлопываются по нему при подсчёте (atlas/stats.py).
CREATE TABLE IF NOT EXISTS activity (
  session_id  TEXT NOT NULL,
  key         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  ts          TEXT NOT NULL,
  active_s    REAL NOT NULL DEFAULT 0,
  model       TEXT,
  input       INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER,
  cost        REAL,
  sub         INTEGER NOT NULL DEFAULT 0,
  tools       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, key)
);
CREATE INDEX IF NOT EXISTS ix_activity_ts ON activity(ts);

CREATE INDEX IF NOT EXISTS ix_sessions_activity ON sessions(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS ix_projects_project  ON session_projects(project_id);
CREATE INDEX IF NOT EXISTS ix_files_session     ON session_files(session_id);
CREATE INDEX IF NOT EXISTS ix_tickets_ticket    ON session_tickets(ticket);

-- Строка — ход сессии (turn ≥ 1), плюс служебные: -2 заголовок/тикеты/пути, -1 сабагенты.
-- Колонку turn держать последней: highlight() берёт колонку по номеру.
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  session_id UNINDEXED, title, user_text, assistant_text,
  commands, paths, tickets, summaries, subagent_text, turn UNINDEXED,
  prefix='2 3 4'
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_paths USING fts5(
  session_id UNINDEXED, blob, turn UNINDEXED, tokenize='trigram'
);

-- Состояние разбора: с какого байта дочитывать и чем был хвост. Производное.
CREATE TABLE IF NOT EXISTS parse_state (
  session_id TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  inode      INTEGER NOT NULL,
  offset     INTEGER NOT NULL,
  tail_sig   TEXT NOT NULL,
  sub_sig    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  state      TEXT NOT NULL
);

-- Кэш LLM-слоя. Производный: ключ включает версии экстрактора и промпта.
CREATE TABLE IF NOT EXISTS enrichment (
  session_id        TEXT NOT NULL,
  artifact_kind     TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  extractor_version INTEGER NOT NULL,
  prompt_version    INTEGER NOT NULL,
  model             TEXT NOT NULL,
  backend           TEXT NOT NULL,
  payload           TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (session_id, artifact_kind)
);

-- Вердикт классификатора. Производный: пересчитывается при смене контента или версии.
CREATE TABLE IF NOT EXISTS classification (
  session_id         TEXT PRIMARY KEY,
  domain             TEXT,
  topic              TEXT,
  summary            TEXT,
  confidence         REAL,
  content_hash       TEXT NOT NULL,
  classifier_version INTEGER NOT NULL,
  model              TEXT,
  backend            TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_classification_topic ON classification(topic);

-- Джобы: один активный на (сессия, состояние контента, действие).
CREATE TABLE IF NOT EXISTS jobs (
  job_id       TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  action_kind  TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  state        TEXT NOT NULL,
  result       TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_active
  ON jobs(session_id, action_kind, content_hash)
  WHERE state IN ('queued', 'running');

-- АВТОРИТЕТНОЕ. Новая сессия заведена, но ещё не запускалась: derived_from появится,
-- когда её транскрипт реально обнаружится.
CREATE TABLE IF NOT EXISTS pending_launches (
  new_session_id    TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  handoff_path      TEXT,
  created_at        TEXT NOT NULL,
  confirmed_at      TEXT
);

-- АВТОРИТЕТНОЕ. Разрешение на отправку наружу: одна операция, конкретное состояние контента.
CREATE TABLE IF NOT EXISTS egress_grants (
  session_id    TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  backend       TEXT NOT NULL,
  model         TEXT NOT NULL,
  granted_at    TEXT NOT NULL,
  used_at       TEXT,
  PRIMARY KEY (session_id, content_hash, artifact_kind, backend, model)
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""


def atlas_home() -> str:
    """ATLAS_HOME переопределяет расположение — нужно тестам и переносу."""
    home = os.environ.get("ATLAS_HOME") or os.path.expanduser(
        "~/Library/Application Support/session-atlas"
    )
    os.makedirs(home, mode=0o700, exist_ok=True)
    return home


def db_path() -> str:
    return os.path.join(atlas_home(), "atlas.sqlite3")


def connect(path: str | None = None) -> sqlite3.Connection:
    path = path or db_path()
    os.makedirs(os.path.dirname(path) or ".", mode=0o700, exist_ok=True)
    fresh = not os.path.exists(path)
    conn = sqlite3.connect(path, timeout=30.0)
    if fresh:
        os.chmod(path, 0o600)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    _migrate(conn)
    # Схема уже на месте — ничего не пишем. Иначе каждое подключение (а сервер открывает его
    # на каждый запрос) ждёт, пока фоновый индексатор допишет транзакцию большого файла.
    if _schema_is_current(conn):
        return conn
    conn.executescript(SCHEMA)
    # Версию только повышаем. Старый долгоживущий процесс (сервер под launchd) иначе
    # откатит её на свою, а следующий запуск новой версии снесёт производные таблицы.
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value "
        "WHERE CAST(excluded.value AS INTEGER) > CAST(meta.value AS INTEGER)",
        (str(SCHEMA_VERSION),),
    )
    conn.commit()
    return conn


_SCHEMA_OBJECTS = set(re.findall(
    r"CREATE (?:VIRTUAL |UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS (\w+)", SCHEMA))


def _schema_is_current(conn: sqlite3.Connection) -> bool:
    row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    if row is None or int(row["value"]) < SCHEMA_VERSION:
        return False
    present = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
    return _SCHEMA_OBJECTS <= present


def _migrate(conn: sqlite3.Connection) -> None:
    """CREATE TABLE IF NOT EXISTS не добавляет колонки в уже существующую таблицу.
    Производное можно просто пересоздать — авторитетное при этом не трогается."""
    conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    if row is None:
        return                                   # свежая база: скрипт создаст всё сам
    if int(row["value"]) >= SCHEMA_VERSION:
        return
    _add_missing_columns(conn)
    for table in DERIVED:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    # Снести производное мало: кто-то должен его пересобрать, иначе интерфейс пустой.
    conn.execute("INSERT INTO meta(key, value) VALUES('needs_reindex', '1') "
                 "ON CONFLICT(key) DO UPDATE SET value='1'")
    conn.commit()


def drop_derived(conn: sqlite3.Connection) -> None:
    """rebuild трогает только дешёвое: ручные правки и оплаченные вызовы модели остаются."""
    for table in DERIVED:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.executescript(SCHEMA)
    conn.execute("INSERT INTO meta(key, value) VALUES('needs_reindex','1') "
                 "ON CONFLICT(key) DO UPDATE SET value='1'")
    conn.commit()


def purge_cache(conn: sqlite3.Connection) -> dict:
    """Явная чистка оплаченного: описания, хендоффы и классификация строятся заново."""
    counts = {}
    for table in EXPENSIVE:
        try:
            counts[table] = conn.execute(f"SELECT count(*) c FROM {table}").fetchone()["c"]
        except sqlite3.OperationalError:
            counts[table] = 0
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.executescript(SCHEMA)
    conn.commit()
    return counts


def _add_missing_columns(conn: sqlite3.Connection) -> None:
    """Авторитетные таблицы не пересоздаются — в них колонки только дописываются."""
    for table, column, decl in (("user_overrides", "topic", "TEXT"),
                                ("user_overrides", "title", "TEXT"),
                                ("classification", "topic", "TEXT"),
                                ("classification", "summary", "TEXT")):
        existing = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        if existing and column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
    conn.commit()


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
