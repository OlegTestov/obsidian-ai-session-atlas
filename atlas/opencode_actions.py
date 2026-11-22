"""Explicit native catalog actions. Catalog indexing remains independent of the service."""
from __future__ import annotations

import json
import os
import re
import shlex
import sqlite3
import time

from . import agent_opencode, agents, opencode_service as service, opencode_tabs, search_rows
from .messages import msg

TOKEN = re.compile(r"[A-Za-z0-9_-]{16,80}")
FORK_INTENT_TTL = 30


def _valid(sid):
    return agents.valid_id(agents.OPENCODE, sid)


def command(cwd, sid=None, first_prompt=""):
    args = ["opencode", cwd]
    if sid:
        args += ["--session", sid]
    if first_prompt:
        args += ["--prompt", first_prompt]
    return "cd " + shlex.quote(cwd) + " && " + shlex.join(args)


def resume(sid):
    cwd = opencode_tabs.checked_directory(sid)
    if not os.path.isdir(cwd):
        raise service.ServiceError("session_missing")
    return {"agent": agents.OPENCODE, "cwd": cwd, "session_id": sid, "command": command(cwd, sid)}


def _client():
    client = service.Client(service.ensure())
    return client, opencode_tabs.verify_profile(client)


def _native_session(client, sid):
    if not _valid(sid):
        raise service.ServiceError("session_missing")
    value = client.data("session/" + sid)
    if value.get("id") != sid:
        raise service.ServiceError("request_failed")
    return value


def _patch(sid, body, verify):
    opencode_tabs.checked_directory(sid)
    client, _ = _client()
    try:
        client.call("PATCH", "session/" + sid, body)
    except service.ServiceError as exc:
        if exc.state != "stopped":
            raise
    if not verify(_native_session(client, sid)):
        raise service.ServiceError("request_failed")


def rename(conn, sid, title):
    if not title:
        raise ValueError(msg("rename.empty"))
    with opencode_tabs.action_lock():
        _patch(sid, {"title": title}, lambda row: row.get("title") == title)
        with search_rows.writing(conn):
            conn.execute("UPDATE sessions SET title=?,title_source='native' WHERE session_id=?", (title, sid))
            conn.execute("UPDATE user_overrides SET title=NULL WHERE session_id=?", (sid,))
        conn.commit()
    return {"title": title, "written_to_transcript": True, "error": None}


def archive(sid, archived):
    if type(archived) is not bool:
        raise service.ServiceError("request_failed")
    with opencode_tabs.action_lock():
        _patch(sid, {"archived": archived},
               lambda row: isinstance(row.get("time"), dict) and bool(row["time"].get("archived")) == archived)
    return {"archived": archived}


def _children(client, sid):
    result = {}
    queue = [sid]
    while queue:
        parent = queue.pop()
        for row in client.sessions(parentID=parent):
            child = row.get("id") if isinstance(row, dict) else None
            if not _valid(child) or child == sid or row.get("parentID") != parent:
                raise service.ServiceError("request_failed")
            if child not in result:
                result[child] = row.get("title") if isinstance(row.get("title"), str) else child
                queue.append(child)
            if len(result) > 2000:
                raise service.ServiceError("request_failed")
    return [{"session_id": child, "title": title} for child, title in sorted(result.items())]


def _tab_block_reason(ids):
    opened, unknown = opencode_tabs.open_tabs()
    if unknown:
        return "unknown_tab"
    return "open_tab" if ids & opened else None


def _block_reason(client, ids):
    if ids & client.data("session/active").keys():
        return "running"
    return _tab_block_reason(ids)


def delete_eligibility(sid):
    opencode_tabs.checked_directory(sid)
    blocked = _tab_block_reason({sid})
    if not blocked:
        database = agent_opencode.data_home() / agent_opencode.DATABASE
        if sid in service.active_sessions(database):
            blocked = "running"
    return {"disabled_reason": msg("opencode." + blocked) if blocked else None}


def delete_preview(sid):
    opencode_tabs.checked_directory(sid)
    if blocked := _tab_block_reason({sid}):
        return {"children": [], "disabled_reason": msg("opencode." + blocked)}
    client, path = _client()
    _native_session(client, sid)
    children = _children(client, sid)
    blocked = _block_reason(client, {sid, *(row["session_id"] for row in children)})
    default = service.xdg_dir("XDG_DATA_HOME", ".local/share") / agent_opencode.DATABASE
    return {"children": children, "disabled_reason": msg("opencode." + blocked) if blocked else None,
            "service_generation": client.generation, "database": str(path) if path != default.resolve() else None}


def _verify_delete(client, ids):
    for sid in ids:
        try:
            _native_session(client, sid)
        except service.ServiceError as exc:
            if exc.status != 404:
                raise
        else:
            raise service.ServiceError("request_failed")


def _db_sessions(path):
    try:
        with agent_opencode.open_readonly(path) as conn:
            return {row["id"]: row for row in conn.execute("SELECT id,parent_id,title FROM session_v2")}
    except (OSError, sqlite3.Error):
        raise service.ServiceError("request_failed") from None


def _descendants(sessions, sid):
    by_parent = {}
    for key, row in sessions.items():
        by_parent.setdefault(row["parent_id"], []).append(key)
    found = {sid}
    pending = [sid]
    while pending:
        for child in by_parent.get(pending.pop(), ()):
            if child not in found:
                found.add(child)
                pending.append(child)
    return found


def delete(sid, confirmed, *, generation=None):
    if not isinstance(confirmed, list) or not all(_valid(child) for child in confirmed):
        raise service.ServiceError("children_changed")
    with opencode_tabs.action_lock():
        opencode_tabs.checked_directory(sid)
        client, path = _client()
        if generation is not None and generation != client.generation:
            raise service.ServiceError("service_changed")
        ids = {sid, *confirmed}
        blocked = _block_reason(client, ids)
        if blocked:
            raise service.ServiceError(blocked)
        before = None

        def check_children():
            nonlocal before
            before = _db_sessions(path)
            if sid not in before or _descendants(before, sid) != ids:
                raise service.ServiceError("children_changed")

        try:
            # Inspect the tree after the pinned socket has passed its listener check.
            client.call("DELETE", "session/" + sid, before_send=check_children)
        except service.ServiceError as exc:
            if before is None or exc.state != "stopped":
                raise
        _verify_delete(client, ids)
        after = _db_sessions(path)
        if ids & after.keys():
            raise service.ServiceError("request_failed")
        extras = sorted(before.keys() - after.keys() - ids)
    result = {"deleted": True}
    if extras:
        result["extra_deleted"] = [{"session_id": key, "title": before[key]["title"] or key} for key in extras]
    return result


def _forks(client, source):
    result = {}
    for row in client.sessions():
        if not isinstance(row, dict) or not _valid(row.get("id")):
            raise service.ServiceError("request_failed")
        link = row.get("fork")
        if isinstance(link, dict) and link.get("sessionID") == source:
            result[row["id"]] = row.get("title") or row["id"]
    return result


def _uncertain_fork(client, row):
    try:
        forks = _forks(client, row["source_id"])
        candidates = [{"session_id": key, "title": forks[key]}
                      for key in sorted(forks.keys() - set(json.loads(row["baseline"])))]
    except service.ServiceError:
        candidates = None
    return {"status": "unknown", "candidates": candidates,
            "confirmation_id": row["request_id"] if row["state"] != "superseded" else None}


def _has_messages(sid):
    try:
        with agent_opencode.open_readonly(agent_opencode.data_home() / agent_opencode.DATABASE) as conn:
            found = conn.execute("SELECT 1 FROM session_message WHERE session_id=? "
                                 "AND type IN ('user','assistant') LIMIT 1", (sid,)).fetchone()
        return bool(found)
    except (OSError, sqlite3.Error):
        raise service.ServiceError("session_missing") from None


def fork(conn, sid, request_id, *, confirm_unknown=None):
    if not _valid(sid) or not isinstance(request_id, str) or not TOKEN.fullmatch(request_id):
        raise service.ServiceError("request_failed")
    with opencode_tabs.action_lock():
        own = conn.execute("SELECT * FROM opencode_fork_intents WHERE request_id=?", (request_id,)).fetchone()
        if own and own["source_id"] != sid:
            raise service.ServiceError("request_failed")
        if own and own["fork_id"]:
            return resume(own["fork_id"])
        opencode_tabs.checked_directory(sid)
        if not _has_messages(sid):
            raise service.ServiceError("empty_fork")
        client, _ = _client()
        unresolved = conn.execute(
            "SELECT * FROM opencode_fork_intents WHERE source_id=? AND fork_id IS NULL "
            "AND state IN ('pending','unknown')", (sid,)).fetchone()
        if unresolved and unresolved["state"] == "pending":
            if 0 <= time.time() - unresolved["started_at"] < FORK_INTENT_TTL:
                raise service.ServiceError("fork_pending")
            conn.execute("UPDATE opencode_fork_intents SET state='unknown' WHERE request_id=?",
                         (unresolved["request_id"],))
            conn.commit()
        if own or (unresolved and confirm_unknown != unresolved["request_id"]):
            return _uncertain_fork(client, unresolved or own)
        if confirm_unknown is not None and unresolved is None:
            return {"status": "unknown", "candidates": None, "confirmation_id": None}
        baseline = json.dumps(sorted(_forks(client, sid)))
        with conn:
            if unresolved:
                conn.execute("UPDATE opencode_fork_intents SET state='superseded' WHERE request_id=?",
                             (unresolved["request_id"],))
            conn.execute("INSERT INTO opencode_fork_intents (request_id,source_id,baseline,state,started_at) "
                         "VALUES (?,?,?,'pending',?)", (request_id, sid, baseline, time.time()))
        try:
            value = client.data("session/" + sid + "/fork", "POST", {})
            link = value.get("fork")
            if not _valid(value.get("id")) or not isinstance(link, dict) or link.get("sessionID") != sid:
                raise service.ServiceError("request_failed")
        except service.ServiceError as exc:
            if exc.status is not None and 400 <= exc.status < 500:
                with conn:
                    conn.execute("DELETE FROM opencode_fork_intents WHERE request_id=?", (request_id,))
                    if unresolved:
                        conn.execute("UPDATE opencode_fork_intents SET state='unknown' WHERE request_id=?",
                                     (unresolved["request_id"],))
                raise
            with conn:
                conn.execute("UPDATE opencode_fork_intents SET state='unknown' WHERE request_id=?", (request_id,))
            row = {"source_id": sid, "request_id": request_id, "baseline": baseline, "state": "unknown"}
            return _uncertain_fork(client, row)
        with conn:
            conn.execute("UPDATE opencode_fork_intents SET fork_id=?,state='confirmed' WHERE request_id=?",
                         (value["id"], request_id))
        return resume(value["id"])
