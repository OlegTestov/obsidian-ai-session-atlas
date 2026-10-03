"""Messages typed while Claude was working: they wait in a queue, not in the transcript.

Claude Code writes the queue as `queue-operation` records: `enqueue` with text, `dequeue` when
the first one is taken, `remove` when one is dropped (often a background task notice), `popAll`
when all are taken. Tool notifications go through the same queue; they are counted but not returned.
"""
from __future__ import annotations

import json
import os

MARK = b'"queue-operation"'
TAIL_BYTES = 2 * 1024 * 1024
TEXT_CHARS = 400
# Not your messages: background task and subagent notifications.
SYSTEM_PREFIXES = ("<task-notification>", "<teammate-message", "<agent-message",
                   "Another Claude session sent")

_cache: dict[str, tuple] = {}      # path -> (inode, size, queue)


def _records(blob: bytes):
    pos = blob.find(MARK)
    while pos >= 0:
        start = blob.rfind(b"\n", 0, pos) + 1
        end = blob.find(b"\n", pos)
        end = end if end >= 0 else len(blob)
        try:
            rec = json.loads(blob[start:end])
        except ValueError:
            rec = None
        if isinstance(rec, dict) and rec.get("type") == "queue-operation":
            yield rec
        pos = blob.find(MARK, end)


def replay(records) -> list[dict]:
    """Queue after all operations, in order. [{text, at}], your messages only."""
    queue: list[dict] = []
    for rec in records:
        op, content = rec.get("operation"), rec.get("content")
        if op == "enqueue":
            queue.append({"text": content if isinstance(content, str) else "",
                          "at": rec.get("timestamp")})
        elif op == "dequeue":
            if queue:
                queue.pop(0)
        elif op == "remove":
            same = [i for i, q in enumerate(queue) if content and q["text"] == content]
            if same:
                queue.pop(same[0])
            elif queue and not content:
                queue.pop(0)
        elif op == "popAll":
            queue.clear()
    return [{"text": q["text"][:TEXT_CHARS], "at": q["at"]} for q in queue
            if q["text"].strip() and not q["text"].startswith(SYSTEM_PREFIXES)]


def queued_messages(path: str | None) -> list[dict]:
    if not path:
        return []
    try:
        st = os.stat(path)
    except OSError:
        return []
    cached = _cache.get(path)
    if cached and cached[:2] == (st.st_ino, st.st_size):
        return cached[2]
    try:
        with open(path, "rb") as fh:
            fh.seek(max(0, st.st_size - TAIL_BYTES))
            blob = fh.read()
    except OSError:
        return []
    queue = replay(_records(blob))
    _cache[path] = (st.st_ino, st.st_size, queue)
    return queue
