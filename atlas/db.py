"""Schema and connection. Derived tables are recreated; authoritative ones never are."""
from __future__ import annotations

import os
import re
import sqlite3

SCHEMA_VERSION = 10

# Three tiers, and they must not be mixed up.
# 1) Edited by hand; cannot be restored from transcripts.
AUTHORITATIVE = ("user_overrides", "pending_launches", "egress_grants")

# 2) Restorable but expensive: every row was paid for with a model call. On a schema change,
# columns are added and the table is kept. Cleared only by an explicit purge-cache.
EXPENSIVE = ("enrichment", "classification")

# 3) Rebuilt from transcripts in seconds; dropped freely.
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

-- "Stats": a model reply or a human prompt. The key is message.id / the record uuid: copies
-- in resumed sessions collapse on it when counting (atlas/stats.py).
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

-- One row per session turn (turn ≥ 1), plus service rows: -2 title/tickets/paths, -1 subagents.
-- Keep the turn column last: highlight() picks the column by index.
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
  session_id UNINDEXED, title, user_text, assistant_text,
  commands, paths, tickets, summaries, subagent_text, turn UNINDEXED,
  prefix='2 3 4'
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_paths USING fts5(
  session_id UNINDEXED, blob, turn UNINDEXED, tokenize='trigram'
);

-- Parse state: the byte to resume reading from and what the tail was. Derived.
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

-- LLM layer cache. Derived: the key includes the extractor and prompt versions.
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

-- Classifier verdict. Derived: recomputed when the content or version changes.
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

-- Jobs: one active job per (session, content state, action).
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

-- AUTHORITATIVE. A new session is registered but not started yet: derived_from appears
-- once its transcript is actually found.
CREATE TABLE IF NOT EXISTS pending_launches (
  new_session_id    TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  handoff_path      TEXT,
  created_at        TEXT NOT NULL,
  confirmed_at      TEXT
);

-- AUTHORITATIVE. Permission to send data out: one operation, one specific content state.
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
    """ATLAS_HOME overrides the location; tests and relocation need it."""
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
    # Schema already in place: write nothing. Otherwise every connection (the server opens one
    # per request) waits for the background indexer to finish a large file's transaction.
    if _schema_is_current(conn):
        return conn
    conn.executescript(SCHEMA)
    # Only raise the version. Otherwise an old long-lived process (server under launchd)
    # rolls it back to its own, and the next start of the new version drops derived tables.
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
    return present >= _SCHEMA_OBJECTS


def _migrate(conn: sqlite3.Connection) -> None:
    """CREATE TABLE IF NOT EXISTS does not add columns to an existing table.
    Derived tables can simply be recreated; authoritative ones stay untouched."""
    conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
    if row is None:
        return                                   # fresh database: the script creates everything
    if int(row["value"]) >= SCHEMA_VERSION:
        return
    _add_missing_columns(conn)
    for table in DERIVED:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    # Dropping derived tables is not enough: something must rebuild them, or the UI stays empty.
    conn.execute("INSERT INTO meta(key, value) VALUES('needs_reindex', '1') "
                 "ON CONFLICT(key) DO UPDATE SET value='1'")
    conn.commit()


def drop_derived(conn: sqlite3.Connection) -> None:
    """rebuild touches only cheap data: manual edits and paid model calls stay."""
    for table in DERIVED:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    conn.executescript(SCHEMA)
    conn.execute("INSERT INTO meta(key, value) VALUES('needs_reindex','1') "
                 "ON CONFLICT(key) DO UPDATE SET value='1'")
    conn.commit()


def purge_cache(conn: sqlite3.Connection) -> dict:
    """Explicit purge of paid data: descriptions, handoffs and classification are built again."""
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
    """Authoritative tables are never recreated; columns are only added to them."""
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
