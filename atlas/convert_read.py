"""Reads a session for "Resume with…": the conversation since its last compaction, as plain items.

An item is `{"role": "user" | "assistant" | "tool", "text", "ts"}`; a tool item also has `name` and
`output`. Reasoning, thinking, signatures and encrypted content are never read: only human prompts,
assistant text, tool calls with their (truncated) results and the compaction summary.
"""
from __future__ import annotations

import contextlib
import json
import os

from . import codex_parse
from .parse import COMPACT_PREFIX, iter_complete_lines, readable_prompt

CALL_LIMIT = 600          # a command or a call's arguments
OUTPUT_LIMIT = 800        # a tool result: enough to see what happened, not the raw dump
TEXT_LIMIT = 40000        # one prompt or reply
# File tools: the path says what happened; their result is the file itself or "ok".
QUIET_TOOLS = {"Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"}


def clip(text: str, limit: int) -> str:
    text = str(text or "").strip()
    return text if len(text) <= limit else text[:limit].rstrip() + " …[truncated]"


def _call_text(name: str, args) -> str:
    """One line a model of another vendor reads as "what the agent did", not a tool schema."""
    if not isinstance(args, dict):
        return clip(args, CALL_LIMIT)
    for key in ("command", "cmd", "file_path", "notebook_path", "path", "pattern", "url", "query",
                "description", "prompt"):
        value = args.get(key)
        if isinstance(value, list):
            value = codex_parse._shell_command({"cmd": value})
        if isinstance(value, str) and value.strip():
            return clip(value, CALL_LIMIT)
    return clip(json.dumps(args, ensure_ascii=False), CALL_LIMIT)


def _output_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        return _output_text(content.get("content") if "content" in content else content.get("output"))
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") in ("text", "input_text", "output_text"):
                parts.append(str(block.get("text") or ""))
            elif isinstance(block, dict) and block.get("type") in ("image", "input_image"):
                parts.append("[image]")
        return "\n".join(p for p in parts if p)
    return ""


def _tool(name: str, args, ts, call_id=None) -> dict:
    return {"role": "tool", "name": name or "tool", "text": _call_text(name, args), "output": None,
            "ts": ts, "id": call_id}


def _attach(calls: dict, call_id, output) -> None:
    item = calls.get(call_id)
    if item is not None and item["name"] not in QUIET_TOOLS:
        item["output"] = clip(_output_text(output), OUTPUT_LIMIT)


class Conversation:
    def __init__(self, agent: str, session_id: str) -> None:
        self.agent = agent
        self.session_id = session_id
        self.cwd: str | None = None
        self.summary: str | None = None
        self.items: list[dict] = []


# --- Claude Code ---------------------------------------------------------------------------

def _claude_items(rec: dict, calls: dict) -> tuple[list[dict], str | None]:
    """(items, compaction summary) of one main-chain record."""
    msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
    content = msg.get("content")
    ts = rec.get("timestamp")
    blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content
    items, summary = [], None
    for block in blocks if isinstance(blocks, list) else []:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text" and rec.get("type") == "user":
            text = str(block.get("text") or "").strip()
            if text.startswith(COMPACT_PREFIX) or rec.get("isCompactSummary"):
                summary = text
            elif text and not rec.get("isMeta"):
                items.append({"role": "user", "text": clip(readable_prompt(text), TEXT_LIMIT), "ts": ts})
        elif kind == "text":
            text = str(block.get("text") or "").strip()
            if text:
                items.append({"role": "assistant", "text": clip(text, TEXT_LIMIT), "ts": ts})
        elif kind == "image" and rec.get("type") == "user":
            items.append({"role": "user", "text": "[image]", "ts": ts})
        elif kind == "tool_use":
            item = _tool(str(block.get("name") or ""), block.get("input"), ts, block.get("id"))
            calls[block.get("id")] = item
            items.append(item)
        elif kind == "tool_result":
            _attach(calls, block.get("tool_use_id"), block.get("content"))
        # thinking, redacted_thinking, documents and anything else: never copied
    return items, summary


def read_claude(path: str, session_id: str) -> Conversation:
    """The main chain from the last message back to the compaction boundary (parentUuid null).
    A transcript without parentUuid fields is read in file order from its last compaction summary."""
    conv = Conversation("claude", session_id)
    links: dict[str, str | None] = {}
    records: dict[str, dict] = {}
    leaf, linked = None, False
    with open(path, "rb") as fh:
        for _, raw in iter_complete_lines(fh):
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(rec, dict) or not isinstance(rec.get("uuid"), str):
                continue
            links[rec["uuid"]] = rec.get("parentUuid")
            if rec.get("type") in ("user", "assistant") and not rec.get("isSidechain"):
                records[rec["uuid"]] = rec
                leaf = rec["uuid"]
                linked = linked or "parentUuid" in rec
                conv.cwd = rec.get("cwd") or conv.cwd
    chain, seen = [], set()
    while linked and leaf and leaf not in seen:
        seen.add(leaf)
        if leaf in records:
            chain.append(records[leaf])
        leaf = links.get(leaf)
    calls: dict = {}
    for rec in reversed(chain) if linked else records.values():
        items, summary = _claude_items(rec, calls)
        if summary:                       # the conversation copied starts at the last compaction
            conv.summary, conv.items = summary, []
        conv.items.extend(items)
    return conv


# --- Codex -------------------------------------------------------------------------------------

def read_codex(path: str, session_id: str) -> Conversation:
    """Prompts and replies come as events and, in newer versions, as completed items too: a pair
    across the two channels is one message. A `compacted` record starts the conversation over."""
    conv = Conversation("codex", session_id)
    calls: dict = {}
    pending: dict = {}

    def first_copy(role: str, channel: str, text: str) -> bool:
        other = pending.setdefault((role, "item" if channel == "event" else "event"), {})
        if other.get(text):
            other[text] -= 1
            return False
        mine = pending.setdefault((role, channel), {})
        mine[text] = mine.get(text, 0) + 1
        return True

    def message(role: str, channel: str, text, ts) -> None:
        text = str(text or "").strip()
        if text and first_copy(role, channel, text):
            conv.items.append({"role": role, "text": clip(text, TEXT_LIMIT), "ts": ts})

    with open(path, "rb") as fh:
        for _, raw in iter_complete_lines(fh):
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            p = rec.get("payload") if isinstance(rec, dict) and isinstance(rec.get("payload"), dict) else {}
            kind, sub, ts = rec.get("type"), p.get("type"), rec.get("timestamp")
            if (kind == "session_meta" and conv.cwd is None) or (kind == "turn_context" and p.get("cwd")):
                conv.cwd = p.get("cwd")
            elif kind == "compacted":
                conv.summary = str(p.get("message") or "").strip() or conv.summary
                conv.items, calls, pending = [], {}, {}
            elif kind == "event_msg" and sub == "user_message":
                message("user", "event", p.get("message"), ts)
            elif kind == "event_msg" and sub == "agent_message":
                message("assistant", "event", p.get("message"), ts)
            elif kind == "event_msg" and sub == "item_completed" and isinstance(p.get("item"), dict):
                item = p["item"]
                if item.get("type") == "UserMessage":
                    message("user", "item", codex_parse._texts(item.get("content"), "text"), ts)
                elif item.get("type") == "AgentMessage":
                    message("assistant", "item", codex_parse._texts(item.get("content"), "text"), ts)
            elif kind == "response_item" and sub in ("function_call", "custom_tool_call"):
                name = str(p.get("name") or "")
                args = p.get("input") if sub == "custom_tool_call" else p.get("arguments")
                if isinstance(args, str) and sub == "function_call":
                    with contextlib.suppress(ValueError):
                        args = json.loads(args)
                if name == "apply_patch" or (isinstance(args, str) and "*** Begin Patch" in args):
                    files = codex_parse.PATCH_FILE.findall(args if isinstance(args, str)
                                                           else str((args or {}).get("input") or ""))
                    args = ", ".join(files) or args
                    name = "apply_patch"
                item = _tool(name, args, ts, p.get("call_id"))
                calls[p.get("call_id")] = item
                conv.items.append(item)
            elif kind == "response_item" and sub in ("function_call_output", "custom_tool_call_output"):
                _attach(calls, p.get("call_id"), p.get("output"))
            # reasoning (with its encrypted content), developer messages, token counts: never copied
    return conv


def read(path: str, session_id: str, agent: str) -> Conversation:
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    return read_codex(path, session_id) if agent == "codex" else read_claude(path, session_id)
