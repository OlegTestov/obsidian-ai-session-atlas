"""Active sessions: live Claude Code processes found via `~/.claude/sessions/<pid>.json`.

Live Codex threads come from `codex_live` and get cards with the same keys.

The transcript does not show if a session is open (`lsof` is empty: each write opens and closes it).
Claude Code writes a file per process with `sessionId`, `startedAt`, `kind` and `status`.
The file outlives its process, so liveness is checked by PID and the process start time.
"""
from __future__ import annotations

import glob
import json
import os
import re
import sqlite3
import subprocess
import time
from datetime import datetime, timedelta, timezone

from . import codex_parse, codex_procs, codex_tail, costs, paths, prompt_queue, search, tasks
from .parse import COMPACT_PREFIX
from .resolve import HEADLESS_ENTRYPOINTS

SESSIONS_DIR = os.environ.get("ATLAS_CLAUDE_SESSIONS", os.path.join(paths.claude_dir(), "sessions"))
TAIL_BYTES = 256 * 1024     # the last message is searched in the tail, not the whole file
MAX_ANCESTORS = 32


def process_table() -> dict[int, tuple]:
    """pid → (ppid, start time, command). `TZ=UTC`: Claude Code writes `procStart` in UTC."""
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,lstart=,command="], capture_output=True,
                         text=True, env=dict(os.environ, TZ="UTC", LC_ALL="C"), timeout=10).stdout
    table = {}
    for line in out.splitlines():
        parts = line.split(None, 7)          # pid, ppid, 5 lstart fields, command
        if len(parts) >= 7 and parts[0].isdigit() and parts[1].isdigit():
            table[int(parts[0])] = (int(parts[1]), " ".join(parts[2:7]),
                                    parts[7] if len(parts) > 7 else "")
    return table


# A Claude Code background command (Monitor, background Bash) is a child shell with an env snapshot.
# MCP servers are child processes too, but they run their own command.
SHELL_TASK_MARK = "/.claude/shell-snapshots/snapshot-"
AGENT_FRESH_SECONDS = 90       # a subagent writes its transcript while it works


def shell_tasks(pid: int, table: dict) -> int:
    return sum(1 for child, row in table.items()
               if row[0] == pid and len(row) > 2 and SHELL_TASK_MARK in row[2])


def live_subagents(*transcripts: str | None, now: float | None = None) -> int:
    """Subagents writing right now. A parked conversation's job links the subagents running at
    the hand-over to the parent's files, so one file is counted once."""
    now = now or time.time()
    fresh = set()
    for transcript in transcripts:
        if not transcript:
            continue
        folder = os.path.join(transcript[:-len(".jsonl")], "subagents")
        for path in glob.glob(os.path.join(glob.escape(folder), "*.jsonl")):
            try:
                if now - os.stat(path).st_mtime < AGENT_FRESH_SECONDS:
                    fresh.add(os.path.realpath(path))
            except OSError:
                continue
    return len(fresh)


# What wakes a session without you: /loop (ScheduleWakeup, CronCreate) and /goal.
_SCHEDULE_MARKS = (b'"ScheduleWakeup"', b'"CronCreate"', b'"CronDelete"', b'goal_status')
SCHEDULE_TAIL = 4 * 1024 * 1024


_schedule_cache: dict[str, tuple] = {}     # path → (inode, size, wakeup, cron, goal)


def _marked_lines(blob: bytes):
    """Only lines with markers, found by byte search without splitting the whole tail into lines."""
    starts = set()
    for mark in _SCHEDULE_MARKS:
        pos = blob.find(mark)
        while pos >= 0:
            starts.add(blob.rfind(b"\n", 0, pos) + 1)
            pos = blob.find(mark, pos + len(mark))
    for start in sorted(starts):
        end = blob.find(b"\n", start)
        yield blob[start:end if end >= 0 else len(blob)]


def schedule_state(path: str | None, now: float | None = None) -> dict:
    """The /loop wakeup, live cron jobs and the active /goal, read from the transcript tail."""
    out = {"wake_at": None, "crons": 0, "goal": None}
    if not path:
        return out
    try:
        st = os.stat(path)
    except OSError:
        return out
    cached = _schedule_cache.get(path)
    if cached and cached[:2] == (st.st_ino, st.st_size):
        wake, crons, goal = cached[2:]
    else:
        try:
            with open(path, "rb") as fh:
                fh.seek(max(0, st.st_size - SCHEDULE_TAIL))
                tail = fh.read()
        except OSError:
            return out
        wake, crons, goal = None, 0, None
        for raw in _marked_lines(tail):
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            attachment = rec.get("attachment")
            if isinstance(attachment, dict) and attachment.get("type") == "goal_status":
                goal = attachment.get("condition") if attachment.get("met") is False else None
                continue
            for block in ((rec.get("message") or {}).get("content") or []):
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                args = block.get("input") or {}
                if block.get("name") == "ScheduleWakeup":
                    at = _as_datetime(rec.get("timestamp")).timestamp()
                    wake = None if args.get("stop") else at + float(args.get("delaySeconds") or 0)
                elif block.get("name") == "CronCreate":
                    crons += 1
                elif block.get("name") == "CronDelete":
                    crons = max(0, crons - 1)
        _schedule_cache[path] = (st.st_ino, st.st_size, wake, crons, goal)
    now = now or time.time()
    if wake and wake > now:
        out["wake_at"] = datetime.fromtimestamp(wake, tz=timezone.utc).isoformat()
    out["crons"], out["goal"] = crons, goal
    return out


def activity(status: str | None, background: dict) -> str:
    """busy: taking a turn; background: done, background work wakes it; waiting: a dialog."""
    if status in ("busy", "shell"):
        return "busy"
    if status == "waiting":
        return "waiting"
    if background["shells"] or background["agents"] or background["wake_at"] \
            or background["crons"]:
        return "background"
    return "idle"


def _alive(pid: int, proc_start: str | None, table: dict) -> bool:
    """PIDs get reused: the start time must match too, otherwise it is another process."""
    if pid not in table:
        return False
    return proc_start is None or table[pid][1] == " ".join(proc_start.split())


def alive_jobs(files: list[dict], table: dict) -> dict[str, dict]:
    """Background jobs (`kind: bg`) by their short id, only those whose process still runs."""
    return {str(d["jobId"]): d for d in files
            if d.get("jobId") and _alive(d["pid"], d.get("procStart"), table)}


def parked_job(data: dict, jobs: dict) -> dict | None:
    """Claude Code 2.1.289+ parks a session: the work goes on in a background job with its own
    process, session file and transcript, while the tab's own file says `idle`."""
    job_id = data.get("parkedJobId")
    return jobs.get(str(job_id)) if job_id else None


def parked_status(own: dict, job: dict | None) -> tuple:
    """(status, waitingFor) of a card: a dialog in either process blocks typing, then work."""
    if job is None:
        return own.get("status"), own.get("waitingFor") if own.get("status") == "waiting" else None
    for data in (job, own):
        if data.get("status") == "waiting":
            return "waiting", data.get("waitingFor")
    for data in (job, own):
        if data.get("status") in ("busy", "shell"):
            return data["status"], None
    return job.get("status") or own.get("status"), None


def _newer(job_found: dict, own_found: dict) -> bool:
    return _as_datetime(job_found["last_at"]) >= _as_datetime(own_found["last_at"])


def live_transcript(conn: sqlite3.Connection, session_id: str, projects_root: str | None = None,
                    sessions_dir: str | None = None, table: dict | None = None) -> str | None:
    """The transcript a card reads: a parked session's job when it has the newer messages."""
    from .index import PROJECTS_ROOT
    projects_root = projects_root or PROJECTS_ROOT
    path = _transcript(conn, session_id, projects_root)
    files = _read_files(sessions_dir or SESSIONS_DIR)
    own = next((d for d in files if str(d["sessionId"]) == session_id and d.get("parkedJobId")),
               None)
    if own is None:
        return path
    job = parked_job(own, alive_jobs(files, process_table() if table is None else table))
    job_path = _transcript(conn, str(job["sessionId"]), projects_root) if job else None
    if job_path and _newer(last_messages(job_path), last_messages(path)):
        return job_path
    return path


def ancestors(pid: int, table: dict) -> list[int]:
    """Parent chain: the page uses it to find the terminal tab the session lives in."""
    chain, seen = [], {pid}
    current = table.get(pid, (0, ""))[0]
    while current > 1 and current not in seen and len(chain) < MAX_ANCESTORS:
        chain.append(current)
        seen.add(current)
        current = table.get(current, (0, ""))[0]
    return chain


def _iso_ms(ms) -> str | None:
    if not isinstance(ms, (int, float)):
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


# Not conversation messages: written by the machinery around, not by a human or Claude's reply.
NOT_A_MESSAGE = ("Another Claude session sent a message", "<task-notification>",
                 "<teammate-message", COMPACT_PREFIX,
                 # Wrappers around commands: /goal output, hook notes, CLI warnings.
                 "<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>",
                 "A session-scoped Stop hook is now active", "Caveat: The messages below",
                 "[Request interrupted by user")
# Esc in the tab or "Stop" on the card: Claude Code writes this as a user record. Not a message, but
# after it your request no longer "awaits a reply": it is interrupted.
INTERRUPTED = "[Request interrupted by user"
_COMMAND_RE = re.compile(r"<command-name>\s*(/?[^<\s]+)\s*</command-name>")
_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)
_PASTED_RE = re.compile(r"</?pasted_content[^>]*>")
TAIL_MAX = 8 * 1024 * 1024     # search stops here: a live session has a message closer to the end


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text") or "" for b in content
                        if isinstance(b, dict) and b.get("type") == "text")
    return ""


def prompt_text(content) -> str:
    """Your message for the card: a slash command as you typed it, without service tags."""
    # Claude Code wraps pasted text in tags; show the text itself.
    text = _PASTED_RE.sub("", _text_of(content)).strip()
    m = _COMMAND_RE.search(text)
    if m:
        name = m.group(1) if m.group(1).startswith("/") else "/" + m.group(1)
        args = _ARGS_RE.search(text)
        return name + (" " + args.group(1).strip() if args and args.group(1).strip() else "")
    return text


def _images_in(content) -> int:
    if not isinstance(content, list):
        return 0
    return sum(1 for b in content if isinstance(b, dict) and b.get("type") == "image")


def is_message(rec: dict) -> bool:
    """A conversation message: your request or a text reply from Claude.

    Tool results, subagent notifications and compaction summaries are appended without you;
    counting them would make "last message" show "just now" for a session where nobody wrote.
    """
    kind = rec.get("type")
    if kind not in ("user", "assistant") or not isinstance(rec.get("timestamp"), str):
        return False
    if rec.get("isMeta") or rec.get("isSidechain"):
        return False
    text = _text_of((rec.get("message") or {}).get("content")).strip()
    if not text:
        return False                          # tool_use, tool_result, thinking
    return kind == "assistant" or not text.startswith(NOT_A_MESSAGE)


PREVIEW_CHARS = 1000         # how much of Claude's last reply the card shows


def _progress_of(rec: dict) -> str | None:
    if rec.get("type") != "assistant" or rec.get("isSidechain"):
        return None
    content = (rec.get("message") or {}).get("content")
    if not isinstance(content, list):
        return None
    notes = [b.get("thinking") or "" for b in content
             if isinstance(b, dict) and b.get("type") == "thinking"]
    text = " ".join(n.strip() for n in notes if n.strip())
    return text or None


def last_messages(path: str | None) -> dict:
    """Time of the last message and Claude's last text reply, read from the transcript tail.

    The index lags behind, so the file itself is read. Message: see `is_message`.
    """
    out = {"last_at": None, "reply": None, "reply_at": None, "progress": None,
           "progress_at": None, "prompt": None, "prompt_at": None, "prompt_images": 0,
           "interrupted_at": None}
    if not path:
        return out
    if codex_parse.session_id_of(path):
        found = codex_tail.read(path)
        return {k: found[k] for k in out}
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            window = TAIL_BYTES
            while True:
                fh.seek(max(0, size - window))
                for raw in reversed(fh.read().split(b"\n")):
                    try:
                        rec = json.loads(raw)
                    except ValueError:
                        continue      # first line of the window is cut; the last may be mid-write
                    if not isinstance(rec, dict):
                        continue
                    # Opus 5.5 writes notes between tool calls as thinking blocks with text:
                    # for a working session this is "what it is doing now".
                    if out["progress"] is None:
                        note = _progress_of(rec)
                        if note:
                            out["progress"], out["progress_at"] = note, rec.get("timestamp")
                    if out["last_at"] is None and out["interrupted_at"] is None \
                            and rec.get("type") == "user" and _text_of(
                                (rec.get("message") or {}).get("content")).startswith(INTERRUPTED):
                        out["interrupted_at"] = rec.get("timestamp")
                    if not is_message(rec):
                        continue
                    if out["last_at"] is None:
                        out["last_at"] = rec["timestamp"]
                    # Your message after Claude's last reply: Claude has not answered it yet.
                    if rec["type"] == "user" and out["prompt"] is None:
                        content = (rec.get("message") or {}).get("content")
                        out["prompt"] = prompt_text(content)
                        out["prompt_at"] = rec["timestamp"]
                        out["prompt_images"] = _images_in(content)
                    if rec["type"] == "assistant":
                        out["reply"] = _text_of((rec.get("message") or {}).get("content")).strip()
                        out["reply_at"] = rec["timestamp"]
                        return out
                if window >= size or window >= TAIL_MAX:
                    return out
                window *= 4           # a tail made only of tool calls: look deeper
    except OSError:
        return out


def last_message_at(path: str | None) -> str | None:
    return last_messages(path)["last_at"]


FENCE = "```"


def markdown_tail(text: str, limit: int = PREVIEW_CHARS) -> str:
    """The reply tail for the card, cut so that its Markdown does not break.

    Cuts at a line start, not mid-word or inside `**bold**`; if the cut lands inside a
    code block, the block is reopened, otherwise the rest of the reply would render as code.
    """
    if len(text) <= limit:
        return text
    cut = len(text) - limit
    line = text.find("\n", cut)
    if 0 <= line < len(text) - 1:
        cut = line + 1
    head = text[:cut]
    fences = sum(1 for ln in head.splitlines() if ln.lstrip().startswith(FENCE))
    tail = text[cut:]
    return (FENCE + "\n" + tail) if fences % 2 else tail


def last_reply(conn: sqlite3.Connection, session_id: str) -> dict | None:
    """Claude's full last reply, for "show in full" on the card."""
    path = live_transcript(conn, session_id)
    if not path:
        return None
    found = last_messages(path)
    return {"session_id": session_id, "text": found["reply"] or "", "at": found["reply_at"]}


def _transcript(conn: sqlite3.Connection, session_id: str, projects_root: str) -> str | None:
    row = conn.execute("SELECT source_path FROM sessions WHERE session_id=?",
                       (session_id,)).fetchone()
    if row and row["source_path"] and os.path.exists(row["source_path"]):
        return row["source_path"]
    found = glob.glob(os.path.join(glob.escape(projects_root), "*", session_id + ".jsonl"))
    # A Codex thread not indexed yet: its rollout is looked up by the thread id.
    return found[0] if found else codex_procs.find_rollout(session_id)


def _read_files(sessions_dir: str) -> list[dict]:
    out = []
    for path in glob.glob(os.path.join(glob.escape(sessions_dir), "*.json")):
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and isinstance(data.get("pid"), int) and data.get("sessionId"):
            out.append(data)
    return out


def is_interactive(data: dict) -> bool:
    """Background runs (`claude -p`, SDK, reviewers, hooks) are not human tabs."""
    return data.get("kind") == "interactive" and data.get("entrypoint") not in HEADLESS_ENTRYPOINTS


def list_active(conn: sqlite3.Connection, sessions_dir: str | None = None,
                projects_root: str | None = None, table: dict | None = None,
                run=None, codex_home: str | None = None) -> list[dict]:
    """Live interactive sessions of both agents, the one with the most recent message first."""
    # Both build on this module's helpers.
    from . import codex_live, jobs as bg_jobs
    from .index import PROJECTS_ROOT
    sessions_dir = sessions_dir or SESSIONS_DIR
    projects_root = projects_root or PROJECTS_ROOT
    table = process_table() if table is None else table
    out = []
    files = _read_files(sessions_dir)
    jobs = alive_jobs(files, table)
    for data in files:
        if is_interactive(data) and _alive(data["pid"], data.get("procStart"), table):
            out.append(_claude_card(conn, data, jobs, table, projects_root))
    # A job whose tab closed runs on; `claude attach` shows it in a tab again, and the card follows
    # that tab's attach client (the job's own process lives under Claude Code's daemon).
    parked = {str(d.get("parkedJobId")) for d in files if d.get("parkedJobId")
              and is_interactive(d) and _alive(d["pid"], d.get("procStart"), table)}
    clients = bg_jobs.attach_clients(table)
    for job_id, data in sorted(bg_jobs.running_jobs(files, table).items()):
        if job_id in clients and job_id not in parked:
            out.append(_claude_card(conn, data, jobs, table, projects_root, tab_pid=clients[job_id]))
    out += codex_live.list_live(conn, table, run=run, home=codex_home)
    out.sort(key=lambda s: _as_datetime(s["last_message_at"]), reverse=True)
    return out


def _claude_card(conn: sqlite3.Connection, data: dict, jobs: dict, table: dict, projects_root: str,
                 tab_pid: int | None = None) -> dict:
    """A Claude Code card. tab_pid: the process in the tab when it is not the session's own (attach)."""
    from .relocate import host_app  # relocate itself depends on this module
    pid = data["pid"]
    sid = str(data["sessionId"])
    meta = search._load_session(conn, sid) or {}
    path = _transcript(conn, sid, projects_root)
    found = last_messages(path)
    # Parked: the job is this card's work; its transcript copies the parent's and goes on.
    job = parked_job(data, jobs)
    job_sid = str(job["sessionId"]) if job else None
    job_path = _transcript(conn, job_sid, projects_root) if job else None
    live_sid, live_path = sid, path
    if job_path:
        job_found = last_messages(job_path)
        if _newer(job_found, found):
            found, live_sid, live_path = job_found, job_sid, job_path
    tail = found["last_at"]
    reply = found["reply"] or ""
    cost = costs.parked_cost(path, job_path) if job_path else costs.session_cost(path)
    plan = schedule_state(live_path)
    status, waiting_for = parked_status(data, job)
    background = {"shells": shell_tasks(pid, table) + (shell_tasks(job["pid"], table) if job else 0),
                  "agents": live_subagents(path, job_path),
                  "wake_at": plan["wake_at"], "crons": plan["crons"], "goal": plan["goal"]}
    # The index is not mixed in: its last_activity_at also counts service records.
    last = tail
    return {
        "session_id": sid,
        "agent": "claude",
        # The process in the tab: input from the card goes there, the tab is found by its parents.
        "pid": tab_pid or pid,
        "ancestors": ancestors(tab_pid or pid, table),
        "host_app": host_app(tab_pid or pid, table),
        "status": status,
        "activity": activity(status, background),
        "background": background,
        # waiting: a dialog is open (a multiple-choice question, a command permission).
        "waiting_for": waiting_for,
        # A parked session's background job and the transcript the card reads.
        "job_session_id": job_sid,
        "transcript_session_id": live_sid,
        "cwd": data.get("cwd"),
        "indexed": bool(meta),
        "title": meta.get("title") or data.get("name") or sid[:8],
        "card_line": meta.get("card_line"),
        "last_prompt": meta.get("last_prompt"),
        "projects": meta.get("projects", []),
        "topic": meta.get("topic"),
        "domains": meta.get("domains", []),
        "tickets": meta.get("tickets", []),
        "sensitivity": meta.get("sensitivity"),
        "human_turns": meta.get("human_turns"),
        # Recorded by Claude Code on exit (as of a date) and the current estimate from tokens.
        "cost_usd": cost["recorded"] if cost["recorded"] is not None else meta.get("cost_usd"),
        "cost_recorded_at": cost["recorded_at"],
        "cost_now": cost["now"],
        "cost_partial": cost["partial"],
        "model": cost["context_model"],
        "context_tokens": cost["context_tokens"],
        "context_window": costs.context_window(cost["context_model"], cost["context_tokens"])
        if cost["context_tokens"] else None,
        "started_at": meta.get("started_at") or _iso_ms(data.get("startedAt")),
        "process_started_at": _iso_ms(data.get("startedAt")),
        "last_message_at": last,
        # Reply tail: a question to you is usually at the end; the start reports work done.
        "reply_tail": markdown_tail(reply),
        "reply_len": len(reply),
        "reply_at": found["reply_at"],
        "progress": (found["progress"] or "")[-PREVIEW_CHARS:] or None,
        "prompt": markdown_tail(found["prompt"]) if found["prompt"] else None,
        "prompt_at": found["prompt_at"],
        "prompt_images": found["prompt_images"],
        "interrupted_at": found["interrupted_at"],
        "queued": prompt_queue.queued_messages(live_path),
        "tasks": (tasks.progress(job_sid) if job_sid else None) or tasks.progress(sid),
        "progress_at": found["progress_at"],
    }


RECENT_HOURS = 8
RECENT_LIMIT = 8


def recently_closed(conn: sqlite3.Connection, live_ids: set[str], now: datetime | None = None,
                    hours: int = RECENT_HOURS, limit: int = RECENT_LIMIT,
                    agents: list[str] | None = None) -> list[dict]:
    """Interactive sessions with work in the last few hours whose process has already exited.

    The "Active" card disappears with the process; from here one button returns to the session
    without searching for it.
    """
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(hours=hours)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    picked = f" AND s.agent IN ({','.join('?' * len(agents))})" if agents else ""
    # A parked conversation is one entry: its job while the parent's card is live, then the job
    # (resuming it opens the whole conversation), not the parent it was handed over from.
    rows = conn.execute(
        f"""SELECT s.session_id, s.agent, COALESCE(u.title, s.title) AS title, s.last_activity_at,
                  s.human_turns, s.cost_usd, s.cwd_last, s.continued_from,
                  (SELECT c.summary FROM classification c WHERE c.session_id = s.session_id) AS summary
             FROM sessions s LEFT JOIN user_overrides u ON u.session_id = s.session_id
            WHERE s.session_kind = 'interactive' AND s.last_activity_at >= ?{picked}
              AND NOT EXISTS (SELECT 1 FROM sessions j WHERE j.session_id = s.continued_in)
            ORDER BY s.last_activity_at DESC LIMIT ?""",
        (cutoff, *(agents or []), limit + len(live_ids))).fetchall()
    out = [dict(r) for r in rows
           if r["session_id"] not in live_ids and r["continued_from"] not in live_ids]
    for r in out:
        del r["continued_from"]
    return out[:limit]


def _as_datetime(value: str | None) -> datetime:
    if not value:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
