"""Subscription limits for the top bar of "Active", read from the file the status line writes.

Claude Code gives `rate_limits` only to the status line script (`tools/statusline.py`),
which saves them to `rate-limits.json`. No file means the status line is not connected.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone

from . import db
from .messages import msg

LIMITS_FILE = "rate-limits.json"
WINDOWS = ("five_hour", "seven_day")        # labels come from messages, in the page language
LIVE_FOR = 600      # seconds: older numbers get their age on the toolbar (Codex's too)


def _iso(value) -> str | None:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc).isoformat(timespec="seconds")
    if isinstance(value, str):
        if value.replace(".", "").isdigit():
            return _iso(float(value))
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat(timespec="seconds")
        except ValueError:
            return None
    return None


def read_limits(home: str | None = None, now: float | None = None) -> dict | None:
    """{captured_at, age_seconds, windows: [{key, label, used_percentage, resets_at}]} or None."""
    path = os.path.join(home or db.atlas_home(), LIMITS_FILE)
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    limits = data.get("rate_limits") if isinstance(data, dict) else None
    if not isinstance(limits, dict):
        return None
    windows = []
    for key in WINDOWS:
        label = msg(f"limits.{key}")
        w = limits.get(key)
        if isinstance(w, dict) and isinstance(w.get("used_percentage"), (int, float)):
            windows.append({"key": key, "label": label, "used_percentage": w["used_percentage"],
                            "resets_at": _iso(w.get("resets_at"))})
    if not windows:
        return None
    captured = data.get("captured_at") if isinstance(data.get("captured_at"), (int, float)) else None
    age = round((now or time.time()) - captured) if captured else None
    return {"captured_at": _iso(captured) if captured else None, "age_seconds": age, "windows": windows,
            "source": "statusline", "live": age is not None and age <= LIVE_FOR}
