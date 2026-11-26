"""Two LLM-layer contracts: a short catalog description and a detailed handoff."""
from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import datetime, timezone

from . import actions, codex_exec, db, prompts, runner
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
            backend: str | None = None, model: str | None = None, *,
            payload: dict | None = None) -> dict:
    """First confirmation stage: show exactly what will be sent and where, before any call."""
    backend = backend or runner.artifact_backend()
    default_model, effort = runner.model_for(artifact_kind, backend)
    model = model or default_model
    payload = runner.preview_payload(conn, session_id, artifact_kind, payload=payload)
    sensitivity = runner.sensitivity_of(conn, session_id)
    fallback_model = runner.artifact_fallback(backend, sensitivity)
    return {
        "session_id": session_id,
        "artifact_kind": artifact_kind,
        "backend": backend,
        "agent_name": runner.agent_name(backend),
        "fallback_model": fallback_model,
        "fallback_effort": codex_exec.fallback_effort(effort) if fallback_model else None,
        "model_id": model,
        "effort": effort,
        "model": f"{runner.model_label(model, backend)} / {effort}",
        "sections": payload["sections"],
        "totals": payload["totals"],
        "budget": payload["budget"],
        "full_path": payload["full_path"],
        "is_local_backend": backend in runner.LOCAL_BACKENDS,
        "sensitivity": sensitivity,
        "excerpt_hash": payload["excerpt_hash"],
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
            backend: str | None = None, model: str | None = None, *, allow_fallback: bool = False,
            confirmed_payload: dict | None = None, fallback_effort: str | None = None,
            primary_effort: str | None = None, finish_job: bool = False) -> dict:
    """Second stage: the model call. The send permission is checked right here."""
    backend = backend or runner.artifact_backend()
    default_model, effort = runner.model_for(artifact_kind, backend)
    model = model or default_model
    effort = primary_effort or effort
    payload = confirmed_payload or runner.build_payload(conn, session_id, artifact_kind)
    runner.check_egress(conn, session_id, payload["content_hash"], artifact_kind, backend, model)
    if actions.is_cancelled(conn, job_id):
        raise RuntimeError(msg("enrich.cancelled"))

    template = prompts.summary() if artifact_kind == "catalog_summary" else prompts.handoff()
    schema = codex_exec.SUMMARY_SCHEMA if artifact_kind == "catalog_summary" else None
    original = payload

    def check_cancelled():
        if actions.is_cancelled(conn, job_id):
            raise RuntimeError(msg("enrich.cancelled"))

    def dispatch(excerpt, backend_name, model_name, effort_level, *, fallback=False):
        check_cancelled()
        if fallback and runner.sensitivity_of(conn, session_id) == "sensitive":
            raise runner.EgressDenied(msg("server.artifact_changed"))
        return runner.run_isolated(fill(template, excerpt["text"]), model=model_name, effort=effort_level,
                                   timeout=2400, backend_name=backend_name, schema=schema,
                                   before_send=check_cancelled)

    try:
        raw = dispatch(original, backend, model, effort)
    except runner.PromptTooLong:
        if backend != runner.CLAUDE_BACKEND and (confirmed_payload is not None or backend == runner.CODEX_BACKEND):
            raise
        if confirmed_payload is not None:
            payload = original.get("trimmed")
            if payload is None:
                raise
        else:
            payload = runner.build_payload(conn, session_id, artifact_kind, scale=0.6)
        if confirmed_payload is None and payload["content_hash"] != original["content_hash"]:
            raise runner.EgressDenied(msg("server.artifact_changed")) from None
        raw = dispatch(payload, backend, model, effort)
    except runner.ClaudeUsageLimit:
        if not allow_fallback or backend != runner.CLAUDE_BACKEND or actions.is_cancelled(conn, job_id):
            raise
        backend, model = runner.CODEX_BACKEND, runner.CLAUDE_LIMIT_FALLBACK_MODEL
        runner.check_egress(conn, session_id, original["content_hash"], artifact_kind, backend, model)
        raw = dispatch(original, backend, model, fallback_effort or codex_exec.fallback_effort(effort), fallback=True)

    conn.execute("BEGIN IMMEDIATE")
    with conn:
        check_cancelled()
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
        response = {"artifact_kind": artifact_kind, "payload": result, "path": stored_path}
        if finish_job:
            actions.set_job_state(conn, job_id, "done", result=json.dumps(response, ensure_ascii=False))
        else:
            conn.commit()
    return response


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
