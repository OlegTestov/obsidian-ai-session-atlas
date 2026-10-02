"""Запись сессии в индекс: целиком или только дописанное.

Строка полнотекстового индекса — ход (твой запрос с ответами на него), а не вся сессия.
Живая сессия дописывается постоянно, и переписывать мегабайты её текста на каждом проходе
стоило 2–5 с: теперь меняются только последний ход и новые.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone

from . import activity, resolve
from .parse import SessionFacts, facts_state, parse_file, parse_tail

META_TURN = -2        # заголовок, тикеты, пути из истории файлов
SUBAGENT_TURN = -1    # тексты сабагентов: меняются только вместе с их файлами
STATE_VERSION = 3     # поднять при любой правке разбора — старые состояния отбросятся
TAIL_SIG_BYTES = 4096


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def tail_sig(path: str, offset: int) -> str:
    """Подпись байтов перед местом продолжения: файл переписали — подпись не совпадёт."""
    with open(path, "rb") as fh:
        fh.seek(max(0, offset - TAIL_SIG_BYTES))
        return hashlib.sha1(fh.read(min(offset, TAIL_SIG_BYTES))).hexdigest()


def purge(conn: sqlite3.Connection, session_id: str, keep_text: bool = False) -> None:
    for table in ("sessions", "session_projects", "session_domains",
                  "session_tickets", "session_files", "session_links"):
        conn.execute(f"DELETE FROM {table} WHERE session_id=?", (session_id,))
    if not keep_text:
        conn.execute("DELETE FROM fts WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM fts_paths WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM parse_state WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM activity WHERE session_id=?", (session_id,))


def _write_meta(conn, session_id: str, path: str, st, sig: str, facts: SessionFacts,
                resolved_files: list[tuple[str, str]]) -> str:
    """Всё, кроме текстов: маленькие таблицы проще переписать, чем сливать."""
    projects, workspace_kind = resolve.resolve_projects(facts.cwds, [r for _, r in resolved_files])
    domains = resolve.resolve_domains(facts.cwds, [r for _, r in resolved_files])
    sensitivity = resolve.resolve_sensitivity(facts.cwds, [r for _, r in resolved_files])
    kind = resolve.session_kind(facts.entrypoint, facts.human_turns)
    title, title_source = resolve.fallback_title(
        facts.title, [facts.first_user_text] if facts.first_user_text else [], facts.last_prompt,
        [facts.first_assistant_text] if facts.first_assistant_text else [], session_id)
    conn.execute(
        """INSERT INTO sessions (session_id, source_path, title, title_source, session_kind,
             workspace_kind, started_at, last_activity_at, human_turns, machine_turns,
             subagent_turns, cost_usd, lines_added, lines_removed, models, entrypoint,
             version, cwd_last, cwds, branch_last, last_prompt, leaf_uuid,
             sensitivity_rule, records, bad_lines, content_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (session_id, path, title, title_source, kind, workspace_kind,
         facts.started_at, facts.last_activity_at, facts.human_turns, facts.machine_turns,
         facts.subagent_turns, facts.cost_usd, facts.lines_added, facts.lines_removed,
         json.dumps(facts.models, ensure_ascii=False), facts.entrypoint, facts.version,
         facts.cwds[-1] if facts.cwds else None, json.dumps(facts.cwds, ensure_ascii=False),
         facts.branches[-1] if facts.branches else None,
         facts.last_prompt, facts.leaf_uuid, sensitivity, facts.records, facts.bad_lines,
         hashlib.sha256(sig.encode()).hexdigest()[:32]),
    )
    conn.executemany("INSERT OR IGNORE INTO session_projects VALUES (?,?,?)",
                     [(session_id, pid, role) for pid, role in projects])
    conn.executemany("INSERT OR IGNORE INTO session_domains VALUES (?,?)",
                     [(session_id, d) for d in domains])
    conn.executemany("INSERT OR IGNORE INTO session_tickets VALUES (?,?)",
                     [(session_id, t) for t in sorted(facts.tickets)])
    conn.executemany("INSERT INTO session_files VALUES (?,?,?,?)",
                     [(session_id, raw, res, resolve.classify_path(res).project_id)
                      for raw, res in resolved_files])
    # frame-link пишется при каждом обновлении артефакта: у одной сессии их бывает 64
    # строки на одну реальную ссылку. Схлопываем по url, пустые не храним вовсе.
    seen: dict[tuple[str, str], str] = {}
    for kind_, url, link_title in facts.links:
        if url:
            seen.setdefault((kind_, url), link_title or "")
    conn.executemany("INSERT INTO session_links VALUES (?,?,?,?)",
                     [(session_id, k, u, t) for (k, u), t in seen.items()])
    return title


def _insert_row(conn, session_id: str, turn: int, **cols) -> None:
    conn.execute(
        "INSERT INTO fts (session_id, title, user_text, assistant_text, commands, paths, "
        "tickets, summaries, subagent_text, turn) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (session_id, cols.get("title", ""), cols.get("user_text", ""),
         cols.get("assistant_text", ""), cols.get("commands", ""), cols.get("paths", ""),
         cols.get("tickets", ""), cols.get("summaries", ""), cols.get("subagent_text", ""), turn))


def _write_meta_row(conn, session_id: str, title: str, facts: SessionFacts,
                    resolved_files) -> None:
    conn.execute("DELETE FROM fts WHERE session_id=? AND turn=?", (session_id, META_TURN))
    conn.execute("DELETE FROM fts_paths WHERE session_id=? AND turn=?", (session_id, META_TURN))
    paths = "\n".join(dict.fromkeys(r for _, r in resolved_files))
    _insert_row(conn, session_id, META_TURN, title=title or "",
                tickets=" ".join(sorted(facts.tickets)), paths=paths)
    conn.execute("INSERT INTO fts_paths (session_id, blob, turn) VALUES (?,?,?)",
                 (session_id, paths, META_TURN))


def _write_turns(conn, session_id: str, facts: SessionFacts) -> None:
    """Ходы от первого из facts.turns: прошлый последний переписывается, новые добавляются."""
    first = facts.turn_base + 1
    conn.execute("DELETE FROM fts WHERE session_id=? AND turn>=?", (session_id, first))
    conn.execute("DELETE FROM fts_paths WHERE session_id=? AND turn>=?", (session_id, first))
    for k, turn in enumerate(facts.turns):
        number = first + k
        _insert_row(conn, session_id, number, **{name: "\n".join(turn[name]) for name in turn})
        blob = "\n".join(turn["paths"] + turn["commands"])
        if blob:
            conn.execute("INSERT INTO fts_paths (session_id, blob, turn) VALUES (?,?,?)",
                         (session_id, blob, number))


def _save_state(conn, session_id: str, path: str, st, sub_sig: str, facts: SessionFacts) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO parse_state VALUES (?,?,?,?,?,?,?,?)",
        (session_id, path, st.st_ino, facts.complete_bytes,
         tail_sig(path, facts.complete_bytes), sub_sig, STATE_VERSION,
         json.dumps(facts_state(facts), ensure_ascii=False)))


def _record_source(conn, path: str, session_id: str, st, sig: str, facts: SessionFacts) -> None:
    conn.execute(
        """INSERT INTO sources (path, session_id, inode, size, mtime, sig, complete_bytes, indexed_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(path) DO UPDATE SET session_id=excluded.session_id, inode=excluded.inode,
             size=excluded.size, mtime=excluded.mtime, sig=excluded.sig,
             complete_bytes=excluded.complete_bytes, indexed_at=excluded.indexed_at""",
        (path, session_id, st.st_ino, st.st_size, st.st_mtime, sig, facts.complete_bytes, _now()))


def _resolved(facts: SessionFacts) -> list[tuple[str, str]]:
    return [(raw, resolve.normalize(raw, facts.cwds[-1] if facts.cwds else None))
            for raw in facts.raw_files]


def store_full(conn, path: str, st, sig: str, subagents: list[str], sub_sig: str) -> str:
    session_id = os.path.splitext(os.path.basename(path))[0]
    facts = parse_file(path, session_id)
    sub_commands: list[str] = []
    sub_paths: list[str] = []
    sub_rows: dict = {}
    # Сабагенты — часть родительской сессии: их команды, файлы и текст вливаются сюда.
    for sub_path in subagents:
        sub = parse_file(sub_path, session_id)
        facts.subagent_turns += sub.machine_turns + sub.subagent_turns
        facts.subagent_text.extend(sub.assistant_text + sub.subagent_text + sub.user_text)
        sub_commands.extend(sub.commands)
        sub_paths.extend(sub.paths)
        facts.raw_files.extend(p for p in sub.raw_files if p not in facts.raw_files)
        facts.tickets |= sub.tickets
        sub_rows.update(sub.activity)
    resolved = _resolved(facts)
    purge(conn, session_id)
    activity.store(conn, session_id, facts.activity)
    activity.store(conn, session_id, sub_rows, sub=True)
    title = _write_meta(conn, session_id, path, st, sig, facts, resolved)
    _write_meta_row(conn, session_id, title, facts, resolved)
    if facts.subagent_text or sub_commands or sub_paths:
        _insert_row(conn, session_id, SUBAGENT_TURN, subagent_text="\n".join(facts.subagent_text),
                    commands="\n".join(sub_commands), paths="\n".join(sub_paths))
        if sub_commands or sub_paths:
            conn.execute("INSERT INTO fts_paths (session_id, blob, turn) VALUES (?,?,?)",
                         (session_id, "\n".join(sub_paths + sub_commands), SUBAGENT_TURN))
    _write_turns(conn, session_id, facts)
    _save_state(conn, session_id, path, st, sub_sig, facts)
    _record_source(conn, path, session_id, st, sig, facts)
    return session_id


def store_tail(conn, path: str, st, sig: str, sub_sig: str) -> bool:
    """Дочитать дописанное. False — продолжать нельзя, нужен полный проход."""
    session_id = os.path.splitext(os.path.basename(path))[0]
    row = conn.execute("SELECT * FROM parse_state WHERE session_id=?", (session_id,)).fetchone()
    if row is None or row["version"] != STATE_VERSION or row["path"] != path \
            or row["inode"] != st.st_ino or row["offset"] > st.st_size \
            or row["sub_sig"] != sub_sig or tail_sig(path, row["offset"]) != row["tail_sig"]:
        return False
    facts = parse_tail(path, json.loads(row["state"]))
    facts.session_id, facts.source_path = session_id, path
    if facts.subagent_text:
        return False          # сабагент писал в основной файл — его строку надо собрать заново
    resolved = _resolved(facts)
    purge(conn, session_id, keep_text=True)
    activity.store(conn, session_id, facts.activity)
    title = _write_meta(conn, session_id, path, st, sig, facts, resolved)
    _write_meta_row(conn, session_id, title, facts, resolved)
    _write_turns(conn, session_id, facts)
    _save_state(conn, session_id, path, st, sub_sig, facts)
    _record_source(conn, path, session_id, st, sig, facts)
    return True
