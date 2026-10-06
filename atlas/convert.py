""""Resume with…": continue a session in the other agent.

The source transcript is only read. A new native session of the target agent is written from it
(atlas/convert_write.py) with a fresh id and opened with that agent's ordinary resume. The link is
kept in `conversions` (authoritative: a transcript cannot tell it was copied), and the index skips
the copied records up to `at`, as it does for a parked conversation's job: nothing is counted twice.
"""
from __future__ import annotations

import os
import sqlite3
import uuid
from datetime import datetime, timezone

from . import actions, agents, convert_read, convert_write, index, search
from .convert_write import ConvertError
from .messages import msg

__all__ = ["ConvertError", "plan", "resume_with"]


def _source(conn: sqlite3.Connection, session_id: str, target: str) -> dict:
    if target not in agents.ALL:
        raise ConvertError(msg("launch.bad_agent"))
    row = conn.execute("SELECT agent, source_path FROM sessions WHERE session_id=?",
                       (session_id,)).fetchone()
    if row is None:
        raise ConvertError(msg("server.no_such_session"))
    cwd = actions.resume_cwd(conn, session_id)
    if not cwd:
        raise ConvertError(msg("server.no_workdir"))
    meta = search.load_session(conn, session_id) or {}
    return {"agent": row["agent"], "path": row["source_path"], "cwd": cwd, "title": meta.get("title")}


def _messages(src: dict, session_id: str, target: str):
    try:
        conv = convert_read.read(src["path"], session_id, src["agent"])
    except FileNotFoundError:
        raise ConvertError(msg("convert.no_transcript")) from None
    if not conv.items and not conv.summary:
        raise ConvertError(msg("convert.empty"))
    conv.cwd = src["cwd"]
    return convert_write.turns(conv)


def plan(conn: sqlite3.Connection, session_id: str, target: str) -> dict:
    """What "Resume with…" would do, without writing anything: for the confirmation dialog."""
    src = _source(conn, session_id, target)
    if src["agent"] == target:
        return {"agent": target, "same_agent": True, "cwd": src["cwd"]}
    messages, omitted = _messages(src, session_id, target)
    return {"agent": target, "same_agent": False, "cwd": src["cwd"], "messages": len(messages),
            "chars": sum(len(text) for _, text, _ in messages), "omitted": omitted,
            "folder": _target_dir(target, os.path.realpath(src["cwd"]))}


def _target_dir(target: str, cwd: str) -> str:
    if target == agents.CLAUDE:
        try:
            return convert_write.claude_folder(index.PROJECTS_ROOT, cwd)
        except ConvertError:
            raise ConvertError(msg("convert.long_folder")) from None
    return os.path.join(index.codex_home(), "sessions")


def resume_with(conn: sqlite3.Connection, session_id: str, target: str) -> dict:
    """Writes the new session and returns how to open it. The own agent is an ordinary resume."""
    src = _source(conn, session_id, target)
    if src["agent"] == target:
        return {"agent": target, "session_id": session_id, "cwd": src["cwd"], "converted": False,
                "command": actions.session_resume_command(conn, src["cwd"], session_id, target)[0]}
    messages, omitted = _messages(src, session_id, target)
    # Claude Code files a session under its physical working folder (getcwd resolves links).
    cwd = os.path.realpath(src["cwd"])
    at = datetime.now(timezone.utc)
    stamp = convert_write.iso(at)
    if target == agents.CLAUDE:
        new_id = str(uuid.uuid4())
        path = os.path.join(_target_dir(target, cwd), new_id + ".jsonl")
        records = convert_write.claude_records(messages, new_id, cwd, src["title"], at)
    else:
        new_id = convert_write.uuid7()
        path = convert_write.codex_path(index.codex_home(), new_id, at)
        records = convert_write.codex_records(messages, new_id, cwd, at,
                                              convert_write.codex_provider(index.codex_home()))
    # The link goes first: an index pass between the two writes must already skip the copies.
    conn.execute("INSERT INTO conversions (session_id, source_session_id, source_agent, agent, path, at) "
                 "VALUES (?,?,?,?,?,?)", (new_id, session_id, src["agent"], target, path, stamp))
    conn.commit()
    try:
        convert_write.write_new(path, records)
    except OSError:
        conn.execute("DELETE FROM conversions WHERE session_id=?", (new_id,))
        conn.commit()
        raise
    return {"agent": target, "session_id": new_id, "cwd": cwd, "converted": True, "path": path,
            "source_session_id": session_id, "omitted": omitted, "messages": len(messages),
            "title": src["title"], "command": actions.resume_command(cwd, new_id, agent=target)}

