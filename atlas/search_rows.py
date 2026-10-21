"""Address FTS mutations by rowid so a session update never scans unrelated messages."""
from __future__ import annotations

import sqlite3


def track(conn: sqlite3.Connection, table: str, row_id: int, session_id: str, turn: int) -> None:
    conn.execute("INSERT OR REPLACE INTO fts_rows VALUES (?,?,?,?)", (table, row_id, session_id, turn))


def delete(conn: sqlite3.Connection, session_id: str, *, turn: int | None = None,
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
