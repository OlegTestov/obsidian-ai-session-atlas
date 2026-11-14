"""What a live Codex card shows besides its rollout: the /goal, queued messages, background commands.

codex-cli keeps a thread's goal in `goals_1.sqlite` (thread_goals) and messages a client queued while a
turn runs in `queue_1.sqlite` (queued_items), next to its rollouts (checked on 0.167). Both are read
only, with a short timeout: Codex writes them. The terminal UI keeps its own queue on the screen, so
for a tab the plugin reads it there. A background command is a child process of `codex` that is
neither one of its MCP servers nor its own helper.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from . import index

GOALS_DB = "goals_1.sqlite"
QUEUE_DB = "queue_1.sqlite"
SHOWN_GOAL = "active"              # a paused, blocked or finished goal wakes nothing
TEXT_CHARS = 400                   # as Claude Code's queue (atlas/prompt_queue.py)
_SECTION = re.compile(r"^\s*\[mcp_servers\.([^\]]+)\]\s*$")
_KEY = re.compile(r'^\s*(command|args)\s*=\s*(.+?)\s*$')
_mcp_cache: dict[str, tuple] = {}  # config path → (mtime, [tokens per server])


def _connect(home: str, name: str) -> sqlite3.Connection | None:
    path = os.path.join(home, name)
    if not os.path.isfile(path):
        return None
    try:
        return sqlite3.connect(Path(path).as_uri() + "?mode=ro", uri=True, timeout=0.5)
    except sqlite3.Error:
        return None


def _select(home: str, name: str, sql: str, ids: list[str]) -> list[tuple]:
    if not ids:
        return []
    conn = _connect(home, name)
    if conn is None:
        return []
    try:
        return conn.execute(sql.format(marks=",".join("?" * len(ids))), ids).fetchall()
    except sqlite3.Error:                  # another schema, a lock held too long: no goal, no queue
        return []
    finally:
        conn.close()


def goals(thread_ids: list[str], home: str | None = None) -> dict[str, str]:
    """thread id → objective of its active goal."""
    rows = _select(home or index.codex_home(), GOALS_DB,
                   "SELECT thread_id, objective, status FROM thread_goals WHERE thread_id IN ({marks})",
                   list(thread_ids))
    return {str(t).lower(): str(o) for t, o, status in rows if status == SHOWN_GOAL and o}


def _iso_ms(ms) -> str | None:
    try:
        when = datetime.fromtimestamp(int(ms) / 1000, timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None
    return when.strftime("%Y-%m-%dT%H:%M:%S.") + f"{when.microsecond // 1000:03d}Z"


def _queued_text(payload: str) -> str:
    """{"UserInput": {"content": [{"type": "text", "text": …}, …]}}: the text parts, joined."""
    try:
        data = json.loads(payload)
    except (TypeError, ValueError):
        return ""
    entry = data.get("UserInput") if isinstance(data, dict) else None
    parts = entry.get("content") if isinstance(entry, dict) else None
    texts = [p["text"] for p in parts or [] if isinstance(p, dict) and p.get("type") == "text"
             and isinstance(p.get("text"), str)]
    return "\n".join(texts).strip()


def queued(thread_ids: list[str], home: str | None = None) -> dict[str, list[dict]]:
    """thread id → [{text, at}] in the order Codex sends them, as Claude Code's queue."""
    rows = _select(home or index.codex_home(), QUEUE_DB,
                   "SELECT thread_id, payload_json, created_at_ms FROM queued_items "
                   "WHERE thread_id IN ({marks}) ORDER BY thread_id, queue_order", list(thread_ids))
    out: dict[str, list[dict]] = {}
    for tid, payload, created in rows:
        text = _queued_text(payload)
        if text:
            out.setdefault(str(tid).lower(), []).append({"text": text[:TEXT_CHARS], "at": _iso_ms(created)})
    return out


def _uncommented(text: str) -> str:
    """The text before a `#` that is not inside a quoted string, stripped."""
    quote = None
    for i, ch in enumerate(text):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "#":
            return text[:i].strip()
    return text.strip()


def _value(raw: str):
    try:
        return json.loads(raw)             # TOML strings and arrays of strings read as JSON
    except ValueError:
        pass
    if raw.startswith("[") and '"' not in raw:
        try:
            return json.loads(raw.replace("'", '"'))      # literal strings: ['-y', 'pkg']
        except ValueError:
            pass
    return raw.strip("'\"")


def mcp_servers(home: str | None = None) -> list[list[str]]:
    """Per MCP server in config.toml: the words that name its process (the command, its arguments)."""
    path = os.path.join(home or index.codex_home(), "config.toml")
    try:
        mtime = os.stat(path).st_mtime_ns
    except OSError:
        return []
    cached = _mcp_cache.get(path)
    if cached and cached[0] == mtime:
        return cached[1]
    servers: dict[str, dict] = {}
    current = None
    try:
        lines = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    pending = None                         # a multi-line array: (server, key, text so far)
    for line in lines:
        if pending:
            server, name, text = pending
            text += " " + _uncommented(line)
            if text.rstrip().endswith("]"):
                server[name] = _value(text.replace("[ ", "[").replace(", ]", "]").replace(",]", "]"))
                pending = None
            else:
                pending = (server, name, text)
            continue
        section = _SECTION.match(line)
        if section:
            current = servers.setdefault(section.group(1).split(".")[0], {})
            continue
        if line.lstrip().startswith("["):
            current = None
        elif current is not None:
            key = _KEY.match(line)
            value = _uncommented(key.group(2)) if key else ""
            if key and value.startswith("[") and not value.endswith("]"):
                pending = (current, key.group(1), value)
            elif key:
                current[key.group(1)] = _value(value)
    out = []
    for server in servers.values():
        command = os.path.basename(str(server.get("command") or ""))
        args = server.get("args")
        words = [w for a in args for w in str(a).split()] if isinstance(args, list) else []
        if command:
            out.append([command, *words])
    _mcp_cache[path] = (mtime, out)
    return out


def _plain(words: list[str]) -> list[str]:
    return [w for w in words if not w.startswith("-")]


# How a configured command shows in `ps`: npx runs as `npm exec`, uvx as `uv tool uvx`, and python3
# as the interpreter the framework build starts (`.../Python.app/Contents/MacOS/Python`).
RUNS_AS = {"npx": (("npm", "exec"),), "uvx": (("uv", "tool", "uvx"), ("uv", "tool", "run"))}


def _head_runs(head: list[str], name: str) -> bool:
    if head == [name] or (len(head) == 2 and head[1] == name):      # the command, or an interpreter running it
        return True
    if tuple(head) in RUNS_AS.get(name, ()):
        return True
    return name.lower().startswith("python") and len(head) == 1 and head[0].lower().startswith("python")


def _is_server(command: str, servers: list[list[str]]) -> bool:
    """The process runs one of the MCP servers: its words end with the server's arguments, exactly and in
    order, after a head that runs the server's command (RUNS_AS). One shared word is never enough."""
    argv = _plain(command.split())
    for name, *args in servers:
        args = _plain(args)
        if args and argv[-len(args):] != args:
            continue
        if _head_runs([os.path.basename(w) for w in argv[:len(argv) - len(args)]], name):
            return True
    return False


def background_commands(pid: int, table: dict, home: str | None = None) -> int:
    """Commands Codex left running (its "background terminals"): children of the codex process."""
    home = home or index.codex_home()
    servers = mcp_servers(home)
    homes = {home, os.path.realpath(home)}
    count = 0
    for row in table.values():
        if row[0] != pid or len(row) < 3 or not row[2]:
            continue
        command = row[2]
        first = os.path.basename(command.split()[0])
        if first.startswith("codex") or any(h in command for h in homes) \
                or _is_server(command, servers):
            continue                       # codex itself, its plugin sync in CODEX_HOME, an MCP server
        count += 1
    return count
