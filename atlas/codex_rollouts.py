"""Codex rollout files and the bounded history of a selected rollout."""
from __future__ import annotations

import json
import os
from collections import defaultdict
from functools import lru_cache
from typing import NamedTuple

from . import agents, codex_parse
from .parse import iter_complete_lines

META_LINE_LIMIT = 4 * 1024 * 1024
MAX_LINEAGE = 64
_meta_cache: dict[str, tuple] = {}
_inventory_cache: dict[str, tuple] = {}


class Part(NamedTuple):
    path: str
    end: int | None = None     # exclusive byte offset, or the whole head


def _stamp(path: str) -> tuple | None:
    try:
        st = os.stat(path)
        return st.st_ino, st.st_mtime_ns, st.st_ctime_ns
    except OSError:
        return None


def inventory(home: str) -> tuple[dict[str, list[str]], dict[str, str]]:
    """Thread and physical IDs. Directory changes invalidate additions, moves and deletions."""
    home = os.path.abspath(home)
    cached = _inventory_cache.get(home)
    if cached and all(_stamp(path) == stamp for path, stamp in cached[0].items()):
        _, threads, physical, duplicates = cached
        return threads, _with_complete_copies(physical, duplicates, home)
    directories = {}
    threads: dict[str, list[str]] = defaultdict(list)
    physical: dict[str, str] = {}
    duplicates: dict[str, list[str]] = {}
    def scan(folder: str, ancestors: set) -> None:
        stamp = directories[folder] = _stamp(folder)
        if stamp is None:
            return
        real = os.path.realpath(folder)
        if real in ancestors:
            return
        try:
            with os.scandir(folder) as entries:
                children = sorted(entries, key=lambda entry: entry.name)
        except (FileNotFoundError, NotADirectoryError):
            return
        for entry in children:
            if entry.is_dir():
                scan(entry.path, ancestors | {real})
            elif ids := codex_parse.rollout_ids(entry.name):
                thread, rollout = ids
                threads[thread].append(entry.path)
                if rollout in physical:
                    duplicates.setdefault(rollout, [physical[rollout]]).append(entry.path)
                else:
                    physical[rollout] = entry.path

    for name in ("sessions", "archived_sessions"):
        scan(os.path.join(home, name), set())
    for paths in threads.values():
        paths.sort()
    _inventory_cache[home] = directories, threads, physical, duplicates
    return threads, _with_complete_copies(physical, duplicates, home)


def _with_complete_copies(physical, duplicates, home):
    if not duplicates:
        return physical
    return {**physical, **preferred_copies((p for paths in duplicates.values() for p in paths), home)}


def all_rollouts(session_id: str, home: str) -> list[str]:
    if not agents.valid_id(agents.CODEX, session_id):
        return []
    return list(inventory(home)[0].get(session_id, ()))


def preferred_copies(paths, home: str) -> dict[str, str]:
    """One path per physical ID. A longer copy wins, with mtime breaking size ties."""
    live = os.path.abspath(os.path.join(home, "sessions")) + os.sep
    copies = {}
    ranks = {}
    for path in paths:
        ids = codex_parse.rollout_ids(path)
        if ids:
            try:
                st = os.stat(path)
            except OSError:
                continue
            physical = ids[1]
            rank = st.st_size, st.st_mtime_ns, os.path.abspath(path).startswith(live), path
            if physical not in ranks or rank > ranks[physical]:
                ranks[physical] = rank
                copies[physical] = path
    return copies


def session_meta(path: str, *, on_error=None) -> dict:
    """Read and cache just the first record, keyed by the file's identity."""
    try:
        st = os.stat(path)
        stamp = st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns
        cached = _meta_cache.get(path)
        if cached and cached[0] == stamp:
            return cached[1]
        with open(path, "rb") as fh:
            raw = fh.readline(META_LINE_LIMIT)
        rec = json.loads(raw)
    except OSError:
        if on_error is not None:
            on_error()
        return {}
    except ValueError:
        return {}
    if not isinstance(rec, dict) or rec.get("type") != "session_meta" or not isinstance(rec.get("payload"), dict):
        return {}
    meta = rec["payload"]
    source = meta.get("source")
    child = source.get("subagent") if isinstance(source, dict) else None
    subagent = meta.get("thread_source") == "subagent" or (isinstance(source, dict) and "subagent" in source)
    spawn = child.get("thread_spawn") if isinstance(child, dict) else None
    parent = meta.get("parent_thread_id") or (spawn.get("parent_thread_id") if isinstance(spawn, dict) else None)
    compact = {"id": codex_parse.session_id_of(path) or meta.get("id") or meta.get("session_id"),
               "cwd": meta.get("cwd"), "timestamp": meta.get("timestamp"), "subagent": subagent,
               "parent": parent if subagent and agents.valid_id(agents.CODEX, parent) else None,
               "history_base": meta.get("history_base")}
    if raw.endswith(b"\n"):
        _meta_cache[path] = stamp, compact
    return compact


def mtime(path: str) -> int:
    try:
        return os.stat(path).st_mtime_ns
    except OSError:
        return -1


def select(paths: list[str], saved: str | None = None, *, allow_subagent: bool = False) -> str | None:
    """Select a head from a single thread's files."""
    eligible = [path for path in paths if os.path.isfile(path)
                and (allow_subagent or not session_meta(path).get("subagent"))]
    if saved:
        target = os.path.realpath(saved)
        for path in eligible:
            if os.path.realpath(path) == target:
                return path
    return max(eligible, key=lambda path: (mtime(path), path), default=None)


def saved_copy(paths, saved, home):
    """Resolve Codex's selected path to the most complete copy of that physical rollout."""
    physical = preferred_copies(paths, home)
    if saved:
        target = os.path.realpath(saved)
        for path in paths:
            if os.path.realpath(path) == target:
                saved = physical.get(codex_parse.rollout_ids(path)[1])
                break
    return list(physical.values()), saved


def file_stamp(path: str) -> tuple[int, int, int, int, int]:
    st = os.stat(path)
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns


@lru_cache(maxsize=512)
def _boundary(path: str, offset: int, stamp: tuple) -> int:
    """Clamp an ancestor cutoff to a complete JSONL record."""
    with open(path, "rb") as fh:
        end = min(offset, stamp[2])
        while end:
            start = max(0, end - 65536)
            fh.seek(start)
            last = fh.read(end - start).rfind(b"\n")
            if last >= 0:
                return start + last + 1
            end = start
    return 0


def lineage(head: str, home: str | None = None, *, on_error=None) -> list[Part]:
    """The selected rollout and its explicitly referenced ancestors, oldest first."""
    if home is None:
        from .index import codex_home

        home = codex_home()
    parts = [Part(head)]
    ids = codex_parse.rollout_ids(head)
    seen = {ids[1]} if ids else set()
    current = head
    physical = None
    for _ in range(MAX_LINEAGE - 1):
        base = session_meta(current, on_error=on_error).get("history_base")
        if not isinstance(base, dict):
            break
        parent, offset = base.get("thread_id"), base.get("end_byte_offset")
        if not agents.valid_id(agents.CODEX, parent) or parent in seen or type(offset) is not int or offset < 0:
            break
        if physical is None:
            _, physical = inventory(home)
        current = physical.get(parent)
        if current is None:
            break
        try:
            parts.append(Part(current, _boundary(current, offset, file_stamp(current))))
        except OSError:
            if on_error is not None:
                on_error()
            break
        seen.add(parent)
    return parts[::-1]


def lines(part: Part):
    with open(part.path, "rb") as fh:
        if part.end is None:
            yield from iter_complete_lines(fh)
        else:
            offset = 0
            while offset < part.end:
                raw = fh.readline(part.end - offset)
                if not raw.endswith(b"\n"):
                    break
                offset += len(raw)
                yield offset, raw


def records(part: Part, skip=None):
    """Complete records from a lineage part, optionally skipping large unused line types."""
    for _, raw in lines(part):
        if skip and skip(raw):
            continue
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if isinstance(rec, dict):
            yield rec


def projected_records(parts: list[Part], keep):
    """Replay selected history, keeping the later copy of any attributed turn."""
    if len(parts) == 1 and parts[0].end is None:
        yield from records(parts[0])
        return
    from . import codex_projection

    for _, groups in codex_projection.selected(parts, keep):
        for group in groups:
            for _, raw in group.lines:
                rec = codex_projection.decoded(raw)
                if rec is not None:
                    yield rec
