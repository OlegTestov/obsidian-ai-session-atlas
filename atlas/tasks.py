"""The agent's task list (TaskCreate/TaskUpdate): how much is done and what is in progress.

Claude Code keeps it as files `~/.claude/tasks/<session id>/<n>.json`, one file per task:
subject, activeForm ("Reviewing merge request diff"), status pending / in_progress / completed,
a removed one is deleted. The files are small and few, so every "Active" poll reads them.
"""
from __future__ import annotations

import glob
import json
import os

from . import paths

TASKS_DIR = os.path.join(paths.claude_dir(), "tasks")
MAX_ITEMS = 30


def _number(path: str) -> int:
    stem = os.path.splitext(os.path.basename(path))[0]
    return int(stem) if stem.isdigit() else 10 ** 9


def progress(session_id: str, root: str | None = None) -> dict | None:
    """{total, done, active: [in progress], items: [{subject, status}]} or None: no tasks."""
    folder = os.path.join(root or TASKS_DIR, session_id)
    if not os.path.isdir(folder):
        return None
    items = []
    for path in sorted(glob.glob(os.path.join(glob.escape(folder), "*.json")), key=_number):
        try:
            with open(path, encoding="utf-8") as fh:
                task = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(task, dict) or task.get("status") == "deleted":
            continue
        items.append({"subject": str(task.get("subject") or "")[:200],
                      "active_form": str(task.get("activeForm") or "")[:200],
                      "status": str(task.get("status") or "pending")})
    if not items:
        return None
    return {"total": len(items),
            "done": sum(1 for t in items if t["status"] == "completed"),
            "active": [t["active_form"] or t["subject"] for t in items
                       if t["status"] == "in_progress"],
            "items": [{"subject": t["subject"], "status": t["status"]} for t in items[:MAX_ITEMS]]}
