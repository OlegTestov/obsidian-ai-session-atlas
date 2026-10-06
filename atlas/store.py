"""Writes a session to the index: in full or only the appended part.

A full-text index row is a turn (your prompt with its replies), not the whole session.
A live session grows constantly, and rewriting megabytes of its text on every pass costs
2–5 s, so only the last turn and the new ones are rewritten.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone

from . import actions, activity, codex_parse, resolve
from .parse import SessionFacts, facts_state, parse_file, parse_tail

META_TURN = -2        # title, tickets, paths from file history
SUBAGENT_TURN = -1    # subagent texts: change only together with their files
STATE_VERSION = 4     # bump on any parser change: old states get discarded
TAIL_SIG_BYTES = 4096


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def tail_sig(path: str, offset: int) -> str:
    """Signature of the bytes before the resume point: if the file is rewritten, it will not match."""
    with open(path, "rb") as fh:
        fh.seek(max(0, offset - TAIL_SIG_BYTES))
        return hashlib.sha1(fh.read(min(offset, TAIL_SIG_BYTES))).hexdigest()


def purge(conn: sqlite3.Connection, session_id: str, keep_text: bool = False) -> None:
    for table in ("sessions", "session_projects", "session_domains",
                  "session_tickets", "session_files", "session_links", "session_continuations"):
        conn.execute(f"DELETE FROM {table} WHERE session_id=?", (session_id,))
    if not keep_text:
        conn.execute("DELETE FROM fts WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM fts_paths WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM parse_state WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM activity WHERE session_id=?", (session_id,))


def _write_meta(conn, session_id: str, path: str, st, sig: str, facts: SessionFacts,
                resolved_files: list[tuple[str, str]]) -> str:
    """Everything except texts: small tables are easier to rewrite than to merge."""
    projects, workspace_kind = resolve.resolve_projects(facts.cwds, [r for _, r in resolved_files])
    domains = resolve.resolve_domains(facts.cwds, [r for _, r in resolved_files])
    sensitivity = resolve.resolve_sensitivity(facts.cwds, [r for _, r in resolved_files])
    kind = resolve.session_kind(facts.entrypoint, facts.human_turns, facts.spawned,
                                continued=bool(facts.continued_from and facts.last_activity_at))
    title, title_source = resolve.fallback_title(
        facts.title, [facts.first_user_text] if facts.first_user_text else [], facts.last_prompt,
        [facts.first_assistant_text] if facts.first_assistant_text else [], session_id)
    conn.execute(
        """INSERT INTO sessions (session_id, source_path, title, title_source, session_kind,
             workspace_kind, started_at, last_activity_at, human_turns, machine_turns,
             subagent_turns, cost_usd, lines_added, lines_removed, models, entrypoint,
             version, cwd_last, cwds, branch_last, last_prompt, leaf_uuid,
             sensitivity_rule, records, bad_lines, content_hash, agent, continued_from,
             continued_in)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (session_id, path, title, title_source, kind, workspace_kind,
         facts.started_at, facts.last_activity_at, facts.human_turns, facts.machine_turns,
         facts.subagent_turns, facts.cost_usd, facts.lines_added, facts.lines_removed,
         json.dumps(facts.models, ensure_ascii=False), facts.entrypoint, facts.version,
         facts.cwds[-1] if facts.cwds else None, json.dumps(facts.cwds, ensure_ascii=False),
         facts.branches[-1] if facts.branches else None,
         facts.last_prompt, facts.leaf_uuid, sensitivity, facts.records, facts.bad_lines,
         hashlib.sha256(sig.encode()).hexdigest()[:32], facts.agent, facts.continued_from,
         facts.continued_in),
    )
    conn.executemany("INSERT INTO session_continuations VALUES (?,?,?)",
                     [(session_id, child, at) for child, at in facts.continuations])
    conn.executemany("INSERT OR IGNORE INTO session_projects VALUES (?,?,?)",
                     [(session_id, pid, role) for pid, role in projects])
    conn.executemany("INSERT OR IGNORE INTO session_domains VALUES (?,?)",
                     [(session_id, d) for d in domains])
    conn.executemany("INSERT OR IGNORE INTO session_tickets VALUES (?,?)",
                     [(session_id, t) for t in sorted(facts.tickets)])
    conn.executemany("INSERT INTO session_files VALUES (?,?,?,?)",
                     [(session_id, raw, res, resolve.classify_path(res).project_id)
                      for raw, res in resolved_files])
    # frame-link is written on every artifact update: one session can have 64 rows
    # for one real link. Collapse by url and skip empty ones entirely.
    seen: dict[tuple[str, str], str] = {}
    for kind_, url, link_title in facts.links:
        if url:
            seen.setdefault((kind_, url), link_title or "")
    conn.executemany("INSERT INTO session_links VALUES (?,?,?,?)",
                     [(session_id, k, u, t) for (k, u), t in seen.items()])
    return title


def _insert_row(conn, session_id: str, turn: int, **cols) -> None:
    conn.execute(
        "INSERT INTO fts (session_id, title, user_text, assistant_text, commands, paths, "
        "tickets, summaries, subagent_text, turn) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (session_id, cols.get("title", ""), cols.get("user_text", ""),
         cols.get("assistant_text", ""), cols.get("commands", ""), cols.get("paths", ""),
         cols.get("tickets", ""), cols.get("summaries", ""), cols.get("subagent_text", ""), turn))


def _write_meta_row(conn, session_id: str, title: str, facts: SessionFacts,
                    resolved_files) -> None:
    conn.execute("DELETE FROM fts WHERE session_id=? AND turn=?", (session_id, META_TURN))
    conn.execute("DELETE FROM fts_paths WHERE session_id=? AND turn=?", (session_id, META_TURN))
    paths = "\n".join(dict.fromkeys(r for _, r in resolved_files))
    _insert_row(conn, session_id, META_TURN, title=title or "",
                tickets=" ".join(sorted(facts.tickets)), paths=paths)
    conn.execute("INSERT INTO fts_paths (session_id, blob, turn) VALUES (?,?,?)",
                 (session_id, paths, META_TURN))


def _write_turns(conn, session_id: str, facts: SessionFacts) -> None:
    """Turns from the first one in facts.turns: the previous last turn is rewritten, new ones are added."""
    first = facts.turn_base + 1
    conn.execute("DELETE FROM fts WHERE session_id=? AND turn>=?", (session_id, first))
    conn.execute("DELETE FROM fts_paths WHERE session_id=? AND turn>=?", (session_id, first))
    for k, turn in enumerate(facts.turns):
        number = first + k
        _insert_row(conn, session_id, number, **{name: "\n".join(turn[name]) for name in turn})
        blob = "\n".join(turn["paths"] + turn["commands"])
        if blob:
            conn.execute("INSERT INTO fts_paths (session_id, blob, turn) VALUES (?,?,?)",
                         (session_id, blob, number))


def _save_state(conn, session_id: str, path: str, st, sub_sig: str, facts: SessionFacts) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO parse_state VALUES (?,?,?,?,?,?,?,?)",
        (session_id, path, st.st_ino, facts.complete_bytes,
         tail_sig(path, facts.complete_bytes), sub_sig, STATE_VERSION,
         json.dumps(facts_state(facts), ensure_ascii=False)))


def _record_source(conn, path: str, session_id: str, st, sig: str, facts: SessionFacts) -> None:
    conn.execute(
        """INSERT INTO sources (path, session_id, inode, size, mtime, sig, complete_bytes, indexed_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(path) DO UPDATE SET session_id=excluded.session_id, inode=excluded.inode,
             size=excluded.size, mtime=excluded.mtime, sig=excluded.sig,
             complete_bytes=excluded.complete_bytes, indexed_at=excluded.indexed_at""",
        (path, session_id, st.st_ino, st.st_size, st.st_mtime, sig, facts.complete_bytes, _now()))


def _resolved(facts: SessionFacts) -> list[tuple[str, str]]:
    return [(raw, resolve.normalize(raw, facts.cwds[-1] if facts.cwds else None))
            for raw in facts.raw_files]


def continuation_of(conn, session_id: str) -> tuple[str | None, str | None]:
    """(parent, hand-over time) if this transcript is a parked conversation's background job, or
    (source, conversion time) if "Resume with…" copied it from another agent's session."""
    row = conn.execute("SELECT source_session_id AS session_id, at FROM conversions WHERE session_id=?",
                       (session_id,)).fetchone() or \
        conn.execute("SELECT session_id, at FROM session_continuations WHERE child_id=? "
                     "ORDER BY at DESC LIMIT 1", (session_id,)).fetchone()
    return (row["session_id"], row["at"]) if row else (None, None)


def _converted(conn, session_id: str, facts: SessionFacts) -> None:
    """A converted session nobody has typed in yet holds only copies: it dates from the conversion
    and, until its agent names it, carries the source's title."""
    row = conn.execute(
        "SELECT COALESCE(u.title, s.title) AS title FROM conversions c "
        "LEFT JOIN sessions s ON s.session_id = c.source_session_id "
        "LEFT JOIN user_overrides u ON u.session_id = c.source_session_id "
        "WHERE c.session_id=?", (session_id,)).fetchone()
    if row is None:
        return
    if facts.last_activity_at is None and facts.copied_until:
        facts.started_at = facts.last_activity_at = facts.copied_until
    if not facts.title and row["title"]:
        facts.title, facts.title_source = row["title"], "converted"


def store_full(conn, path: str, st, sig: str, subagents: list[str], sub_sig: str) -> str:
    session_id = os.path.splitext(os.path.basename(path))[0]
    parent, handed_over = continuation_of(conn, session_id)
    facts = parse_file(path, session_id, continued_from=parent, copied_until=handed_over)
    _converted(conn, session_id, facts)
    sub_commands: list[str] = []
    sub_paths: list[str] = []
    sub_rows: dict = {}
    # Subagents are part of the parent session: their commands, files and text are merged here.
    for sub_path in subagents:
        sub = parse_file(sub_path, session_id)
        facts.subagent_turns += sub.machine_turns + sub.subagent_turns
        facts.subagent_text.extend(sub.assistant_text + sub.subagent_text + sub.user_text)
        sub_commands.extend(sub.commands)
        sub_paths.extend(sub.paths)
        facts.raw_files.extend(p for p in sub.raw_files if p not in facts.raw_files)
        facts.tickets |= sub.tickets
        sub_rows.update(sub.activity)
    resolved = _resolved(facts)
    purge(conn, session_id)
    activity.store(conn, session_id, facts.activity)
    activity.store(conn, session_id, sub_rows, sub=True)
    title = _write_meta(conn, session_id, path, st, sig, facts, resolved)
    _write_meta_row(conn, session_id, title, facts, resolved)
    if facts.subagent_text or sub_commands or sub_paths:
        _insert_row(conn, session_id, SUBAGENT_TURN, subagent_text="\n".join(facts.subagent_text),
                    commands="\n".join(sub_commands), paths="\n".join(sub_paths))
        if sub_commands or sub_paths:
            conn.execute("INSERT INTO fts_paths (session_id, blob, turn) VALUES (?,?,?)",
                         (session_id, "\n".join(sub_paths + sub_commands), SUBAGENT_TURN))
    _write_turns(conn, session_id, facts)
    _save_state(conn, session_id, path, st, sub_sig, facts)
    _record_source(conn, path, session_id, st, sig, facts)
    return session_id


def store_codex(conn, path: str, st, sig: str, title: str | None = None) -> str:
    """A Codex rollout is reread in full on any change: the largest is ~25 MB, a pass is ~0.2 s."""
    parent, converted_at = continuation_of(conn, codex_parse.session_id_of(path) or "")
    facts = codex_parse.parse_file(path, title=title, continued_from=parent, copied_until=converted_at)
    session_id = facts.session_id
    _converted(conn, session_id, facts)
    if not session_id:
        raise ValueError("no thread id in the rollout name or its session_meta")
    resolved = _resolved(facts)
    purge(conn, session_id)
    activity.store(conn, session_id, facts.activity)
    title = _write_meta(conn, session_id, path, st, sig, facts, resolved)
    _write_meta_row(conn, session_id, title, facts, resolved)
    _write_turns(conn, session_id, facts)
    _record_source(conn, path, session_id, st, sig, facts)
    # "New from this one" for Codex: the thread's id is known only now (atlas/actions.py).
    actions.link_codex_launch(conn, session_id, facts.first_user_text)
    return session_id


def store_tail(conn, path: str, st, sig: str, sub_sig: str) -> bool:
    """Reads the appended part. False means resuming is impossible and a full pass is needed."""
    session_id = os.path.splitext(os.path.basename(path))[0]
    row = conn.execute("SELECT * FROM parse_state WHERE session_id=?", (session_id,)).fetchone()
    if row is None or row["version"] != STATE_VERSION or row["path"] != path \
            or row["inode"] != st.st_ino or row["offset"] > st.st_size \
            or row["sub_sig"] != sub_sig or tail_sig(path, row["offset"]) != row["tail_sig"]:
        return False
    facts = parse_tail(path, json.loads(row["state"]))
    facts.session_id, facts.source_path = session_id, path
    if facts.subagent_text:
        return False          # a subagent wrote to the main file: its row must be rebuilt
    resolved = _resolved(facts)
    purge(conn, session_id, keep_text=True)
    activity.store(conn, session_id, facts.activity)
    title = _write_meta(conn, session_id, path, st, sig, facts, resolved)
    _write_meta_row(conn, session_id, title, facts, resolved)
    _write_turns(conn, session_id, facts)
    _save_state(conn, session_id, path, st, sub_sig, facts)
    _record_source(conn, path, session_id, st, sig, facts)
    return True
