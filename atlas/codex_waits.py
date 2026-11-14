"""Approval waits of live Codex threads, from the opt-in Codex hook (`codex_hook.py`).

The hook marks the moment Codex is about to ask (`<data>/codex-waits/<thread>.json`). The thread still
waits while its rollout has nothing newer that settles the request: a tool's output or its start (the
approval was given), a refusal, an abort, the end of the turn or a new prompt. Token counts and
reasoning written after the mark settle nothing. Only a busy thread can wait.
"""
from __future__ import annotations

import json
import os

from . import db

FOLDER = "codex-waits"
TAIL_BYTES = 256 * 1024
# Records that mean the approval prompt is gone: the call ran (or was refused), or the turn moved on.
SETTLED = {"function_call_output", "custom_tool_call_output", "exec_command_begin", "exec_command_end",
           "patch_apply_begin", "patch_apply_end", "turn_aborted", "task_complete", "user_message",
           "agent_message", "mcp_tool_call_end"}


def mark(session_id: str, home: str | None = None) -> dict | None:
    try:
        with open(os.path.join(home or db.atlas_home(), FOLDER, session_id + ".json"), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("at"), str) else None


def _settled_after(path: str, at: str) -> bool:
    """Whether the rollout's tail holds a settling record stamped after `at` (same format, compared as text)."""
    try:
        with open(path, "rb") as fh:
            size = os.fstat(fh.fileno()).st_size
            fh.seek(max(0, size - TAIL_BYTES))
            tail = fh.read()
    except OSError:
        return True                        # nothing to check against: no mark shown
    for raw in reversed(tail.split(b"\n")):
        try:
            rec = json.loads(raw)
        except ValueError:
            continue                       # a cut first line or a line still being written
        stamp = rec.get("timestamp") if isinstance(rec, dict) else None
        if not isinstance(stamp, str) or stamp <= at:
            return False                   # older records come before the mark: nothing settled it
        payload = rec.get("payload")
        if isinstance(payload, dict) and payload.get("type") in SETTLED:
            return True
    return False


def waiting(session_id: str, rollout: str, status: str | None, home: str | None = None) -> str | None:
    """The time Codex started waiting for an approval, or None."""
    if status != "busy":
        return None
    found = mark(session_id, home)
    if not found or _settled_after(rollout, found["at"]):
        return None
    return found["at"]
