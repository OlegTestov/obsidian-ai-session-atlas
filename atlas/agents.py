"""Which agent wrote a session (Claude Code or Codex) and reading it with the right parser."""
from __future__ import annotations

import sqlite3

from . import codex_parse, parse
from .parse import SessionFacts

CLAUDE, CODEX = "claude", "codex"
ALL = (CLAUDE, CODEX)


def parse_filter(values) -> list[str] | None:
    """`agent=claude,codex` (a comma list, possibly repeated). Unknown values are ignored;
    None means no filter: nothing known was asked for, or every agent was."""
    picked: list[str] = []
    for value in values or []:
        for part in str(value).split(","):
            part = part.strip().lower()
            if part in ALL and part not in picked:
                picked.append(part)
    return picked if picked and len(picked) < len(ALL) else None


def session_agent(conn: sqlite3.Connection, session_id: str) -> str | None:
    row = conn.execute("SELECT agent FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    return row["agent"] if row else None


def parse_session(path: str, session_id: str, agent: str | None) -> SessionFacts:
    if agent == CODEX:
        return codex_parse.parse_file(path, session_id)
    return parse.parse_file(path, session_id)
