"""Incremental indexer: transcripts -> SQLite. One writer under a file lock."""
from __future__ import annotations

import fcntl
import glob
import os
import sqlite3
import sys
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config, db, paths, store

PROJECTS_ROOT = os.environ.get("ATLAS_PROJECTS_ROOT", os.path.join(paths.claude_dir(), "projects"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def writer_lock():
    """Inter-process lock: manual index, CLI refresh and the server timer never write at once."""
    path = os.path.join(db.atlas_home(), "index.lock")
    with open(path, "w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


# Transcripts of our own compressor: indexing them would feed our output back into itself.
RUNNER_SLUG_MARK = "session-atlas-runner"


def discover(root: str = PROJECTS_ROOT) -> list[str]:
    """Sessions live at the second level. Deeper files are subagent transcripts, not sessions."""
    found = glob.glob(os.path.join(root, "*", "*.jsonl"))
    return sorted(p for p in found if RUNNER_SLUG_MARK not in os.path.basename(os.path.dirname(p)))


def discover_subagents(session_path: str) -> list[str]:
    session_id = os.path.splitext(os.path.basename(session_path))[0]
    folder = os.path.join(os.path.dirname(session_path), session_id, "subagents")
    return sorted(glob.glob(os.path.join(folder, "*.jsonl")))


def _signature(session_path: str, subagents: list[str]) -> str:
    """Signature of a session together with its subagents: a change to any file refreshes the parent."""
    parts = []
    for path in [session_path, *subagents]:
        try:
            st = os.stat(path)
        except FileNotFoundError:
            continue
        parts.append(f"{os.path.basename(path)}:{st.st_ino}:{st.st_size}:{st.st_mtime_ns}")
    return "|".join(parts)


def _files_signature(paths: list[str]) -> str:
    parts = []
    for path in paths:
        try:
            st = os.stat(path)
        except FileNotFoundError:
            continue
        parts.append(f"{os.path.basename(path)}:{st.st_ino}:{st.st_size}:{st.st_mtime_ns}")
    return "|".join(parts)


def _changed(row: sqlite3.Row | None, sig: str) -> bool:
    """The file is reread in full on any mismatch: parsing one file takes milliseconds."""
    return row is None or row["sig"] != sig


def _purge(conn: sqlite3.Connection, session_id: str) -> None:
    store.purge(conn, session_id)


def index_all(conn: sqlite3.Connection, root: str = PROJECTS_ROOT,
              full: bool = False, only_if_flagged: bool = False) -> dict:
    """Returns a run summary. Each file is its own transaction: a failure does not break the whole index."""
    stats = {"seen": 0, "indexed": 0, "skipped": 0, "removed": 0, "errors": 0,
             "subagent_files": 0, "full": 0, "tail": 0}
    with writer_lock():
        # Recheck the flag under the lock: another process may have rebuilt while we waited.
        if only_if_flagged and db.get_meta(conn, "needs_reindex") != "1":
            return stats
        known = {r["path"]: r for r in conn.execute("SELECT * FROM sources")}
        present = set()
        for path in discover(root):
            present.add(path)
            stats["seen"] += 1
            try:
                st = os.stat(path)
            except FileNotFoundError:
                continue
            subagents = discover_subagents(path)
            stats["subagent_files"] += len(subagents)
            sig = _signature(path, subagents)
            if not full and not _changed(known.get(path), sig):
                stats["skipped"] += 1
                continue
            sub_sig = _files_signature(subagents)
            try:
                # An appended file is read from where the last pass stopped; otherwise in full.
                if full or known.get(path) is None \
                        or not store.store_tail(conn, path, st, sig, sub_sig):
                    store.store_full(conn, path, st, sig, subagents, sub_sig)
                    stats["full"] += 1
                else:
                    stats["tail"] += 1
                conn.commit()
                stats["indexed"] += 1
            except Exception as exc:  # one unreadable transcript must not stop the pass
                conn.rollback()
                stats["errors"] += 1
                print(f"atlas index: {path}: {type(exc).__name__}: {exc}", file=sys.stderr)

        for path, row in known.items():
            if path not in present:  # the source is gone: remove its derived rows too
                _purge(conn, row["session_id"])
                conn.execute("DELETE FROM sources WHERE path=?", (path,))
                stats["removed"] += 1
        db.set_meta(conn, "indexed_through", _now())
        db.set_meta(conn, "needs_reindex", "0")
        conn.commit()
    return stats


def ensure_indexed(conn: sqlite3.Connection, root: str = PROJECTS_ROOT) -> dict | None:
    """After a schema change the derived tables are empty; the first caller to need them rebuilds.
    Same after a change to settings the index depends on: projects, path domains, tickets."""
    fingerprint = config.index_fingerprint()
    if db.get_meta(conn, "config_fingerprint") != fingerprint:
        db.set_meta(conn, "config_fingerprint", fingerprint)
        db.set_meta(conn, "needs_reindex", "1")
        conn.commit()
    if db.get_meta(conn, "needs_reindex") != "1":
        return None
    return index_all(conn, root=root, full=True, only_if_flagged=True)


def index_age_seconds(conn: sqlite3.Connection) -> float | None:
    value = db.get_meta(conn, "indexed_through")
    if not value:
        return None
    return (datetime.now(timezone.utc) - datetime.fromisoformat(value)).total_seconds()
