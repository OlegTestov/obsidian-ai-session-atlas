"""Writes a conversation (atlas/convert_read.py) as a new native session of the other agent.

Claude Code: `<projects>/<slug of cwd>/<id>.jsonl`, user/assistant records chained by uuid/parentUuid.
Codex: `<home>/sessions/YYYY/MM/DD/rollout-<local time>-<id>.jsonl` in the shape Codex's own importer
of external sessions writes: session_meta, then per turn task_started, the user and assistant
messages (as response items and events) and task_complete. Both formats were checked by resuming
such files with claude 2.1.289 and codex-cli 0.160.0 against a stand-in API (tests/fixtures/xresume).
Messages alternate strictly, user first; every copied record is stamped no later than `at`.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
import uuid
from datetime import datetime, timezone

from . import prompts
from .convert_read import Conversation

AGENT_NAMES = {"claude": "Claude Code", "codex": "Codex"}
# Half of a 200k-token window at ~2.1 characters a token (CLAUDE.md): room for the work to go on.
BUDGET_CHARS = 210_000
SUMMARY_SHARE = 0.4           # the compaction summary may take at most this share of the budget
SLUG_MAX = 200                # Claude Code hashes longer folder names: only an existing folder is used
CODEX_VERSION = "0.160.0"     # the version this format was checked on; Codex only needs the field


class ConvertError(ValueError):
    """The message is shown to the user as is."""


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def uuid7() -> str:
    """Codex thread ids are UUID v7: a millisecond timestamp, then random bits."""
    raw = bytearray(int(time.time() * 1000).to_bytes(6, "big") + secrets.token_bytes(10))
    raw[6] = (raw[6] & 0x0F) | 0x70
    raw[8] = (raw[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(raw)))


def _item_text(item: dict) -> str:
    if item["role"] != "tool":
        return item["text"]
    out = f"[{item['name']}] {item['text']}"
    return out + (f"\n[output] {item['output']}" if item.get("output") else "")


def trim(conv: Conversation, budget: int = BUDGET_CHARS) -> tuple[str | None, list[dict], bool]:
    """(summary, items, omitted): the newest items that fit, cut at a prompt where possible."""
    summary = conv.summary
    limit = int(budget * SUMMARY_SHARE)
    if summary and len(summary) > limit:
        summary = summary[:limit].rstrip() + " …[truncated]"
    room = budget - len(summary or "")
    start, used = len(conv.items), 0
    while start > 0 and used + len(_item_text(conv.items[start - 1])) <= room:
        start -= 1
        used += len(_item_text(conv.items[start]))
    if start > 0:
        prompt = next((i for i in range(start, len(conv.items)) if conv.items[i]["role"] == "user"), None)
        start = prompt if prompt is not None else start
    return summary, conv.items[start:], start > 0


def turns(conv: Conversation, lg: str | None = None,
          budget: int = BUDGET_CHARS) -> tuple[list[tuple[str, str, str | None]], bool]:
    """([(role, text, ts)], omitted): alternating user/assistant, the note first, an assistant last."""
    summary, items, omitted = trim(conv, budget)
    lg = lg or prompts.lang()
    head = prompts.continued(AGENT_NAMES[conv.agent], conv.session_id, conv.cwd or "?", omitted, lg)
    if summary:
        head += "\n\n" + prompts.SUMMARY_HEAD[lg] + "\n\n" + summary
    out: list[list] = [["user", [head], items[0]["ts"] if items else None]]
    for item in items:
        role = "user" if item["role"] == "user" else "assistant"
        if out[-1][0] != role:
            out.append([role, [], item.get("ts")])
        out[-1][1].append(_item_text(item))
    if out[-1][0] == "user":
        out.append(["assistant", [prompts.NO_REPLY[lg]], None])
    return [(role, "\n\n".join(parts), ts) for role, parts, ts in out], omitted


def _stamps(messages, at: datetime) -> list[str]:
    """Source times where known, never later than `at` and never going back in time."""
    cap, last, out = iso(at), None, []
    for _, _, ts in messages:
        value = ts if isinstance(ts, str) and re.match(r"^\d{4}-\d\d-\d\dT", ts or "") else last or cap
        value = min(value, cap)
        value = max(value, last) if last else value
        out.append(value)
        last = value
    return out


# --- Claude Code ---------------------------------------------------------------------------------

def claude_slug(cwd: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def claude_folder(projects: str, cwd: str) -> str:
    slug = claude_slug(cwd)
    if len(slug) <= SLUG_MAX:
        return os.path.join(projects, slug)
    found = [n for n in (os.listdir(projects) if os.path.isdir(projects) else [])
             if n.startswith(slug[:SLUG_MAX] + "-")]
    if len(found) != 1:
        raise ConvertError("folder name too long")
    return os.path.join(projects, found[0])


def claude_records(messages, new_id: str, cwd: str, title: str | None, at: datetime) -> list[dict]:
    records, parent = [], None
    for (role, text, _), ts in zip(messages, _stamps(messages, at)):
        rec_id = str(uuid.uuid4())
        rec = {"parentUuid": parent, "isSidechain": False, "type": role, "uuid": rec_id,
               "timestamp": ts, "userType": "external", "entrypoint": "cli", "cwd": cwd,
               "sessionId": new_id}
        if role == "user":
            rec["message"] = {"role": "user", "content": text}
        else:
            rec["message"] = {"id": "msg_atlas_" + uuid.uuid4().hex[:20], "type": "message",
                              "role": "assistant", "model": "<synthetic>",
                              "content": [{"type": "text", "text": text}],
                              "stop_reason": "end_turn", "stop_sequence": None,
                              "usage": {"input_tokens": 0, "output_tokens": 0}}
        records.append(rec)
        parent = rec_id
    if title:
        records.append({"type": "custom-title", "customTitle": title, "sessionId": new_id})
    return records


# --- Codex ---------------------------------------------------------------------------------------

def codex_path(home: str, new_id: str, at: datetime) -> str:
    local = at.astimezone()
    folder = os.path.join(home, "sessions", local.strftime("%Y"), local.strftime("%m"), local.strftime("%d"))
    return os.path.join(folder, f"rollout-{local.strftime('%Y-%m-%dT%H-%M-%S')}-{new_id}.jsonl")


def codex_provider(home: str) -> str:
    """The provider config.toml selects (top level, before any table); Codex's default otherwise."""
    try:
        with open(os.path.join(home, "config.toml"), encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return "openai"
    for line in lines:
        if line.strip().startswith("["):
            break
        m = re.match(r"""\s*model_provider\s*=\s*["']([^"']+)["']""", line)
        if m:
            return m.group(1)
    return "openai"


def codex_records(messages, new_id: str, cwd: str, at: datetime, provider: str = "openai") -> list[dict]:
    """codex resume finds a thread only when session_meta has cli_version (any value), and loads it
    only when model_provider names a configured provider: both checked on 0.160.0. Field order and
    compact JSON follow Codex's own rollouts (0.160 starts the payload with session_id, id)."""
    stamps = _stamps(messages, at)
    # The thread itself starts now: Codex dates its list entry by session_meta.
    # ordinal: the record's line number, as Codex 0.160 writes it.
    out = [{"timestamp": iso(at), "ordinal": 0, "type": "session_meta",
            "payload": {"session_id": new_id, "id": new_id, "timestamp": iso(at), "cwd": cwd,
                        "originator": "session-atlas", "cli_version": CODEX_VERSION, "source": "cli",
                        "model_provider": provider}}]

    def add(ts: str, kind: str, payload: dict) -> None:
        out.append({"timestamp": ts, "ordinal": len(out), "type": kind, "payload": payload})

    turn, reply = 0, ""
    for (role, text, _), ts in zip(messages, stamps):
        if role == "user":
            turn += 1
            add(ts, "event_msg", {"type": "task_started", "turn_id": f"atlas-import-turn-{turn}",
                                  "model_context_window": None})
            add(ts, "response_item", {"type": "message", "role": "user",
                                      "content": [{"type": "input_text", "text": text}]})
            add(ts, "event_msg", {"type": "user_message", "message": text, "images": [],
                                  "local_images": [], "text_elements": []})
        else:
            reply = text
            add(ts, "response_item", {"type": "message", "role": "assistant",
                                      "content": [{"type": "output_text", "text": text}]})
            add(ts, "event_msg", {"type": "agent_message", "message": text})
            add(ts, "event_msg", {"type": "task_complete", "turn_id": f"atlas-import-turn-{turn}",
                                  "last_agent_message": reply})
    return out


def write_new(path: str, records: list[dict]) -> None:
    """A new file only (O_EXCL): an existing session is never overwritten. 0600, like the agents' own.
    Compact JSON and raw UTF-8, as both agents write it: tools match their records as text."""
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write("".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in records))
