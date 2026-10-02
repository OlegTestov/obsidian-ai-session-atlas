"""Строка состояния Claude Code: модель и лимиты подписки; лимиты — ещё и в файл для каталога.

Claude Code передаёт скрипту JSON на stdin, в нём `rate_limits` (окна 5 часов и 7 дней:
`used_percentage`, `resets_at`). Больше нигде локально эти цифры не лежат, поэтому скрипт
сохраняет их, а вкладка «Активные» показывает недельный лимит.

Запускается отдельным файлом, без пакета `atlas`: так его зовёт Claude Code. Подключает его
переключатель в настройках плагина (с согласия — это правка `~/.claude/settings.json`).
"""
from __future__ import annotations

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
    """Язык подписей — тот же, что у каталога (config.json в папке данных)."""
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
    os.replace(tmp, os.path.join(home, LIMITS_FILE))     # читатель не увидит полфайла


def _has_window(limits) -> bool:
    """Сохраняем, только если есть настоящее окно: мусор не должен затирать хороший файл."""
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
        try:
            save_limits(data["rate_limits"])
        except OSError:
            pass                       # строка состояния не должна падать из-за файла
    try:
        print(line(data, language()) if isinstance(data, dict) else "")
    except Exception:               # строка состояния не должна ронять ничего и никогда
        print("")
    return 0


if __name__ == "__main__":
    sys.exit(main())
