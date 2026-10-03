"""Claude Code status line: model and subscription limits; the limits also go to a file for the catalog.

Claude Code passes the script JSON on stdin with `rate_limits` (5-hour and 7-day windows:
`used_percentage`, `resets_at`). These numbers exist nowhere else locally, so the script
saves them, and the "Active" tab shows the weekly limit.

It runs as a standalone file, without the `atlas` package: that is how Claude Code calls it. A toggle
in the plugin settings connects it (with consent, since it edits `~/.claude/settings.json`).
"""
from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile
import time
from datetime import datetime

LIMITS_FILE = "rate-limits.json"
LABELS = {"en": (("five_hour", "5h"), ("seven_day", "week"), "until"),
          "ru": (("five_hour", "5ч"), ("seven_day", "нед"), "до")}


def atlas_home() -> str:
    return os.environ.get("ATLAS_HOME") or os.path.expanduser(
        "~/Library/Application Support/session-atlas")


def language(home: str | None = None) -> str:
    """Label language matches the catalog's (config.json in the data folder)."""
    try:
        with open(os.path.join(home or atlas_home(), "config.json"), encoding="utf-8") as fh:
            value = json.load(fh).get("language")
    except (OSError, ValueError, AttributeError):
        value = None
    return value if value in LABELS else "en"


def save_limits(limits: dict, home: str | None = None) -> None:
    home = home or atlas_home()
    os.makedirs(home, exist_ok=True)
    data = {"captured_at": time.time(), "rate_limits": limits}
    fd, tmp = tempfile.mkstemp(dir=home, prefix=".limits-")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(tmp, os.path.join(home, LIMITS_FILE))     # a reader never sees half a file


def _has_window(limits) -> bool:
    """Save only when a real window is present: junk must not overwrite a good file."""
    return isinstance(limits, dict) and any(
        isinstance(w, dict) and isinstance(w.get("used_percentage"), (int, float))
        for w in limits.values())


def _reset(value) -> str:
    try:
        ts = float(value) if not isinstance(value, str) or value.replace(".", "").isdigit() \
            else datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return ""
    moment = datetime.fromtimestamp(ts)
    return moment.strftime("%H:%M") if ts - time.time() < 86400 else moment.strftime("%d.%m")


def line(data: dict, lang: str = "en") -> str:
    five, week, until = LABELS.get(lang, LABELS["en"])
    model = data.get("model")
    parts = [str((model.get("display_name") if isinstance(model, dict) else "") or "").strip()]
    limits = data.get("rate_limits")
    limits = limits if isinstance(limits, dict) else {}
    for key, label in (five, week):
        window = limits.get(key)
        window = window if isinstance(window, dict) else {}
        pct = window.get("used_percentage")
        if isinstance(pct, (int, float)):
            reset = _reset(window.get("resets_at"))
            parts.append(f"{label} {round(pct)}%" + (f" {until} {reset}" if reset else ""))
    return " · ".join(p for p in parts if p)


def main() -> int:
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        data = {}
    if isinstance(data, dict) and _has_window(data.get("rate_limits")):
        with contextlib.suppress(OSError):  # the status line must not fail because of the file
            save_limits(data["rate_limits"])
    try:
        print(line(data, language()) if isinstance(data, dict) else "")
    except Exception:               # the status line must never break anything
        print("")
    return 0


if __name__ == "__main__":
    sys.exit(main())
