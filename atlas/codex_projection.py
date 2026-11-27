"""Shared, bounded per-rollout projections for readers of a Codex lineage."""
from __future__ import annotations

import json
import re
import sqlite3
from collections import OrderedDict
from concurrent.futures import Future
from contextlib import closing
from threading import Lock, RLock
from typing import Iterable, NamedTuple
from weakref import WeakValueDictionary

from . import codex_parse, codex_rollouts

CACHE_BYTES = 64 * 1024 * 1024
CACHE_ENTRIES = 128
SPILL_CACHE_BYTES = 128 * 1024 * 1024
# These records can change turn grouping even when a view has no use for their payloads.
_TURN_MARK = re.compile(rb'"(?:turn_context|turn_id|task_started|task_complete|turn_aborted|user_message)"')
_cache = OrderedDict()
_retained = WeakValueDictionary()
_inflight: dict[tuple, Future] = {}
_resident_bytes = 0
_lock = RLock()
_build_lock = Lock()


class Group(NamedTuple):
    turn_id: str | None
    lines: Iterable[tuple[int, bytes]]


def decoded(raw: bytes) -> dict | None:
    try:
        rec = json.loads(raw)
    except ValueError:
        return None
    return rec if isinstance(rec, dict) else None


class Projection:
    def __init__(self):
        self.weight = 0
        self.disk_bytes = 0
        self._groups: list[Group] = []
        self._ids: set[str] = set()
        self._db = None
        self._db_lock = Lock()
        self._index = -1

    def _reserve(self, weight):
        global _resident_bytes
        with _lock:
            while _resident_bytes + weight > CACHE_BYTES:
                evict = next((key for key, item in _cache.items() if item.weight), None)
                if evict is None or self.weight + weight > CACHE_BYTES:
                    return False
                del _cache[evict]
            _resident_bytes += weight
            self.weight += weight
            return True

    def _release(self):
        global _resident_bytes
        with _lock:
            _resident_bytes -= self.weight
            self.weight = 0

    def __del__(self):
        if self.weight:
            self._release()
        if self._db is not None:
            with self._db_lock:
                self._db.close()

    def _spill(self):
        # An empty SQLite filename creates a private temporary database, removed on close.
        # The builder owns the connection exclusively until it publishes the finished projection.
        db = self._db = sqlite3.connect("", check_same_thread=False)
        db.executescript("""
            PRAGMA journal_mode=OFF;
            PRAGMA cache_size=0;
            CREATE TABLE groups (id INTEGER PRIMARY KEY, turn_id TEXT);
            CREATE INDEX turn_ids ON groups (turn_id);
            CREATE TABLE lines (group_id INTEGER, offset INTEGER, raw BLOB,
                                PRIMARY KEY (group_id, offset)) WITHOUT ROWID;
            BEGIN;
        """)
        for i, group in enumerate(self._groups):
            db.execute("INSERT INTO groups VALUES (?, ?)", (i, group.turn_id))
            db.executemany("INSERT INTO lines VALUES (?, ?, ?)", ((i, *line) for line in group.lines))
        self._groups.clear()
        self._ids.clear()
        self._release()

    def start(self):
        if self._db is None and not self._reserve(180):
            self._spill()
        self._index += 1
        if self._db is None:
            self._groups.append(Group(None, []))
        else:
            self._db.execute("INSERT INTO groups VALUES (?, NULL)", (self._index,))

    def identify(self, turn_id):
        if self._db is None and not self._reserve(len(turn_id) * 4 + 120):
            self._spill()
        if self._db is None:
            self._groups[-1] = Group(turn_id, self._groups[-1].lines)
            self._ids.add(turn_id)
        else:
            self._db.execute("UPDATE groups SET turn_id=? WHERE id=?", (turn_id, self._index))

    def append(self, offset, raw):
        if self._db is None and not self._reserve(len(raw) + 150):
            self._spill()
        if self._db is None:
            self._groups[-1].lines.append((offset, raw))
        else:
            self._db.execute("INSERT INTO lines VALUES (?, ?, ?)", (self._index, offset, raw))

    def finish(self):
        if self._db is not None:
            self._db.commit()
            pages, = self._db.execute("PRAGMA page_count").fetchone()
            page_size, = self._db.execute("PRAGMA page_size").fetchone()
            self.disk_bytes = pages * page_size
            self._db.execute("PRAGMA shrink_memory")

    def groups(self, reverse=False, reverse_lines=False):
        if self._db is None:
            for group in reversed(self._groups) if reverse else self._groups:
                yield Group(group.turn_id, reversed(group.lines)) if reverse_lines else group
        else:
            order = "DESC" if reverse else "ASC"
            with closing(self._rows(f"SELECT id, turn_id FROM groups ORDER BY id {order}")) as rows:
                for index, turn in rows:
                    yield Group(turn, self._lines(index, reverse_lines))

    def _lines(self, index, reverse):
        order = "DESC" if reverse else "ASC"
        return self._rows(f"SELECT offset, raw FROM lines WHERE group_id=? ORDER BY offset {order}", (index,))

    def _rows(self, sql, args=()):
        # macOS SQLite may forbid concurrent calls on a connection. Readers can pause at a yield.
        with self._db_lock:
            cursor = self._db.execute(sql, args)
        try:
            while True:
                with self._db_lock:
                    row = cursor.fetchone()
                if row is None:
                    break
                yield row
        finally:
            with self._db_lock:
                cursor.close()

    def contains(self, turn_id):
        if self._db is None:
            return turn_id in self._ids
        with closing(self._rows("SELECT 1 FROM groups WHERE turn_id=? LIMIT 1", (turn_id,))) as rows:
            return next(rows, None) is not None


def _read(part, keep) -> Projection:
    projection = Projection()
    turn_id = None
    in_turn = finished = has_prompt = False
    for offset, raw in codex_rollouts.lines(part):
        kept = keep(raw)
        rec = decoded(raw) if kept is raw or _TURN_MARK.search(raw, 0, 480) else None
        if rec is None and kept is None:
            continue
        rec = rec or {}
        payload = rec.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        kind = rec.get("type")
        event = payload.get("type") if kind == "event_msg" else None
        tid = codex_parse._turn_id(payload)
        tid = tid if isinstance(tid, str) else None
        starts_turn = (event == "task_started" or kind == "turn_context") and tid and tid != turn_id
        late_start = turn_id is None and has_prompt and not finished
        if kind == "session_meta":
            projection.start()
            if kept is not None:
                projection.append(offset, kept)
            in_turn = finished = has_prompt = False
            turn_id = None
            continue
        if not in_turn or (starts_turn and not late_start) or (finished and event == "user_message"):
            projection.start()
            in_turn = True
            turn_id = None
            finished = has_prompt = False
        if tid and turn_id is None:
            turn_id = tid
            projection.identify(tid)
        if kept is not None:
            projection.append(offset, kept)
        has_prompt |= event == "user_message"
        if event in ("task_complete", "turn_aborted"):
            finished = True
    projection.finish()
    return projection


def _remember(key, result):
    _retained[key] = result
    if result.disk_bytes > SPILL_CACHE_BYTES:
        return
    disk = sum(p.disk_bytes for p in _cache.values())
    while _cache and (len(_cache) >= CACHE_ENTRIES or disk + result.disk_bytes > SPILL_CACHE_BYTES):
        disk -= _cache.popitem(last=False)[1].disk_bytes
    _cache[key] = result


def _get(part, keep) -> Projection:
    key = part, codex_rollouts.file_stamp(part.path), keep
    with _lock:
        cached = _retained.get(key)
        if cached is not None:
            if key in _cache:
                _cache.move_to_end(key)
            return cached
        flight = _inflight.get(key)
        if flight is None:
            flight = _inflight[key] = Future()
            build = True
        else:
            build = False
    if not build:
        return flight.result()
    try:
        # A builder reserves memory as records arrive. Serializing builds also bounds
        # transient decoding buffers, including one large input record.
        with _build_lock:
            result = _read(part, keep)
        with _lock:
            _remember(key, result)
            flight.set_result(result)
        return result
    except BaseException as exc:
        flight.set_exception(exc)
        raise
    finally:
        with _lock:
            del _inflight[key]


class SelectedGroups:
    def __init__(self, current, later):
        self.current = current
        self.later = later

    def _groups(self, reverse, reverse_lines=False):
        for group in self.current.groups(reverse, reverse_lines):
            if group.turn_id is None or not any(p.contains(group.turn_id) for p in self.later):
                yield group

    def __iter__(self):
        return self._groups(False)

    def __reversed__(self):
        return self._groups(True)

    def newest_records(self):
        return self._groups(True, reverse_lines=True)


def selected(parts, keep, *, newest=False, on_error=None):
    """Yield groups with turn IDs owned by later parts removed."""
    later = []
    selected_parts = []
    for part in reversed(parts):
        try:
            projected = _get(part, keep)
        except OSError:
            if on_error is None:
                raise
            on_error()
            continue
        item = part, SelectedGroups(projected, tuple(later))
        later.append(projected)
        if newest:
            yield item
        else:
            selected_parts.append(item)
    yield from reversed(selected_parts)
