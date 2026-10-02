"""Активные сессии: живые процессы Claude Code по файлам `~/.claude/sessions/<pid>.json`.

Сам транскрипт не говорит, открыта ли сессия (`lsof` пуст — файл дописывается и закрывается).
А Claude Code пишет на каждый процесс файл с `sessionId`, `startedAt`, `kind` и `status`.
Файл переживает свой процесс, поэтому живость проверяется по PID и времени его старта.
"""
from __future__ import annotations

import glob
import json
import os
import re
import sqlite3
import subprocess
import time
from datetime import datetime, timedelta, timezone

from . import costs, prompt_queue, search, tasks
from .parse import COMPACT_PREFIX
from .resolve import HEADLESS_ENTRYPOINTS

SESSIONS_DIR = os.environ.get("ATLAS_CLAUDE_SESSIONS", os.path.expanduser("~/.claude/sessions"))
TAIL_BYTES = 256 * 1024     # последнее сообщение ищется в хвосте, а не во всём файле
MAX_ANCESTORS = 32


def process_table() -> dict[int, tuple]:
    """pid → (ppid, время старта, команда). `TZ=UTC`: Claude Code пишет `procStart` в UTC."""
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,lstart=,command="], capture_output=True,
                         text=True, env=dict(os.environ, TZ="UTC", LC_ALL="C"), timeout=10).stdout
    table = {}
    for line in out.splitlines():
        parts = line.split(None, 7)          # pid, ppid, 5 полей lstart, команда
        if len(parts) >= 7 and parts[0].isdigit() and parts[1].isdigit():
            table[int(parts[0])] = (int(parts[1]), " ".join(parts[2:7]),
                                    parts[7] if len(parts) > 7 else "")
    return table


# Фоновая команда Claude Code (Monitor, Bash в фоне) — дочерний шелл со снимком окружения.
# MCP-серверы тоже дети процесса, но запускаются своей командой.
SHELL_TASK_MARK = "/.claude/shell-snapshots/snapshot-"
AGENT_FRESH_SECONDS = 90       # сабагент пишет транскрипт, пока работает


def shell_tasks(pid: int, table: dict) -> int:
    return sum(1 for child, row in table.items()
               if row[0] == pid and len(row) > 2 and SHELL_TASK_MARK in row[2])


def live_subagents(transcript: str | None, now: float | None = None) -> int:
    if not transcript:
        return 0
    folder = os.path.join(transcript[:-len(".jsonl")], "subagents")
    now = now or time.time()
    count = 0
    for path in glob.glob(os.path.join(glob.escape(folder), "*.jsonl")):
        try:
            if now - os.stat(path).st_mtime < AGENT_FRESH_SECONDS:
                count += 1
        except OSError:
            continue
    return count


# Что разбудит сессию без тебя: /loop (ScheduleWakeup, CronCreate) и /goal.
_SCHEDULE_MARKS = (b'"ScheduleWakeup"', b'"CronCreate"', b'"CronDelete"', b'goal_status')
SCHEDULE_TAIL = 4 * 1024 * 1024


_schedule_cache: dict[str, tuple] = {}     # путь → (inode, размер, будильник, cron, цель)


def _marked_lines(blob: bytes):
    """Только строки с метками — поиском по байтам, без разрезания всего хвоста на строки."""
    starts = set()
    for mark in _SCHEDULE_MARKS:
        pos = blob.find(mark)
        while pos >= 0:
            starts.add(blob.rfind(b"\n", 0, pos) + 1)
            pos = blob.find(mark, pos + len(mark))
    for start in sorted(starts):
        end = blob.find(b"\n", start)
        yield blob[start:end if end >= 0 else len(blob)]


def schedule_state(path: str | None, now: float | None = None) -> dict:
    """Будильник /loop, живые cron-задания и активная цель /goal — по хвосту транскрипта."""
    out = {"wake_at": None, "crons": 0, "goal": None}
    if not path:
        return out
    try:
        st = os.stat(path)
    except OSError:
        return out
    cached = _schedule_cache.get(path)
    if cached and cached[:2] == (st.st_ino, st.st_size):
        wake, crons, goal = cached[2:]
    else:
        try:
            with open(path, "rb") as fh:
                fh.seek(max(0, st.st_size - SCHEDULE_TAIL))
                tail = fh.read()
        except OSError:
            return out
        wake, crons, goal = None, 0, None
        for raw in _marked_lines(tail):
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            attachment = rec.get("attachment")
            if isinstance(attachment, dict) and attachment.get("type") == "goal_status":
                goal = attachment.get("condition") if attachment.get("met") is False else None
                continue
            for block in ((rec.get("message") or {}).get("content") or []):
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                args = block.get("input") or {}
                if block.get("name") == "ScheduleWakeup":
                    at = _as_datetime(rec.get("timestamp")).timestamp()
                    wake = None if args.get("stop") else at + float(args.get("delaySeconds") or 0)
                elif block.get("name") == "CronCreate":
                    crons += 1
                elif block.get("name") == "CronDelete":
                    crons = max(0, crons - 1)
        _schedule_cache[path] = (st.st_ino, st.st_size, wake, crons, goal)
    now = now or time.time()
    if wake and wake > now:
        out["wake_at"] = datetime.fromtimestamp(wake, tz=timezone.utc).isoformat()
    out["crons"], out["goal"] = crons, goal
    return out


def activity(status: str | None, background: dict) -> str:
    """busy — делает ход; background — ход закончен, но его разбудит фон; waiting — диалог."""
    if status in ("busy", "shell"):
        return "busy"
    if status == "waiting":
        return "waiting"
    if background["shells"] or background["agents"] or background["wake_at"] \
            or background["crons"]:
        return "background"
    return "idle"


def _alive(pid: int, proc_start: str | None, table: dict) -> bool:
    """PID переиспользуется: совпасть должно и время старта, иначе это чужой процесс."""
    if pid not in table:
        return False
    return proc_start is None or table[pid][1] == " ".join(proc_start.split())


def ancestors(pid: int, table: dict) -> list[int]:
    """Цепочка родителей: по ней страница находит вкладку терминала, в которой живёт сессия."""
    chain, seen = [], {pid}
    current = table.get(pid, (0, ""))[0]
    while current > 1 and current not in seen and len(chain) < MAX_ANCESTORS:
        chain.append(current)
        seen.add(current)
        current = table.get(current, (0, ""))[0]
    return chain


def _iso_ms(ms) -> str | None:
    if not isinstance(ms, (int, float)):
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


# Не реплики разговора: их пишет не человек и не ответ Claude, а механика вокруг.
NOT_A_MESSAGE = ("Another Claude session sent a message", "<task-notification>",
                 "<teammate-message", COMPACT_PREFIX,
                 # Обвязка вокруг команд: вывод /goal, заметка о хуке, предупреждения CLI.
                 "<local-command-stdout>", "<local-command-stderr>", "<local-command-caveat>",
                 "A session-scoped Stop hook is now active", "Caveat: The messages below",
                 "[Request interrupted by user")
# Esc во вкладке или «Стоп» в карточке: Claude Code пишет это user-записью. Не реплика, но
# после неё твой запрос уже не «ждёт ответа» — он прерван.
INTERRUPTED = "[Request interrupted by user"
_COMMAND_RE = re.compile(r"<command-name>\s*(/?[^<\s]+)\s*</command-name>")
_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)
_PASTED_RE = re.compile(r"</?pasted_content[^>]*>")
TAIL_MAX = 8 * 1024 * 1024     # дальше не ищем: у живой сессии реплика найдётся раньше


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text") or "" for b in content
                        if isinstance(b, dict) and b.get("type") == "text")
    return ""


def prompt_text(content) -> str:
    """Твоя реплика для карточки: слэш-команда — как ты её набрал, без служебных тегов."""
    # Вставленный текст Claude Code оборачивает тегами — показываем сам текст.
    text = _PASTED_RE.sub("", _text_of(content)).strip()
    m = _COMMAND_RE.search(text)
    if m:
        name = m.group(1) if m.group(1).startswith("/") else "/" + m.group(1)
        args = _ARGS_RE.search(text)
        return name + (" " + args.group(1).strip() if args and args.group(1).strip() else "")
    return text


def _images_in(content) -> int:
    if not isinstance(content, list):
        return 0
    return sum(1 for b in content if isinstance(b, dict) and b.get("type") == "image")


def is_message(rec: dict) -> bool:
    """Реплика разговора: твой запрос или текстовый ответ Claude.

    Результаты тулов, уведомления сабагентов и сводки компактации дописываются без тебя —
    по ним «последнее сообщение» показывало «только что» у сессии, где никто не писал.
    """
    kind = rec.get("type")
    if kind not in ("user", "assistant") or not isinstance(rec.get("timestamp"), str):
        return False
    if rec.get("isMeta") or rec.get("isSidechain"):
        return False
    text = _text_of((rec.get("message") or {}).get("content")).strip()
    if not text:
        return False                          # tool_use, tool_result, thinking
    return kind == "assistant" or not text.startswith(NOT_A_MESSAGE)


PREVIEW_CHARS = 1000         # сколько из последнего ответа Claude показывать в карточке


def _progress_of(rec: dict) -> str | None:
    if rec.get("type") != "assistant" or rec.get("isSidechain"):
        return None
    content = (rec.get("message") or {}).get("content")
    if not isinstance(content, list):
        return None
    notes = [b.get("thinking") or "" for b in content
             if isinstance(b, dict) and b.get("type") == "thinking"]
    text = " ".join(n.strip() for n in notes if n.strip())
    return text or None


def last_messages(path: str | None) -> dict:
    """Время последней реплики и последний текстовый ответ Claude — по хвосту транскрипта.

    Индекс догоняет с задержкой, поэтому читаем сам файл. Реплика — см. `is_message`.
    """
    out = {"last_at": None, "reply": None, "reply_at": None, "progress": None,
           "progress_at": None, "prompt": None, "prompt_at": None, "prompt_images": 0,
           "interrupted_at": None}
    if not path:
        return out
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            window = TAIL_BYTES
            while True:
                fh.seek(max(0, size - window))
                for raw in reversed(fh.read().split(b"\n")):
                    try:
                        rec = json.loads(raw)
                    except ValueError:
                        continue      # первая строка окна обрезана, последняя может дописываться
                    if not isinstance(rec, dict):
                        continue
                    # Opus 5.5 пишет заметки между вызовами тулов блоками thinking с текстом:
                    # у работающей сессии это «что делает сейчас».
                    if out["progress"] is None:
                        note = _progress_of(rec)
                        if note:
                            out["progress"], out["progress_at"] = note, rec.get("timestamp")
                    if out["last_at"] is None and out["interrupted_at"] is None \
                            and rec.get("type") == "user" and _text_of(
                                (rec.get("message") or {}).get("content")).startswith(INTERRUPTED):
                        out["interrupted_at"] = rec.get("timestamp")
                    if not is_message(rec):
                        continue
                    if out["last_at"] is None:
                        out["last_at"] = rec["timestamp"]
                    # Твоё сообщение после последнего ответа Claude: он ещё не ответил на него.
                    if rec["type"] == "user" and out["prompt"] is None:
                        content = (rec.get("message") or {}).get("content")
                        out["prompt"] = prompt_text(content)
                        out["prompt_at"] = rec["timestamp"]
                        out["prompt_images"] = _images_in(content)
                    if rec["type"] == "assistant":
                        out["reply"] = _text_of((rec.get("message") or {}).get("content")).strip()
                        out["reply_at"] = rec["timestamp"]
                        return out
                if window >= size or window >= TAIL_MAX:
                    return out
                window *= 4           # хвост из одних вызовов тулов — смотрим глубже
    except OSError:
        return out


def last_message_at(path: str | None) -> str | None:
    return last_messages(path)["last_at"]


FENCE = "```"


def markdown_tail(text: str, limit: int = PREVIEW_CHARS) -> str:
    """Хвост ответа для карточки — так, чтобы Markdown в нём не разъехался.

    Режем по началу строки, а не посреди слова или `**жирного**`; если обрез пришёлся внутрь
    блока кода, открываем его заново — иначе остаток ответа отрисовался бы кодом.
    """
    if len(text) <= limit:
        return text
    cut = len(text) - limit
    line = text.find("\n", cut)
    if 0 <= line < len(text) - 1:
        cut = line + 1
    head = text[:cut]
    fences = sum(1 for ln in head.splitlines() if ln.lstrip().startswith(FENCE))
    tail = text[cut:]
    return (FENCE + "\n" + tail) if fences % 2 else tail


def last_reply(conn: sqlite3.Connection, session_id: str) -> dict | None:
    """Последний ответ Claude целиком — для «показать целиком» в карточке."""
    from .index import PROJECTS_ROOT
    path = _transcript(conn, session_id, PROJECTS_ROOT)
    if not path:
        return None
    found = last_messages(path)
    return {"session_id": session_id, "text": found["reply"] or "", "at": found["reply_at"]}


def _transcript(conn: sqlite3.Connection, session_id: str, projects_root: str) -> str | None:
    row = conn.execute("SELECT source_path FROM sessions WHERE session_id=?",
                       (session_id,)).fetchone()
    if row and row["source_path"] and os.path.exists(row["source_path"]):
        return row["source_path"]
    found = glob.glob(os.path.join(glob.escape(projects_root), "*", session_id + ".jsonl"))
    return found[0] if found else None


def _read_files(sessions_dir: str) -> list[dict]:
    out = []
    for path in glob.glob(os.path.join(glob.escape(sessions_dir), "*.json")):
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and isinstance(data.get("pid"), int) and data.get("sessionId"):
            out.append(data)
    return out


def is_interactive(data: dict) -> bool:
    """Фоновые прогоны (`claude -p`, SDK, ревьюеры, хуки) — не вкладки человека."""
    return data.get("kind") == "interactive" and data.get("entrypoint") not in HEADLESS_ENTRYPOINTS


def list_active(conn: sqlite3.Connection, sessions_dir: str | None = None,
                projects_root: str | None = None, table: dict | None = None) -> list[dict]:
    """Живые интерактивные сессии, сверху — с самым свежим сообщением."""
    from .index import PROJECTS_ROOT
    from .relocate import host_app            # relocate сам опирается на этот модуль
    sessions_dir = sessions_dir or SESSIONS_DIR
    projects_root = projects_root or PROJECTS_ROOT
    table = process_table() if table is None else table
    out = []
    for data in _read_files(sessions_dir):
        pid = data["pid"]
        if not is_interactive(data) or not _alive(pid, data.get("procStart"), table):
            continue
        sid = str(data["sessionId"])
        meta = search._load_session(conn, sid) or {}
        path = _transcript(conn, sid, projects_root)
        found = last_messages(path)
        tail = found["last_at"]
        reply = found["reply"] or ""
        cost = costs.session_cost(path)
        plan = schedule_state(path)
        background = {"shells": shell_tasks(pid, table), "agents": live_subagents(path),
                      "wake_at": plan["wake_at"], "crons": plan["crons"], "goal": plan["goal"]}
        # Индекс не подмешиваем: его last_activity_at считает и служебные записи.
        last = tail
        out.append({
            "session_id": sid,
            "pid": pid,
            "ancestors": ancestors(pid, table),
            "host_app": host_app(pid, table),
            "status": data.get("status"),
            "activity": activity(data.get("status"), background),
            "background": background,
            # waiting — открыт диалог (вопрос с вариантами, разрешение на команду).
            "waiting_for": data.get("waitingFor") if data.get("status") == "waiting" else None,
            "cwd": data.get("cwd"),
            "indexed": bool(meta),
            "title": meta.get("title") or data.get("name") or sid[:8],
            "card_line": meta.get("card_line"),
            "last_prompt": meta.get("last_prompt"),
            "projects": meta.get("projects", []),
            "topic": meta.get("topic"),
            "domains": meta.get("domains", []),
            "tickets": meta.get("tickets", []),
            "sensitivity": meta.get("sensitivity"),
            "human_turns": meta.get("human_turns"),
            # Записано Claude Code при выходе (на дату) и оценка сейчас — досчёт по токенам.
            "cost_usd": cost["recorded"] if cost["recorded"] is not None else meta.get("cost_usd"),
            "cost_recorded_at": cost["recorded_at"],
            "cost_now": cost["now"],
            "cost_partial": cost["partial"],
            "context_tokens": cost["context_tokens"],
            "context_window": costs.context_window(cost["context_model"], cost["context_tokens"])
            if cost["context_tokens"] else None,
            "started_at": meta.get("started_at") or _iso_ms(data.get("startedAt")),
            "process_started_at": _iso_ms(data.get("startedAt")),
            "last_message_at": last,
            # Хвост ответа: вопрос к тебе обычно в конце, а начало — отчёт о сделанном.
            "reply_tail": markdown_tail(reply),
            "reply_len": len(reply),
            "reply_at": found["reply_at"],
            "progress": (found["progress"] or "")[-PREVIEW_CHARS:] or None,
            "prompt": markdown_tail(found["prompt"]) if found["prompt"] else None,
            "prompt_at": found["prompt_at"],
            "prompt_images": found["prompt_images"],
            "interrupted_at": found["interrupted_at"],
            "queued": prompt_queue.queued_messages(path),
            "tasks": tasks.progress(sid),
            "progress_at": found["progress_at"],
        })
    out.sort(key=lambda s: _as_datetime(s["last_message_at"]), reverse=True)
    return out


RECENT_HOURS = 8
RECENT_LIMIT = 8


def recently_closed(conn: sqlite3.Connection, live_ids: set[str], now: datetime | None = None,
                    hours: int = RECENT_HOURS, limit: int = RECENT_LIMIT) -> list[dict]:
    """Интерактивные сессии с работой за последние часы, чей процесс уже завершён.

    Карточка «Активных» пропадает вместе с процессом; отсюда к сессии возвращаются одной
    кнопкой, не ища её в поиске.
    """
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(hours=hours)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    rows = conn.execute(
        """SELECT s.session_id, COALESCE(u.title, s.title) AS title, s.last_activity_at,
                  s.human_turns, s.cost_usd, s.cwd_last,
                  (SELECT c.summary FROM classification c WHERE c.session_id = s.session_id) AS summary
             FROM sessions s LEFT JOIN user_overrides u ON u.session_id = s.session_id
            WHERE s.session_kind = 'interactive' AND s.last_activity_at >= ?
            ORDER BY s.last_activity_at DESC LIMIT ?""", (cutoff, limit + len(live_ids))).fetchall()
    return [dict(r) for r in rows if r["session_id"] not in live_ids][:limit]


def _as_datetime(value: str | None) -> datetime:
    if not value:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
