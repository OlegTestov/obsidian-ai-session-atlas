"""LLM-классификация: домен и тема работы. Реестр тем растёт сам, но не бесконтрольно."""
from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import datetime, timezone

from . import actions, config, db, parse, prompts, runner
from .messages import msg

CLASSIFIER_VERSION = 4

# Сессии идут пачкой: модель видит их рядом и переиспользует темы, а не плодит синонимы.
BATCH_SIZE = 8


# На классификатор уходит не транскрипт, а карточка фактов — этого хватает и стоит копейки.
SIGNAL_PROMPT_CHARS = 400
SIGNAL_FILES = 12
# У сессии без файлов и тикетов весь сигнал — в разговоре, поэтому берём больше реплик.
THIN_PROMPTS = 6

# Тексты запросов — в prompts.py: язык и домены берутся из настроек.



def context_path() -> str:
    return os.path.join(db.atlas_home(), "context.md")


def owner_context() -> str:
    """Контекст владельца правится руками — без него модель путает Teams с личным."""
    path = context_path()
    if not os.path.exists(path):
        # Шаблон на языке настроек; дальше файл только твой и не перезаписывается.
        default = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               f"context_default.{prompts.lang()}.md")
        with open(default, encoding="utf-8") as src, open(path, "w", encoding="utf-8") as dst:
            dst.write(src.read())
        os.chmod(path, 0o600)
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def build_signal(conn: sqlite3.Connection, session_id: str) -> dict:
    """Карточка фактов для классификатора. Полный транскрипт не нужен и наружу не идёт."""
    row = conn.execute(
        "SELECT title, started_at, last_activity_at, cwd_last, branch_last, human_turns, "
        "content_hash, source_path FROM sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    if row is None:
        raise LookupError(session_id)
    projects = [r["project_id"] for r in conn.execute(
        "SELECT project_id FROM session_projects WHERE session_id=? ORDER BY role", (session_id,))]
    tickets = [r["ticket"] for r in conn.execute(
        "SELECT ticket FROM session_tickets WHERE session_id=? LIMIT 8", (session_id,))]
    files = [r["resolved_path"] for r in conn.execute(
        "SELECT DISTINCT resolved_path FROM session_files WHERE session_id=? LIMIT ?",
        (session_id, SIGNAL_FILES))]
    facts = parse.parse_file(row["source_path"], session_id)
    prompts = facts.user_text
    thin = not files and not tickets
    extra = [p[:SIGNAL_PROMPT_CHARS] for p in prompts[1:-1][:THIN_PROMPTS]] if thin else []
    return {
        "session_id": session_id,
        "content_hash": row["content_hash"],
        "title": row["title"],
        "first_prompt": (prompts[0] if prompts else "")[:SIGNAL_PROMPT_CHARS],
        "last_prompt": (prompts[-1] if prompts else "")[:SIGNAL_PROMPT_CHARS],
        "extra_prompts": extra,
        "projects": projects,
        "tickets": tickets,
        "branch": row["branch_last"],
        "cwd": row["cwd_last"],
        "files": files,
        "turns": row["human_turns"],
    }


def signal_text(signal: dict) -> str:
    # Язык подписей — язык страницы: предпросмотр показывает ровно то, что уйдёт в модель.
    lines = [
        msg("fact.title", value=signal["title"]),
        msg("fact.workdir", cwd=signal["cwd"], branch=signal["branch"]),
        msg("fact.projects", value=", ".join(signal["projects"]) or "—"),
        msg("fact.tickets", value=", ".join(signal["tickets"]) or "—"),
        msg("fact.turns", value=signal["turns"]),
        msg("fact.first_prompt", value=signal["first_prompt"]),
        msg("fact.last_prompt", value=signal["last_prompt"]),
    ]
    for i, extra in enumerate(signal.get("extra_prompts") or [], start=2):
        lines.append(msg("fact.prompt_n", i=i, value=extra))
    lines.append(msg("fact.files") + "\n  "
                 + "\n  ".join(signal["files"][:SIGNAL_FILES] or ["—"]))
    return "\n".join(lines)


def registry(conn: sqlite3.Connection, limit: int = 60) -> list[tuple[str, int]]:
    rows = conn.execute(
        "SELECT topic, count(*) c FROM classification WHERE topic IS NOT NULL AND topic != '' "
        "GROUP BY topic ORDER BY c DESC LIMIT ?", (limit,)
    ).fetchall()
    return [(r["topic"], r["c"]) for r in rows]


def _registry_text(items: list[tuple[str, int]]) -> str:
    if not items:
        return msg("classify.registry_empty", prompts.lang())      # только для модели
    return "\n".join(f"- {topic} ({count})" for topic, count in items)


def parse_batch(text: str, expected: int) -> dict[int, dict]:
    """Битый вывод не чиним эвристикой: берём только те записи, что прошли проверку."""
    match = re.search(r"\[.*\]", text, re.S)
    if not match:
        raise ValueError(msg("classify.no_array"))
    out: dict[int, dict] = {}
    for item in json.loads(match.group(0)):
        if not isinstance(item, dict):
            continue
        try:
            n = int(item.get("n"))
        except (TypeError, ValueError):
            continue
        if not 1 <= n <= expected:
            continue
        try:
            out[n] = _verdict(item)
        except ValueError:
            continue
    return out


def _verdict(data: dict) -> dict:
    domain = data.get("domain")
    ids = config.domain_ids()
    if ids and domain not in ids:
        raise ValueError(msg("classify.bad_domain", domain=repr(domain)))
    if not ids:
        domain = None                        # доменов в настройках нет — и спрашивать не о чем
    topic = (data.get("topic") or "").strip()
    if not topic:
        raise ValueError(msg("classify.empty_topic"))
    summary = " ".join((data.get("summary") or "").split())[:200]
    try:
        confidence = float(data.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))
    # «разное» с высокой уверенностью — противоречие: модель поняла, но поленилась назвать.
    if topic.lower() in {t.lower() for t in prompts.MISC_TOPIC.values()} and confidence >= 0.5:
        confidence = 0.4
    return {"domain": domain, "topic": topic[:60], "summary": summary,
            "confidence": confidence}


def pending(conn: sqlite3.Connection, include_automation: bool = False) -> list[str]:
    """Сессии без свежей классификации. Чувствительные во внешнюю модель не идут."""
    sql = """
        SELECT s.session_id FROM sessions s
        LEFT JOIN classification c
          ON c.session_id = s.session_id
         AND c.content_hash = s.content_hash
         AND c.classifier_version = ?
        WHERE c.session_id IS NULL
          AND COALESCE((SELECT sensitivity FROM user_overrides u WHERE u.session_id = s.session_id),
                       s.sensitivity_rule) != 'sensitive'
    """
    if not include_automation:
        sql += " AND s.session_kind = 'interactive'"
    sql += " ORDER BY s.last_activity_at DESC"
    return [r["session_id"] for r in conn.execute(sql, (CLASSIFIER_VERSION,))]


def _store(conn: sqlite3.Connection, session_id: str, verdict: dict, content_hash: str,
           backend: str, model: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO classification (session_id, domain, topic, summary, confidence, "
        "content_hash, classifier_version, model, backend, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (session_id, verdict["domain"], verdict["topic"], verdict.get("summary"),
         verdict["confidence"], content_hash, CLASSIFIER_VERSION, model, backend, _now()),
    )
    conn.commit()


def classify_batch(conn: sqlite3.Connection, session_ids: list[str], job_id: str | None = None,
                   backend: str = runner.EXTERNAL_BACKEND,
                   model: str | None = None, effort: str | None = None) -> dict:
    """Пачками по BATCH_SIZE, одна пачка за вызов, пачки последовательно: фоновый
    claude -p ест ту же квоту подписки, что интерактив."""
    default_model, default_effort = runner.model_for("classification")
    model = model or default_model
    effort = effort or default_effort
    done, failed, errors = 0, 0, []
    for start in range(0, len(session_ids), BATCH_SIZE):
        if job_id and actions.is_cancelled(conn, job_id):
            break
        chunk = session_ids[start:start + BATCH_SIZE]
        signals, ok_ids = [], []
        for session_id in chunk:
            try:
                signal = build_signal(conn, session_id)
                runner.grant_egress(conn, session_id, signal["content_hash"], "classification",
                                    backend, model)
                runner.check_egress(conn, session_id, signal["content_hash"], "classification",
                                    backend, model)
                signals.append(signal)
                ok_ids.append(session_id)
            except Exception as exc:
                failed += 1
                if len(errors) < 5:
                    errors.append(f"{session_id[:8]}: {type(exc).__name__}: {exc}")
        if not signals:
            continue
        body = "\n\n".join(msg("fact.separator", n=i + 1) + "\n" + signal_text(sig)
                            for i, sig in enumerate(signals))
        prompt = prompts.classify().format(context=owner_context(),
                               registry=_registry_text(registry(conn)), signal=body)
        try:
            verdicts = parse_batch(
                runner.run_isolated(prompt, model=model, effort=effort), len(signals))
        except Exception as exc:
            failed += len(signals)
            if len(errors) < 5:
                errors.append(msg("classify.batch_failed", sid=ok_ids[0][:8],
                                   error=f"{type(exc).__name__}: {exc}"))
            continue
        for i, session_id in enumerate(ok_ids, start=1):
            verdict = verdicts.get(i)
            if verdict is None:
                failed += 1
                continue
            _store(conn, session_id, verdict, signals[i - 1]["content_hash"], backend, model)
            done += 1
    merged = {}
    if done:
        try:                                     # проход дешёвый: наружу уходят только имена тем
            merged = merge_topics(conn, model=model)
        except Exception as exc:
            errors.append(msg("classify.merge_failed", error=f"{type(exc).__name__}: {exc}"))
    return {"classified": done, "failed": failed, "errors": errors,
            "merged_topics": merged.get("merged", 0), "topics": len(registry(conn))}


def dry_run(conn: sqlite3.Connection, session_ids: list[str], model: str,
            effort: str = "low") -> dict[str, dict]:
    """Классифицирует, ничего не записывая. Нужно замеру: сравнить модели на одной выборке."""
    out: dict[str, dict] = {}
    for start in range(0, len(session_ids), BATCH_SIZE):
        chunk = session_ids[start:start + BATCH_SIZE]
        signals = [build_signal(conn, sid) for sid in chunk]
        body = "\n\n".join(msg("fact.separator", n=i + 1) + "\n" + signal_text(sig)
                            for i, sig in enumerate(signals))
        prompt = prompts.classify().format(context=owner_context(),
                               registry=_registry_text(registry(conn)), signal=body)
        verdicts = parse_batch(runner.run_isolated(prompt, model=model, effort=effort),
                               len(signals))
        for i, sid in enumerate(chunk, start=1):
            if i in verdicts:
                out[sid] = verdicts[i]
    return out


def preview_batch(conn: sqlite3.Connection, limit: int = 3) -> dict:
    """Что именно уйдёт наружу — показываем до запуска, на настоящих примерах."""
    ids = pending(conn)
    samples = []
    for session_id in ids[:limit]:
        try:
            samples.append(signal_text(build_signal(conn, session_id)))
        except Exception:
            continue
    total_chars = sum(len(s) for s in samples)
    avg = total_chars // max(1, len(samples))
    model, effort = runner.model_for("classification")
    return {
        "pending": len(ids),
        "backend": runner.EXTERNAL_BACKEND,
        "model": f"{model} / {effort}",
        "estimated_chars": avg * len(ids),
        "samples": samples,
        "note": msg("classify.note"),
    }


def export_path() -> str:
    return os.path.join(os.path.expanduser("~"), ".atlas-topics.json")

def merge_topics(conn: sqlite3.Connection, model: str = runner.DEFAULT_MODEL) -> dict:
    """Отдельный проход: реестр растёт сам, но синонимы в нём надо схлопывать."""
    items = registry(conn, limit=200)
    if len(items) < 3:
        return {"merged": 0, "mapping": {}}
    raw = runner.run_isolated(
        prompts.merge().format(registry=_registry_text(items)), model=model)
    match = re.search(r"\{.*\}", raw, re.S)
    if not match:
        raise ValueError(msg("classify.merge_no_json"))
    known = {topic for topic, _ in items}
    mapping = {k: v for k, v in json.loads(match.group(0)).items()
               if k in known and isinstance(v, str) and v.strip() and v != k}
    for old, new in mapping.items():
        conn.execute("UPDATE classification SET topic=? WHERE topic=?", (new.strip()[:60], old))
    conn.commit()
    return {"merged": len(mapping), "mapping": mapping}
