"""Claude Code status line: model, subscription limits and context window; the limits also go to a file for the catalog.

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
import re
import sys
import tempfile
import time
from datetime import datetime

LIMITS_FILE = "rate-limits.json"
LABELS = {"en": (("five_hour", "5h"), ("seven_day", "week"), "until"),
          "ru": (("five_hour", "5ч"), ("seven_day", "нед"), "до")}
CONTEXT_LABELS = {"en": ("context", "compact at ~", "window", "compact off"),
                  "ru": ("контекст", "сжатие ~", "окно", "сжатие выкл")}
MANAGED_SETTINGS = "/Library/Application Support/ClaudeCode/managed-settings.json"
COMPACT_BUFFER = 33000          # what Claude Code's /context calls "Autocompact buffer"
WINDOW_MIN, WINDOW_MAX = 100000, 1000000


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


def _tokens(n: int) -> str:
    """228k below a million, 1M / 1.5M from it."""
    if n >= 1_000_000 or round(n / 1000) >= 1000:
        return f"{n / 1_000_000:.1f}".rstrip("0").rstrip(".") + "M"
    return f"{round(n / 1000)}k"


def _positive_int(value):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _read_object(path: str) -> dict:
    """A settings file as a dict; missing, broken or not an object -> {}."""
    try:
        with open(path, encoding="utf-8") as fh:
            value = json.load(fh)
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _settings(data: dict) -> dict:
    """Effective Claude Code settings: managed > project local > project > user, merged by key."""
    workspace = data.get("workspace")
    workspace = workspace if isinstance(workspace, dict) else {}
    project = next((str(workspace[k]) for k in ("project_dir", "current_dir")
                    if isinstance(workspace.get(k), str) and workspace[k]), None)
    if project is None and isinstance(data.get("cwd"), str) and data["cwd"]:
        project = data["cwd"]
    user = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    paths = [os.path.join(user, "settings.json")]
    if project:
        paths += [os.path.join(project, ".claude", "settings.json"),
                  os.path.join(project, ".claude", "settings.local.json")]
    paths.append(MANAGED_SETTINGS)
    merged: dict = {}
    for path in paths:                      # lowest precedence first, later files win per key
        found = _read_object(path)
        models = dict(merged.get("modelSettings") or {}) if isinstance(merged.get("modelSettings"), dict) else {}
        if isinstance(found.get("modelSettings"), dict):
            for name, entry in found["modelSettings"].items():
                old = models.get(name)
                models[name] = {**old, **entry} if isinstance(old, dict) and isinstance(entry, dict) else entry
        merged.update(found)
        if models:
            merged["modelSettings"] = models
    return merged


def _truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true")


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _compact_off(settings: dict) -> bool:
    return (_truthy("DISABLE_AUTO_COMPACT") or _truthy("DISABLE_COMPACT")
            or settings.get("autoCompactEnabled") is False)


def _compact_window(size: int, data: dict, settings: dict) -> int:
    """Window the auto-compact point is counted from: env, model setting, setting; clamped, capped at the window."""
    value = None
    env = os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "").strip()
    if re.fullmatch(r"\d+", env):
        value = int(env)
    if value is None:
        model = data.get("model")
        model_id = model.get("id") if isinstance(model, dict) else None
        models = settings.get("modelSettings")
        entry = models.get(model_id) if isinstance(models, dict) and isinstance(model_id, str) else None
        if isinstance(entry, dict):
            value = _number(entry.get("autoCompactWindow"))      # "auto" = not set
    if value is None:
        value = _number(settings.get("autoCompactWindow"))
    if value is None:
        return size
    return min(int(min(max(value, WINDOW_MIN), WINDOW_MAX)), size)


def _compact_point(window: int) -> int:
    """Used tokens at which auto-compact fires, as far as the status line can know.

    Claude Code does not document the exact rule: /context shows a 33k "Autocompact buffer" and the docs
    say 1M-window models compact at "about 967K", so the point is shown as window - 33k. The percent
    override can only lower it. The --autocompact launch flag and CLAUDE_CODE_MAX_OUTPUT_TOKENS never
    reach the status line.
    """
    point = max(window - COMPACT_BUFFER, 0)
    env = os.environ.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "").strip()
    if re.fullmatch(r"\d+", env) and 1 <= int(env) <= 100:
        point = min(point, window * int(env) // 100)
    return point


def context_segment(data: dict, lang: str = "en") -> str:
    """Used context (cache counts, output does not), the compact point and the window; "" if unknown."""
    window = data.get("context_window")
    usage = window.get("current_usage") if isinstance(window, dict) else None
    size = _positive_int(window.get("context_window_size")) if isinstance(window, dict) else None
    if not isinstance(usage, dict) or size is None:
        return ""
    used = 0
    for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
        part = usage.get(key, 0)
        if isinstance(part, bool) or not isinstance(part, (int, float)):
            return ""
        used += part
    used_label, compact_label, window_label, off_label = CONTEXT_LABELS.get(lang, CONTEXT_LABELS["en"])
    settings = _settings(data)
    if _compact_off(settings):
        compact = off_label
    else:
        compact = f"{compact_label}{_tokens(_compact_point(_compact_window(size, data, settings)))}"
    return f"{used_label} {_tokens(int(used))} · {compact} · {window_label} {_tokens(size)}"


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
    parts.append(context_segment(data, lang))
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
