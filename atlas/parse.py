"""Разбор транскрипта Claude Code (.jsonl) в факты о сессии. Без LLM, без БД, без сети."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from . import activity, config


# Первое user-сообщение после компактации — сводка прошлого контекста, а не промпт человека.
COMPACT_PREFIX = "This session is being continued from a previous conversation"

# Слэш-команда приезжает обёрнутой в теги — в карточке это нечитаемо.
_COMMAND_NAME = re.compile(r"<command-name>(.*?)</command-name>", re.S)
_COMMAND_ARGS = re.compile(r"<command-args>(.*?)</command-args>", re.S)


def readable_prompt(text: str) -> str:
    """`<command-message>loop</command-message><command-name>/loop</command-name>…` → `/loop …`."""
    if "<command-name>" not in text:
        return text
    name = _COMMAND_NAME.search(text)
    args = _COMMAND_ARGS.search(text)
    parts = [(name.group(1) if name else "").strip(), (args.group(1) if args else "").strip()]
    return " ".join(p for p in parts if p) or text

FILE_TOOL_INPUTS = {
    "Read": "file_path",
    "Edit": "file_path",
    "Write": "file_path",
    "MultiEdit": "file_path",
    "NotebookEdit": "notebook_path",
}

# Что попадает в индекс. Всё остальное (tool_result, image, document, thinking,
# attachment, snapshot) не попадает никогда: там base64 на мегабайты и сырой вывод тулов.
_TEXT_BLOCK = "text"


@dataclass
class SessionFacts:
    session_id: str = ""
    source_path: str = ""
    title: str | None = None
    title_source: str | None = None
    entrypoint: str | None = None
    version: str | None = None
    started_at: str | None = None
    last_activity_at: str | None = None
    human_turns: int = 0
    machine_turns: int = 0
    subagent_turns: int = 0
    cost_usd: float | None = None
    lines_added: int | None = None
    lines_removed: int | None = None
    models: list[str] = field(default_factory=list)
    last_prompt: str | None = None
    leaf_uuid: str | None = None
    cwds: list[str] = field(default_factory=list)
    branches: list[str] = field(default_factory=list)
    raw_files: list[str] = field(default_factory=list)
    links: list[tuple[str, str, str]] = field(default_factory=list)  # kind, url, title
    mcp_servers: list[str] = field(default_factory=list)
    tickets: set[str] = field(default_factory=set)
    # Тексты для FTS, по колонкам
    user_text: list[str] = field(default_factory=list)
    assistant_text: list[str] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)
    paths: list[str] = field(default_factory=list)
    summaries: list[str] = field(default_factory=list)
    subagent_text: list[str] = field(default_factory=list)
    records: int = 0
    bad_lines: int = 0
    complete_bytes: int = 0
    # Ходы для индекса: твой запрос вместе с ответами и командами на него. Строка индекса —
    # ход, а не вся сессия: дописанный файл трогает только последний ход, а «слова рядом»
    # не ловятся через границу двух сообщений.
    turns: list[dict] = field(default_factory=list)
    first_user_text: str | None = None
    first_assistant_text: str | None = None
    turn_base: int = 0            # сколько ходов уже в индексе до первого из self.turns
    # «Статистика»: строки ответов и запросов (только новые) и время, ещё не отданное строке.
    activity: dict = field(default_factory=dict)
    pending_active: float = 0.0
    last_main_ts: str | None = None


TURN_FIELDS = ("user_text", "assistant_text", "commands", "paths", "summaries")


def _new_turn() -> dict:
    return {name: [] for name in TURN_FIELDS}


def _turn(facts: SessionFacts, start_new: bool = False) -> dict:
    if start_new or not facts.turns:
        facts.turns.append(_new_turn())
    return facts.turns[-1]


def iter_complete_lines(fh):
    """Отдаёт только строки, завершённые переводом строки, и смещение после каждой.

    Живая сессия дописывается в этот же файл: недописанный хвост нужно оставить
    следующему проходу, иначе запись теряется навсегда.
    """
    offset = 0
    for raw in fh:
        if not raw.endswith(b"\n"):
            break
        offset += len(raw)
        yield offset, raw


def _add_seen(seq: list, value) -> None:
    if value and value not in seq:
        seq.append(value)


def _blocks(content):
    if isinstance(content, str):
        return [{"type": _TEXT_BLOCK, "text": content}]
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def _harvest_tickets(facts: SessionFacts, text: str) -> None:
    pattern = config.ticket_re()          # префиксы тикетов — из настроек
    if text and pattern:
        facts.tickets.update(pattern.findall(text))


def _handle_user(facts: SessionFacts, rec: dict) -> None:
    msg = rec.get("message") or {}
    sidechain = bool(rec.get("isSidechain"))
    for block in _blocks(msg.get("content")):
        if block.get("type") != _TEXT_BLOCK:
            continue  # tool_result / image / document — никогда не в индекс
        text = (block.get("text") or "").strip()
        if not text:
            continue
        if text.startswith(COMPACT_PREFIX):
            facts.summaries.append(text)  # сводка компактации, не промпт человека
            _turn(facts, start_new=True)["summaries"].append(text)
            continue
        if sidechain:
            facts.subagent_text.append(text)
            continue
        if rec.get("isMeta"):
            continue
        prompt = readable_prompt(text)
        facts.user_text.append(prompt)
        _turn(facts, start_new=True)["user_text"].append(prompt)
        if facts.first_user_text is None:
            facts.first_user_text = prompt
        facts.human_turns += 1
        _harvest_tickets(facts, text)


def _handle_assistant(facts: SessionFacts, rec: dict) -> None:
    msg = rec.get("message") or {}
    sidechain = bool(rec.get("isSidechain"))
    if sidechain:
        facts.subagent_turns += 1
    else:
        facts.machine_turns += 1
    _add_seen(facts.models, msg.get("model"))
    for block in _blocks(msg.get("content")):
        kind = block.get("type")
        if kind == _TEXT_BLOCK:
            text = (block.get("text") or "").strip()
            if text and sidechain:
                facts.subagent_text.append(text)
            elif text:
                facts.assistant_text.append(text)
                _turn(facts)["assistant_text"].append(text)
                if facts.first_assistant_text is None:
                    facts.first_assistant_text = text
        elif kind == "tool_use":
            name = block.get("name") or ""
            args = block.get("input") or {}
            if not isinstance(args, dict):
                continue
            if name == "Bash" and args.get("command"):
                facts.commands.append(str(args["command"]))
                if not sidechain:
                    _turn(facts)["commands"].append(str(args["command"]))
            elif name in FILE_TOOL_INPUTS:
                value = args.get(FILE_TOOL_INPUTS[name])
                if value:
                    facts.paths.append(str(value))
                    if not sidechain:
                        _turn(facts)["paths"].append(str(value))
    _add_seen(facts.mcp_servers, rec.get("attributionMcpServer"))


def _handle_cost(facts: SessionFacts, rec: dict) -> None:
    facts.cost_usd = rec.get("totalCostUSD")
    facts.lines_added = rec.get("totalLinesAdded")
    facts.lines_removed = rec.get("totalLinesRemoved")
    for model in (rec.get("modelUsage") or {}):
        _add_seen(facts.models, model)


def _handle_file_history(facts: SessionFacts, rec: dict) -> None:
    if rec.get("type") == "file-history-delta":
        _add_seen(facts.raw_files, rec.get("trackingPath"))
        return
    snapshot = rec.get("snapshot") or {}
    for tracked in (snapshot.get("trackedFileBackups") or {}):
        _add_seen(facts.raw_files, tracked)


def _handle_meta(facts: SessionFacts, rec: dict, kind: str) -> None:
    if kind == "ai-title" and not facts.title_source:
        facts.title, facts.title_source = rec.get("aiTitle"), "ai"
    elif kind in ("custom-title", "agent-name"):
        # Ручной заголовок всегда перебивает автоматический.
        facts.title = rec.get("customTitle") or rec.get("agentName")
        facts.title_source = "manual"
    elif kind == "last-prompt":
        facts.last_prompt = rec.get("lastPrompt")
        facts.leaf_uuid = rec.get("leafUuid")
    elif kind == "pr-link":
        facts.links.append(("pr", rec.get("prUrl") or "", rec.get("prRepository") or ""))
        _harvest_tickets(facts, rec.get("prRepository") or "")
    elif kind == "frame-link":
        facts.links.append(("artifact", rec.get("frameUrl") or "", rec.get("title") or ""))


def parse_file(path: str, session_id: str) -> SessionFacts:
    """Разбирает транскрипт целиком. Дёшево: весь корпус в 218k строк читается за ~5 с."""
    facts = SessionFacts(session_id=session_id, source_path=path)
    parse_range(path, facts, 0)
    _harvest_all(facts)
    return facts


def _harvest_all(facts: SessionFacts) -> None:
    for text in facts.commands + facts.paths + facts.branches:
        _harvest_tickets(facts, text)


def parse_tail(path: str, state: dict) -> SessionFacts:
    """Дочитывает дописанное с места прошлого прохода. Итог совпадает с `parse_file`,
    кроме плоских текстов: в них только новое, а ходы — последний прошлый плюс новые."""
    facts = facts_from_state(state)
    parse_range(path, facts, facts.complete_bytes)
    _harvest_all(facts)
    return facts


def parse_range(path: str, facts: SessionFacts, start: int) -> None:
    with open(path, "rb") as fh:
        fh.seek(start)
        for offset, raw in iter_complete_lines(fh):
            facts.complete_bytes = start + offset
            try:
                rec = json.loads(raw)
            except Exception:
                facts.bad_lines += 1
                continue
            if not isinstance(rec, dict):
                facts.bad_lines += 1
                continue
            facts.records += 1
            kind = rec.get("type")

            ts = rec.get("timestamp")
            if ts and kind in ("user", "assistant", "system"):
                if facts.started_at is None:
                    facts.started_at = ts
                facts.last_activity_at = ts

            _add_seen(facts.cwds, rec.get("cwd"))
            _add_seen(facts.branches, rec.get("gitBranch"))
            facts.entrypoint = rec.get("entrypoint") or facts.entrypoint
            facts.version = rec.get("version") or facts.version

            if ts and kind in ("user", "assistant", "system") and not rec.get("isSidechain"):
                facts.pending_active += activity.active_part(
                    activity.seconds_between(facts.last_main_ts, ts))
                facts.last_main_ts = ts

            if kind == "user":
                prompts = facts.human_turns
                _handle_user(facts, rec)
                if facts.human_turns > prompts:
                    activity.note_prompt(facts, rec)
            elif kind == "assistant":
                _handle_assistant(facts, rec)
                activity.note_answer(facts, rec)
            elif kind == "cost-state":
                _handle_cost(facts, rec)
            elif kind in ("file-history-delta", "file-history-snapshot"):
                _handle_file_history(facts, rec)
            else:
                _handle_meta(facts, rec, kind or "")


# Состояние разбора между проходами: всё, кроме текстов. Из ходов хранится только последний —
# в него ещё допишутся ответы, остальные уже лежат в индексе.
_STATE_SKIP = ("user_text", "assistant_text", "commands", "paths", "summaries", "subagent_text",
               "activity")


def facts_state(facts: SessionFacts) -> dict:
    out = {}
    for name, value in facts.__dict__.items():
        if name in _STATE_SKIP:
            continue
        if name == "turns":
            value = value[-1:]
        elif name == "tickets":
            value = sorted(value)
        out[name] = value
    out["turn_count"] = len(facts.turns)
    return out


def facts_from_state(state: dict) -> SessionFacts:
    facts = SessionFacts()
    for name, value in state.items():
        if name == "turn_count":
            continue
        if name == "tickets":
            value = set(value)
        elif name == "links":
            value = [tuple(x) for x in value]
        setattr(facts, name, value)
    facts.turn_base = state.get("turn_base", 0) + max(0, state.get("turn_count", 0) - len(facts.turns))
    return facts
