"""New session from the "Active" tab: in which folder and with which first prompt.

The folder must come from the `workdirs` list: the page sends a path, and an arbitrary one is not
accepted because the command goes to the terminal tab's shell.
"""
from __future__ import annotations

import os
import shlex
import sqlite3
import uuid

from . import config
from .messages import msg

RECENT_LIMIT = 40
MAX_PROMPT_CHARS = 20000
# Temporary and system folders are not opened as a new session.
SKIP_PREFIXES = ("/tmp/", "/private/tmp/", "/var/tmp/", "/private/var/tmp/", "/System/")


def _home() -> str:
    return os.path.expanduser("~")


def label(path: str) -> str:
    for vault, vault_id in config.vaults():
        if path == vault:
            return f"{vault_id} (Obsidian)"
        if path.startswith(vault + os.sep):
            return f"{vault_id}/" + path[len(vault) + 1:]
    home = _home()
    return "~" + path[len(home):] if path == home or path.startswith(home + os.sep) else path


def _usable(path: str) -> bool:
    return bool(path) and os.path.isabs(path) and os.path.isdir(path) \
        and not (path + "/").startswith(SKIP_PREFIXES) and "/scratchpad" not in path \
        and not any(part.startswith(".") for part in path.split(os.sep))


def workdirs(conn: sqlite3.Connection) -> list[dict]:
    """First folders you worked in recently (by last activity), then note folders
    and projects from the configured roots."""
    out: dict[str, dict] = {}
    rows = conn.execute(
        "SELECT cwd_last AS cwd, count(*) AS n, max(last_activity_at) AS last FROM sessions "
        "WHERE session_kind = 'interactive' AND cwd_last IS NOT NULL "
        "GROUP BY cwd_last ORDER BY last DESC LIMIT ?", (RECENT_LIMIT * 2,)).fetchall()
    for r in rows:
        if _usable(r["cwd"]) and len(out) < RECENT_LIMIT:
            out[r["cwd"]] = {"path": r["cwd"], "label": label(r["cwd"]), "sessions": r["n"],
                             "last_at": r["last"], "recent": True}
    extra = [vault for vault, _ in config.vaults()]
    containers = set(config.workspace_containers())
    for root in config.workspace_roots():
        if root in containers or not os.path.isdir(root):
            continue
        extra += [os.path.join(root, n) for n in sorted(os.listdir(root))[:200]
                  if not n.startswith(".")]
    for path in extra:
        if path not in out and _usable(path):
            out[path] = {"path": path, "label": label(path), "sessions": 0, "last_at": None,
                         "recent": False}
    return list(out.values())


class LaunchError(ValueError):
    """The message is shown to the user as is."""


def new_session(conn: sqlite3.Connection, cwd: str, prompt: str) -> dict:
    if not isinstance(cwd, str) or cwd not in {w["path"] for w in workdirs(conn)}:
        raise LaunchError(msg("launch.bad_folder"))
    if not isinstance(prompt, str):
        raise LaunchError(msg("launch.prompt_not_text"))
    prompt = prompt.replace("\r\n", "\n").strip()
    if len(prompt) > MAX_PROMPT_CHARS:
        raise LaunchError(msg("launch.prompt_too_long"))
    session_id = str(uuid.uuid4())
    parts = ["claude", "--session-id", session_id]
    if prompt:
        # claude would read a prompt starting with "-" as a flag.
        parts.append(" " + prompt if prompt.startswith("-") else prompt)
    command = f"cd {shlex.quote(cwd)} && " + " ".join(shlex.quote(p) for p in parts)
    title = (prompt.splitlines()[0][:60] if prompt else "") or label(cwd)
    return {"session_id": session_id, "cwd": cwd, "command": command, "title": title}
