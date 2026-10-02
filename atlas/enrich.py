"""Два контракта LLM-слоя: короткое описание для каталога и подробный хендофф."""
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

# Тексты запросов и обязательные разделы хендоффа — в prompts.py, на языке из настроек.



def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def handoff_dir() -> str:
    """По умолчанию app-data, а не папка проекта: untracked-файл слишком легко уезжает в коммит."""
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
    """Битый вывод модели не чиним эвристиками — помечаем ошибкой."""
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
    """Первая стадия подтверждения: показать, что именно уйдёт и куда, до всякого вызова."""
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
    """Выдержка в шаблон заменой, а не .format(): в шаблоне «Что сделано» образец JSON в {…},
    и format принимал его за поле подстановки (KeyError '"did"')."""
    return template.replace("{payload}", text)


def produce(conn: sqlite3.Connection, session_id: str, artifact_kind: str, job_id: str,
            backend: str = runner.EXTERNAL_BACKEND, model: str | None = None) -> dict:
    """Вторая стадия: вызов модели. Разрешение на отправку проверяется здесь же."""
    default_model, effort = runner.model_for(artifact_kind)
    model = model or default_model
    payload = runner.build_payload(conn, session_id, artifact_kind)
    runner.check_egress(conn, session_id, payload["content_hash"], artifact_kind, backend, model)
    if actions.is_cancelled(conn, job_id):
        raise RuntimeError(msg("enrich.cancelled"))

    template = prompts.summary() if artifact_kind == "catalog_summary" else prompts.handoff()
    # Большой хендофф идёт долго: окно на миллион токенов читается не за минуту.
    try:
        raw = runner.run_isolated(fill(template, payload["text"]), model=model,
                                  effort=effort, timeout=2400)
    except runner.PromptTooLong:
        # Символы на токен зависят от языка и содержимого, поэтому одна попытка урезать.
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
    """Экспорт в проект — отдельное явное действие, цель только из allowlist сервера."""
    art = cached(conn, session_id, "handoff")
    if not art or not art["payload"]:
        raise LookupError(msg("enrich.no_handoff"))
    os.makedirs(destination_dir, exist_ok=True)
    target = os.path.join(destination_dir, f"HANDOFF-{session_id[:8]}.md")
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(art["payload"])
    return target
