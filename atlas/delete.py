"""Full session deletion: the agent's files on disk and everything the catalog knows about it.

Touches only standard Claude Code locations (the ~/.claude folder), Codex rollouts and input history
(the Codex home) and the catalog data folder. Codex's own databases (state_*.sqlite) are never
written. A running session is not deleted: its process would immediately write the transcript again.
"""
from __future__ import annotations

import contextlib
import glob
import json
import os
import shutil
import sqlite3
import tempfile

from . import active, agents, codex_procs, db, index, store
from .actions import valid_session_id
from .messages import msg

HISTORY = "history.jsonl"            # Claude Code input history (up arrow)
DB_TABLES = ("sources", "user_overrides", "enrichment", "classification", "jobs", "egress_grants",
             "conversions")


class DeleteError(RuntimeError):
    pass


def claude_home() -> str:
    return os.path.dirname(os.path.abspath(index.PROJECTS_ROOT))


def _size(path: str) -> int:
    if os.path.islink(path) or not os.path.isdir(path):
        try:
            return os.lstat(path).st_size
        except OSError:
            return 0
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            with contextlib.suppress(OSError):
                total += os.lstat(os.path.join(root, name)).st_size
    return total


def _files_in(path: str) -> int:
    if not os.path.isdir(path) or os.path.islink(path):
        return 1
    return sum(len(files) for _root, _dirs, files in os.walk(path))


def _history_lines(path: str, session_id: str) -> int:
    try:
        with open(path, encoding="utf-8") as fh:
            return sum(1 for line in fh if session_id in line and _line_sid(line) == session_id)
    except OSError:
        return 0


def _line_sid(line: str) -> str | None:
    """Claude Code writes `sessionId`, Codex `session_id`."""
    try:
        rec = json.loads(line)
    except ValueError:
        return None
    if not isinstance(rec, dict):
        return None
    return rec.get("sessionId") or rec.get("session_id")


def _handoffs(conn: sqlite3.Connection, session_id: str) -> list[str]:
    """Catalog handoffs are named by 8 id characters: take one only if no other session shares the prefix."""
    short = session_id[:8]
    others = conn.execute("SELECT COUNT(*) FROM sessions WHERE session_id LIKE ? AND session_id<>?",
                          (short + "%", session_id)).fetchone()[0]
    if others:
        return []
    folder = os.path.join(db.atlas_home(), "handoffs")
    names = glob.glob(os.path.join(glob.escape(folder), f"????-??-??-{short}.md"))
    names += glob.glob(os.path.join(glob.escape(folder), f"launch-{short}.md"))
    return sorted(names)


def _claude_paths(session_id: str) -> list[tuple[str, str]]:
    home = glob.escape(claude_home())
    sid = glob.escape(session_id)
    found = [("transcript", p) for p in glob.glob(os.path.join(home, "projects", "*", sid + ".jsonl"))]
    found += [("subagents", p) for p in glob.glob(os.path.join(home, "projects", "*", sid)) if os.path.isdir(p)]
    for kind, pattern in (("file_history", ("file-history", sid)), ("session_env", ("session-env", sid)),
                          ("tasks", ("tasks", sid)), ("todos", ("todos", sid + "-*.json"))):
        found += [(kind, p) for p in glob.glob(os.path.join(home, *pattern))]
    return found


def is_running(session_id: str, sessions_dir: str | None = None, table: dict | None = None) -> bool:
    table = active.process_table() if table is None else table
    for data in active._read_files(sessions_dir or active.SESSIONS_DIR):
        if str(data.get("sessionId")) == session_id and active._alive(
                data["pid"], data.get("procStart"), table):
            return True
    return False


def _is_codex(conn: sqlite3.Connection, session_id: str) -> bool:
    """By the catalog, or for a thread not indexed yet, by a rollout with that id."""
    agent = agents.session_agent(conn, session_id)
    if agent:
        return agent == agents.CODEX
    return bool(codex_procs.all_rollouts(session_id))


def footprint(conn: sqlite3.Connection, session_id: str) -> dict:
    """What will be deleted, for the confirmation dialog. Changes nothing."""
    if not valid_session_id(session_id):
        raise DeleteError(msg("session_id.invalid"))
    codex = _is_codex(conn, session_id)
    found = [("rollout", p) for p in codex_procs.all_rollouts(session_id)] if codex \
        else _claude_paths(session_id)
    items = [{"kind": kind, "path": p, "bytes": _size(p), "files": _files_in(p)} for kind, p in found]
    items += [{"kind": "handoff", "path": p, "bytes": _size(p), "files": 1}
              for p in _handoffs(conn, session_id)]
    row = conn.execute("SELECT title FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    home = index.codex_home() if codex else claude_home()
    return {
        "session_id": session_id,
        "agent": agents.CODEX if codex else agents.CLAUDE,
        "title": row["title"] if row else None,
        "items": items,
        "bytes": sum(i["bytes"] for i in items),
        "history_lines": _history_lines(os.path.join(home, HISTORY), session_id),
        "indexed": row is not None,
        "running": _codex_running(session_id) if codex else is_running(session_id),
        # Codex keeps its own thread list in a database that is never written here.
        "notes": [msg("delete.codex_app_note")] if codex else [],
    }


def _codex_running(session_id: str, table: dict | None = None) -> bool:
    return codex_procs.running(session_id, active.process_table() if table is None else table)


def _drop_history(path: str, session_id: str) -> int:
    """This session's lines from the input history. The file is rewritten whole and atomically."""
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return 0
    keep = [line for line in lines if not (session_id in line and _line_sid(line) == session_id)]
    removed = len(lines) - len(keep)
    if removed:
        mode = os.stat(path).st_mode & 0o777
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".history-")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.writelines(keep)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    return removed


def _remove(path: str) -> None:
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    elif os.path.lexists(path):
        os.remove(path)


def delete_session(conn: sqlite3.Connection, session_id: str) -> dict:
    plan = footprint(conn, session_id)
    if plan["running"]:
        raise DeleteError(msg("delete.running"))
    codex = plan["agent"] == agents.CODEX
    home = index.codex_home() if codex else claude_home()
    roots = (os.path.realpath(home), os.path.realpath(db.atlas_home()))
    for item in plan["items"]:
        # Only inside our own folders: the path comes from glob, but where it points is checked too.
        parent = os.path.realpath(os.path.dirname(item["path"]))
        if not any(parent == r or parent.startswith(r + os.sep) for r in roots):
            raise DeleteError(msg("delete.outside_codex" if codex else "delete.outside", path=item["path"]))
    for item in plan["items"]:
        _remove(item["path"])
    history = _drop_history(os.path.join(home, HISTORY), session_id)
    with index.writer_lock():            # the indexer cannot write the session back mid-deletion
        store.purge(conn, session_id)
        for table in DB_TABLES:
            conn.execute(f"DELETE FROM {table} WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM pending_launches WHERE new_session_id=? OR source_session_id=?",
                      (session_id, session_id))
        conn.commit()
    return {"session_id": session_id, "removed": len(plan["items"]), "bytes": plan["bytes"],
            "history_lines": history}
