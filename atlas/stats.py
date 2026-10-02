"""«Статистика» за период: сессии, токены, активное время, цена по API, попадание в кэш.

Считается по ответам, а не по сессиям: сессия, начатая до периода, попадает в него той частью,
что пришлась на период. Ответ, скопированный возобновлённой сессией, считается один раз.
Сабагенты входят в токены и цену, но не во время (см. atlas/activity.py).
"""
from __future__ import annotations

import sqlite3
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

from .messages import msg

PERIODS = {"today": None, "7d": 7, "30d": 30, "90d": 90, "all": None}
TOP = 30                     # строк разбивки: страница сама режет до видимых
SESSIONS_EACH = 10


def window(period: str, now: datetime | None = None) -> tuple[datetime | None, datetime]:
    """(начало, конец) в местном времени. «Сегодня» — с полуночи, «всё» — без начала."""
    now = now or datetime.now().astimezone()
    if period == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0), now
    days = PERIODS.get(period)
    return (now - timedelta(days=days) if days else None), now


def _utc(dt: datetime | None) -> str:
    # Время в транскриптах — `2026-09-27T18:42:01.304Z`: сравниваем строки того же вида.
    if dt is None:
        return ""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


_ROWS = """
WITH d AS (
  SELECT a.key, MIN(a.session_id) AS sid, MIN(a.ts) AS ts, a.kind,
         MAX(a.active_s) AS act, MAX(a.model) AS model,
         MAX(a.input) AS inp, MAX(a.output) AS out, MAX(a.cache_read) AS cr,
         MAX(a.cache_write) AS cw, MAX(a.cost) AS cost, MAX(a.tools) AS tools
    FROM activity a JOIN sessions s ON s.session_id = a.session_id
   WHERE a.ts >= :since AND a.ts < :until AND (:auto OR s.session_kind = 'interactive')
   GROUP BY a.key)
SELECT d.*, strftime('%Y-%m-%d %H', d.ts, 'localtime') AS lh,
       CAST(strftime('%w', d.ts, 'localtime') AS INTEGER) AS wd
  FROM d"""


def _rows(conn: sqlite3.Connection, since: datetime | None, until: datetime, auto: bool):
    return conn.execute(_ROWS, {"since": _utc(since), "until": _utc(until) or "9",
                                "auto": 1 if auto else 0}).fetchall()


def wall_seconds(rows) -> float:
    """Время за экраном: активные отрезки всех сессий, слитые там, где они шли параллельно."""
    spans = []
    for r in rows:
        act = r["act"] or 0
        if act <= 0:
            continue
        end = datetime.fromisoformat(r["ts"].replace("Z", "+00:00")).timestamp()
        spans.append((end - act, end))
    spans.sort()
    total, cur_start, cur_end = 0.0, None, None
    for start, end in spans:
        if cur_end is None or start > cur_end:
            if cur_end is not None:
                total += cur_end - cur_start
            cur_start, cur_end = start, end
        else:
            cur_end = max(cur_end, end)
    if cur_end is not None:
        total += cur_end - cur_start
    return total


def tool_group(name: str) -> tuple[str, str]:
    """(панель, строка). MCP — по серверу, а не по вызову; скиллы и агенты — отдельно."""
    if name.startswith("mcp__"):
        return "tools", "MCP " + name.split("__")[1]
    if name.startswith("Skill:"):
        return "skills", name[6:]
    if name.startswith("Cmd:"):
        return "skills", name[4:]
    if name.startswith("Agent:"):
        return "agents", name[6:]
    return "tools", name


def _totals(rows) -> dict:
    t = Counter()
    sessions = set()
    unknown = set()
    for r in rows:
        sessions.add(r["sid"])
        t["active_s"] += r["act"] or 0
        if r["kind"] == "p":
            t["prompts"] += 1
            continue
        t["answers"] += 1
        for k in ("inp", "out", "cr", "cw"):
            t[k] += r[k] or 0
        if r["cost"] is None:
            unknown.add(r["model"] or "?")
        else:
            t["cost"] += r["cost"]
    fresh = t["inp"] + t["cw"] + t["cr"]
    return {
        "sessions": len(sessions), "prompts": t["prompts"], "answers": t["answers"],
        "tokens": {"input": t["inp"] + t["cw"], "output": t["out"], "cache_read": t["cr"],
                   "total": t["inp"] + t["cw"] + t["cr"] + t["out"]},
        "cache_hit": (t["cr"] / fresh) if fresh else None,
        "active_s": round(t["active_s"]), "wall_s": round(wall_seconds(rows)),
        "cost": round(t["cost"], 2),
        "unpriced_models": sorted(unknown),
    }


def _series(rows, since: datetime | None, until: datetime) -> dict:
    """По часам, если период — сутки, иначе по дням; пустые промежутки заполнены нулями."""
    hourly = since is not None and until - since <= timedelta(hours=36)
    width = 13 if hourly else 10
    acc: dict[str, Counter] = defaultdict(Counter)
    sess: dict[str, set] = defaultdict(set)
    for r in rows:
        b = r["lh"][:width]
        acc[b]["active_s"] += r["act"] or 0
        acc[b]["cost"] += r["cost"] or 0
        acc[b]["tokens"] += (r["inp"] or 0) + (r["out"] or 0) + (r["cr"] or 0) + (r["cw"] or 0)
        sess[b].add(r["sid"])
    if not acc:
        return {"unit": "hour" if hourly else "day", "points": []}
    first = since.strftime("%Y-%m-%d %H")[:width] if since else min(acc)
    step = timedelta(hours=1) if hourly else timedelta(days=1)
    fmt = "%Y-%m-%d %H" if hourly else "%Y-%m-%d"
    cur, last, points = datetime.strptime(first, fmt), until.strftime(fmt), []
    while (key := cur.strftime(fmt)) <= last and len(points) < 2000:
        c = acc.get(key, Counter())
        points.append({"t": key, "cost": round(c["cost"], 2), "tokens": c["tokens"],
                       "active_s": round(c["active_s"]), "sessions": len(sess.get(key, ()))})
        cur += step
    return {"unit": "hour" if hourly else "day", "points": points}


def _breakdowns(conn: sqlite3.Connection, rows) -> dict:
    ids = {r["sid"] for r in rows}
    names = {}
    for chunk in _chunks(sorted(ids), 500):
        marks = ",".join("?" * len(chunk))
        for r in conn.execute(f"""
            SELECT s.session_id, COALESCE(u.title, s.title) AS title,
                   (SELECT project_id FROM session_projects p
                     WHERE p.session_id = s.session_id AND p.role = 'primary') AS project,
                   COALESCE(u.domain, c.domain, (SELECT domain FROM session_domains d
                     WHERE d.session_id = s.session_id LIMIT 1)) AS domain,
                   COALESCE(u.topic, c.topic) AS topic
              FROM sessions s LEFT JOIN user_overrides u ON u.session_id = s.session_id
              LEFT JOIN classification c ON c.session_id = s.session_id
             WHERE s.session_id IN ({marks})""", chunk):
            names[r["session_id"]] = r
    by = {"project": defaultdict(Counter), "domain": defaultdict(Counter), "topic": defaultdict(Counter),
          "model": defaultdict(Counter), "session": defaultdict(Counter)}
    calls = {"tools": Counter(), "skills": Counter(), "agents": Counter()}
    hours = [0.0] * 24
    week = [[0.0] * 24 for _ in range(7)]
    for r in rows:
        meta = names.get(r["sid"])
        cost, act = r["cost"] or 0, r["act"] or 0
        tokens = (r["inp"] or 0) + (r["out"] or 0) + (r["cr"] or 0) + (r["cw"] or 0)
        keys = {"project": (meta["project"] if meta else None) or "—",
                "domain": (meta["domain"] if meta else None) or "—",
                "topic": (meta["topic"] if meta else None) or msg("stats.no_topic"),
                "session": r["sid"]}
        if r["kind"] == "a":
            keys["model"] = _short_model(r["model"])
        for dim, key in keys.items():
            c = by[dim][key]
            c["cost"] += cost
            c["active_s"] += act
            c["tokens"] += tokens
            c["prompts"] += r["kind"] == "p"
            c["answers"] += r["kind"] == "a"
        if r["tools"]:
            for t in r["tools"].split(","):
                if t:
                    panel, name = tool_group(t)
                    calls[panel][name] += 1
        hour = int(r["lh"][11:13])
        hours[hour] += act
        week[(r["wd"] + 6) % 7][hour] += act          # понедельник — первая строка

    def top(dim, n=TOP, key="cost"):
        items = sorted(by[dim].items(), key=lambda kv: -kv[1][key])[:n]
        return [{"name": k, "cost": round(v["cost"], 2), "active_s": round(v["active_s"]),
                 "tokens": v["tokens"], "prompts": v["prompts"], "answers": v["answers"]}
                for k, v in items]

    # Страница сортирует сама — по цене, токенам или времени: сессий — первые по каждому.
    picked = {}
    for key in ("cost", "tokens", "active_s"):
        for item in top("session", SESSIONS_EACH, key):
            picked[item["name"]] = item
    sessions = list(picked.values())
    for s in sessions:
        meta = names.get(s["name"])
        s["session_id"] = s["name"]
        s["name"] = (meta["title"] if meta else None) or s["name"][:8]
        s["project"] = meta["project"] if meta else None
    return {
        "projects": top("project"), "domains": top("domain"), "topics": top("topic"),
        "models": top("model"),
        "sessions": sessions,
        **{panel: [{"name": k, "count": v} for k, v in c.most_common(15)]
           for panel, c in calls.items()},
        "hours": [round(h) for h in hours],
        "week": [[round(h) for h in day] for day in week],
    }


def _short_model(model: str | None) -> str:
    return (model or "?").replace("claude-", "").split("[")[0]


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def summary(conn: sqlite3.Connection, period: str = "7d", automation: bool = False,
            now: datetime | None = None) -> dict:
    period = period if period in PERIODS else "7d"
    started = time.monotonic()
    since, until = window(period, now)
    rows = _rows(conn, since, until, automation)
    out = {"period": period, "since": since.isoformat() if since else None,
           "until": until.isoformat(), "automation": automation,
           "totals": _totals(rows), "series": _series(rows, since, until)}
    out.update(_breakdowns(conn, rows))
    # Прошлый такой же отрезок — для сравнения «больше / меньше, чем обычно».
    if since is not None:
        prev = _rows(conn, since - (until - since), since, automation)
        out["previous"] = _totals(prev)
    out["took_ms"] = round((time.monotonic() - started) * 1000)
    return out
