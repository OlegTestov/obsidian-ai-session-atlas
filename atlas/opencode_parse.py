"""Whitelist OpenCode 2 message content and convert it to catalog facts."""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone

from . import activity, agents
from .parse import SessionFacts, _add_seen, _harvest_tickets, _turn

FORK_SUFFIX = re.compile(r" \(fork #([0-9]{1,9})\)$")


def _catalog_title(title, source):
    if not isinstance(source, str) or not source:
        return title
    match = FORK_SUFFIX.search(source)
    base = source[:match.start()] if match else source
    next_number = int(match[1]) + 1 if match else 1
    # Native siblings can have the same suffix. Keep custom titles and number default copies in Atlas.
    return base if title == f"{base} (fork #{next_number})" else title


def _when(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _object(value):
    return value if isinstance(value, dict) else {}


def _tokens(value):
    return value if isinstance(value, int) and value >= 0 else 0


def _price(value):
    return value if isinstance(value, (int, float)) and math.isfinite(value) and value > 0 else None


def _text(facts, turn, field, value):
    if isinstance(value, str) and value.strip():
        getattr(facts, field).append(value)
        turn[field].append(value)
        _harvest_tickets(facts, value)
        return value
    return None


def _content(facts, turn, content):
    tools = []
    if not isinstance(content, list):
        return tools
    for item in content:
        item = _object(item)
        if item.get("type") == "text":
            text = _text(facts, turn, "assistant_text", item.get("text"))
            facts.first_assistant_text = facts.first_assistant_text or text
        if item.get("type") != "tool":
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name:
            continue
        tools.append(name.replace(",", " "))
        _text(facts, turn, "commands", name)
        args = _object(_object(item.get("state")).get("input"))
        path = _text(facts, turn, "paths", args.get("filePath")) if name in {"read", "edit", "write"} else None
        if path and name in {"edit", "write"}:
            _add_seen(facts.raw_files, path)
        if name in {"bash", "shell"}:
            _text(facts, turn, "commands", args.get("command"))
    return tools


def _usage(facts, message, data, tools, elapsed):
    usage = _object(data.get("usage"))
    tokens = _object(data.get("tokens")) or _object(usage.get("tokens"))
    cache = _object(tokens.get("cache"))
    model = _object(data.get("model")) or _object(usage.get("model"))
    provider, mid = model.get("providerID"), model.get("id")
    name = f"{provider}/{mid}" if isinstance(provider, str) and isinstance(mid, str) else None
    _add_seen(facts.models, name)
    return {"kind": activity.ANSWER, "ts": _when(message["time_created"]), "active_s": elapsed,
            "model": name, "input": _tokens(tokens.get("input")), "output": _tokens(tokens.get("output")),
            "reasoning": _tokens(tokens.get("reasoning")), "cache_read": _tokens(cache.get("read")),
            "cache_write": _tokens(cache.get("write")), "cost": _price(data.get("cost") or usage.get("cost")),
            "tools": tools}


def project(session, messages, *, fork_source_title=None) -> SessionFacts:
    sid = session["id"]
    fork = session["fork_session_id"]
    facts = SessionFacts(session_id=sid, agent=agents.OPENCODE, spawned=bool(session["parent_id"]),
                         title=_catalog_title(session["title"], fork_source_title),
                         version=session["version"], cwds=[session["directory"]],
                         started_at=_when(session["time_created"]), last_activity_at=_when(session["time_updated"]),
                         forked_from=fork, forked_at=_when(session["time_created"]) if fork else None)
    previous = None
    for message in messages:
        facts.records += 1
        kind = message["type"]
        timestamp = _when(message["time_created"])
        if kind not in ("user", "assistant", "compaction"):
            continue
        data = _object(json.loads(message["data"]))
        elapsed = activity.active_part(activity.seconds_between(previous, timestamp))
        previous = timestamp
        key = message["id"]
        # Native 2.3.2 forks assign new IDs to their copied prefix, suffixed with the source seq.
        inherited = fork and key.endswith(f"_{message['seq']}")
        if kind == "user":
            facts.human_turns += 1
            text = _text(facts, _turn(facts, start_new=True), "user_text", data.get("text"))
            facts.first_user_text = facts.first_user_text or text
            facts.last_prompt = text or facts.last_prompt
            if not inherited:
                facts.activity[key] = {"kind": activity.PROMPT, "ts": timestamp, "active_s": elapsed,
                                       "model": None, "input": 0, "output": 0, "cache_read": 0,
                                       "cache_write": 0, "cost": None, "tools": []}
        elif kind == "assistant":
            facts.machine_turns += 1
            tool_names = _content(facts, _turn(facts), data.get("content"))
            reply = _usage(facts, message, data, tool_names, elapsed)
            if not inherited:
                facts.activity[key] = reply
        elif not inherited and (data.get("tokens") or data.get("usage") or data.get("cost")):
            facts.activity[key] = _usage(facts, message, data, [], elapsed)
    prices = [r["cost"] for r in facts.activity.values() if r["cost"] is not None]
    facts.cost_usd = sum(prices) if prices else None
    return facts
