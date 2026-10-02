"""Что уходит наружу и через что. Fail-closed: без явного разрешения не уходит ничего."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
from datetime import datetime, timezone

from . import config, db, parse, prompts
from .messages import msg

EXTRACTOR_VERSION = 1

# Локальным считается только явно перечисленный backend. Сам по себе litellm локальности
# не означает — он маршрутизирует дальше во внешнего провайдера.
LOCAL_BACKENDS = {"ollama", "lmstudio", "llamacpp"}
EXTERNAL_BACKEND = "claude-cli"

DEFAULT_MODEL = "sonnet"
DEFAULT_EFFORT = "medium"

# Модели с окном 1M без суффикса `[1m]` — замерено по contextWindow в выводе `claude -p`:
# `claude-opus-5-5` отдаёт 1 000 000, как и `[1m]`.
NATIVE_1M = {"claude-opus-5-5"}
WINDOW_1M = 1_000_000
WINDOW_DEFAULT = 200_000


def has_1m_window(model: str) -> bool:
    return model.endswith("[1m]") or model in NATIVE_1M


def _models() -> dict:
    """Модель и эффорт под задачу — из настроек. Классификация идёт пачками — там low;
    описание и хендофф — по одной штуке по кнопке."""
    out = {}
    for kind, value in (config.get("models") or {}).items():
        if isinstance(value, (list, tuple)) and len(value) == 2 and all(isinstance(v, str) and v for v in value):
            out[kind] = (value[0], value[1])
    return out

# Бюджет отправки в символах (≈ делить на 4 для токенов). Для хендоффа берём почти всё окно,
# для короткого описания столько не нужно.
# Замерено на боевой сессии: 2 798 964 символа дали 1 315 799 токенов, то есть ~2.1 символа
# на токен. Делить на 4, как для английского, нельзя — кириллица дороже вдвое.
CHARS_PER_TOKEN = 2.1

# Бюджет в токенах, с запасом под шаблон промпта и ответ (лимит окна — 1M).
TOKEN_BUDGET = {
    "handoff": 750_000,
    "catalog_summary": 50_000,
}
DEFAULT_TOKEN_BUDGET = 20_000


def budget_chars(artifact_kind: str, scale: float = 1.0) -> int:
    tokens = TOKEN_BUDGET.get(artifact_kind, DEFAULT_TOKEN_BUDGET)
    # Бюджеты рассчитаны на окно 1M; у модели с обычным окном — та же доля от него.
    window = WINDOW_1M if has_1m_window(model_for(artifact_kind)[0]) else WINDOW_DEFAULT
    return int(tokens * window / WINDOW_1M * CHARS_PER_TOKEN * scale)

# В preview целиком 3 МБ не покажешь — отдаём начало и хвост, полный текст кладём в файл.
PREVIEW_HEAD = 6_000
PREVIEW_TAIL = 2_000


def model_for(artifact_kind: str) -> tuple[str, str]:
    """С настройкой force_1m модели без родного окна 1M получают суффикс [1m] — он есть не на
    каждом тарифе, поэтому по умолчанию выключен."""
    model, effort = _models().get(artifact_kind, (DEFAULT_MODEL, DEFAULT_EFFORT))
    if config.get("force_1m") and not has_1m_window(model):
        model += "[1m]"
    return model, effort

ASSISTANT_SAMPLE = 60


class EgressDenied(RuntimeError):
    pass


class LlmDisabled(EgressDenied):
    """ИИ-функции выключены в настройках: ни один запрос к модели не уходит."""


def llm_enabled() -> bool:
    return config.get("llm_enabled") is True


def require_llm() -> None:
    if not llm_enabled():
        raise LlmDisabled(msg("server.llm_off"))


class PromptTooLong(RuntimeError):
    """Окно всё-таки не вместило: оценка по символам зависит от языка и содержимого."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# launchd не наследует пользовательский PATH: сервер под ним не находил claude в ~/.local/bin,
# и классификация падала «claude не найден в PATH» на каждой пачке.
CLAUDE_CANDIDATES = (
    "~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
)


def find_claude() -> str:
    configured = config.get("claude_bin")
    if configured and os.access(os.path.expanduser(configured), os.X_OK):
        return os.path.expanduser(configured)
    found = shutil.which("claude")
    if found:
        return found
    for candidate in CLAUDE_CANDIDATES:
        path = os.path.expanduser(candidate)
        if os.access(path, os.X_OK):
            return path
    raise RuntimeError(msg("runner.no_claude", paths=", ".join(CLAUDE_CANDIDATES)))


def runner_cwd() -> str:
    """Отдельная папка: транскрипт компрессора ложится под свой слаг и отсекается индексатором."""
    path = os.path.join(db.atlas_home(), "runner")
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def _sample(items: list[str], limit: int) -> list[str]:
    """Равномерно по всей сессии, а не голова с хвостом: решение обычно лежит в середине."""
    if len(items) <= limit:
        return items
    step = len(items) / limit
    return [items[int(i * step)] for i in range(limit)]


def _tail_within(items: list[str], budget: int) -> list[str]:
    """Берём с конца, пока влезает: «последняя часть сессии» — это хвост, а не начало."""
    out, used = [], 0
    for text in reversed(items):
        cost = len(text) + 2
        if used + cost > budget:
            break
        out.append(text)
        used += cost
    out.reverse()
    return out


def build_payload(conn: sqlite3.Connection, session_id: str,
                  artifact_kind: str = "handoff", scale: float = 1.0) -> dict:
    """Ровно тот текст, который уйдёт наружу.

    Порядок приоритетов: сводки компактации и запросы пользователя идут целиком — они несут
    цель и решения и весят мало. Остаток бюджета добивается ответами ассистента с конца.
    """
    row = conn.execute(
        "SELECT source_path, title, started_at, last_activity_at, cwd_last, branch_last, "
        "human_turns, content_hash FROM sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    if row is None:
        raise LookupError(msg("runner.no_session", sid=session_id))

    budget = budget_chars(artifact_kind, scale)
    facts = parse.parse_file(row["source_path"], session_id)
    files = [r["resolved_path"] for r in conn.execute(
        "SELECT resolved_path FROM session_files WHERE session_id=?", (session_id,))]
    links = [f"{r['kind']}: {r['url']}" for r in conn.execute(
        "SELECT kind, url FROM session_links WHERE session_id=?", (session_id,))]
    tickets = [r["ticket"] for r in conn.execute(
        "SELECT ticket FROM session_tickets WHERE session_id=?", (session_id,))]

    # Подписи — на языке страницы: предпросмотр показывает ровно тот текст, что уйдёт наружу.
    header = "\n".join([
        msg("fact.session", sid=session_id),
        msg("fact.title", value=row["title"]),
        msg("fact.period", start=row["started_at"], end=row["last_activity_at"]),
        msg("fact.folder", cwd=row["cwd_last"], branch=row["branch_last"]),
        msg("fact.turns", value=row["human_turns"]),
        msg("fact.tickets", value=", ".join(tickets) or "—"),
        msg("fact.files_n", n=len(files), value=", ".join(files[:80]) or "—"),
        msg("fact.links", value=", ".join(links) or "—"),
    ])

    sections, used = [((msg("payload.header"), 1, len(header)))], len(header)
    blocks = [header]

    def take(title: str, items: list[str], joiner: str = "\n\n") -> None:
        nonlocal used
        if not items:
            return
        kept = _tail_within(items, max(0, budget - used))
        if not kept:
            return
        text = f"\n## {title}\n" + joiner.join(kept)
        blocks.append(text)
        used += len(text)
        sections.append((title, len(kept), len(text)))

    t_summaries, t_prompts = msg("payload.summaries"), msg("payload.prompts")
    t_answers, t_commands = msg("payload.answers"), msg("payload.commands")
    take(t_summaries, facts.summaries)
    take(t_prompts, facts.user_text)
    take(t_answers, facts.assistant_text)
    take(t_commands, facts.commands, joiner="\n")

    text = "\n".join(blocks)
    dropped = {
        "summaries": len(facts.summaries),
        "prompts": len(facts.user_text),
        "answers": len(facts.assistant_text),
        "commands": len(facts.commands),
    }
    kept = {title: count for title, count, _ in sections}
    # «Обрезано» — это про потерянные куски, а не про упор в бюджет: команды могут не влезть,
    # даже когда итог чуть меньше потолка.
    truncated = (kept.get(t_summaries, 0) < dropped["summaries"]
                 or kept.get(t_prompts, 0) < dropped["prompts"]
                 or kept.get(t_answers, 0) < dropped["answers"]
                 or kept.get(t_commands, 0) < dropped["commands"])
    return {
        "session_id": session_id,
        "content_hash": row["content_hash"],
        "text": text,
        "chars": len(text),
        "budget": budget,
        "estimated_tokens": int(len(text) / CHARS_PER_TOKEN),
        "truncated": truncated,
        "sections": [{"title": t, "items": c, "chars": n} for t, c, n in sections],
        "totals": dropped,
        "kept": kept,
    }


def sensitivity_of(conn: sqlite3.Connection, session_id: str) -> str:
    override = conn.execute(
        "SELECT sensitivity FROM user_overrides WHERE session_id=?", (session_id,)
    ).fetchone()
    if override and override["sensitivity"]:
        return override["sensitivity"]
    row = conn.execute(
        "SELECT sensitivity_rule FROM sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    return (row["sensitivity_rule"] if row else None) or "unclassified"


def grant_egress(conn: sqlite3.Connection, session_id: str, content_hash: str,
                 artifact_kind: str, backend: str, model: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO egress_grants (session_id, content_hash, artifact_kind, "
        "backend, model, granted_at) VALUES (?,?,?,?,?,?)",
        (session_id, content_hash, artifact_kind, backend, model, _now()),
    )
    conn.commit()


def check_egress(conn: sqlite3.Connection, session_id: str, content_hash: str,
                 artifact_kind: str, backend: str, model: str) -> None:
    """Разрешение привязано к состоянию контента: любой append его аннулирует."""
    if backend in LOCAL_BACKENDS:
        return
    sensitivity = sensitivity_of(conn, session_id)
    grant = conn.execute(
        "SELECT granted_at FROM egress_grants WHERE session_id=? AND content_hash=? "
        "AND artifact_kind=? AND backend=? AND model=?",
        (session_id, content_hash, artifact_kind, backend, model),
    ).fetchone()
    if grant:
        return
    raise EgressDenied(msg("runner.egress_denied", sensitivity=sensitivity,
                           backend=backend, model=model))


# Выше этого объёма сначала проверяем сами флаги дешёвым вызовом: ошибка в них иначе
# обнаружится только после отправки мегабайтов.
PREFLIGHT_ABOVE = 200_000


def _argv(binary: str, model: str, effort: str) -> list[str]:
    return [
        binary, "-p",
        "--model", model,
        "--effort", effort,
        "--setting-sources", "",
        "--strict-mcp-config", "--mcp-config", json.dumps({"mcpServers": {}}),
        "--allowed-tools", "",
        "--disallowed-tools", "Bash,Read,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task",
        "--output-format", "text",
    ]


def preflight(model: str = "claude-haiku-4-5-20251001", effort: str = "low") -> None:
    """Крошечный прогон теми же флагами: ловит поломку вызова до дорогой отправки."""
    binary = find_claude()
    env = dict(os.environ)
    env.pop("CLAUDE_EFFORT", None)
    env.pop("ANTHROPIC_API_KEY", None)
    proc = subprocess.run(_argv(binary, model, effort), input=msg("runner.preflight_prompt", prompts.lang()),
                          capture_output=True, text=True, timeout=120,
                          cwd=runner_cwd(), env=env)
    if proc.returncode != 0:
        raise RuntimeError(msg("runner.preflight_failed",
                               detail=(proc.stderr or "").strip()[:300]))


def run_isolated(prompt: str, model: str = DEFAULT_MODEL, effort: str = DEFAULT_EFFORT,
                 timeout: int = 900) -> str:
    """`claude -p` без настроек, хуков, плагинов, MCP и тулов: иначе компрессор поднимет
    твоё окружение и наплодит собственных транскриптов."""
    require_llm()                  # последний рубеж: сюда сходятся все вызовы модели
    binary = find_claude()
    if len(prompt) > PREFLIGHT_ABOVE:
        preflight(effort=effort)
    argv = _argv(binary, model, effort)
    env = dict(os.environ)
    env.pop("CLAUDE_EFFORT", None)      # уровень задан флагом; переменная из окружения помешает
    env.pop("ANTHROPIC_API_KEY", None)
    proc = subprocess.run(argv, input=prompt, capture_output=True, text=True,
                          timeout=timeout, cwd=runner_cwd(), env=env)
    if proc.returncode != 0:
        # Причина приходит в stdout: при пустом stderr сообщение «вернул ошибку» бесполезно.
        detail = ((proc.stderr or "").strip() or (proc.stdout or "").strip()
                  or msg("runner.cli_error"))
        if "Prompt is too long" in detail:
            raise PromptTooLong(detail[:300])
        raise RuntimeError(detail[:500])
    return proc.stdout.strip()


def preview_payload(conn: sqlite3.Connection, session_id: str, artifact_kind: str) -> dict:
    """Показать нельзя 3 МБ: отдаём начало и хвост, полный текст пишем в файл для сверки."""
    payload = build_payload(conn, session_id, artifact_kind)
    text = payload["text"]
    if len(text) > PREVIEW_HEAD + PREVIEW_TAIL:
        shown = (text[:PREVIEW_HEAD]
                 + msg("payload.skipped", n=f"{len(text) - PREVIEW_HEAD - PREVIEW_TAIL:,}")
                 + text[-PREVIEW_TAIL:])
    else:
        shown = text
    folder = os.path.join(db.atlas_home(), "payloads")
    os.makedirs(folder, mode=0o700, exist_ok=True)
    path = os.path.join(folder, f"{session_id}.{artifact_kind}.txt")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(path, 0o600)
    return {**payload, "text": shown, "full_path": path}
