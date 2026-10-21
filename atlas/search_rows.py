"""Address FTS mutations by rowid so a session update never scans unrelated messages."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS fts_rows (
  index_name TEXT NOT NULL, row_id INTEGER NOT NULL,
  session_id TEXT NOT NULL, turn INTEGER NOT NULL,
  PRIMARY KEY (index_name, row_id)
);
CREATE INDEX IF NOT EXISTS ix_fts_rows_session ON fts_rows(session_id, turn, index_name, row_id);
CREATE TABLE IF NOT EXISTS fts_guard (
  id INTEGER PRIMARY KEY CHECK(id=1), managed INTEGER NOT NULL DEFAULT 0,
  dirty INTEGER NOT NULL DEFAULT 0, recovery INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO fts_guard(id) VALUES(1);
"""
TRIGGERS = {}
for _table in ("sessions", "sources"):
    for _event in ("INSERT", "UPDATE", "DELETE"):
        _name = f"fts_guard_{_table}_{_event.lower()}"
        TRIGGERS[_name] = f"""CREATE TRIGGER IF NOT EXISTS {_name} AFTER {_event} ON {_table}
WHEN (SELECT managed FROM fts_guard WHERE id=1)=0
BEGIN UPDATE fts_guard SET dirty=1 WHERE id=1; END;
"""
SCHEMA += "\n".join(TRIGGERS.values())
OBJECTS = {"fts_rows", "ix_fts_rows_session", "fts_guard", *TRIGGERS}


def ready(conn: sqlite3.Connection) -> bool:
    present = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE name LIKE 'fts_%' OR name='ix_fts_rows_session'")}
    return present >= OBJECTS


def pending(conn: sqlite3.Connection) -> bool:
    """Read-only: even an unchanged transcript pass must notice an old writer or rebuild."""
    return not ready(conn) or bool(conn.execute(
        "SELECT dirty OR recovery FROM fts_guard WHERE id=1").fetchone()[0])


def backfill(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM fts_rows")
    for table in ("fts", "fts_paths"):
        conn.execute("INSERT OR REPLACE INTO fts_rows "
                     f"SELECT ?, rowid, session_id, turn FROM {table}", (table,))


def repair(conn: sqlite3.Connection) -> None:
    """Only a legacy write/migration scans FTS. Never trust the old mapping to repair itself."""
    backfill(conn)
    for table in ("fts", "fts_paths"):
        conn.execute(f"DELETE FROM {table} WHERE rowid IN "
                     "(SELECT row_id FROM fts_rows WHERE index_name=? AND session_id NOT IN "
                     "(SELECT session_id FROM sessions))", (table,))
    conn.execute("DELETE FROM fts_rows WHERE session_id NOT IN (SELECT session_id FROM sessions)")
    conn.execute("UPDATE fts_guard SET dirty=0, recovery=1, generation=generation+1 WHERE id=1")
    conn.execute("INSERT OR REPLACE INTO meta VALUES ('needs_reindex','1')")


@contextmanager
def writing(conn: sqlite3.Connection):
    """The marker is visible only inside our transaction; old writers always invalidate it.

    Check after taking SQLite's writer lock, including on long-lived connections. A savepoint
    restores the marker and the operation together on error, without committing the caller.
    """
    if conn.in_transaction and conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name='fts_guard'").fetchone():
        row = conn.execute("SELECT managed FROM fts_guard WHERE id=1").fetchone()
        if row and row[0]:
            yield
            return
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    else:
        conn.execute("UPDATE meta SET value=value WHERE key='schema_version'")
    conn.execute("SAVEPOINT atlas_fts_write")
    try:
        if not ready(conn):
            run_schema(conn, SCHEMA)
            repair(conn)
        elif conn.execute("SELECT dirty FROM fts_guard WHERE id=1").fetchone()[0]:
            repair(conn)
        conn.execute("UPDATE fts_guard SET managed=1 WHERE id=1")
        yield
        conn.execute("UPDATE fts_guard SET managed=0 WHERE id=1")
        conn.execute("RELEASE atlas_fts_write")
    except BaseException:
        # SQLITE_INTERRUPT can already have rolled back the entire transaction and its savepoints.
        if conn.in_transaction:
            conn.execute("ROLLBACK TO atlas_fts_write")
            conn.execute("RELEASE atlas_fts_write")
        raise


def run_schema(conn: sqlite3.Connection, script: str) -> None:
    """executescript implicitly commits, so execute complete statements in the caller's transaction."""
    statement = ""
    for line in script.splitlines(keepends=True):
        statement += line
        if sqlite3.complete_statement(statement):
            conn.execute(statement)
            statement = ""
    if statement.strip():
        conn.execute(statement)


def track(conn: sqlite3.Connection, table: str, row_id: int, session_id: str, turn: int) -> None:
    conn.execute("INSERT OR REPLACE INTO fts_rows VALUES (?,?,?,?)", (table, row_id, session_id, turn))


def delete(conn: sqlite3.Connection, session_id: str, *, turn: int | None = None,
           first: int | None = None) -> None:
    with writing(conn):
        _delete(conn, session_id, turn=turn, first=first)


def _delete(conn: sqlite3.Connection, session_id: str, *, turn: int | None = None,
            first: int | None = None) -> None:
    where, args = "session_id=?", [session_id]
    if turn is not None:
        where += " AND turn=?"
        args.append(turn)
    if first is not None:
        where += " AND turn>=?"
        args.append(first)
    for table in ("fts", "fts_paths"):
        conn.execute(f"DELETE FROM {table} WHERE rowid IN "
                     f"(SELECT row_id FROM fts_rows WHERE {where} AND index_name=?)", [*args, table])
    conn.execute(f"DELETE FROM fts_rows WHERE {where}", args)
