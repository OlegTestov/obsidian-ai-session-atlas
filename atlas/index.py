"""Инкрементальный индексатор: транскрипты → SQLite. Один writer под файловым локом."""
from __future__ import annotations

import fcntl
import glob
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from . import config, db, store

PROJECTS_ROOT = os.environ.get(
    "ATLAS_PROJECTS_ROOT", os.path.expanduser("~/.claude/projects")
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def writer_lock():
    """Межпроцессный лок: ручной index, CLI-refresh и таймер сервера не пишут разом."""
    path = os.path.join(db.atlas_home(), "index.lock")
    fh = open(path, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fh, fcntl.LOCK_UN)
        fh.close()


# Транскрипты нашего же компрессора: индексировать их — значит обогащать себя по кругу.
RUNNER_SLUG_MARK = "session-atlas-runner"


def discover(root: str = PROJECTS_ROOT) -> list[str]:
    """Сессии лежат на втором уровне. Файлы глубже — транскрипты сабагентов, не сессии."""
    found = glob.glob(os.path.join(root, "*", "*.jsonl"))
    return sorted(p for p in found if RUNNER_SLUG_MARK not in os.path.basename(os.path.dirname(p)))


def discover_subagents(session_path: str) -> list[str]:
    session_id = os.path.splitext(os.path.basename(session_path))[0]
    folder = os.path.join(os.path.dirname(session_path), session_id, "subagents")
    return sorted(glob.glob(os.path.join(folder, "*.jsonl")))


def _signature(session_path: str, subagents: list[str]) -> str:
    """Подпись сессии вместе с её сабагентами: правка любого файла обновит родителя."""
    parts = []
    for path in [session_path] + subagents:
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
    """Файл перечитывается целиком при любом расхождении — разбор одного файла это миллисекунды."""
    return row is None or row["sig"] != sig


def _purge(conn: sqlite3.Connection, session_id: str) -> None:
    store.purge(conn, session_id)


def index_all(conn: sqlite3.Connection, root: str = PROJECTS_ROOT,
              full: bool = False, only_if_flagged: bool = False) -> dict:
    """Возвращает сводку прогона. Каждый файл — своя транзакция: сбой не рвёт весь индекс."""
    stats = {"seen": 0, "indexed": 0, "skipped": 0, "removed": 0, "errors": 0,
             "subagent_files": 0, "full": 0, "tail": 0}
    with writer_lock():
        # Флаг перепроверяется под локом: пока ждали, пересборку мог уже сделать другой процесс.
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
                # Дописанный файл дочитывается с места прошлого прохода; иначе — целиком.
                if full or known.get(path) is None \
                        or not store.store_tail(conn, path, st, sig, sub_sig):
                    store.store_full(conn, path, st, sig, subagents, sub_sig)
                    stats["full"] += 1
                else:
                    stats["tail"] += 1
                conn.commit()
                stats["indexed"] += 1
            except Exception:
                conn.rollback()
                stats["errors"] += 1

        for path, row in known.items():
            if path not in present:  # источник исчез — убираем и его производные
                _purge(conn, row["session_id"])
                conn.execute("DELETE FROM sources WHERE path=?", (path,))
                stats["removed"] += 1
        db.set_meta(conn, "indexed_through", _now())
        db.set_meta(conn, "needs_reindex", "0")
        conn.commit()
    return stats


def ensure_indexed(conn: sqlite3.Connection, root: str = PROJECTS_ROOT) -> dict | None:
    """После смены схемы производные таблицы пусты — пересобрать должен первый, кто их спросит.
    То же после смены настроек, от которых зависит индекс: проекты, домены по путям, тикеты."""
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
