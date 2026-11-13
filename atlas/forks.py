"""Copies Claude Code made of a session (`--fork-session`, /branch).

A copy carries its source's title, so two entries in the list read the same. While the titles are
equal, the copies are numbered: "Title (2)", "Title (3)". The number is worked out on reading, not
stored: a rename on either side changes it, and the copy table is a handful of rows.
"""
from __future__ import annotations

import sqlite3


def numbers(conn: sqlite3.Connection) -> dict[str, int]:
    """session id -> its number among same-title copies; the source of a family has none.

    Copies of one source with the same title are one family, and so is the source while its title
    is the same: a copy of a copy never takes a sibling's number. A source that has left the
    catalog still counts as the first, so its copies keep their numbers. A session renamed in
    Atlas shows its own name and is left out of the count."""
    edges = conn.execute(
        """SELECT f.session_id AS child, f.parent_id AS parent, f.at, c.title,
                  p.session_id AS found, p.title AS parent_title FROM session_forks f
             JOIN sessions c ON c.session_id = f.session_id
             LEFT JOIN sessions p ON p.session_id = f.parent_id
            WHERE COALESCE(c.title, '') <> ''""").fetchall()
    if not edges:
        return {}
    root: dict = {}

    def find(x):
        while root.setdefault(x, x) != x:
            root[x] = root[root[x]]
            x = root[x]
        return x

    made, gone = {}, set()
    for e in edges:
        siblings = ("copies of", e["parent"], e["title"])
        root[find(e["child"])] = find(siblings)
        made[e["child"]] = e["at"] or ""
        if e["found"] is None:
            gone.add(siblings)                # stands in for the source in the count
        elif e["parent_title"] == e["title"]:
            root[find(siblings)] = find(e["parent"])
    renamed = {r["session_id"] for r in conn.execute(
        "SELECT session_id FROM user_overrides WHERE COALESCE(title, '') <> ''")}
    families: dict = {}
    for node in list(root):
        if (isinstance(node, str) and node not in renamed) or node in gone:
            families.setdefault(find(node), []).append(node)
    out = {}
    for family in families.values():
        # The source first, then the copies in the order they were made.
        family.sort(key=lambda n: (n in made, made.get(n, ""), str(n)))
        out.update({sid: n for n, sid in enumerate(family[1:], start=2) if isinstance(sid, str)})
    return out


def label(title: str | None, number: int | None) -> str | None:
    return f"{title} ({number})" if title and number else title


def shown(row, nums: dict[str, int]) -> str | None:
    """A row with session_id, title and renamed (an Atlas rename is shown as typed)."""
    return row["title"] if row["renamed"] else label(row["title"], nums.get(row["session_id"]))


def lineage(conn: sqlite3.Connection, session_id: str, nums: dict[str, int]) -> dict:
    """The session this one is a copy of, and its own copies, with the titles the list shows."""
    def titled(rows) -> list[dict]:
        return [{"session_id": r["session_id"], "title": label(r["title"], nums.get(r["session_id"]))}
                for r in rows]

    source = conn.execute(
        "SELECT s.session_id, COALESCE(NULLIF(u.title, ''), s.title) AS title FROM session_forks f "
        "JOIN sessions s ON s.session_id = f.parent_id "
        "LEFT JOIN user_overrides u ON u.session_id = s.session_id WHERE f.session_id=?",
        (session_id,)).fetchall()
    copies = conn.execute(
        "SELECT s.session_id, COALESCE(NULLIF(u.title, ''), s.title) AS title FROM session_forks f "
        "JOIN sessions s ON s.session_id = f.session_id "
        "LEFT JOIN user_overrides u ON u.session_id = s.session_id "
        "WHERE f.parent_id=? ORDER BY f.at, s.session_id", (session_id,)).fetchall()
    found = titled(source)
    return {"forked_from": found[0] if found else None, "forks": titled(copies)}
