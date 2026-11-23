"""OpenCode Active state from the managed service and the read-only v2 transcript."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from concurrent.futures import Future
from urllib.parse import urlencode

from . import (
    active,
    agent_opencode as source,
    agents,
    opencode_parse as parse,
    opencode_service as service,
    opencode_tabs,
    search,
)

IDENTITY_REFRESH = 30
IDENTITY_TTL = 60
VERIFY_SECONDS = 2
MODEL_TTL = 600
TAIL_ROWS = 64
MESSAGE_SCAN_ROWS = 96


class LiveService:
    def __init__(self):
        self.key = None
        self.checked = 0
        self.client = None
        self.models = {}
        self.pending = {}
        self.available = False
        self.budget = None
        self.cards = {}
        self._card_database = None
        self._verification = None
        self._verification_key = None

    @property
    def verifying(self):
        return self._verification is not None

    def _identity(self, database):
        key = _identity_key(database)
        if self.key != key:
            self.invalidate()
            self.key = key
        if self.client is not None and (
            time.monotonic() - self.checked >= IDENTITY_TTL or not self.client.poll_connected
        ):
            self.close_poll()
        if self._verification is not None:
            if not self._verification.done():
                return
            verification, self._verification = self._verification, None
            try:
                checked, client = verification.result()
            except Exception as exc:
                active.log_opencode_error(exc)
                checked, client = 0, None
            if client is not None:
                if (key is not None and key == self._verification_key and key == _identity_key(database)
                        and time.monotonic() - checked < IDENTITY_TTL):
                    self.close_poll()
                    self.checked, self.client = checked, client
                    return
                client.close_poll()
        if key is not None and (self.client is None or time.monotonic() - self.checked >= IDENTITY_REFRESH):
            self._start_verification(key)

    def _start_verification(self, key):
        if key is not None and self._verification is None:
            database = key[1][0]
            self._verification_key = key
            self._verification = Future()
            threading.Thread(target=_verify, args=(database, self._verification), daemon=True).start()

    def close_poll(self):
        if self.client is not None:
            self.client.close_poll()
            self.client = None

    def invalidate(self):
        self.close_poll()
        self.available = False
        self.models.clear()
        self.pending.clear()

    def read(self, route, expect=dict):
        if self.client:
            if time.monotonic() - self.checked >= IDENTITY_TTL and self.key is not None:
                self.close_poll()
                return None
            if self.key is not None and self.key[1] != _database_key(self.key[1][0]):
                self.invalidate()
                return None
            try:
                return self.client.poll(route, expect, budget=self.budget)
            except service.ServiceError as exc:
                identity_lost = exc.state in {"service_changed", "unauthorized"}
                socket_lost = exc.state == "stopped" or not self.client.poll_connected
                if identity_lost or socket_lost:
                    self.invalidate()
                    if socket_lost and not identity_lost:
                        self._start_verification(self.key)
        return None

    def active(self, database):
        self._identity(database)
        found = self.read("session/active")
        self.available = found is not None
        if found is None:
            return None
        return {sid for sid, entry in found.items() if agents.valid_id(agents.OPENCODE, sid)
                and parse._object(entry).get("type") == "running"}

    def window(self, cwd, model):
        if not cwd or not model or not self.client:
            return None
        now = time.monotonic()
        if cwd not in self.models or now - self.models[cwd][0] >= MODEL_TTL:
            query = urlencode({"location[directory]": cwd})
            records = self.read("model?" + query, list)
            if records is None:
                return None
            limits = {}
            for entry in map(parse._object, records):
                provider, mid = entry.get("providerID"), entry.get("id")
                limit = parse._object(entry.get("limit")).get("context")
                if isinstance(provider, str) and isinstance(mid, str) and type(limit) is int and limit > 0:
                    limits[f"{provider}/{mid}"] = limit
            self.models[cwd] = (now, limits)
        return self.models[cwd][1].get(model)


def _identity_key(database):
    if not service.binary():
        return None
    file = service.registration_path()
    try:
        st = file.lstat()
    except OSError:
        return None
    registration = (file, st.st_dev, st.st_ino, st.st_mtime_ns, st.st_ctime_ns, st.st_mode, st.st_size)
    db = _database_key(database)
    return (registration, db) if db else None


def _database_key(database):
    try:
        st = database.stat()
    except OSError:
        return None
    return database, st.st_dev, st.st_ino


def _verify(database, result):
    budget = service.PollBudget(VERIFY_SECONDS, VERIFY_SECONDS)
    client = None
    try:
        client = service.verified_client(database, budget=budget)
        budget.remaining()
        if client.version == service.TESTED_VERSION:
            result.set_result((time.monotonic(), client))
            return
    except (service.ServiceError, service.PollBudgetExpired):
        pass
    except Exception as exc:
        if client is not None:
            client.close_poll()
        result.set_exception(exc)
        return
    if client is not None:
        client.close_poll()
    result.set_result((0, None))


_live = LiveService()


def _data(row):
    try:
        return parse._object(json.loads(row["data"]))
    except (ValueError, TypeError, RecursionError):
        return {}


def _messages(db, sid):
    prompts = db.execute("""
        SELECT time_created, data FROM session_message
        WHERE session_id=? AND type='user' ORDER BY seq DESC
    """, (sid,))
    user = next(((row, text) for row in prompts if (text := parse.text_value(_data(row).get("text")))), None)
    rows = db.execute("""
        SELECT id, type, seq, time_created, data FROM session_message
        WHERE session_id=?
        ORDER BY seq DESC LIMIT ?
    """, (sid, MESSAGE_SCAN_ROWS))
    tail, answer = [], None
    for row in rows:
        kind = row["type"]
        if kind not in {"user", "assistant", "idle", "compaction"}:
            continue
        recent = len(tail) < TAIL_ROWS
        if not recent and not (kind == "assistant" and answer is None):
            continue
        data = _data(row)
        if recent:
            tail.append((row, data))
        if answer is None and _settled(row, data) and (text := parse.assistant_text(data)):
            answer = {**dict(row), "time_completed": parse.answer_time(row, data)}, text
        if len(tail) == TAIL_ROWS and answer:
            break
    return tail, user, answer


def _settled(row, data):
    return row["type"] == "assistant" and parse.completed(data)


def _timestamp(pair):
    return active._iso_ms(pair[0]["time_created"]) if pair else None


def queued_entries(raw):
    return [{"id": row["id"], "text": text, "at": active._iso_ms(parse._object(row.get("time")).get("created"))}
            for row in map(parse._object, raw or []) if row.get("type") == "user"
            and row.get("delivery") == "queue" and isinstance(row.get("id"), str)
            if (text := parse.text_value(parse._object(row.get("payload")).get("text")))]


def _pending(sid, pid, running, live):
    from .opencode_live_actions import project_pending

    if running is None:
        return None, None, None, False
    if not running:
        live.pending.pop(sid, None)
        return None, None, None, bool(pid)

    prefix = f"session/{sid}"
    # A partial read can update one list while retaining the last observation of the other.
    previous = live.pending.get(sid, {})
    items = {}
    known = bool(pid)
    for kind in ("permission", "form"):
        result = live.read(f"{prefix}/{kind}", list)
        if result is None:
            known = False
            items[kind] = previous.get(kind)
        else:
            items[kind] = result[0] if result else None
    live.pending[sid] = items

    kind = "permission" if items["permission"] else "form"
    item = items[kind]
    waiting = ("permission prompt" if kind == "permission" else "question") if item else None
    dialog = project_pending(sid, kind, item) if item and pid else None
    inbox = live.read(prefix + "/inbox", list)
    return waiting, dialog, inbox, known


def _card(conn, row, messages, table, sid, pid, running, live):
    info = search._load_session(conn, sid) or {}
    tail, user, answer = messages
    usage = next(((line, data) for line, data in tail if _settled(line, data)), None)
    prompt = user[1] if user else info.get("last_prompt")
    reply = answer[1] if answer else ""
    if not answer and info:
        # Older index rows could contain unfinished text until the next indexing pass.
        indexed = conn.execute("""
            SELECT d.last_answer FROM opencode_details d JOIN sessions s USING(session_id)
            JOIN sources f ON s.source_path=f.path WHERE d.session_id=? AND (f.sig LIKE ? OR f.sig LIKE ?)
        """, (sid, "[4,%", f"[{source.VERSION},%")).fetchone()
        if indexed:
            reply = indexed["last_answer"]
    updated = (active._iso_ms(row["time_updated"]) if row else None) or info.get("last_activity_at")
    updated = updated or (active._iso_ms(row["time_created"]) if row else None) or info.get("started_at")
    updated = updated or "1970-01-01T00:00:00+00:00"
    prompt_at = (_timestamp(user) or updated) if prompt else None
    completed_at = active._iso_ms(answer[0].get("time_completed")) if answer else None
    reply_at = (completed_at or _timestamp(answer) or updated) if reply else None
    cwd = row["directory"] if row else info.get("cwd_last")
    waiting, dialog, inbox, pending_known = _pending(sid, pid, running, live)
    status = "waiting" if waiting else "busy" if running else "idle"
    pricing = info.get("cost_usd")
    model = context = None
    if usage:
        usage_row, data = usage
        totals = parse._usage(parse.SessionFacts(), usage_row, data, [], 0)
        model = totals["model"]
        if data.get("tokens") or parse._object(data.get("usage")).get("tokens"):
            context = sum(totals[key] for key in ("input", "output", "reasoning", "cache_read", "cache_write"))
    cost_updates = [price for line, data in tail
                    if (not info.get("last_activity_at")
                        or (active._iso_ms(line["time_created"]) or "") > info["last_activity_at"])
                    and (not row or not row["fork_session_id"] or not line["id"].endswith(f"_{line['seq']}"))
                    if line["type"] in {"assistant", "compaction"}
                    if (price := parse.reported_cost(data)) is not None]
    if cost_updates:
        pricing = (pricing or 0) + sum(cost_updates)
    interrupted = (active._iso_ms(row["time_idle"]) if row and not running and not waiting
                   and row["idle_outcome"] in {"failed", "interrupted"} else None)
    return {
        "session_id": sid, "agent": agents.OPENCODE, **_process_fields(table, pid),
        "host_app": None, "status": status, "activity": status,
        "background": {"shells": 0, "agents": 0, "wake_at": None, "crons": 0, "goal": None},
        "waiting_for": waiting, "job_session_id": None, "transcript_session_id": sid,
        "cwd": cwd, "indexed": bool(info), "title": info.get("title") or (row["title"] if row else None) or sid,
        "card_line": info.get("card_line"), "last_prompt": prompt,
        "projects": info.get("projects", []), "topic": info.get("topic"), "domains": info.get("domains", []),
        "tickets": info.get("tickets", []), "sensitivity": info.get("sensitivity"),
        "human_turns": info.get("human_turns"), "cost_usd": info.get("cost_usd"),
        "cost_recorded_at": None, "cost_now": pricing, "cost_partial": False, "model": model,
        "context_tokens": context,
        "context_window": live.window(cwd, model) if context is not None and running is not None else None,
        "started_at": info.get("started_at") or (active._iso_ms(row["time_created"]) if row else None),
        "status_at": None,
        "last_message_at": max(filter(None, (prompt_at, reply_at)), default=None),
        "reply_tail": active.markdown_tail(reply), "reply_len": len(reply), "reply_at": reply_at,
        "progress": None, "prompt": active.markdown_tail(prompt) if prompt else None, "prompt_at": prompt_at,
        "prompt_images": 0, "interrupted_at": interrupted, "queued": queued_entries(inbox),
        "tasks": None, "progress_at": None, "opencode_dialog": dialog,
        "opencode_pending_known": pending_known, "opencode_running": running,
        "opencode_verifying": live.verifying,
        "opencode_generation": live.client.generation if live.client is not None else None,
    }


def _snapshot(database, sid, budget=None):
    try:
        with source.open_readonly(database, timeout=0) as db:
            if budget is not None:
                db.set_progress_handler(lambda: time.monotonic() >= budget.deadline, 1000)
            row = db.execute("""
                SELECT title, directory, time_created, time_updated, time_idle, idle_outcome, fork_session_id
                FROM session_v2 WHERE id=?
            """, (sid,)).fetchone()
            messages = _messages(db, sid) if row else ([], None, None)
        return row, messages
    except (OSError, sqlite3.Error):
        if budget is not None:
            budget.remaining()
        return None, ([], None, None)


def list_live(conn, table, live=_live):
    live.budget = service.PollBudget()
    tabs = {}
    try:
        database = source.data_home() / source.DATABASE
        database_key = _database_key(database)
        if live._card_database != database_key:
            live.cards.clear()
            live._card_database = database_key
        tabs = opencode_tabs.active_tabs(table)
        running = live.active(database)
        client = live.client
        pending = live.pending.copy()
        try:
            cards = _cards(conn, table, live, database, tabs, running)
            if _database_key(database) != database_key:
                live.cards.clear()
                live.invalidate()
                return _fallback(live, table, tabs)
            if live.client is not client or (client is not None and live.key != _identity_key(database)):
                live.invalidate()
                return _fallback(live, table, tabs)
            live.budget.remaining()
        except service.PollBudgetExpired:
            if live.client is client:
                live.pending = pending
            raise
        live.cards = {card["session_id"]: card for card in cards}
        return cards
    except service.PollBudgetExpired:
        live.close_poll()
        live.available = False
        live._start_verification(live.key)
        return _fallback(live, table, tabs)
    finally:
        live.budget = None


def _process_fields(table, pid):
    return {"pid": pid, "ancestors": [pid] if pid else [],
            "process_started_at": active.process_start_iso(table.get(pid, (0, ""))[1])}


def _fallback(live, table, tabs):
    live.cards = {sid: live.cards[sid] for sid in tabs.keys() & live.cards.keys()}
    verifying = live.verifying
    return [{**live.cards.get(sid, {"session_id": sid, "agent": agents.OPENCODE, "title": sid,
                                  "transcript_session_id": sid, "last_message_at": None}),
             **_process_fields(table, pid), "status": "idle", "activity": "idle",
             "opencode_running": None, "opencode_generation": None, "opencode_verifying": verifying,
             "waiting_for": None,
             "opencode_dialog": None, "opencode_pending_known": False, "queued": []}
            for sid, pid in sorted(tabs.items())]


def _cards(conn, table, live, database, tabs, running):
    visible = set(tabs) | (running or set())
    for sid in live.pending.keys() - visible:
        del live.pending[sid]
    out = []
    client = live.client
    for sid in sorted(visible):
        live.budget.remaining()
        row, messages = _snapshot(database, sid, live.budget)
        is_running = sid in running if running is not None else None
        card = _card(conn, row, messages, table, sid, tabs.get(sid), is_running, live)
        if live.client is not client:
            break
        out.append(card)
    return out
