"""Hourly: topic, description line and "What was done" for new and changed sessions.

Off until explicitly enabled: every session goes to Claude (batch classification and
"What was done" one by one) and uses the same weekly subscription quota as interactive work.

"Changed" means new messages appeared since the last pass: the "human turns : agent records"
signature from the index is compared with the one stored in `auto_marks`. Already classified
sessions without a mark are only recorded on the first pass, otherwise it would redo the whole
catalog at once. Sessions younger than half an hour wait: early on there is nothing to judge.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import threading
import time
import traceback
from datetime import datetime, timezone

from . import actions, classify, db, enrich, messages, runner

KEY_ENABLED = "auto_classify"
KEY_LAST = "auto_classify_last"
INTERVAL_SECONDS = 3600
MIN_AGE_SECONDS = 1800
MAX_PER_RUN = 8               # sessions per pass, fully: topic and "What was done"
TICK_SECONDS = 60
SUMMARY_KIND = "catalog_summary"

def _meta(conn: sqlite3.Connection, key: str) -> str | None:
    return db.get_meta(conn, key)


def _set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    db.set_meta(conn, key, value)
    conn.commit()


def enabled(conn: sqlite3.Connection) -> bool:
    return _meta(conn, KEY_ENABLED) == "1"


def set_enabled(conn: sqlite3.Connection, on: bool) -> dict:
    _set_meta(conn, KEY_ENABLED, "1" if on else "0")
    return status(conn)


def status(conn: sqlite3.Connection, now: float | None = None) -> dict:
    last = _meta(conn, KEY_LAST)
    last_at = float(last) if last else None
    on = enabled(conn)
    return {
        "enabled": on,
        "last_run": _iso(last_at),
        "next_run": _iso(max(last_at + INTERVAL_SECONDS, now or time.time())
                         if last_at else (now or time.time())) if on else None,
        "interval_minutes": INTERVAL_SECONDS // 60,
        "max_per_run": MAX_PER_RUN,
    }


def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def _ensure_marks(conn: sqlite3.Connection) -> None:
    # Not in DERIVED: survives rebuild, otherwise everything would look changed after a rebuild.
    conn.execute("CREATE TABLE IF NOT EXISTS auto_marks (session_id TEXT PRIMARY KEY, "
                 "turns_sig TEXT NOT NULL, marked_at TEXT NOT NULL)")


def _mark(conn: sqlite3.Connection, session_id: str, sig: str) -> None:
    conn.execute("INSERT OR REPLACE INTO auto_marks VALUES (?,?,?)",
                 (session_id, sig, datetime.now(timezone.utc).isoformat(timespec="seconds")))
    conn.commit()


def candidates(conn: sqlite3.Connection, now: float | None = None) -> list[tuple[str, str]]:
    """[(id, signature)]: unclassified or with new messages. Most recently active first."""
    _ensure_marks(conn)
    # Transcript timestamps look like `2026-09-27T18:42:01.304Z`: strings are compared in that form.
    cutoff = datetime.fromtimestamp((now or time.time()) - MIN_AGE_SECONDS,
                                    timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    rows = conn.execute(
        """SELECT s.session_id AS sid,
                  COALESCE(s.human_turns, 0) || ':' || COALESCE(s.machine_turns, 0) AS sig,
                  EXISTS (SELECT 1 FROM classification c WHERE c.session_id = s.session_id) AS done,
                  m.turns_sig AS seen
             FROM sessions s LEFT JOIN auto_marks m ON m.session_id = s.session_id
            WHERE s.session_kind = 'interactive' AND s.started_at <= ?
              AND COALESCE((SELECT sensitivity FROM user_overrides u
                             WHERE u.session_id = s.session_id), s.sensitivity_rule,
                            'unclassified') != 'sensitive'
            ORDER BY s.last_activity_at DESC""", (cutoff,)).fetchall()
    out = []
    for r in rows:
        if r["done"] and r["seen"] is None:
            _mark(conn, r["sid"], r["sig"])          # first sighting: record, do not recompute
        elif not r["done"] or r["seen"] != r["sig"]:
            out.append((r["sid"], r["sig"]))
    return out[:MAX_PER_RUN]


def summarize(conn: sqlite3.Connection, session_id: str, job_id: str) -> None:
    """Builds "What was done" the same way as the button: grant for this session state, then call."""
    model, _ = runner.model_for(SUMMARY_KIND)
    payload = runner.build_payload(conn, session_id, SUMMARY_KIND)
    runner.grant_egress(conn, session_id, payload["content_hash"], SUMMARY_KIND,
                        runner.EXTERNAL_BACKEND, model)
    enrich.produce(conn, session_id, SUMMARY_KIND, job_id)


def _job_running(conn: sqlite3.Connection) -> bool:
    return conn.execute("SELECT 1 FROM jobs WHERE action_kind='classification' "
                        "AND state IN ('queued','running') LIMIT 1").fetchone() is not None


def tick(conn: sqlite3.Connection, now: float | None = None, run=None, summary=None) -> dict | None:
    """One scheduler step. None means not now (disabled, too early, or a classification is running)."""
    now = now or time.time()
    if not enabled(conn) or not runner.llm_enabled() or _job_running(conn):
        return None
    last = _meta(conn, KEY_LAST)
    if last and now - float(last) < INTERVAL_SECONDS:
        return None
    _set_meta(conn, KEY_LAST, repr(now))      # also on an empty pass: next one in an hour
    found = candidates(conn, now)
    if not found:
        return {"classified": 0, "summaries": 0, "candidates": 0}
    ids = [sid for sid, _ in found]
    job_id, created = actions.claim_job(conn, "batch", "classification", f"auto-{len(ids)}-{now}")
    if not created:
        return None
    run = run or classify.classify_batch
    summary = summary or summarize
    actions.set_job_state(conn, job_id, "running")
    try:
        result = run(conn, ids, job_id=job_id)
    except Exception as exc:
        actions.set_job_state(conn, job_id, "failed", error=f"{type(exc).__name__}: {exc}")
        return {"classified": 0, "summaries": 0, "candidates": len(ids), "error": str(exc)}
    done, errors = 0, list(result.get("errors") or [])
    for sid, sig in found:
        if actions.is_cancelled(conn, job_id):
            break
        try:
            summary(conn, sid, job_id)
            done += 1
        except Exception as exc:
            errors.append(messages.msg("auto.summary_failed", sid=sid[:8],
                                       error=f"{type(exc).__name__}: {exc}"))
        _mark(conn, sid, sig)                  # on failure, retry when the session has something new
    out = dict(result, summaries=done, candidates=len(ids), errors=errors[:8])
    actions.set_job_state(conn, job_id, "done", result=json.dumps(out, ensure_ascii=False))
    return out


def start_scheduler(stop: threading.Event | None = None) -> threading.Thread:
    """Background server thread: checks once a minute whether a run is due."""
    stop = stop or threading.Event()

    def loop() -> None:
        while not stop.wait(TICK_SECONDS):
            try:
                # The scheduler has no request of its own: errors use the language of the page's last request.
                messages.set_lang(messages.last_lang(), remember=False)
                conn = db.connect()
                try:
                    tick(conn)
                finally:
                    conn.close()
            except Exception:                  # the scheduler must not crash the server
                traceback.print_exc(file=sys.stderr)
                continue

    thread = threading.Thread(target=loop, name="auto-classify", daemon=True)
    thread.start()
    return thread
