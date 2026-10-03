"""Session actions: resume commands and the job registry. Nothing runs silently."""
from __future__ import annotations

import json
import os
import re
import shlex
import sqlite3
import subprocess
import uuid
from datetime import datetime, timezone

from . import prompts
from .messages import msg

UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")


JOB_KINDS = ("catalog_summary", "handoff", "classification")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def valid_session_id(value: str) -> bool:
    return bool(value and UUID_RE.match(value))


def resume_cwd(conn: sqlite3.Connection, session_id: str) -> str | None:
    """The folder the session was started from, not the last cwd: Claude looks up a session by project."""
    row = conn.execute(
        "SELECT cwds, cwd_last, source_path FROM sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    if row is None:
        return None
    try:
        cwds = json.loads(row["cwds"] or "[]")
    except json.JSONDecodeError:
        cwds = []
    for candidate in cwds:                       # the first cwd is the one whose slug holds the transcript
        if candidate and os.path.isdir(candidate):
            return candidate
    return row["cwd_last"] if row["cwd_last"] and os.path.isdir(row["cwd_last"]) else None


def resume_command(cwd: str | None, session_id: str, fork: bool = False) -> str | None:
    """Every argument is POSIX-quoted: cd '<cwd>' breaks on an apostrophe in the path."""
    if not cwd or not valid_session_id(session_id):
        return None
    parts = ["claude", "--resume", session_id] + (["--fork-session"] if fork else [])
    return f"cd {shlex.quote(cwd)} && " + " ".join(shlex.quote(p) for p in parts)


def new_session_command(cwd: str | None, new_id: str, handoff_path: str) -> str | None:
    """The command carries the real first prompt, not just a promise of one in the docs."""
    if not cwd or not valid_session_id(new_id):
        return None
    prompt = prompts.resume(handoff_path)
    parts = ["claude", "--session-id", new_id, prompt]
    return f"cd {shlex.quote(cwd)} && " + " ".join(shlex.quote(p) for p in parts)


def open_in_terminal(cwd: str, command: str) -> tuple[bool, str]:
    """Requires the Automation permission in TCC. On denial, return an error instead of silence."""
    script = (
        'tell application "Terminal"\n'
        f"  do script {json.dumps(command)}\n"
        "  activate\n"
        "end tell"
    )
    try:
        proc = subprocess.run(["osascript", "-e", script], capture_output=True,
                              text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, msg("terminal.osascript_failed", error=exc)
    if proc.returncode != 0:
        hint = msg("terminal.automation_hint")
        return False, (proc.stderr.strip() or msg("terminal.osascript_error")) + hint
    return True, msg("terminal.sent")


# --- rename ---

MAX_TITLE = 200


def rename_session(conn: sqlite3.Connection, session_id: str, title: str,
                   write_to_transcript: bool = True) -> dict:
    """Writes the title to the catalog and, optionally, to the transcript itself.

    The only place that touches the transcript file. Only an append of one line in the same
    form Claude Code writes itself (`custom-title`): no rewriting and no truncation.
    """
    title = " ".join((title or "").split())[:MAX_TITLE]
    if not title:
        raise ValueError(msg("rename.empty"))
    if not valid_session_id(session_id):
        raise ValueError(msg("session_id.invalid"))

    conn.execute(
        "INSERT INTO user_overrides (session_id, title, updated_at) VALUES (?,?,datetime('now')) "
        "ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, updated_at=datetime('now')",
        (session_id, title),
    )
    conn.commit()

    written = False
    error = None
    if write_to_transcript:
        row = conn.execute(
            "SELECT source_path FROM sessions WHERE session_id=?", (session_id,)).fetchone()
        if row is None:
            error = msg("rename.no_transcript")
        else:
            try:
                line = json.dumps({"type": "custom-title", "customTitle": title,
                                   "sessionId": session_id}, ensure_ascii=False) + "\n"
                # One record in one call in append mode: a live session writes to this same
                # file, and its line must not be cut.
                with open(row["source_path"], "a", encoding="utf-8") as fh:
                    fh.write(line)
                written = True
            except OSError as exc:
                error = msg("rename.append_failed", error=exc)
    return {"title": title, "written_to_transcript": written, "error": error}


# --- job registry -----------------------------------------------------------

def claim_job(conn: sqlite3.Connection, session_id: str, action_kind: str,
              content_hash: str) -> tuple[str, bool]:
    """Returns (job_id, created). A repeated click returns the same job_id, not a second run."""
    row = conn.execute(
        "SELECT job_id FROM jobs WHERE session_id=? AND action_kind=? AND content_hash=? "
        "AND state IN ('queued','running')",
        (session_id, action_kind, content_hash),
    ).fetchone()
    if row:
        return row["job_id"], False
    job_id = uuid.uuid4().hex
    try:
        conn.execute(
            "INSERT INTO jobs (job_id, session_id, action_kind, content_hash, state, "
            "created_at, updated_at) VALUES (?,?,?,?,'queued',?,?)",
            (job_id, session_id, action_kind, content_hash, _now(), _now()),
        )
        conn.commit()
    except sqlite3.IntegrityError:               # race between two requests: the first one wins
        conn.rollback()
        row = conn.execute(
            "SELECT job_id FROM jobs WHERE session_id=? AND action_kind=? AND content_hash=? "
            "AND state IN ('queued','running')",
            (session_id, action_kind, content_hash),
        ).fetchone()
        return (row["job_id"] if row else job_id), False
    return job_id, True


def set_job_state(conn: sqlite3.Connection, job_id: str, state: str,
                  result: str | None = None, error: str | None = None) -> None:
    conn.execute(
        "UPDATE jobs SET state=?, result=COALESCE(?, result), error=COALESCE(?, error), "
        "updated_at=? WHERE job_id=?",
        (state, result, error, _now(), job_id),
    )
    conn.commit()


def get_job(conn: sqlite3.Connection, job_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
    return dict(row) if row else None


def cancel_job(conn: sqlite3.Connection, job_id: str) -> bool:
    """Cancel is an intent, not a process kill: the worker checks the flag itself."""
    cur = conn.execute(
        "UPDATE jobs SET state='cancel_requested', updated_at=? "
        "WHERE job_id=? AND state IN ('queued','running')",
        (_now(), job_id),
    )
    conn.commit()
    return cur.rowcount > 0


def is_cancelled(conn: sqlite3.Connection, job_id: str) -> bool:
    row = conn.execute("SELECT state FROM jobs WHERE job_id=?", (job_id,)).fetchone()
    return bool(row) and row["state"] == "cancel_requested"


# --- new session launch -----------------------------------------------------

def register_pending_launch(conn: sqlite3.Connection, source_session_id: str,
                            handoff_path: str) -> str:
    """derived_from appears only once the new session's transcript is actually found."""
    new_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO pending_launches (new_session_id, source_session_id, handoff_path, "
        "created_at) VALUES (?,?,?,?)",
        (new_id, source_session_id, handoff_path, _now()),
    )
    conn.commit()
    return new_id


def confirm_launches(conn: sqlite3.Connection) -> int:
    """Confirms the launches whose sessions have appeared in the catalog."""
    rows = conn.execute(
        "SELECT new_session_id FROM pending_launches WHERE confirmed_at IS NULL"
    ).fetchall()
    confirmed = 0
    for row in rows:
        exists = conn.execute(
            "SELECT 1 FROM sessions WHERE session_id=?", (row["new_session_id"],)
        ).fetchone()
        if exists:
            conn.execute(
                "UPDATE pending_launches SET confirmed_at=? WHERE new_session_id=?",
                (_now(), row["new_session_id"]),
            )
            confirmed += 1
    conn.commit()
    return confirmed


def lineage(conn: sqlite3.Connection, session_id: str) -> dict:
    derived_from = conn.execute(
        "SELECT source_session_id, handoff_path, confirmed_at FROM pending_launches "
        "WHERE new_session_id=?", (session_id,)
    ).fetchone()
    children = conn.execute(
        "SELECT new_session_id, confirmed_at FROM pending_launches WHERE source_session_id=?",
        (session_id,),
    ).fetchall()
    return {
        "derived_from": dict(derived_from) if derived_from else None,
        "derived": [dict(r) for r in children],
    }


def actions_for(conn: sqlite3.Connection, session_id: str) -> dict:
    """Everything a card needs: ready commands and warnings, without running anything."""
    cwd = resume_cwd(conn, session_id)
    row = conn.execute(
        "SELECT last_activity_at, content_hash FROM sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    warnings = []
    if cwd is None:
        warnings.append(msg("actions.no_workdir"))
    warnings.append(msg("actions.resume_copy"))
    return {
        "resume_cwd": cwd,
        "content_hash": row["content_hash"] if row else None,
        "resume_command": resume_command(cwd, session_id),
        "fork_command": resume_command(cwd, session_id, fork=True),
        "can_open_terminal": cwd is not None,
        "warnings": warnings,
        "lineage": lineage(conn, session_id),
    }
