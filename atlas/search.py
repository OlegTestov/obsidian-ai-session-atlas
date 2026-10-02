"""Поиск: кандидаты из FTS5, фильтры карточки, подсветка только видимой страницы."""
from __future__ import annotations

import sqlite3

from . import query as q
from .query import (FTS_COLUMNS, IDENTIFIER_RE, PREFIX_MIN_LEN, SCOPE_COLUMNS,  # noqa: F401
                    STEM_FLOOR, QueryError, build_match, is_pathlike, stem_prefix)

# Вес колонки в bm25. Заголовок и тикет опознают сессию точнее, чем случайная фраза в ответе.
COLUMN_WEIGHTS = {"title": 10.0, "user_text": 5.0, "assistant_text": 2.0,
                  "commands": 3.0, "paths": 3.0, "tickets": 8.0, "summaries": 4.0,
                  "subagent_text": 1.5}

# Сколько полей с фрагментом отдаётся на сессию: остальные — только счётчиком.
FRAGMENTS_PER_SESSION = 2


def _weights() -> list[float]:
    # Первая колонка fts — session_id: без нуля впереди веса съезжали на колонку вправо
    # (вес заголовка доставался session_id, заголовку — вес запросов и так далее).
    return [0.0] + [COLUMN_WEIGHTS[c] for c in FTS_COLUMNS] + [0.0]


def _session_where(kinds, include_automation, since) -> tuple[list[str], list]:
    """Вид сессии и дата — в SQL: фоновых прогонов сотни, и отбрасывать их в Python дорого."""
    where, args = [], []
    if not include_automation and not kinds:
        where.append("s.session_kind = 'interactive'")
    elif kinds:
        where.append("s.session_kind IN (%s)" % ",".join("?" * len(kinds)))
        args += kinds
    if since:
        where.append("s.last_activity_at >= ?")
        args.append(since)
    return where, args


def _scoped(columns: tuple[str, ...], expr: str) -> str:
    return expr if columns == FTS_COLUMNS else "{" + " ".join(columns) + "} : (" + expr + ")"


def _best_per_session(conn, match: str, where: list[str], args: list) -> dict[str, float]:
    """Лучшая оценка bm25 по строкам-ходам сессии: строка — ход, решает лучший ход.

    Минимум — в Python: bm25 нельзя звать внутри группировки SQLite.
    """
    weights = _weights()
    sql = f"""
        SELECT f.session_id AS session_id, bm25(fts, {', '.join('?' for _ in weights)}) AS score
        FROM fts f JOIN sessions s ON s.session_id = f.session_id
        WHERE {' AND '.join(["fts MATCH ?", *where])}
    """
    best: dict[str, float] = {}
    for sid, score in conn.execute(sql, (*weights, match, *args)):
        if sid not in best or score < best[sid]:
            best[sid] = score
    return best


def _candidates(conn: sqlite3.Connection, parsed: q.Parsed, columns: tuple[str, ...], *, kinds,
                include_automation, since, order) -> list[tuple[str, float]]:
    """Сессии, где есть каждая группа слов запроса — в любых ходах, а не обязательно в одном.

    Группа — слово или «ИЛИ»-связка; исключённые слова вычитаются по всей сессии.
    """
    where, args = _session_where(kinds, include_automation, since)
    total: dict[str, float] | None = None
    for group in parsed.groups:
        expr = group[0].fts() if len(group) == 1 else "(" + " OR ".join(t.fts() for t in group) + ")"
        found = _best_per_session(conn, _scoped(columns, expr), where, args)
        if total is None:
            total = found
        else:
            total = {sid: total[sid] + score for sid, score in found.items() if sid in total}
        if not total:
            return []
    for term in parsed.excluded:
        for sid in _best_per_session(conn, _scoped(columns, term.fts()), where, args):
            total.pop(sid, None)
    if not total:
        return []
    dates = {r["session_id"]: r["last_activity_at"] or "" for r in conn.execute(
        "SELECT session_id, last_activity_at FROM sessions WHERE session_id IN (%s)"
        % ",".join("?" * len(total)), list(total))}
    if order == "date":
        keys = sorted(total, key=lambda sid: dates.get(sid, ""), reverse=True)
    else:
        by_date = sorted(total, key=lambda sid: dates.get(sid, ""), reverse=True)
        keys = sorted(by_date, key=lambda sid: total[sid])      # устойчиво: при равенстве — дата
    return [(sid, total[sid]) for sid in keys]


def _trigram_extra(conn, query: str, known: set[str], limit: int, *, kinds,
                   include_automation, since) -> list[tuple[str, float]]:
    """Подстрочный поиск по путям и командам: `release.mjs` внутри `deploy-release.mjs`."""
    extra, extra_args = _session_where(kinds, include_automation, since)
    where = " AND ".join(["fts_paths MATCH ?", *extra])
    out = []
    for token in query.split():
        if not q.PATHLIKE_RE.search(token):
            continue
        for row in conn.execute(
                "SELECT DISTINCT p.session_id FROM fts_paths p JOIN sessions s "
                f"ON s.session_id = p.session_id WHERE {where} LIMIT ?",
                (q._quote(token), *extra_args, limit)):
            if row["session_id"] not in known:
                known.add(row["session_id"])
                out.append((row["session_id"], 0.0))
    return out


def _sessions_matching(conn, match: str, session_ids: list[str]) -> dict[str, int]:
    """Сколько строк сессии подходят под выражение — по каждой из заданных сессий."""
    if not session_ids:
        return {}
    marks = ",".join("?" * len(session_ids))
    out: dict[str, int] = {}
    for r in conn.execute(f"SELECT session_id FROM fts WHERE fts MATCH ? AND session_id IN ({marks})",
                          (match, *session_ids)):
        out[r["session_id"]] = out.get(r["session_id"], 0) + 1
    return out


def _by_relevance(conn, parsed: q.Parsed, cands, columns) -> list[tuple[str, float]]:
    """Сначала заголовок со всеми словами, потом слова рядом в одном ходе, потом bm25.

    Один bm25 поднимал наверх огромные сессии, где слова запроса разбросаны по мегабайтам.
    Близость считается внутри строки-хода: через границу двух сообщений она больше не ловится.
    """
    ids = [sid for sid, _ in cands]
    if not ids:
        return cands
    in_title = set(_sessions_matching(conn, q.title_match(parsed), ids))
    pairs = {sid: 0 for sid in ids}
    for near in q.near_pairs(parsed, columns):
        for sid in _sessions_matching(conn, near, ids):
            pairs[sid] += 1
    position = {sid: i for i, sid in enumerate(ids)}      # внутри ступени — порядок bm25
    return sorted(cands, key=lambda c: (c[0] not in in_title, -pairs[c[0]], position[c[0]]))


def _filtered(conn, candidates, cache: dict, *, projects, domains,
              topics) -> list[tuple[str, dict, float]]:
    out = []
    for sid, score in candidates:
        if sid not in cache:
            cache[sid] = _load_session(conn, sid)
        meta = cache[sid]
        if meta is None:
            continue
        if projects and not (set(projects) & set(meta["projects"])):
            continue
        # Домен может прийти от классификатора, поэтому фильтруется после сборки карточки.
        if domains and not (set(domains) & set(meta["domains"])):
            continue
        if topics and meta["topic"] not in topics:
            continue
        out.append((sid, meta, score))
    return out


def _highlight(conn, parsed: q.Parsed, session_ids: list[str],
               columns: tuple[str, ...]) -> dict[str, list[dict]]:
    """Подсветка по строкам-ходам видимых сессий: совпадения суммируются, фрагмент — из хода,
    где сошлось больше разных слов запроса."""
    found: dict[str, dict[str, dict]] = {sid: {} for sid in session_ids}
    if not session_ids:
        return {sid: [] for sid in session_ids}
    marks = ",".join("?" * len(session_ids))
    for column in columns:
        i = FTS_COLUMNS.index(column) + 1
        for r in conn.execute(
                f"SELECT session_id, highlight(fts, {i}, ?, ?) AS h FROM fts "
                f"WHERE fts MATCH ? AND session_id IN ({marks})",
                (q.MARK_OPEN, q.MARK_CLOSE, q.column_match(parsed, column), *session_ids)):
            segs, hits = q.segments(r["h"] or "")
            if not hits:
                continue
            distinct = len({s["t"].lower() for s in segs if s["hit"]})
            slot = found[r["session_id"]].get(column)
            if slot is None:
                slot = found[r["session_id"]][column] = {
                    "field": column, "hits": 0, "score": COLUMN_WEIGHTS[column],
                    "marked": None, "_best": (-1, -1)}
            slot["hits"] += hits
            if (distinct, hits) > slot["_best"]:
                slot["_best"] = (distinct, hits)
                slot["segments"], slot["fragment"] = segs, q.as_text(segs)
                slot["marked"] = r["h"] if column == "title" else None
    out: dict[str, list[dict]] = {}
    for sid, slots in found.items():
        items = [{k: v for k, v in m.items() if k != "_best"} for m in slots.values()]
        out[sid] = sorted(items, key=lambda m: (-m["score"], -m["hits"]))
    return out


def _whole(marked: str) -> list[dict]:
    """Заголовок короткий — отдаётся целиком, с подсветкой на месте."""
    return q.segments(marked, width=len(marked) + 1)[0]


def run(conn: sqlite3.Connection, query: str, limit: int = 20,
        projects: list[str] | None = None, domains: list[str] | None = None,
        kinds: list[str] | None = None, since: str | None = None,
        include_automation: bool = False, topics: list[str] | None = None,
        scope: str = "prompts", order: str = "date") -> dict:
    """Выдача вместе с тем, как понят запрос, полным числом и подсказкой про другую область."""
    parsed = q.parse(query)
    out = {"results": [], "total": 0, "plan": q.describe(parsed), "elsewhere": None,
           "error": None}
    try:
        match = build_match(parsed, scope=scope)
    except QueryError as exc:
        out["error"] = str(exc)
        return out
    if not match:
        return out
    scope = scope if scope in SCOPE_COLUMNS else "prompts"
    opts = dict(kinds=kinds, include_automation=include_automation, since=since)
    filters = dict(projects=projects, domains=domains, topics=topics)
    cache: dict = {}

    columns = SCOPE_COLUMNS[scope]
    cands = _candidates(conn, parsed, columns, order=order, **opts)
    if order == "relevance":
        cands = _by_relevance(conn, parsed, cands, columns)
    if scope == "all" and is_pathlike(query):
        cands += _trigram_extra(conn, query, {c[0] for c in cands}, limit * 2, **opts)
    rows = _filtered(conn, cands, cache, **filters)
    out["total"] = len(rows)

    page = rows[:limit]
    found = _highlight(conn, parsed, [sid for sid, _, _ in page], columns)
    for sid, meta, score in page:
        matches = found.get(sid)
        if not matches:
            # Триграммная добавка: слово нашлось подстрокой пути, токен FTS его не видит.
            matches = [{"field": "paths", "segments": [], "fragment": "", "hits": 0,
                        "score": 0.0}]
        # Заголовок обычно и есть первый запрос: во фрагментах и в общем счёте он дублирует
        # запросы, поэтому подсвечивается на месте, а не отдельным фрагментом.
        title = next((m for m in matches if m["field"] == "title"), None)
        body = [m for m in matches if m["field"] != "title"] or matches
        meta["score"] = round(-score, 4) if score else 0.0
        meta["title_segments"] = _whole(title["marked"]) if title and title.get("marked") else None
        meta["hits"] = sum(m["hits"] for m in body)
        meta["hit_fields"] = {m["field"]: m["hits"] for m in matches}
        meta["matches"] = [{k: v for k, v in m.items() if k != "marked"}
                           for m in body[:FRAGMENTS_PER_SESSION]]
        out["results"].append(meta)

    # Узкая область по умолчанию прячет сессии, где слово было только в ответах или командах.
    # Сколько их — говорим, а не молчим: иначе «ничего не нашлось» выглядит как правда.
    if scope == "prompts":
        wide = _filtered(conn, _candidates(conn, parsed, FTS_COLUMNS, order=order, **opts),
                         cache, **filters)
        shown = {meta["session_id"] for _, meta, _ in rows}
        out["elsewhere"] = sum(1 for _, meta, _ in wide if meta["session_id"] not in shown)
    return out


def search(conn: sqlite3.Connection, query: str, limit: int = 20, **kw) -> list[dict]:
    return run(conn, query, limit=limit, **kw)["results"]


def _load_session(conn: sqlite3.Connection, session_id: str) -> dict | None:
    row = conn.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    if row is None:
        return None
    override = conn.execute(
        "SELECT * FROM user_overrides WHERE session_id=?", (session_id,)
    ).fetchone()
    projects = [r["project_id"] for r in conn.execute(
        "SELECT project_id FROM session_projects WHERE session_id=? ORDER BY role", (session_id,))]
    domains = [r["domain"] for r in conn.execute(
        "SELECT domain FROM session_domains WHERE session_id=?", (session_id,))]
    tickets = [r["ticket"] for r in conn.execute(
        "SELECT ticket FROM session_tickets WHERE session_id=?", (session_id,))]
    verdict = conn.execute(
        "SELECT domain, topic, summary, confidence, content_hash FROM classification "
        "WHERE session_id=?", (session_id,)).fetchone()
    # Ручное значение перебивает правило и никогда не перезаписывается индексатором.
    sensitivity = (override["sensitivity"] if override and override["sensitivity"]
                   else row["sensitivity_rule"])
    # Приоритет: ручное → вердикт модели → правило по пути.
    # Модель выше правила намеренно: правило видит только путь, а «сессия тронула файл в
    # ~/.claude» не делает работу над клиентским репозиторием cross-cutting.
    if override and override["domain"]:
        final_domains, domain_source = [override["domain"]], "manual"
    elif verdict and verdict["domain"]:
        final_domains, domain_source = [verdict["domain"]], "llm"
    elif domains:
        final_domains, domain_source = domains, "rule"
    else:
        final_domains, domain_source = [], None

    return {
        "session_id": session_id,
        "title": (override["title"] if override and override["title"] else row["title"]),
        "title_source": ("manual" if override and override["title"] else row["title_source"]),
        "session_kind": row["session_kind"],
        "workspace_kind": row["workspace_kind"],
        "started_at": row["started_at"],
        "last_activity_at": row["last_activity_at"],
        "human_turns": row["human_turns"],
        "machine_turns": row["machine_turns"],
        "subagent_turns": row["subagent_turns"],
        "cost_usd": row["cost_usd"],
        "cwd_last": row["cwd_last"],
        "branch_last": row["branch_last"],
        "projects": projects,
        "domains": final_domains,
        "domain_source": domain_source,
        "topic": ((override["topic"] if override and override["topic"] else None)
                  or (verdict["topic"] if verdict else None)),
        "card_line": verdict["summary"] if verdict else None,
        "topic_confidence": verdict["confidence"] if verdict else None,
        "topic_source": ("manual" if override and override["topic"]
                         else ("llm" if verdict else None)),
        "topic_stale": (not (override and override["topic"]) and bool(verdict)
                        and verdict["content_hash"] != row["content_hash"]),
        "tickets": tickets,
        "sensitivity": sensitivity,
        "work_outcome": (override["work_outcome"] if override else None) or "unknown",
        "last_prompt": row["last_prompt"],
    }


def load_session(conn: sqlite3.Connection, session_id: str) -> dict | None:
    meta = _load_session(conn, session_id)
    if meta is None:
        return None
    meta["files"] = [dict(r) for r in conn.execute(
        "SELECT raw_path, resolved_path, project_id FROM session_files WHERE session_id=?",
        (session_id,))]
    meta["links"] = [dict(r) for r in conn.execute(
        "SELECT kind, url, title FROM session_links WHERE session_id=?", (session_id,))]
    return meta


def recent(conn: sqlite3.Connection, limit: int = 60, projects: list[str] | None = None,
           domains: list[str] | None = None, since: str | None = None,
           include_automation: bool = False, topics: list[str] | None = None,
           scope: str = "prompts", order: str = "date") -> list[dict]:
    """Список без запроса: последняя активность сверху."""
    sql = ["SELECT s.session_id FROM sessions s"]
    where, args = [], []
    if projects:
        sql.append("JOIN session_projects p ON p.session_id = s.session_id")
        where.append("p.project_id IN (%s)" % ",".join("?" * len(projects)))
        args += projects
    if not include_automation:
        where.append("s.session_kind = 'interactive'")
    if since:
        where.append("s.last_activity_at >= ?")
        args.append(since)
    if where:
        sql.append("WHERE " + " AND ".join(where))
    sql.append("GROUP BY s.session_id ORDER BY s.last_activity_at DESC LIMIT ?")
    args.append(limit * 4 if (domains or topics) else limit)
    out = []
    for row in conn.execute(" ".join(sql), args):
        meta = _load_session(conn, row["session_id"])
        if not meta:
            continue
        # Домен может прийти от классификатора, поэтому фильтруется после сборки карточки.
        if domains and not (set(domains) & set(meta["domains"])):
            continue
        if topics and meta["topic"] not in topics:
            continue
        meta["matches"] = []
        meta["score"] = 0.0
        out.append(meta)
        if len(out) >= limit:
            break
    return out

# Запрос показывается как есть: переносы строк в нём несут смысл (списки, таблицы).
# Но длину надо ограничить — целиком запросы читаются в своём блоке карточки.
QUOTE_LIMIT = 900


def _trim_quote(text: str, limit: int = QUOTE_LIMIT) -> str:
    """Схлопывает пустые строки и обрезает по границе строки, сохраняя разбивку."""
    lines = [ln.rstrip() for ln in (text or "").splitlines()]
    kept: list[str] = []
    for line in lines:
        if not line and (not kept or not kept[-1]):
            continue
        kept.append(line)
    out = "\n".join(kept).strip()
    if len(out) <= limit:
        return out
    head = out[:limit]
    edge = head.rfind("\n")
    # Граница строки — только если она близко к концу: иначе одна длинная строка
    # срезает всю выдержку до предыдущего абзаца.
    if edge > limit * 0.7:
        head = head[:edge]
    return head.rstrip() + " …"


def local_state(conn: sqlite3.Connection, session_id: str) -> dict | None:
    """«Где остановились», собранное из транскрипта без единого вызова модели.

    Главный блок карточки не должен зависеть от внешнего вызова: всё нужное уже на диске.
    """
    row = conn.execute(
        "SELECT source_path, cwd_last, branch_last, last_prompt FROM sessions WHERE session_id=?",
        (session_id,)).fetchone()
    if row is None:
        return None
    from .parse import parse_file
    facts = parse_file(row["source_path"], session_id)
    tail = facts.assistant_text[-1] if facts.assistant_text else ""
    summary = facts.summaries[-1] if facts.summaries else None
    if summary:
        # Преамбула одинакова у всех сводок и места в карточке не стоит.
        marker = "Summary:"
        if marker in summary[:400]:
            summary = summary.split(marker, 1)[1].lstrip()
    return {
        "last_prompt": _trim_quote(facts.user_text[-1] if facts.user_text else row["last_prompt"]),
        "last_answer": " ".join(tail.split())[:600],
        "compaction_summary": " ".join(summary.split())[:900] if summary else None,
        "compactions": len(facts.summaries),
        "cwd": row["cwd_last"],
        "branch": row["branch_last"],
        "files": len(set(facts.raw_files)),
        "commands": len(facts.commands),
    }


def load_prompts(conn: sqlite3.Connection, session_id: str, limit: int = 40) -> list[str]:
    """Промпты разбираются по требованию: держать их в БД ради карточки незачем."""
    row = conn.execute(
        "SELECT source_path FROM sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    if row is None:
        return []
    from .parse import parse_file
    return parse_file(row["source_path"], session_id).user_text[:limit]
