"""Search: candidates from FTS5, card filters, highlighting only for the visible page."""
from __future__ import annotations

import sqlite3

from . import agents as agents_mod, query as q
from .query import (  # noqa: F401
    FTS_COLUMNS,
    IDENTIFIER_RE,
    PREFIX_MIN_LEN,
    SCOPE_COLUMNS,
    STEM_FLOOR,
    QueryError,
    build_match,
    is_pathlike,
    stem_prefix,
)

# Column weights for bm25. Title and ticket identify a session better than a phrase in a reply.
COLUMN_WEIGHTS = {"title": 10.0, "user_text": 5.0, "assistant_text": 2.0,
                  "commands": 3.0, "paths": 3.0, "tickets": 8.0, "summaries": 4.0,
                  "subagent_text": 1.5}

# How many fields with a snippet are returned per session: the rest only as a count.
FRAGMENTS_PER_SESSION = 2


def _weights() -> list[float]:
    # The first fts column is session_id: without a leading zero the weights shift one column right
    # (the title weight goes to session_id, the requests weight to the title, and so on).
    return [0.0] + [COLUMN_WEIGHTS[c] for c in FTS_COLUMNS] + [0.0]


def _session_where(kinds, include_automation, since, agents=None) -> tuple[list[str], list]:
    """Session kind, agent and date are filtered in SQL: there are hundreds of background runs."""
    where, args = [], []
    if agents:
        where.append(f"s.agent IN ({','.join('?' * len(agents))})")
        args += agents
    if not include_automation and not kinds:
        where.append("s.session_kind = 'interactive'")
    elif kinds:
        where.append(f"s.session_kind IN ({','.join('?' * len(kinds))})")
        args += kinds
    if since:
        where.append("s.last_activity_at >= ?")
        args.append(since)
    return where, args


def _scoped(columns: tuple[str, ...], expr: str) -> str:
    return expr if columns == FTS_COLUMNS else "{" + " ".join(columns) + "} : (" + expr + ")"


def _best_per_session(conn, match: str, where: list[str], args: list) -> dict[str, float]:
    """Best bm25 score over the session's turn rows: a row is a turn, the best turn decides.

    The minimum is taken in Python: bm25 cannot be called inside a SQLite GROUP BY.
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
                include_automation, since, order, agents=None) -> list[tuple[str, float]]:
    """Sessions containing every word group of the query, in any turns, not necessarily one.

    A group is a word or an OR chain; excluded words are subtracted over the whole session.
    """
    where, args = _session_where(kinds, include_automation, since, agents)
    total: dict[str, float] | None = None
    for group in parsed.groups:
        expr = group[0].fts() if len(group) == 1 else "(" + " OR ".join(t.fts() for t in group) + ")"
        found = _best_per_session(conn, _scoped(columns, expr), where, args)
        total = found if total is None else {sid: total[sid] + score for sid, score in found.items() if sid in total}
        if not total:
            return []
    for term in parsed.excluded:
        for sid in _best_per_session(conn, _scoped(columns, term.fts()), where, args):
            total.pop(sid, None)
    if not total:
        return []
    dates = {r["session_id"]: r["last_activity_at"] or "" for r in conn.execute(
        f"SELECT session_id, last_activity_at FROM sessions WHERE session_id IN ({','.join('?' * len(total))})",
        list(total))}
    if order == "date":
        keys = sorted(total, key=lambda sid: dates.get(sid, ""), reverse=True)
    else:
        by_date = sorted(total, key=lambda sid: dates.get(sid, ""), reverse=True)
        keys = sorted(by_date, key=lambda sid: total[sid])      # stable: ties keep date order
    return [(sid, total[sid]) for sid in keys]


def _trigram_extra(conn, query: str, known: set[str], limit: int, *, kinds,
                   include_automation, since, agents=None) -> list[tuple[str, float]]:
    """Substring search over paths and commands: `release.mjs` inside `deploy-release.mjs`."""
    extra, extra_args = _session_where(kinds, include_automation, since, agents)
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
    """How many session rows match the expression, for each of the given sessions."""
    if not session_ids:
        return {}
    marks = ",".join("?" * len(session_ids))
    out: dict[str, int] = {}
    for r in conn.execute(f"SELECT session_id FROM fts WHERE fts MATCH ? AND session_id IN ({marks})",
                          (match, *session_ids)):
        out[r["session_id"]] = out.get(r["session_id"], 0) + 1
    return out


def _by_relevance(conn, parsed: q.Parsed, cands, columns) -> list[tuple[str, float]]:
    """Title with all words first, then words close together in one turn, then bm25.

    bm25 alone ranks first huge sessions with query words scattered over megabytes.
    Closeness is measured inside a turn row, so it does not match across two messages.
    """
    ids = [sid for sid, _ in cands]
    if not ids:
        return cands
    in_title = set(_sessions_matching(conn, q.title_match(parsed), ids))
    pairs = dict.fromkeys(ids, 0)
    for near in q.near_pairs(parsed, columns):
        for sid in _sessions_matching(conn, near, ids):
            pairs[sid] += 1
    position = {sid: i for i, sid in enumerate(ids)}      # within a tier, bm25 order
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
        # The domain may come from the classifier, so it is filtered after the card is built.
        if domains and not (set(domains) & set(meta["domains"])):
            continue
        if topics and meta["topic"] not in topics:
            continue
        out.append((sid, meta, score))
    return out


def _highlight(conn, parsed: q.Parsed, session_ids: list[str],
               columns: tuple[str, ...]) -> dict[str, list[dict]]:
    """Highlighting over turn rows of the visible sessions: matches are summed, the snippet comes
        from the turn where most distinct query words meet."""
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
    """The title is short: returned whole, highlighted in place."""
    return q.segments(marked, width=len(marked) + 1)[0]


def run(conn: sqlite3.Connection, query: str, limit: int = 20,
        projects: list[str] | None = None, domains: list[str] | None = None,
        kinds: list[str] | None = None, since: str | None = None,
        include_automation: bool = False, topics: list[str] | None = None,
        scope: str = "prompts", order: str = "date", agents: list[str] | None = None) -> dict:
    """Results plus how the query was understood, the full count and a hint about another scope.
    `agents` narrows to sessions of these agents (claude, codex); None means all."""
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
    opts = {"kinds": kinds, "include_automation": include_automation, "since": since,
            "agents": agents}
    filters = {"projects": projects, "domains": domains, "topics": topics}
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
            # Trigram addition: the word was found as a path substring, the FTS token misses it.
            matches = [{"field": "paths", "segments": [], "fragment": "", "hits": 0,
                        "score": 0.0}]
        # The title is usually the first request: in snippets and in the total it duplicates the
        # requests, so it is highlighted in place, not as a separate snippet.
        title = next((m for m in matches if m["field"] == "title"), None)
        body = [m for m in matches if m["field"] != "title"] or matches
        meta["score"] = round(-score, 4) if score else 0.0
        meta["title_segments"] = _whole(title["marked"]) if title and title.get("marked") else None
        meta["hits"] = sum(m["hits"] for m in body)
        meta["hit_fields"] = {m["field"]: m["hits"] for m in matches}
        meta["matches"] = [{k: v for k, v in m.items() if k != "marked"}
                           for m in body[:FRAGMENTS_PER_SESSION]]
        out["results"].append(meta)

    # The narrow default scope hides sessions where the word was only in replies or commands.
    # Their number is reported, not hidden: otherwise "nothing found" looks like the truth.
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
    # A manual value overrides the rule and is never overwritten by the indexer.
    sensitivity = (override["sensitivity"] if override and override["sensitivity"]
                   else row["sensitivity_rule"])
    # Priority: manual → model verdict → path rule.
    # The model ranks above the rule on purpose: the rule sees only the path, and "the session
    # touched a file in ~/.claude" does not make work on a client repository cross-cutting.
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
        "agent": row["agent"],
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
        # A parked conversation: the background job it went on in, or the session it came from.
        "continued_from": row["continued_from"],
        "continued_in": row["continued_in"],
        **conversions(conn, session_id),
    }


def conversions(conn: sqlite3.Connection, session_id: str) -> dict:
    """"Resume with…" (atlas/convert.py): the session this one was copied from, and its copies."""
    source = conn.execute(
        "SELECT c.source_session_id AS session_id, c.source_agent AS agent, c.at, "
        "COALESCE(u.title, s.title) AS title FROM conversions c "
        "LEFT JOIN sessions s ON s.session_id = c.source_session_id "
        "LEFT JOIN user_overrides u ON u.session_id = c.source_session_id "
        "WHERE c.session_id=?", (session_id,)).fetchone()
    copies = conn.execute("SELECT session_id, agent, at FROM conversions "
                          "WHERE source_session_id=? ORDER BY at", (session_id,)).fetchall()
    return {"converted_from": dict(source) if source else None,
            "converted_to": [dict(r) for r in copies]}


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
           scope: str = "prompts", order: str = "date",
           agents: list[str] | None = None) -> list[dict]:
    """List without a query: most recent activity first."""
    sql = ["SELECT s.session_id FROM sessions s"]
    where, args = [], []
    if agents:
        where.append(f"s.agent IN ({','.join('?' * len(agents))})")
        args += agents
    if projects:
        sql.append("JOIN session_projects p ON p.session_id = s.session_id")
        where.append(f"p.project_id IN ({','.join('?' * len(projects))})")
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
        # The domain may come from the classifier, so it is filtered after the card is built.
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

# The request is shown as is: line breaks in it carry meaning (lists, tables).
# But the length is limited: full requests are read in their own card block.
QUOTE_LIMIT = 900


def _trim_quote(text: str, limit: int = QUOTE_LIMIT) -> str:
    """Collapses blank lines and cuts at a line boundary, keeping the line breaks."""
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
    # Cut at a line boundary only if it is near the end: otherwise one long line
    # cuts the whole excerpt back to the previous paragraph.
    if edge > limit * 0.7:
        head = head[:edge]
    return head.rstrip() + " …"


def local_state(conn: sqlite3.Connection, session_id: str) -> dict | None:
    """The "where we left off" block, built from the transcript without any model call.

    The main card block must not depend on an external call: all it needs is already on disk.
    """
    row = conn.execute(
        "SELECT source_path, cwd_last, branch_last, last_prompt, agent FROM sessions "
        "WHERE session_id=?", (session_id,)).fetchone()
    if row is None:
        return None
    facts = agents_mod.parse_session(row["source_path"], session_id, row["agent"])
    tail = facts.assistant_text[-1] if facts.assistant_text else ""
    summary = facts.summaries[-1] if facts.summaries else None
    if summary:
        # The preamble is the same in all summaries and is not worth card space.
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
    """Prompts are parsed on demand: there is no reason to keep them in the DB for the card."""
    row = conn.execute(
        "SELECT source_path, agent FROM sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    if row is None:
        return []
    return agents_mod.parse_session(row["source_path"], session_id, row["agent"]).user_text[:limit]
