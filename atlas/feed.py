"""Session feed for the side panel: recent turns with your prompt, what Claude did, its reply.

A turn starts with your message (see `active.is_message`). Tool calls collapse into short
lines: "edited 3 files", "commands: 2". The transcript tail is read with a growing window
until it holds enough turns; for a live session that is usually the last few hundred KB.
"""
from __future__ import annotations

import json
import os
from collections import OrderedDict

from . import active, steps as stepmod
from .messages import msg, plural as nplural

DEFAULT_TURNS = 8
MAX_TURNS = 20
FIRST_WINDOW = 512 * 1024
MAX_WINDOW = 16 * 1024 * 1024
PROMPT_CHARS = 2000
REPLY_CHARS = 4000
DETAIL_ITEMS = 6
HISTORY_PROMPT_CHARS = 1500       # conversation tail in the card: shorter than in the feed
HISTORY_REPLY_CHARS = 2000
HISTORY_CACHE_SIZE = 64
HISTORY_MAX = 30
_history_cache: OrderedDict[tuple, list] = OrderedDict()

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
    return {"prompt": prompt[:PROMPT_CHARS], "prompt_len": len(prompt),
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
    for turn in turns:
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
    out = []
    for raw in lines:
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def feed(path: str | None, turns: int = DEFAULT_TURNS, with_events: bool = False) -> list[dict]:
    if not path:
        return []
    turns = max(1, min(MAX_TURNS, int(turns)))
    try:
        size = os.path.getsize(path)
    except OSError:
        return []
    window = FIRST_WINDOW
    while True:
        built = build(_window(path, size, window), with_events)
        # `build` drops the tail of a turn started before the window; the other turns are whole.
        if len(built) >= turns or window >= size or window >= MAX_WINDOW:
            return built[-turns:]
        window *= 4


def feed_page(path: str | None, turns: int = DEFAULT_TURNS, with_events: bool = False,
              before: str | None = None, since: str | None = None) -> dict:
    """A page of the feed. before: turns earlier than this time (scrolling up); since: all turns
    from this time on (live end while the feed is open). Keyed by turn time, not index from the end:
    a live session's end keeps growing, so indexes would shift."""
    if not path:
        return {"turns": [], "has_more": False}
    turns = max(1, min(MAX_TURNS, int(turns)))
    try:
        size = os.path.getsize(path)
    except OSError:
        return {"turns": [], "has_more": False}
    cap = None if (before or since) else MAX_WINDOW    # scrolling up may reach the very beginning
    window = FIRST_WINDOW
    while True:
        built = build(_window(path, size, window), with_events)
        whole = window >= size

        def at(t: dict) -> str:
            return t.get("prompt_at") or ""

        if since:
            # A turn started at `since` is fully in the window if the window starts no later than it.
            if whole or (built and at(built[0]) <= since):
                return {"turns": [t for t in built if at(t) >= since], "has_more": None}
        else:
            pool = [t for t in built if not before or at(t) < before]
            if len(pool) > turns or whole or (cap and window >= cap):
                return {"turns": pool[-turns:], "has_more": len(pool) > turns or not whole}
        window *= 4


def messages_tail(path: str | None, count: int) -> list[dict]:
    """Last conversation messages, yours and the agent's, without steps: for the detail card."""
    if not path or count < 1:
        return []
    try:
        st = os.stat(path)
    except OSError:
        return []
    key = (path, st.st_size, st.st_mtime_ns, count)
    if key in _history_cache:
        _history_cache.move_to_end(key)
        return _history_cache[key]
    out = []
    for t in feed(path, turns=min(MAX_TURNS, count // 2 + 2)):
        out.append({"role": "you", "text": (t["prompt"] or "")[:HISTORY_PROMPT_CHARS],
                    "len": t["prompt_len"], "at": t["prompt_at"], "images": t["images"]})
        if t["reply"]:
            out.append({"role": "claude", "text": active.markdown_tail(t["reply"], HISTORY_REPLY_CHARS),
                        "len": t["reply_len"], "at": t["reply_at"]})
    out = out[-count:]
    _history_cache[key] = out
    while len(_history_cache) > HISTORY_CACHE_SIZE:
        _history_cache.popitem(last=False)
    return out
