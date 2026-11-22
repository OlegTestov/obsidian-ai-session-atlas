"""Read OpenCode 2's catalog snapshot without contacting its service."""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from collections import defaultdict
from contextlib import closing, contextmanager
from pathlib import Path

from . import agents, config, db

DATABASE = "opencode.db"
STATE = "opencode_state"
FINGERPRINT = "opencode_fingerprint"
VERSION = 3
SESSION = ("id", "title", "directory", "version", "parent_id", "fork_session_id", "fork_boundary",
           "time_created", "time_updated", "time_archived")
MESSAGE = ("id", "session_id", "type", "seq", "time_created", "time_updated", "data")


def data_home() -> Path:
    override = os.environ.get("ATLAS_OPENCODE_HOME") or config.get("opencode_home")
    if isinstance(override, str) and override.strip():
        return Path(override.strip()).expanduser().absolute()
    xdg = os.environ.get("XDG_DATA_HOME")
    return (Path(xdg).expanduser() if xdg else Path.home() / ".local/share").absolute() / "opencode"


def discover(root: str, codex_root: str) -> agents.Discovery:
    # One source per database at discovery, expanded to one locator per root in its snapshot.
    return "complete", [agents.SourceRef(agents.OPENCODE, str(data_home() / DATABASE))]


@contextmanager
def open_readonly(path: Path):
    path = path.resolve(strict=True)
    before = _stat_key(path.stat())
    cold = _wal_stat(path) is None
    uri = path.as_uri() + "?mode=ro" + ("&immutable=1" if cold else "")
    with closing(sqlite3.connect(uri, uri=True, timeout=3.0)) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=1")
        conn.execute("BEGIN")
        yield conn
    if cold and (_wal_stat(path) is not None or _stat_key(path.stat()) != before):
        raise OSError("OpenCode database changed during a cold read")


def schema_state(conn) -> str:
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "session_v2" not in tables:
        return "v1" if {"session", "message", "part"} <= tables else "unsupported"
    for name, required in (("session_v2", SESSION), ("session_message", MESSAGE)):
        actual = {row["name"] for row in conn.execute(f"PRAGMA table_info({name})")}
        if not set(required) <= actual:
            return "unsupported"
    return "v2"


def _stat_key(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _wal_stat(path):
    try:
        return _stat_key(Path(str(path) + "-wal").stat())
    except FileNotFoundError:
        return None


def _fingerprint(path, st):
    return [str(path), _stat_key(st), _wal_stat(path), VERSION, config.index_fingerprint()]


def _sessions(conn):
    fields = ", ".join(SESSION)
    return conn.execute(f"""
        SELECT {fields},
               (SELECT MAX(seq) FROM session_message WHERE session_id = s.id) AS max_seq,
               (SELECT MAX(time_updated) FROM session_message WHERE session_id = s.id) AS message_updated,
               (SELECT COUNT(*) FROM session_message WHERE session_id = s.id) AS message_count
          FROM session_v2 s ORDER BY id
    """).fetchall()


def _groups(rows):
    parents = {r["id"]: r["parent_id"] for r in rows}
    groups = defaultdict(list)
    for row in rows:
        sid = root = row["id"]
        visited = set()
        while parents.get(root) in parents and root not in visited:
            visited.add(root)
            root = parents[root]
        # Orphans and invalid cycles don't cause otherwise readable messages to be lost.
        if root in visited or parents.get(root):
            root = sid
        groups[root].append(row)
    return groups


def _signature(path_stat, group, fork_source_title):
    return json.dumps([VERSION, path_stat.st_dev, path_stat.st_ino, config.index_fingerprint(),
                       [tuple(row) for row in group], fork_source_title], ensure_ascii=False)


def _session_ref(path, sid):
    return agents.SourceRef(agents.OPENCODE, f"{path.as_uri()}#{sid}")


def read(ref: agents.SourceRef, *, conn, row, subagents=(), fork_source_title=None) -> agents.SourceFacts:
    from . import opencode_parse

    def project(session, source_title=None):
        messages = conn.execute("""
            SELECT id, type, seq, time_created, data FROM session_message
             WHERE session_id = ? ORDER BY seq
        """, (session["id"],))
        return opencode_parse.project(session, messages, fork_source_title=source_title)

    facts = project(row, fork_source_title)
    facts.source_path = ref.locator
    return agents.SourceFacts(facts, [project(child) for child in subagents])


def _changed_sources(source, rows, path, st, known, previous, full):
    from .index import _changed

    present, changed = set(), []
    roots = {row["id"]: row for row in rows}
    for sid, group in _groups(rows).items():
        if not agents.valid_id(agents.OPENCODE, sid):
            raise ValueError("Unexpected OpenCode session ID")
        ref = _session_ref(path, sid)
        present.add(ref.locator)
        row = roots[sid]
        original = roots.get(row["fork_session_id"])
        source_title = original["title"] if original else None
        sig = _signature(st, group, source_title)
        if full or ref.locator not in previous or _changed(known.get(ref.locator), sig):
            children = [row for row in group if row["id"] != sid]
            snapshot = read(ref, conn=source, row=row, subagents=children, fork_source_title=source_title)
            changed.append((ref, sig, snapshot, row["time_archived"]))
    return present, changed


def _index_refs(conn, refs, _home, known, present, stats, full, _paced, _protected):
    from . import store

    previous = {r[0] for r in conn.execute("SELECT source_path FROM sessions WHERE agent=?", (agents.OPENCODE,))}
    try:
        path = Path(refs[0].locator).resolve(strict=True)
        st = path.stat()
        fingerprint = _fingerprint(path, st)
        cache = json.dumps([fingerprint, sorted(previous)])
        if not full and previous <= known.keys() and db.get_meta(conn, FINGERPRINT) == cache:
            stats["seen"] += len(previous)
            stats["skipped"] += len(previous)
            present.update(previous)
            return
        with open_readonly(path) as source:
            state = schema_state(source)
            if state == "v2":
                rows = _sessions(source)
                found, changed = _changed_sources(source, rows, path, st, known, previous, full)
    except FileNotFoundError:
        state = "missing"
    except (OSError, sqlite3.Error, ValueError, OverflowError) as exc:
        # Exception details from damaged rows/JSON may contain source text.
        print(f"atlas index: OpenCode read failed ({type(exc).__name__})", file=sys.stderr)
        stats["errors"] += 1
        state = "unavailable"
    if state != "v2":
        present.update(previous)
        db.set_meta(conn, STATE, state)
        db.set_meta(conn, FINGERPRINT, cache if state in {"v1", "unsupported"} else "")
        return

    # The source read transaction has ended. Apply the whole successful snapshot with the purge
    # in index_all's final Atlas transaction, so its watermark can't run ahead of the catalog.
    for ref, sig, (facts, children), archived in changed:
        store.store_snapshot(conn, ref.locator, st, sig, facts, children)
        answer = facts.assistant_text[-1] if facts.assistant_text else ""
        conn.execute("INSERT OR REPLACE INTO opencode_details VALUES (?,?,?)",
                     (facts.session_id, bool(archived), " ".join(answer.split())[:600]))
    stats["indexed"] += len(changed)
    stats["full"] += len(changed)
    stats["seen"] += len(found)
    stats["skipped"] += len(found) - len(changed)
    stats["subagent_files"] += len(rows) - len(found)
    present.update(found)
    db.set_meta(conn, STATE, state)
    db.set_meta(conn, FINGERPRINT, json.dumps([fingerprint, sorted(found)]))


def session_metadata(sid):
    if not agents.valid_id(agents.OPENCODE, sid):
        return None
    try:
        with open_readonly(data_home() / DATABASE) as conn:
            row = (conn.execute("SELECT directory, time_archived FROM session_v2 WHERE id=?", (sid,)).fetchone()
                   if schema_state(conn) == "v2" else None)
        return row
    except (OSError, sqlite3.Error):
        return None


def session_directory(sid):
    row = session_metadata(sid)
    return row["directory"] if row else None


def status(conn):
    from .opencode_service import binary

    rows = conn.execute("SELECT 1 FROM sessions WHERE agent=? LIMIT 1", (agents.OPENCODE,)).fetchone()
    state = db.get_meta(conn, STATE) or "missing"
    return {"state": state, "available": bool(binary() or rows)}
