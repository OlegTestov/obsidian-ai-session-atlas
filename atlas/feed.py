"""Session turns for paged conversations and step views.

A turn starts with your message (see `active.is_message`). Tool calls collapse into short
lines: "edited 3 files", "commands: 2". The transcript tail is read with a growing window
until it holds enough turns; for a live session that is usually the last few hundred KB.
"""
from __future__ import annotations

import hashlib
import json
import os
from collections import OrderedDict

from . import active, codex_feed, codex_parse, steps as stepmod
from .messages import msg, plural as nplural

DEFAULT_TURNS = 8
MAX_TURNS = 20
FIRST_WINDOW = 512 * 1024
MAX_WINDOW = 16 * 1024 * 1024
PROMPT_CHARS = 2000
REPLY_CHARS = 4000
DETAIL_ITEMS = 6

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
SEARCH_TOOLS = {"Grep", "Glob"}
AGENT_TOOLS = {"Task", "Agent"}
WEB_TOOLS = {"WebFetch", "WebSearch"}


def plural(n: int, one: str, few: str, many: str) -> str:
    m10, m100 = n % 10, n % 100
    if m10 == 1 and m100 != 11:
        return one
    if 2 <= m10 <= 4 and not 12 <= m100 <= 14:
        return few
    return many


def _short(text: str, limit: int = 70) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _tool_key(name: str, args: dict) -> tuple[str, str | None]:
    """Group and detail line for one call."""
    if name in EDIT_TOOLS:
        path = args.get("file_path") or args.get("notebook_path") or ""
        return "edit", os.path.basename(path) or None
    if name == "Bash":
        return "bash", _short(args.get("description") or args.get("command") or "")
    if name == "Read":
        return "read", os.path.basename(args.get("file_path") or "") or None
    if name in SEARCH_TOOLS:
        return "search", _short(args.get("pattern") or "", 40) or None
    if name in AGENT_TOOLS:
        return "agent", _short(args.get("description") or "")
    if name in WEB_TOOLS:
        return "web", _short(args.get("url") or args.get("query") or "", 60) or None
    if name.startswith("mcp__"):
        parts = name.split("__")
        server = parts[1] if len(parts) > 1 else "mcp"
        return "mcp:" + server, parts[-1]
    return "other:" + name, None


def summarize(calls: list[tuple[str, dict]]) -> list[dict]:
    """[(name, args)] -> [{kind, text, detail[]}] in order of each group's first appearance."""
    groups: OrderedDict[str, dict] = OrderedDict()
    for name, args in calls:
        key, detail = _tool_key(name, args if isinstance(args, dict) else {})
        g = groups.setdefault(key, {"n": 0, "detail": []})
        g["n"] += 1
        if detail and detail not in g["detail"]:
            g["detail"].append(detail)
    out = []
    for key, g in groups.items():
        n = g["n"]
        if key == "edit":
            files = len(g["detail"]) or n
            text = nplural("feed.edited", files)
        elif key == "bash":
            text = nplural("feed.commands", n)
        elif key == "read":
            files = len(g["detail"]) or n
            text = nplural("feed.read", files)
        elif key == "search":
            text = nplural("feed.searched", n)
        elif key == "agent":
            text = nplural("feed.agents", n)
        elif key == "web":
            text = msg("feed.web", n=n)
        elif key.startswith("mcp:"):
            text = f"{key[4:]}: {n}"
        else:
            text = f"{key.split(':', 1)[1]}: {n}"
        kind = key.split(":", 1)[0]
        out.append({"kind": kind, "text": text, "detail": g["detail"][:DETAIL_ITEMS]})
    return out


def _new_turn(rec: dict) -> dict:
    content = (rec.get("message") or {}).get("content")
    prompt = active.prompt_text(content)
    # `id` is the key clients merge on, so it must not depend on the read window: the record's uuid, else
    # the time plus a short hash of the text (Codex records carry no uuid).
    stamp = f"{rec.get('timestamp') or ''}:{hashlib.sha1(prompt.encode('utf-8', 'replace')).hexdigest()[:8]}"
    return {"id": rec.get("uuid") or stamp, "prompt": prompt[:PROMPT_CHARS], "prompt_len": len(prompt),
            "prompt_at": rec.get("timestamp"), "images": active._images_in(content),
            "calls": [], "reply": None, "reply_at": None, "interrupted": False,
            "collector": stepmod.Collector()}


def build(records, with_events: bool = False) -> list[dict]:
    """Turns in order. Records before your first message in the window are an earlier turn's tail; skipped."""
    turns: list[dict] = []
    for rec in records:
        kind = rec.get("type")
        if kind == "user" and active.is_message(rec):
            turns.append(_new_turn(rec))
            continue
        if not turns:
            continue
        turn = turns[-1]
        content = (rec.get("message") or {}).get("content")
        if kind == "user" and active._text_of(content).startswith(active.INTERRUPTED):
            turn["interrupted"] = True
        if kind == "user" and isinstance(content, list) and not rec.get("isSidechain"):
            turn["collector"].result(rec, content)
        if kind != "assistant" or rec.get("isSidechain") or not isinstance(content, list):
            continue
        turn["collector"].assistant(rec, content)
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_use":
                turn["calls"].append((block.get("name") or "?", block.get("input") or {}))
            elif block.get("type") == "text" and (block.get("text") or "").strip():
                turn["reply"] = block["text"].strip()
                turn["reply_at"] = rec.get("timestamp")
    seen: dict = {}
    for turn in turns:
        # Only an identical time and text repeats an id; it would make since_id/before_id pick the first turn.
        n = seen[turn["id"]] = seen.get(turn["id"], 0) + 1
        if n > 1 and turn["id"]:
            turn["id"] = f"{turn['id']}#{n}"
        calls = turn.pop("calls")
        collector = turn.pop("collector")
        turn["steps"] = summarize(calls)
        reply = turn["reply"] or ""
        if with_events:
            turn["events"] = collector.finish(reply)
        turn["reply_len"] = len(reply)
        turn["reply"] = active.markdown_tail(reply, REPLY_CHARS) if reply else None
    return turns


def _window(path: str, size: int, window: int) -> list[dict]:
    with open(path, "rb") as fh:
        fh.seek(max(0, size - window))
        lines = fh.read().split(b"\n")
    if window < size:
        lines = lines[1:]                 # the window's first line is cut
    if codex_parse.session_id_of(path):
        return codex_feed.records(lines)  # a Codex rollout, in the records `build` reads
    out = []
    for raw in lines:
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def feed_page(path: str | None, turns: int = DEFAULT_TURNS, with_events: bool = False,
              before: str | None = None, since: str | None = None,
              before_id: str | None = None, since_id: str | None = None) -> dict:
    """A page of the feed. before/before_id: turns earlier than that time/turn (scrolling up); since/since_id:
    the turns from that time/turn on, inclusive, because a live turn keeps growing (the open feed's live end).
    Keyed by turn id or time, not by index from the end: a live session's end keeps growing, so indexes
    would shift. An id works for turns without a time; one that is gone answers `reset` with the last page."""
    if not path:
        return {"turns": [], "has_more": False}
    turns = max(1, min(MAX_TURNS, int(turns)))
    try:
        size = os.path.getsize(path)
    except OSError:
        return {"turns": [], "has_more": False}
    cap = None if (before or since or before_id) else MAX_WINDOW    # scrolling up may reach the very beginning
    window = FIRST_WINDOW
    while True:
        built = build(_window(path, size, window), with_events)
        whole = window >= size

        def at(t: dict) -> str:
            return t.get("prompt_at") or ""

        ids = [t.get("id") for t in built]
        if since_id:
            if since_id in ids:
                return {"turns": built[ids.index(since_id):], "has_more": None}
            if whole or (cap and window >= cap):
                return {"turns": built[-turns:], "has_more": len(built) > turns or not whole, "reset": True}
        elif since:
            # A turn started at `since` is fully in the window if the window starts no later than it.
            if whole or (built and at(built[0]) <= since):
                first = next((i for i, t in enumerate(built) if at(t) >= since), len(built))
                return {"turns": built[first:], "has_more": None}   # a later turn without a time stays
        else:
            if before_id and before_id not in ids:
                if whole:
                    return {"turns": [], "has_more": False}
                window *= 4
                continue
            pool = built[:ids.index(before_id)] if before_id else [t for t in built if not before or at(t) < before]
            if len(pool) > turns or whole or (cap and window >= cap):
                return {"turns": pool[-turns:], "has_more": len(pool) > turns or not whole}
        window *= 4
