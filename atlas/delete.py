"""Полное удаление сессии: файлы Claude Code на диске и всё, что о ней знает каталог.

Трогаем только стандартные места Claude Code (папка ~/.claude) и папку данных каталога.
Запущенную сессию не удаляем: процесс тут же записал бы транскрипт заново.
"""
from __future__ import annotations

import glob
import json
import os
import shutil
import sqlite3
import tempfile

from . import active, db, index, store
from .actions import valid_session_id
from .messages import msg

HISTORY = "history.jsonl"            # история ввода Claude Code (стрелка вверх)
DB_TABLES = ("sources", "user_overrides", "enrichment", "classification", "jobs", "egress_grants")


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
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
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
    try:
        rec = json.loads(line)
    except ValueError:
        return None
    return rec.get("sessionId") if isinstance(rec, dict) else None


def _handoffs(conn: sqlite3.Connection, session_id: str) -> list[str]:
    """Хендоффы каталога названы по 8 знакам id: берём, только если префикс ни у кого больше нет."""
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


def footprint(conn: sqlite3.Connection, session_id: str) -> dict:
    """Что будет удалено — для окна подтверждения. Ничего не меняет."""
    if not valid_session_id(session_id):
        raise DeleteError(msg("session_id.invalid"))
    items = [{"kind": kind, "path": p, "bytes": _size(p), "files": _files_in(p)}
             for kind, p in _claude_paths(session_id)]
    items += [{"kind": "handoff", "path": p, "bytes": _size(p), "files": 1}
              for p in _handoffs(conn, session_id)]
    row = conn.execute("SELECT title FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    return {
        "session_id": session_id,
        "title": row["title"] if row else None,
        "items": items,
        "bytes": sum(i["bytes"] for i in items),
        "history_lines": _history_lines(os.path.join(claude_home(), HISTORY), session_id),
        "indexed": row is not None,
        "running": is_running(session_id),
    }


def _drop_history(path: str, session_id: str) -> int:
    """Строки этой сессии из истории ввода. Файл переписывается целиком и атомарно."""
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
    roots = (os.path.realpath(claude_home()), os.path.realpath(db.atlas_home()))
    for item in plan["items"]:
        # Только внутри своих папок: путь из glob, но проверяем и то, куда он ведёт.
        parent = os.path.realpath(os.path.dirname(item["path"]))
        if not any(parent == r or parent.startswith(r + os.sep) for r in roots):
            raise DeleteError(msg("delete.outside", path=item["path"]))
    for item in plan["items"]:
        _remove(item["path"])
    history = _drop_history(os.path.join(claude_home(), HISTORY), session_id)
    with index.writer_lock():            # индексатор не допишет сессию обратно посреди удаления
        store.purge(conn, session_id)
        for table in DB_TABLES:
            conn.execute(f"DELETE FROM {table} WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM pending_launches WHERE new_session_id=? OR source_session_id=?",
                      (session_id, session_id))
        conn.commit()
    return {"session_id": session_id, "removed": len(plan["items"]), "bytes": plan["bytes"],
            "history_lines": history}
