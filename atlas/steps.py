"""Шаги хода для ленты: каждый вызов инструмента по порядку — что, сколько шёл, чем кончился.

Итог хода лента и так показывает свёрнутыми метками («3 команды»); шаги отвечают на другой
вопрос — что агент делает прямо сейчас и где застрял. Результат вызова приходит отдельной
записью `tool_result` с тем же id: из неё — ошибка (`is_error`) и время выполнения.
Подряд идущие чтения и поиски сливаются в одну строку: иначе их сотни и не видно главного.
"""
from __future__ import annotations

import os
from datetime import datetime

from .messages import msg, plural

MAX_EVENTS = 300              # на ход: в длинном ходе старые шаги отрезаются, считаются числом
DETAIL_CHARS = 600
ERROR_CHARS = 400
TEXT_CHARS = 240
MERGED = {"read", "search"}


def _short(text, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _base(path) -> str:
    return os.path.basename(str(path or "")) or str(path or "")


def describe(name: str, args: dict) -> tuple[str, str, str]:
    """(вид, строка, подробности в подсказку) для одного вызова."""
    a = args if isinstance(args, dict) else {}
    if name in ("Edit", "MultiEdit", "NotebookEdit"):
        path = a.get("file_path") or a.get("notebook_path")
        return "edit", msg("step.edit", name=_base(path)), str(path or "")
    if name == "Write":
        return "edit", msg("step.write", name=_base(a.get("file_path"))), str(a.get("file_path") or "")
    if name == "Bash":
        cmd = str(a.get("command") or "")
        return "bash", _short(a.get("description") or cmd, 90), _short(cmd, DETAIL_CHARS)
    if name == "Read":
        return "read", msg("step.read", name=_base(a.get("file_path"))), str(a.get("file_path") or "")
    if name in ("Grep", "Glob"):
        return "search", msg("step.search", pattern=_short(a.get("pattern"), 50)), _short(a.get("path") or "", 200)
    if name in ("Agent", "Task"):
        who = a.get("subagent_type") or msg("step.agent_default")
        return "agent", msg("step.agent", who=who, what=_short(a.get("description"), 70)), _short(a.get("prompt"), DETAIL_CHARS)
    if name in ("WebFetch", "WebSearch"):
        return "web", _short(a.get("url") or a.get("query"), 90), ""
    if name == "Skill":
        return "skill", msg("step.skill", name=str(a.get("skill") or "")), _short(a.get("args"), 200)
    if name in ("TaskCreate", "TaskUpdate", "TodoWrite"):
        what = a.get("subject") or a.get("status") or ""
        return "task", _short(msg("step.tasks_what", what=what) if what else msg("step.tasks"), 90), ""
    if name.startswith("mcp__"):
        parts = name.split("__")
        return "mcp", f"{parts[1] if len(parts) > 1 else 'mcp'}: {parts[-1]}", _short(a, 300)
    return "other", name, _short(a, 300) if a else ""


def _seconds(start: str | None, end: str | None) -> float | None:
    try:
        return (datetime.fromisoformat(end.replace("Z", "+00:00"))
                - datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds()
    except (AttributeError, ValueError):
        return None


def _result_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(b.get("text") or "") for b in content if isinstance(b, dict))
    return ""


class Collector:
    """Шаги одного хода. Записи — по порядку, как в транскрипте."""

    def __init__(self):
        self.events: list[dict] = []
        self.by_id: dict[str, dict] = {}

    def assistant(self, rec: dict, content: list) -> None:
        at = rec.get("timestamp")
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                kind, text, detail = describe(block.get("name") or "?", block.get("input") or {})
                ev = {"at": at, "kind": kind, "text": text, "detail": detail, "status": "run"}
                self.events.append(ev)
                if block.get("id"):
                    self.by_id[block["id"]] = ev
            elif block.get("type") == "text" and (block.get("text") or "").strip():
                self.events.append({"at": at, "kind": "text", "text": _short(block["text"], TEXT_CHARS),
                                    "detail": "", "status": "ok"})

    def result(self, rec: dict, content: list) -> None:
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            ev = self.by_id.get(block.get("tool_use_id"))
            if ev is None:
                continue
            ev["took"] = _seconds(ev["at"], rec.get("timestamp"))
            if block.get("is_error"):
                ev["status"] = "error"
                ev["error"] = _short(_result_text(block.get("content")), ERROR_CHARS)
            else:
                ev["status"] = "ok"

    def finish(self, reply: str | None) -> dict:
        events = self.events
        # Последний текст хода — это ответ, лента показывает его ниже целиком.
        if reply and events and events[-1]["kind"] == "text":
            events = events[:-1]
        merged: list[dict] = []
        for ev in events:
            prev = merged[-1] if merged else None
            if (prev and ev["kind"] in MERGED and prev["kind"] == ev["kind"]
                    and ev["status"] == "ok" and prev["status"] == "ok"):
                prev["n"] = prev.get("n", 1) + 1
                prev["items"].append(ev["detail"] or ev["text"])
                prev["took"] = (prev.get("took") or 0) + (ev.get("took") or 0)
                continue
            ev = dict(ev)
            if ev["kind"] in MERGED:
                ev["items"] = [ev["detail"] or ev["text"]]
            merged.append(ev)
        for ev in merged:
            if ev.get("n"):
                n = ev["n"]
                ev["text"] = plural("step.read_many" if ev["kind"] == "read" else "step.search_many", n)
                ev["detail"] = "\n".join(ev["items"][:40])
            ev.pop("items", None)
            if ev.get("took") is not None:
                ev["took"] = round(ev["took"], 1)
        hidden = max(0, len(merged) - MAX_EVENTS)
        return {"events": merged[hidden:], "earlier": hidden,
                "errors": sum(1 for e in merged if e["status"] == "error")}
