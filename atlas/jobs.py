"""Claude Code background jobs (2.1.289+): a session that runs in one opens with `claude attach`.

`claude --resume <id>` refuses a session whose job still runs ("run `claude attach <job>`"). The job
is found by its process file (`kind: bg`, `jobId`), for the job's own session, for the parent whose
file names it (`parkedJobId`) and for the parent whose transcript continued in it (`continued_in`).
A tab showing a job runs the attach client, `claude attach <job>`; the job's process lives under
Claude Code's daemon, so the tab is found by the client.
"""
from __future__ import annotations

import re
import shlex
import sqlite3

from . import active

JOB_ID_RE = re.compile(r"^[0-9a-f]{8}$")
ATTACH_RE = re.compile(r"^(?:\S*/)?claude attach ([0-9a-f]{8})$")


def running_jobs(files: list[dict], table: dict) -> dict[str, dict]:
    """Live background jobs by job id; a spare (a process kept warm for the next job) is not one."""
    return {job: d for job, d in active.alive_jobs(files, table).items()
            if JOB_ID_RE.match(job) and d.get("kind") == "bg" and d.get("spare") is not True}


def attach_clients(table: dict) -> dict[str, int]:
    """Job id → pid of a `claude attach <job>` process: the tab that shows the job."""
    out = {}
    for pid, row in table.items():
        m = ATTACH_RE.match(row[2].strip()) if len(row) > 2 else None
        if m:
            out.setdefault(m.group(1), pid)
    return out


def live_job(conn: sqlite3.Connection | None, session_id: str, sessions_dir: str | None = None,
             table: dict | None = None) -> dict | None:
    """The running job a session goes on in, or None: {job_id, session_id, cwd}."""
    files = active._read_files(sessions_dir or active.SESSIONS_DIR)
    jobs = running_jobs(files, active.process_table() if table is None else table)
    if not jobs:
        return None
    wanted = {str(d.get("parkedJobId")) for d in files
              if str(d["sessionId"]) == session_id and d.get("parkedJobId")}
    sessions = {session_id}
    if conn is not None:
        row = conn.execute("SELECT continued_in FROM sessions WHERE session_id=?", (session_id,)).fetchone()
        if row and row["continued_in"]:
            sessions.add(row["continued_in"])
    for job, d in sorted(jobs.items()):
        if job in wanted or str(d["sessionId"]) in sessions:
            return {"job_id": job, "session_id": str(d["sessionId"]), "cwd": d.get("cwd")}
    return None


def attach_command(cwd: str | None, job_id: str) -> str | None:
    if not cwd or not JOB_ID_RE.match(job_id or ""):
        return None
    return f"cd {shlex.quote(cwd)} && claude attach {job_id}"
