"""Parses a Claude Code transcript (.jsonl) into session facts. No LLM, no DB, no network."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from . import activity, config

# The first user message after compaction is a summary of earlier context, not a human prompt.
COMPACT_PREFIX = "This session is being continued from a previous conversation"

# A slash command arrives wrapped in tags, which is unreadable on a card.
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

# What goes into the index. Everything else (tool_result, image, document, thinking,
# attachment, snapshot) never does: it holds megabytes of base64 and raw tool output.
_TEXT_BLOCK = "text"


@dataclass
class SessionFacts:
    session_id: str = ""
    source_path: str = ""
    agent: str = "claude"         # which agent wrote the transcript: claude | codex
    spawned: bool = False         # started by another agent (a Codex subagent thread), not a human
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
    # Texts for FTS, per column
    user_text: list[str] = field(default_factory=list)
    assistant_text: list[str] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)
    paths: list[str] = field(default_factory=list)
    summaries: list[str] = field(default_factory=list)
    subagent_text: list[str] = field(default_factory=list)
    records: int = 0
    bad_lines: int = 0
    complete_bytes: int = 0
    # Turns for the index: your prompt together with its replies and commands. An index row is
    # a turn, not the whole session: an appended file touches only the last turn, and "nearby
    # words" do not match across the boundary of two messages.
    turns: list[dict] = field(default_factory=list)
    first_user_text: str | None = None
    first_assistant_text: str | None = None
    turn_base: int = 0            # how many turns are already indexed before the first of self.turns
    # "Stats": reply and prompt rows (new ones only) and time not yet assigned to a row.
    activity: dict = field(default_factory=dict)
    pending_active: float = 0.0
    last_main_ts: str | None = None
    # A parked conversation (Claude Code 2.1.289+) goes on in a background job with its own
    # transcript: the parent ends with `continued-in`, the job copies the chain since the last
    # compaction (same uuids and message ids) and continues it. continued_in is set only while
    # that record is the parent's last word; continuations keeps every hand-over.
    continued_in: str | None = None
    continuations: list = field(default_factory=list)          # [child id, timestamp]
    continued_from: str | None = None
    copied_until: str | None = None    # the child's records up to here are copies of the parent
    copied: int = 0


TURN_FIELDS = ("user_text", "assistant_text", "commands", "paths", "summaries")


def _new_turn() -> dict:
    return {name: [] for name in TURN_FIELDS}


def _turn(facts: SessionFacts, start_new: bool = False) -> dict:
    if start_new or not facts.turns:
        facts.turns.append(_new_turn())
    return facts.turns[-1]


def iter_complete_lines(fh):
    """Yields only newline-terminated lines, with the offset after each.

    A live session appends to this same file: the unfinished tail must be left
    to the next pass, or the record is lost for good.
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
    pattern = config.ticket_re()          # ticket prefixes come from settings
    if text and pattern:
        facts.tickets.update(pattern.findall(text))


def _handle_user(facts: SessionFacts, rec: dict) -> None:
    msg = rec.get("message") or {}
    sidechain = bool(rec.get("isSidechain"))
    for block in _blocks(msg.get("content")):
        if block.get("type") != _TEXT_BLOCK:
            continue  # tool_result / image / document: never indexed
        text = (block.get("text") or "").strip()
        if not text:
            continue
        if text.startswith(COMPACT_PREFIX):
            facts.summaries.append(text)  # compaction summary, not a human prompt
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
        # A manual title always overrides the automatic one.
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


def parse_file(path: str, session_id: str, continued_from: str | None = None,
               copied_until: str | None = None) -> SessionFacts:
    """Parses the whole transcript. Cheap: the full 218k-line corpus reads in ~5 s."""
    facts = SessionFacts(session_id=session_id, source_path=path,
                         continued_from=continued_from, copied_until=copied_until)
    parse_range(path, facts, 0)
    _harvest_all(facts)
    return facts


def _harvest_all(facts: SessionFacts) -> None:
    for text in facts.commands + facts.paths + facts.branches:
        _harvest_tickets(facts, text)


def parse_tail(path: str, state: dict) -> SessionFacts:
    """Reads what was appended since the last pass. The result matches `parse_file`
    except for flat texts: they hold only new content, and turns are the last old one plus new ones."""
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
            if _is_copy(facts, rec, kind, ts):
                facts.copied += 1
                continue
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

            if kind in ("user", "assistant") and not rec.get("isSidechain"):
                facts.continued_in = None     # the conversation went on here after all
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
            elif kind == "continued-in":
                _handle_continued(facts, rec)
            else:
                _handle_meta(facts, rec, kind or "")


def _is_copy(facts: SessionFacts, rec: dict, kind, ts) -> bool:
    """A job's record written before the hand-over is the parent's, copied: it is indexed there."""
    if not facts.copied_until:
        return False
    if kind == "file-history-snapshot":
        ts = (rec.get("snapshot") or {}).get("timestamp")
    elif kind not in ("user", "assistant", "system", "attachment"):
        return False
    return isinstance(ts, str) and ts <= facts.copied_until


def _handle_continued(facts: SessionFacts, rec: dict) -> None:
    child = rec.get("continuedInSessionId")
    if isinstance(child, str) and child and child != facts.session_id:
        facts.continuations.append([child, rec.get("timestamp") or ""])
        facts.continued_in = child


# Parse state between passes: everything except texts. Only the last turn is kept,
# since more replies will be appended to it; the others are already in the index.
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
