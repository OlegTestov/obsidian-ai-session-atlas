"""Перенос сессии из iTerm/VS Code во вкладку Obsidian.

`--resume` рядом с живым процессом дал бы два процесса над одним транскриптом. Поэтому
сначала процесс завершается: SIGTERM — Claude Code выходит штатно, как по Ctrl+C, и
транскрипт остаётся целым, — и только потом сессия открывается заново уже в Obsidian.
"""
from __future__ import annotations

import json
import os
import re
import signal
import time

from . import active
from .messages import msg

EXIT_WAIT_SECONDS = 8.0
_APP = re.compile(r"/([^/]+)\.app/")


def _command(table: dict, pid: int) -> str:
    entry = table.get(pid) or ()
    return entry[2] if len(entry) > 2 else ""


def host_app(pid: int, table: dict) -> str | None:
    """Приложение, в котором запущена сессия: самое верхнее `.app` в цепочке родителей.

    Ближние бывают служебными — прокси PTY плагина Terminal живёт в Python.app.
    """
    found = None
    for ancestor in active.ancestors(pid, table):
        m = _APP.search(_command(table, ancestor))
        if m:
            found = m.group(1)
    return found


class RelocateError(ValueError):
    """Объяснение уходит пользователю как есть."""


def _state(pid: int, sessions_dir: str) -> dict | None:
    try:
        with open(os.path.join(sessions_dir, f"{pid}.json"), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _gone(pid: int, proc_start: str | None, table_fn) -> bool:
    """Завершился — нет в таблице или зомби (`<defunct>`: родитель ещё не забрал код выхода)."""
    table = table_fn()
    return not active._alive(pid, proc_start, table) \
        or _command(table, pid).strip() == "<defunct>"


def stop_for_move(session_id: str, pid, *, sessions_dir: str | None = None, table_fn=None,
                  wait: float = EXIT_WAIT_SECONDS, sleep=time.sleep) -> dict:
    """Проверить, что PID — именно эта живая сессия вне Obsidian, и завершить её."""
    sessions_dir = sessions_dir or active.SESSIONS_DIR
    table_fn = table_fn or active.process_table
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        raise RelocateError(msg("relocate.bad_pid"))
    data = _state(pid, sessions_dir)
    if not data or data.get("sessionId") != session_id or not active.is_interactive(data):
        raise RelocateError(msg("relocate.foreign_pid"))
    table = table_fn()
    if not active._alive(pid, data.get("procStart"), table):
        raise RelocateError(msg("relocate.ended"))
    app = host_app(pid, table)
    if app == "Obsidian":
        raise RelocateError(msg("relocate.in_obsidian"))
    os.kill(pid, signal.SIGTERM)
    waited = 0.0
    while waited < wait:
        sleep(0.25)
        waited += 0.25
        if _gone(pid, data.get("procStart"), table_fn):
            return {"stopped": True, "host_app": app, "waited": round(waited, 2)}
    raise RelocateError(msg("relocate.not_stopped", app=app or msg("relocate.terminal")))
