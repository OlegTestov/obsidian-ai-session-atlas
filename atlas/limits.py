"""Лимиты подписки для верхней строки «Активных» — из файла, который пишет строка состояния.

Claude Code отдаёт `rate_limits` только скрипту строки состояния (`tools/statusline.py`),
тот сохраняет их в `rate-limits.json`. Нет файла — строка состояния не подключена.
"""
from __future__ import annotations

from .messages import msg

import json
import os
import time
from datetime import datetime, timezone

from . import db

LIMITS_FILE = "rate-limits.json"
WINDOWS = ("five_hour", "seven_day")        # подпись — из messages, на языке страницы


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
    """{captured_at, age_seconds, windows: [{key, label, used_percentage, resets_at}]} или None."""
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
    return {"captured_at": _iso(captured) if captured else None,
            "age_seconds": round((now or time.time()) - captured) if captured else None,
            "windows": windows}
