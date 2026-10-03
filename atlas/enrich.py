"""Two LLM-layer contracts: a short catalog description and a detailed handoff."""
from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import datetime, timezone

from . import actions, db, prompts, runner
from .messages import msg

PROMPT_VERSION = 1

WORK_OUTCOMES = ("done", "blocked", "in_progress", "unknown")

# Prompt texts and required handoff sections live in prompts.py, in the language from settings.



def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def handoff_dir() -> str:
    """Defaults to app-data, not the project folder: an untracked file slips into a commit too easily."""
    path = os.path.join(db.atlas_home(), "handoffs")
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def cached(conn: sqlite3.Connection, session_id: str, artifact_kind: str) -> dict | None:
    row = conn.execute(
        "SELECT * FROM enrichment WHERE session_id=? AND artifact_kind=?",
        (session_id, artifact_kind),
    ).fetchone()
    if row is None:
        return None
    current = conn.execute(
        "SELECT content_hash FROM sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    fresh = (
        row["content_hash"] == (current["content_hash"] if current else None)
        and row["extractor_version"] == runner.EXTRACTOR_VERSION
        and row["prompt_version"] == PROMPT_VERSION
    )
    return {**dict(row), "fresh": fresh}


def _parse_summary(text: str) -> dict:
    """Broken model output is not patched with heuristics; it is marked as an error."""
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError(msg("enrich.no_json"))
    data = json.loads(match.group(0))
    if not isinstance(data, dict) or "did" not in data:
        raise ValueError(msg("enrich.no_did"))
    outcome = data.get("work_outcome")
    if outcome not in WORK_OUTCOMES:
        data["work_outcome"] = "unknown"
    return data


def _validate_handoff(text: str) -> str:
    missing = [s for s in prompts.HANDOFF_REQUIRED[prompts.lang()] if s not in text]
    if missing:
        raise ValueError(msg("enrich.handoff_missing", sections=", ".join(missing)))
    return text


def preview(conn: sqlite3.Connection, session_id: str, artifact_kind: str,
            backend: str = runner.EXTERNAL_BACKEND, model: str | None = None) -> dict:
    """First confirmation stage: show exactly what will be sent and where, before any call."""
    default_model, effort = runner.model_for(artifact_kind)
    model = model or default_model
    payload = runner.preview_payload(conn, session_id, artifact_kind)
    return {
        "session_id": session_id,
        "artifact_kind": artifact_kind,
        "backend": backend,
        "model": f"{model} / {effort}",
        "sections": payload["sections"],
        "totals": payload["totals"],
        "budget": payload["budget"],
        "full_path": payload["full_path"],
        "is_local_backend": backend in runner.LOCAL_BACKENDS,
        "sensitivity": runner.sensitivity_of(conn, session_id),
        "content_hash": payload["content_hash"],
        "chars": payload["chars"],
        "truncated": payload["truncated"],
        "text": payload["text"],
    }


def fill(template: str, text: str) -> str:
    """Inserts the excerpt by replace, not .format(): the "What was done" template has a JSON sample in {…},
    which format would treat as a replacement field (KeyError '"did"')."""
    return template.replace("{payload}", text)


def produce(conn: sqlite3.Connection, session_id: str, artifact_kind: str, job_id: str,
            backend: str = runner.EXTERNAL_BACKEND, model: str | None = None) -> dict:
    """Second stage: the model call. The send permission is checked right here."""
    default_model, effort = runner.model_for(artifact_kind)
    model = model or default_model
    payload = runner.build_payload(conn, session_id, artifact_kind)
    runner.check_egress(conn, session_id, payload["content_hash"], artifact_kind, backend, model)
    if actions.is_cancelled(conn, job_id):
        raise RuntimeError(msg("enrich.cancelled"))

    template = prompts.summary() if artifact_kind == "catalog_summary" else prompts.handoff()
    # A large handoff takes long: a million-token window is not read within a minute.
    try:
        raw = runner.run_isolated(fill(template, payload["text"]), model=model,
                                  effort=effort, timeout=2400)
    except runner.PromptTooLong:
        # Characters per token depend on language and content, so there is one retry with a trimmed input.
        payload = runner.build_payload(conn, session_id, artifact_kind, scale=0.6)
        raw = runner.run_isolated(fill(template, payload["text"]), model=model,
                                  effort=effort, timeout=2400)

    if artifact_kind == "catalog_summary":
        result = json.dumps(_parse_summary(raw), ensure_ascii=False)
        stored_path = None
    else:
        result = _validate_handoff(raw)
        stored_path = os.path.join(
            handoff_dir(), f"{datetime.now(timezone.utc):%Y-%m-%d}-{session_id[:8]}.md"
        )
        with open(stored_path, "w", encoding="utf-8") as fh:
            fh.write(result)
        os.chmod(stored_path, 0o600)

    conn.execute(
        "INSERT OR REPLACE INTO enrichment (session_id, artifact_kind, content_hash, "
        "extractor_version, prompt_version, model, backend, payload, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (session_id, artifact_kind, payload["content_hash"], runner.EXTRACTOR_VERSION,
         PROMPT_VERSION, model, backend, result, _now()),
    )
    conn.execute(
        "UPDATE egress_grants SET used_at=? WHERE session_id=? AND content_hash=? "
        "AND artifact_kind=?", (_now(), session_id, payload["content_hash"], artifact_kind),
    )
    conn.commit()
    return {"artifact_kind": artifact_kind, "payload": result, "path": stored_path}


def export_handoff(conn: sqlite3.Connection, session_id: str, destination_dir: str) -> str:
    """Export to a project is a separate explicit action; the target must be in the server allowlist."""
    art = cached(conn, session_id, "handoff")
    if not art or not art["payload"]:
        raise LookupError(msg("enrich.no_handoff"))
    os.makedirs(destination_dir, exist_ok=True)
    target = os.path.join(destination_dir, f"HANDOFF-{session_id[:8]}.md")
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(art["payload"])
    return target
