"""Сырьё «Статистики»: ответы модели и запросы человека с токенами, ценой и временем работы.

Строка — ответ модели (ключ message.id: один ответ пишется несколькими записями) или запрос
человека (ключ uuid записи). Возобновлённая сессия копирует чужую историю в свой файл с теми же
ключами, поэтому при подсчёте строки схлопываются по ключу — иначе ~3,5% ответов считались бы
дважды.

Активное время — сумма промежутков между соседними записями основного файла, но только
коротких: пауза длиннее IDLE_SECONDS — человек ушёл, и она не считается вовсе. Промежуток
приписывается следующей строке-ответу или запросу. У сабагентов время не считается: они идут
параллельно с основной сессией и удвоили бы её.
"""
from __future__ import annotations

import re
from datetime import datetime

from . import costs

IDLE_SECONDS = 15 * 60
PROMPT, ANSWER = "p", "a"
_COMMAND = re.compile(r"<command-name>/?([^<\s]+)</command-name>")


def seconds_between(prev: str | None, ts: str | None) -> float:
    """Секунды от prev до ts; 0 — если одного нет, порядок нарушен или строка не разбирается."""
    if not prev or not ts:
        return 0.0
    try:
        delta = (datetime.fromisoformat(ts.replace("Z", "+00:00"))
                 - datetime.fromisoformat(prev.replace("Z", "+00:00"))).total_seconds()
    except ValueError:
        return 0.0
    return delta if delta > 0 else 0.0


def active_part(gap: float) -> float:
    return gap if gap <= IDLE_SECONDS else 0.0


def _tool_names(content) -> list[str]:
    """Имена вызовов; у скилла и агента — с тем, что именно вызвано: `Skill:browse`, `Agent:Explore`."""
    if not isinstance(content, list):
        return []
    out = []
    for b in content:
        if not isinstance(b, dict) or b.get("type") != "tool_use":
            continue
        name = b.get("name") or "?"
        args = b.get("input") if isinstance(b.get("input"), dict) else {}
        if name == "Skill" and args.get("skill"):
            name = "Skill:" + str(args["skill"])
        elif name in ("Agent", "Task") and args.get("subagent_type"):
            name = "Agent:" + str(args["subagent_type"])
        out.append(name.replace(",", " "))
    return out


def _command(rec: dict) -> list[str]:
    """Слэш-команда, набранная человеком: `/loop` приезжает тегом внутри текста запроса."""
    content = (rec.get("message") or {}).get("content")
    texts = [content] if isinstance(content, str) else [
        b.get("text") or "" for b in content or [] if isinstance(b, dict)]
    for text in texts:
        m = _COMMAND.search(text)
        if m:
            return ["Cmd:/" + m.group(1).replace(",", " ")]
    return []


def note_answer(facts, rec: dict) -> None:
    """Ответ модели: токены и цена — по первой записи ответа, инструменты — со всех."""
    msg = rec.get("message") or {}
    usage = msg.get("usage")
    if not isinstance(usage, dict) or msg.get("model") == costs.SYNTHETIC:
        return
    key = msg.get("id") or rec.get("uuid")
    if not key:
        return
    row = facts.activity.get(key)
    if row is None:
        split = usage.get("cache_creation") or {}
        write = (split.get("ephemeral_5m_input_tokens") or 0) + (split.get("ephemeral_1h_input_tokens") or 0)
        row = facts.activity[key] = {
            "kind": ANSWER, "ts": rec.get("timestamp") or "", "active_s": 0.0,
            "model": msg.get("model"),
            "input": int(usage.get("input_tokens") or 0),
            "output": int(usage.get("output_tokens") or 0),
            "cache_read": int(usage.get("cache_read_input_tokens") or 0),
            "cache_write": int(write or usage.get("cache_creation_input_tokens") or 0),
            "cost": costs.message_cost(msg.get("model"), usage),
            "tools": []}
    row["tools"].extend(_tool_names(msg.get("content")))
    row["active_s"] += facts.pending_active
    facts.pending_active = 0.0


def note_prompt(facts, rec: dict) -> None:
    key = rec.get("uuid")
    if not key:
        return
    facts.activity[key] = {"kind": PROMPT, "ts": rec.get("timestamp") or "",
                           "active_s": facts.pending_active, "model": None, "input": 0,
                           "output": 0, "cache_read": 0, "cache_write": 0, "cost": None,
                           "tools": _command(rec)}
    facts.pending_active = 0.0


def store(conn, session_id: str, rows: dict, sub: bool = False) -> None:
    """Дописать строки. Ответ, начатый прошлым проходом, дополняется временем и инструментами."""
    for key, r in rows.items():
        if sub and r["kind"] == PROMPT:
            continue
        conn.execute(
            """INSERT INTO activity (session_id, key, kind, ts, active_s, model, input, output,
                 cache_read, cache_write, cost, sub, tools) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(session_id, key) DO UPDATE SET
                 active_s = active_s + excluded.active_s,
                 tools = CASE WHEN excluded.tools = '' THEN tools
                              WHEN tools = '' THEN excluded.tools
                              ELSE tools || ',' || excluded.tools END""",
            (session_id, key, r["kind"], r["ts"], 0.0 if sub else r["active_s"], r["model"],
             r["input"], r["output"], r["cache_read"], r["cache_write"], r["cost"],
             1 if sub else 0, ",".join(r["tools"])))
