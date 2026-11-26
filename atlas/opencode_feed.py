"""OpenCode v2 turns and file activity in the shared Active feed format."""
from __future__ import annotations

import os
import sqlite3

from . import active, agent_opencode as source, feed, opencode_parse as parse, touched
from .opencode_live import _data, _settled

TOOLS = {"read": "Read", "write": "Write", "edit": "Edit", "bash": "Bash", "shell": "Bash"}


def _tools(row, data):
    for index, item in enumerate(parse.content_items(data.get("content"))):
        name = parse.text_value(item.get("name"))
        if item.get("type") != "tool" or not name:
            continue
        args = parse.tool_args(item)
        path = parse.tool_path(args) if name in {"read", "write", "edit"} else None
        command = parse.text_value(args.get("command")) if name in {"bash", "shell"} else None
        yield {"type": "tool_use", "id": f"{row['id']}:{index}", "name": TOOLS.get(name, name),
               "input": {"file_path": path} if path else {"command": command} if command else {}}, item


def _records(rows):
    for row in rows:
        data = _data(row)
        stamp = parse._when(row["time_created"])
        kind = row["type"]
        if kind == "user":
            if text := parse.text_value(data.get("text")):
                yield {"type": kind, "uuid": row["id"], "timestamp": stamp, "message": {"content": text}}
        elif kind == "assistant":
            tools = list(_tools(row, data))
            text = parse.assistant_text(data) if _settled(row, data) else ""
            content = [block for block, _ in tools]
            if text:
                content.append({"type": "text", "text": text})
            yield {"type": kind, "timestamp": stamp, "message": {"content": content}}
            for tool, item in tools:
                status = parse._object(item.get("state")).get("status")
                if status in {"completed", "error", "aborted", "failed"}:
                    time = parse._object(item.get("time"))
                    end = active._iso_ms(time.get("completed")) or stamp
                    result = {"type": "tool_result", "tool_use_id": tool["id"], "is_error": status != "completed"}
                    yield {"type": "user", "timestamp": end, "message": {"content": [result]}}
        elif kind == "idle" and data.get("outcome") in {"failed", "interrupted"}:
            yield {"type": "user", "timestamp": stamp, "message": {"content": active.INTERRUPTED}}


def _turns(db, sid, view, turns, *, before_id, since_id, before, since):
    turns = max(1, min(feed.MAX_TURNS, turns))
    reset = False
    args = [sid]
    condition = ""
    anchor = before_id or since_id
    if anchor:
        row = db.execute("SELECT seq FROM session_message WHERE session_id=? AND id=? AND type='user'",
                         (sid, anchor)).fetchone()
        if row:
            condition = " AND seq < ?" if before_id else " AND seq >= ?"
            args.append(row["seq"])
        elif before_id:
            return {"turns": [], "has_more": False}
        else:
            reset = True
    elif before or since:
        condition = " AND time_created < ?" if before else " AND time_created >= ?"
        args.append(db.execute("SELECT CAST(ROUND((julianday(?) - 2440587.5) * 86400000) AS INTEGER)",
                               (before or since,)).fetchone()[0])

    forwards = bool((since_id or since) and not reset)
    limit = "" if forwards else " LIMIT ?"
    if limit:
        args.append(turns + 1)
    anchors = db.execute("SELECT seq FROM session_message WHERE session_id=? AND type='user'"
                         " AND json_valid(data) AND typeof(json_extract(data,'$.text'))='text'"
                         " AND trim(json_extract(data,'$.text'))<>''" + condition
                         + " ORDER BY seq DESC" + limit, args).fetchall()
    older = len(anchors) > turns
    if not anchors:
        return {"turns": [], "has_more": None if forwards else False}
    start = anchors[-1 if forwards else min(len(anchors), turns) - 1]["seq"]
    # Include all steps of the last selected turn, up to (but excluding) the next user prompt.
    end = db.execute("SELECT MIN(seq) FROM session_message WHERE session_id=? AND type='user' AND seq>?",
                     (sid, anchors[0]["seq"])).fetchone()[0] if before_id or before else None
    rows = db.execute("SELECT id,type,seq,time_created,data FROM session_message "
                      "WHERE session_id=? AND seq>=? AND (? IS NULL OR seq<?) ORDER BY seq",
                      (sid, start, end, end))
    items = feed.build(_records(rows), view == "steps", full_text=view == "turns")
    result = {"turns": items, "has_more": None if forwards else older}
    if reset:
        result["reset"] = True
    return result


def _files(db, sid, cwd):
    rows = db.execute("""
        WITH RECURSIVE children(id, directory) AS (
            SELECT id, directory FROM session_v2 WHERE id=?
            UNION
            SELECT s.id, s.directory FROM session_v2 s JOIN children c ON s.parent_id=c.id
        )
        SELECT m.id, m.time_created, m.data, c.directory FROM children c
        JOIN session_message m ON m.session_id=c.id WHERE m.type='assistant'
        ORDER BY m.time_created
    """, (sid,))
    files = {}
    for row in rows:
        for block, _ in _tools(row, _data(row)):
            name = block["name"]
            path = block["input"].get("file_path")
            if path:
                touched._note(files, os.path.normpath(os.path.join(row["directory"], path)),
                              name.lower(), parse._when(row["time_created"]))
    ordered = sorted(files.values(), key=lambda f: (bool(f["edit"] + f["write"]), f["last_at"]), reverse=True)
    return {"cwd": cwd, "files": ordered, "home": os.path.expanduser("~")}


def read(sid, view, turns, *, before_id=None, since_id=None, before=None, since=None):
    try:
        with source.open_readonly(source.data_home() / source.DATABASE, timeout=0.5) as db:
            row = db.execute("SELECT directory FROM session_v2 WHERE id=?", (sid,)).fetchone()
            if row is None:
                return None
            if view == "files":
                return _files(db, sid, row["directory"])
            return _turns(db, sid, view, turns, before_id=before_id, since_id=since_id, before=before, since=since)
    except (OSError, sqlite3.Error):
        return None
