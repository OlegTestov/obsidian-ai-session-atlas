"""Cache rewrites: replies that wrote the whole context to the prompt cache again, and what that cost.

A "cold" main-thread reply carries at least COLD_MIN fresh tokens (input + cache writes) and more of
them than it read from the cache. Its extra cost is the reply's cost minus the same usage read from
the cache. The cause is the gap to the session's previous main-thread reply (the last one before the
period counts too) against the lifetime of the cache the latest earlier writer paid for.
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta

from . import costs, forks, openai_costs
from .agents import CODEX

COLD_MIN = 20_000
CHANGED_MAX_S = 300          # the short cache life; also the guess when nobody wrote before
PAUSE_MAX_S = 3600           # past an hour even the long cache is gone
CAUSES = ("pause_long", "pause", "changed")
TOP_SESSIONS = 10


def is_cold(r) -> bool:
    fresh = (r["inp"] or 0) + (r["cw"] or 0)
    return fresh >= COLD_MIN and fresh > (r["cr"] or 0)


def cause(gap_s: float | None, lifetime_s: float = CHANGED_MAX_S) -> str:
    if gap_s is None:
        return "first"
    if gap_s > PAUSE_MAX_S:
        return "pause_long"
    return "pause" if gap_s > lifetime_s else "changed"


def lifetime(w) -> float | None:
    """Cache life of a reply that wrote the cache. Claude Code writes 5-minute or 1-hour entries and
    prices them differently: the stored cost is nearer to one price than to the other. None when the
    reply wrote nothing or has no price (Codex, unpriced models): the caller keeps the earlier answer."""
    if w is None or not w["cw"] or w["cost"] is None:
        return None
    usage = {"input_tokens": w["inp"] or 0, "output_tokens": w["out"] or 0, "cache_read_input_tokens": w["cr"] or 0}
    short = costs.message_cost(w["model"], dict(usage, cache_creation_input_tokens=w["cw"]))
    long = costs.message_cost(w["model"], dict(usage, cache_creation_input_tokens=w["cw"], cache_creation={
        "ephemeral_1h_input_tokens": w["cw"], "ephemeral_5m_input_tokens": 0}))
    if short is None or long is None:
        return None
    return PAUSE_MAX_S if w["cost"] > (short + long) / 2 else CHANGED_MAX_S


def extra_cost(r, prices: dict | None) -> float | None:
    """What the reply cost beyond a warm cache; None when the model or the reply has no price."""
    if r["cost"] is None:
        return None
    inp, cr, cw, out = (r[k] or 0 for k in ("inp", "cr", "cw", "out"))
    if r["agent"] == CODEX:
        warm = openai_costs.reply_cost(r["model"], 0, cr + inp + cw, 0, out, prices)
    else:
        warm = costs.message_cost(r["model"], {"output_tokens": out, "cache_read_input_tokens": cr + inp + cw})
    return None if warm is None else r["cost"] - warm


def _epoch(ts: str) -> float:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def _session_names(conn: sqlite3.Connection, ids: list[str]) -> dict:
    out = {}
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        for r in conn.execute(f"""
            SELECT s.session_id, COALESCE(u.title, s.title) AS title,
                   COALESCE(u.title, '') <> '' AS renamed,
                   (SELECT project_id FROM session_projects p
                     WHERE p.session_id = s.session_id AND p.role = 'primary') AS project
              FROM sessions s LEFT JOIN user_overrides u ON u.session_id = s.session_id
             WHERE s.session_id IN ({','.join('?' * len(chunk))})""", chunk):
            out[r["session_id"]] = r
    return out


_COLS = "session_id AS sid, key, ts, model, input AS inp, output AS out, cache_read AS cr, cache_write AS cw, cost"


# Unlike stats._ROWS, the smallest id is taken among all sessions, not only those the filters keep:
# the catalog has no reply shared by an automation and an interactive session.
_OWN = """NOT EXISTS (SELECT 1 FROM activity b WHERE b.ts = a.ts AND b.key = a.key AND b.session_id < a.session_id)"""


def _earlier_gap_rows(conn, sids: set, since: str) -> dict:
    """sid -> its last own main-thread reply in the hour before `since`; replies that far back are the
    only ones that can make a gap shorter than an hour. "Own" follows stats._ROWS: a reply shared by
    several sessions belongs to the one with the smallest id."""
    lo = (datetime.fromisoformat(since.replace("Z", "+00:00")) - timedelta(seconds=PAUSE_MAX_S)
          ).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    found: dict = {}
    for r in conn.execute(f"SELECT {_COLS} FROM activity a WHERE ts >= ? AND ts < ? AND kind = 'a' AND sub = 0 "
                          f"AND {_OWN} ORDER BY ts DESC", (lo, since)):
        if r["sid"] in sids and r["sid"] not in found:
            found[r["sid"]] = dict(r)
    return found


def _has_earlier(conn, sid: str, since: str) -> bool:
    """Any own main-thread reply before `since`: a session that ran earlier is a pause, not a start."""
    return conn.execute(f"SELECT 1 FROM activity a WHERE session_id = ? AND kind = 'a' AND sub = 0 AND ts < ? "
                        f"AND {_OWN} LIMIT 1", (sid, since)).fetchone() is not None


def _last_lifetime(conn, sid: str, since: str) -> float | None:
    """Cache life of the session's last priced writer before `since`."""
    for r in conn.execute(f"SELECT {_COLS} FROM activity a WHERE session_id = ? AND kind = 'a' AND sub = 0 "
                          f"AND cache_write > 0 AND ts < ? AND {_OWN} ORDER BY ts DESC", (sid, since)):
        life = lifetime(r)
        if life is not None:
            return life
    return None


def summarize(conn: sqlite3.Connection, rows, period_cost: float | None, prices: dict | None,
              since: str | None = None) -> dict:
    by_session = defaultdict(list)
    for r in rows:
        if r["kind"] == "a" and not r.get("sub"):
            by_session[r["sid"]].append(r)
    for replies in by_session.values():
        replies.sort(key=lambda r: r["ts"])
    start = {sid for sid, replies in by_session.items() if is_cold(replies[0])} if since else set()
    last_any = _earlier_gap_rows(conn, start, since) if start else {}
    for sid in start:
        if sid not in last_any and _has_earlier(conn, sid, since):    # more than an hour back: a long pause
            last_any[sid] = {"ts": "1970-01-01T00:00:00.000Z"}
    life_before_period: dict = {}        # sid -> lifetime of its last priced writer before `since`
    by_cause = {c: {"count": 0, "cost": 0.0, "tokens": 0, "priced": 0} for c in CAUSES}
    per_session: dict[str, dict] = {}
    for sid, replies in by_session.items():
        prev = last_any.get(sid, {}).get("ts")
        life = None
        for r in replies:
            # Parse times only around cold replies: they are a few hundred among many thousands.
            before, prev = prev, r["ts"]
            life_before = life
            if r["cw"]:
                life = lifetime(r) or life            # an unpriced writer keeps the earlier answer
            if not is_cold(r):
                continue
            gap = None if before is None else _epoch(r["ts"]) - _epoch(before)
            if life_before is None and since and gap is not None and CHANGED_MAX_S < gap <= PAUSE_MAX_S:
                # No priced writer in the period yet: the lifetime comes from the one before it.
                if sid not in life_before_period:
                    life_before_period[sid] = _last_lifetime(conn, sid, since)
                life_before = life_before_period[sid]
            why = cause(gap, life_before or CHANGED_MAX_S)
            if why == "first":
                continue
            known = extra_cost(r, prices)
            extra = known or 0.0
            bucket = by_cause[why]
            bucket["priced"] += known is not None
            bucket["count"] += 1
            bucket["cost"] += extra
            bucket["tokens"] += (r["inp"] or 0) + (r["cw"] or 0)
            s = per_session.setdefault(sid, {"count": 0, "cost": 0.0, "priced": 0,
                                             "causes": dict.fromkeys(CAUSES, 0)})
            s["count"] += 1
            s["priced"] += known is not None
            s["cost"] += extra
            s["causes"][why] += 1
    cost = sum(b["cost"] for b in by_cause.values())
    top = sorted(per_session.items(), key=lambda kv: (-kv[1]["cost"], -kv[1]["count"]))[:TOP_SESSIONS]
    names = _session_names(conn, [sid for sid, _ in top])
    nums = forks.numbers(conn) if top else {}
    sessions = []
    for sid, s in top:
        meta = names.get(sid)
        sessions.append({"session_id": sid, "name": (forks.shown(meta, nums) if meta else None) or sid[:8],
                         "project": meta["project"] if meta else None, "count": s["count"],
                         "cost": round(s["cost"], 2) if s["priced"] else None, "causes": s["causes"]})
    count = sum(b["count"] for b in by_cause.values())
    priced = sum(b["priced"] for b in by_cause.values())
    unknown = bool(count) and not priced                 # replies were found but none has a price
    return {"cost": None if unknown else round(cost, 2),
            "share": None if unknown or not period_cost else cost / period_cost, "count": count,
            "by_cause": {c: {"count": b["count"],
                             "cost": None if b["count"] and not b["priced"] else round(b["cost"], 2),
                             "tokens": b["tokens"]} for c, b in by_cause.items()},
            "sessions": sessions}
