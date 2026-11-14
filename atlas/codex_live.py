"""Codex cards for "Active": the same keys as a Claude Code card, plus `agent` and `model`.

The process table gives interactive `codex` processes, `lsof` the rollout each one holds open
(`codex_procs`), the rollout tail the turn state and the last messages (`codex_tail`). A permission
prompt is not in the rollout: the plugin reads it from the terminal screen, as for Claude Code, and the
opt-in Codex hook marks it for sessions outside tabs (`codex_waits`).
"""
from __future__ import annotations

import glob
import os
import sqlite3
import time
from datetime import datetime, timezone

from . import active, codex_procs, codex_state, codex_tail, codex_usage, codex_waits, index, openai_costs, search

AGENT = "codex"
TITLE_CHARS = 80
RECENT_FILES = 40             # rollouts checked for the newest rate limits, newest first
_last_live: list[str] = []    # rollouts of the last pass: their tails hold the freshest limits


def _iso_lstart(lstart: str | None) -> str | None:
    """`ps` start time, printed in UTC (`process_table` sets TZ=UTC)."""
    try:
        when = datetime.strptime(" ".join((lstart or "").split()), "%a %b %d %H:%M:%S %Y")
    except ValueError:
        return None
    return when.replace(tzinfo=timezone.utc).isoformat()


def _cost_now(model: str | None, total: dict | None) -> float | None:
    """The thread's running total priced by the model, when the price table knows it."""
    if not isinstance(total, dict):
        return None
    cached = int(total.get("cached_input_tokens") or 0)
    written = int(total.get("cache_write_input_tokens") or 0)
    fresh = max(0, int(total.get("input_tokens") or 0) - cached - written)
    return openai_costs.reply_cost(model, fresh, cached, written, int(total.get("output_tokens") or 0))


def _title(info: dict, tail: dict, sid: str) -> str:
    if info.get("title"):
        return info["title"]
    text = " ".join((tail.get("last_prompt") or "").split())
    return (text[:TITLE_CHARS - 1] + "…" if len(text) > TITLE_CHARS else text) or sid[:8]


def live_subagents(pid: int, table: dict, sid: str, now: float | None = None, home: str | None = None) -> int:
    """Subagent threads writing right now, as for Claude Code: a finished one stays open, unwritten.
    Those the process holds open, and those on disk (a daemon-run Codex holds them elsewhere)."""
    now = time.time() if now is None else now
    fresh = 0
    held = codex_procs.subagent_rollouts(pid, table, sid)
    for path in {os.path.realpath(p) for p in held + codex_procs.subagents_on_disk(sid, home, now)}:
        try:
            fresh += now - os.stat(path).st_mtime < active.AGENT_FRESH_SECONDS
        except OSError:
            continue
    return fresh


def card(conn: sqlite3.Connection, pid: int, path: str, table: dict, state: dict | None = None,
         home: str | None = None) -> dict | None:
    """state: {"goals": {sid: objective}, "queued": {sid: [...]}} read once for every live thread."""
    from .relocate import host_app  # relocate itself depends on active
    meta = codex_procs.session_meta(path)
    sid = codex_procs.thread_id(path)
    if not sid:
        return None
    info = search._load_session(conn, sid) or {}
    t = codex_tail.read(path)
    reply = t["reply"] or ""
    state = state or {}
    background = {"shells": codex_state.background_commands(pid, table, home),
                  "agents": live_subagents(pid, table, sid, home=home), "wake_at": None, "crons": 0,
                  "goal": (state.get("goals") or {}).get(sid)}
    context = codex_tail.context_tokens(t["usage"])
    started = _iso_lstart(table.get(pid, (0, ""))[1])
    waited = codex_waits.waiting(sid, path, t["status"])
    status = "waiting" if waited else t["status"]
    return {
        "session_id": sid,
        "agent": AGENT,
        "pid": pid,
        "ancestors": active.ancestors(pid, table),
        "host_app": host_app(pid, table),
        "status": status,
        "activity": active.activity(status, background),
        "background": background,
        "waiting_for": "permission prompt" if waited else None,   # else the plugin reads the tab's screen
        "job_session_id": None,
        "transcript_session_id": sid,
        "cwd": t["cwd"] or meta.get("cwd"),
        "indexed": bool(info),
        "title": _title(info, t, sid),
        "card_line": info.get("card_line"),
        "last_prompt": info.get("last_prompt") or t["last_prompt"],
        "projects": info.get("projects", []),
        "topic": info.get("topic"),
        "domains": info.get("domains", []),
        "tickets": info.get("tickets", []),
        "sensitivity": info.get("sensitivity"),
        "human_turns": info.get("human_turns"),
        "cost_usd": info.get("cost_usd"),
        "cost_recorded_at": None,
        "cost_now": _cost_now(t["model"], t["total_usage"]),
        "cost_partial": False,
        "model": t["model"],
        "context_tokens": context,
        "context_window": t["window"] if context and t["window"] else None,
        "started_at": info.get("started_at") or meta.get("timestamp") or started,
        "process_started_at": started,
        "last_message_at": t["last_at"],
        "status_at": waited,          # the hook's time; Codex itself keeps no status time
        "reply_tail": active.markdown_tail(reply),
        "reply_len": len(reply),
        "reply_at": t["reply_at"],
        "progress": None,
        "prompt": active.markdown_tail(t["prompt"]) if t["prompt"] else None,
        "prompt_at": t["prompt_at"],
        "prompt_images": t["prompt_images"],
        "interrupted_at": t["interrupted_at"],
        "queued": (state.get("queued") or {}).get(sid, []),
        "tasks": codex_tail.plan_progress(t["plan"]),
        "progress_at": None,
    }


def list_live(conn: sqlite3.Connection, table: dict, run=None,
              home: str | None = None) -> list[dict]:
    """Cards of live interactive Codex threads; one per thread even if two processes hold it."""
    paths = codex_procs.rollouts_for(table, run=run, home=home)
    ids = sorted({sid for sid in map(codex_procs.thread_id, paths.values()) if sid})
    state = {"goals": codex_state.goals(ids, home), "queued": codex_state.queued(ids, home)}
    out, seen = [], set()
    for pid, path in sorted(paths.items()):
        made = card(conn, pid, path, table, state, home)
        if made and made["session_id"] not in seen:
            seen.add(made["session_id"])
            out.append(made)
    _last_live[:] = list(paths.values())
    return out


def _recent_rollouts(home: str) -> list[str]:
    """The newest rollouts of the last two date folders: any Codex run reports the account's limits."""
    days = sorted(glob.glob(os.path.join(glob.escape(home), "sessions", "*", "*", "*")))[-2:]
    files = [p for d in days for p in glob.glob(os.path.join(glob.escape(d), "rollout-*.jsonl"))]

    def mtime(p: str) -> float:
        try:
            return os.stat(p).st_mtime
        except OSError:
            return 0.0
    return sorted(files, key=mtime, reverse=True)[:RECENT_FILES]


def limits(home: str | None = None, now: float | None = None, live: bool = False) -> dict | None:
    """Codex's 5-hour and weekly limits: the newer of Codex's own answer (`codex_usage`, read when
    `live` asks for it) and the newest token count in live or recent rollouts."""
    home = home or index.codex_home()
    best = None
    for path in _last_live:
        t = codex_tail.read(path)
        if t["rate_limits"] and (best is None or (t["rate_limits_at"] or "") > (best["rate_limits_at"] or "")):
            best = t
    # Newest first; a run that failed on a spent limit reports empty windows, so look further back.
    for path in _recent_rollouts(home):
        t = codex_tail.read(path)
        if t["rate_limits"]:
            if best is None or (t["rate_limits_at"] or "") > (best["rate_limits_at"] or ""):
                best = t
            break
    seen = codex_tail.limit_windows(best["rate_limits"], best["rate_limits_at"], now) if best else None
    if seen:
        seen.update(source="rollout", live=False)
    asked = codex_usage.current(home, start=live, now=now)
    if asked and (not seen or (asked["captured_at"] or "") >= (seen["captured_at"] or "")):
        return asked
    return seen
