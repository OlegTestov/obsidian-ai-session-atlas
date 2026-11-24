import json
import sqlite3
import threading
import time
from contextlib import closing
from unittest.mock import Mock

import pytest

from atlas import active, opencode_live as live, opencode_parse as parse, opencode_service as service

SID = "ses_" + "a" * 26


def test_verification_runs_once_off_the_poll_thread(tmp_path, monkeypatch):
    database = tmp_path / "opencode.db"
    registration = tmp_path / "service.json"
    database.touch()
    registration.touch()
    entered, finished = threading.Event(), threading.Event()
    client = Mock(version=service.TESTED_VERSION)
    client.poll.return_value = {SID: {"type": "running"}}

    def verify(path, *, budget):
        assert path == database
        assert budget.remaining() <= 2
        entered.set()
        assert finished.wait(1)
        return client

    verifier = Mock(side_effect=verify)
    monkeypatch.setattr(service, "binary", lambda: "/fixture/opencode")
    monkeypatch.setattr(service, "registration_path", lambda: registration)
    monkeypatch.setattr(service, "verified_client", verifier)
    state = live.LiveService()
    try:
        assert state.active(database) is None
        assert entered.wait(1)
        assert state.verifying
        assert state.active(database) is None
        verifier.assert_called_once()
        client.poll.assert_not_called()
    finally:
        finished.set()
    state._verification.result(timeout=1)
    assert state.active(database) == {SID}
    assert not state.verifying


def test_lost_client_discards_active_map_and_controls(monkeypatch, tmp_path):
    state = live.LiveService()
    client = Mock(version=service.TESTED_VERSION, generation="current")
    client.poll.side_effect = [
        {SID: {"type": "running"}}, service.ServiceError("unauthorized"),
    ]
    state.client = client
    monkeypatch.setattr(state, "_identity", lambda _: None)
    monkeypatch.setattr(live.opencode_tabs, "active_tabs", lambda _: {SID: 42})
    monkeypatch.setattr(live.search, "_load_session", lambda *_: None)
    card, = live.list_live(None, {}, state)
    assert not state.available
    assert card["opencode_running"] is None
    assert card["opencode_generation"] is None
    assert not card["opencode_pending_known"]
    assert card["status"] == "idle"


def test_expired_pass_reuses_projection(monkeypatch):
    state = live.LiveService()
    state.cards = {SID: {"session_id": SID, "reply_tail": "last answer", "opencode_running": True}}
    monkeypatch.setattr(live.opencode_tabs, "active_tabs", lambda _: {SID: 42})
    monkeypatch.setattr(state, "active", Mock(side_effect=service.PollBudgetExpired))
    monkeypatch.setattr(live, "_snapshot", Mock(side_effect=AssertionError("projection ran twice")))
    card, = live.list_live(None, {}, state)
    assert card["reply_tail"] == "last answer"
    assert card["pid"] == 42
    assert card["opencode_running"] is None


def test_answer_after_last_visit_uses_completion_in_live_and_catalog(monkeypatch):
    with closing(sqlite3.connect(":memory:")) as database:
        database.row_factory = sqlite3.Row
        database.execute("CREATE TABLE session_message (id, session_id, type, seq, time_created, data)")
        data = {"time": {"completed": 460000}, "content": [{"type": "text", "text": "answer"}]}
        database.execute("INSERT INTO session_message VALUES ('msg_1', ?, 'assistant', 1, 400000, ?)",
                         (SID, json.dumps(data)))
        database.executemany("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)", [
            ("prompt", SID, "user", 0, 220000, '{"text":"question"}'),
            ("overlap", SID, "assistant", 2, 420000, '{"time":{"completed":440000}}'),
        ])
        messages = live._messages(database, SID)
        session = {"id": SID, "fork_session_id": None, "parent_id": None, "title": "Test", "version": "2.3.2",
                   "directory": "/fixture", "time_created": 1000, "time_updated": 460000}
        facts = parse.project(session, database.execute("SELECT * FROM session_message ORDER BY seq"))
    monkeypatch.setattr(live.search, "_load_session", lambda *_: None)
    card = live._card(None, None, messages, {}, SID, 42, None, live.LiveService())
    visit = active._as_datetime(active._iso_ms(430000))
    assert card["reply_at"] == card["last_message_at"] == active._iso_ms(460000)
    assert active._as_datetime(card["last_message_at"]) > visit
    assert active._as_datetime(facts.activity["msg_1"]["ts"]) > visit
    assert facts.activity["msg_1"]["active_s"] == 240
    assert facts.activity["overlap"]["active_s"] == 0


@pytest.mark.parametrize("change", ["registration", "database"])
def test_replaced_identity_cannot_adopt_in_flight_socket(tmp_path, monkeypatch, change):
    database = tmp_path / "opencode.db"
    registration = tmp_path / "service.json"
    database.touch()
    registration.touch()
    monkeypatch.setattr(service, "binary", lambda: "/fixture/opencode")
    monkeypatch.setattr(service, "registration_path", lambda: registration)
    old = Mock(version=service.TESTED_VERSION)
    new = Mock(version=service.TESTED_VERSION, generation="new")
    new.poll.return_value = {SID: {"type": "running"}}
    monkeypatch.setattr(service, "verified_client", Mock(side_effect=[old, new]))
    state = live.LiveService()
    assert state.active(database) is None
    state._verification.result(timeout=1)
    replacement = tmp_path / "replacement"
    replacement.touch()
    replacement.replace(registration if change == "registration" else database)
    assert state.active(database) is None
    old.poll.assert_not_called()
    old.close_poll.assert_called_once()
    state._verification.result(timeout=1)
    assert state.active(database) == {SID}


def test_proactive_refresh_keeps_old_socket_on_failure_and_closes_it_on_replacement(tmp_path, monkeypatch):
    database = tmp_path / "opencode.db"
    registration = tmp_path / "service.json"
    database.touch()
    registration.touch()
    monkeypatch.setattr(service, "binary", lambda: "/fixture/opencode")
    monkeypatch.setattr(service, "registration_path", lambda: registration)
    old = Mock(version=service.TESTED_VERSION, generation="old")
    new = Mock(version=service.TESTED_VERSION, generation="new")
    old.poll.return_value = new.poll.return_value = {SID: {"type": "running"}}
    verifier = Mock(side_effect=[old, service.ServiceError("stopped"), new])
    monkeypatch.setattr(service, "verified_client", verifier)
    state = live.LiveService()
    assert state.active(database) is None
    state._verification.result(timeout=1)
    assert state.active(database) == {SID}
    state.checked -= live.IDENTITY_REFRESH
    assert state.active(database) == {SID}
    assert state.verifying
    state._verification.result(timeout=1)
    assert state.active(database) == {SID}
    assert state.client is old
    old.close_poll.assert_not_called()
    state._verification.result(timeout=1)
    assert state.active(database) == {SID}
    assert state.client is new
    old.close_poll.assert_called_once()


def test_unexpected_opencode_exception_preserves_other_agents(monkeypatch, caplog):
    from atlas import codex_live, jobs

    claude = {"last_message_at": None, "agent": "claude"}
    codex = {"last_message_at": None, "agent": "codex"}
    monkeypatch.setattr(active, "_opencode_errors", set())
    monkeypatch.setattr(active, "_read_files", lambda _: [{"pid": 42}])
    monkeypatch.setattr(active, "is_interactive", lambda _: True)
    monkeypatch.setattr(active, "_alive", lambda *_: True)
    monkeypatch.setattr(active, "alive_jobs", lambda *_: {})
    monkeypatch.setattr(active, "_claude_card", lambda *_: claude)
    monkeypatch.setattr(jobs, "attach_clients", lambda _: {})
    monkeypatch.setattr(jobs, "running_jobs", lambda *_: {})
    monkeypatch.setattr(codex_live, "list_live", lambda *_, **__: [codex])
    monkeypatch.setattr(live, "_live", live.LiveService())
    live._live.available = True
    monkeypatch.setattr(live, "list_live", Mock(side_effect=RuntimeError("private session text")))
    for _ in range(2):
        assert active.list_active(None, table={}) == [claude, codex]
        assert not live._live.available
    assert caplog.text.count("OpenCode Active failed (RuntimeError)") == 1
    assert "private session text" not in caplog.text


def test_refresh_in_progress_cannot_extend_socket_past_sixty_seconds(tmp_path, monkeypatch):
    database = tmp_path / "opencode.db"
    registration = tmp_path / "service.json"
    database.touch()
    registration.touch()
    monkeypatch.setattr(service, "binary", lambda: "/fixture/opencode")
    monkeypatch.setattr(service, "registration_path", lambda: registration)
    old = Mock(version=service.TESTED_VERSION)
    old.poll.return_value = {SID: {"type": "running"}}
    cache = live.LiveService()
    cache.key = live._identity_key(database)
    cache.client = old
    cache.checked = live.time.monotonic() - live.IDENTITY_TTL
    release = threading.Event()

    def verify(*_, **__):
        assert release.wait(1)
        raise service.ServiceError("stopped")

    monkeypatch.setattr(service, "verified_client", verify)
    try:
        assert cache.active(database) is None
        assert cache.verifying
        assert not cache.available
        old.poll.assert_not_called()
        old.close_poll.assert_called_once()
    finally:
        release.set()
        cache._verification.result(timeout=1)


def test_long_history_active_pass_stays_within_budget(tmp_path, monkeypatch):
    database = tmp_path / "opencode.db"
    tool = json.dumps({"time": {"completed": 2}, "content": [{"type": "tool", "input": "x" * 4096}]})
    with closing(sqlite3.connect(database)) as db, db:
        db.execute("CREATE TABLE session_v2 (id PRIMARY KEY, title, directory, time_created, time_updated, "
                   "time_idle, idle_outcome, fork_session_id)")
        db.execute("INSERT INTO session_v2 VALUES (?, 'Fixture', '/fixture', 1, 2, NULL, NULL, NULL)", (SID,))
        db.execute("CREATE TABLE session_message (id, session_id, type, seq, time_created, data)")
        db.execute("CREATE INDEX message_seq ON session_message (session_id, seq)")
        db.execute("CREATE INDEX message_type_seq ON session_message (session_id, type, seq)")
        db.executemany("INSERT INTO session_message VALUES (?, ?, 'assistant', ?, ?, ?)",
                       ((str(i), SID, i, i, tool) for i in range(1, 12001)))
        db.execute("INSERT INTO session_message VALUES ('p1', ?, 'user', 12001, 12001, ?)",
                   (SID, '{"text":"Current prompt"}'))
    tabs = {"ses_" + f"{n:026d}": n + 10 for n in range(30)}
    tabs[SID] = 42
    monkeypatch.setenv("ATLAS_OPENCODE_HOME", str(tmp_path))
    monkeypatch.setattr(service, "binary", lambda: None)
    monkeypatch.setattr(live.opencode_tabs, "active_tabs", lambda _: tabs)
    monkeypatch.setattr(live.search, "_load_session", lambda *_: None)
    start = time.monotonic()
    cards = live.list_live(None, {}, live.LiveService())
    assert time.monotonic() - start < 0.3
    assert len(cards) == 31
    card = next(card for card in cards if card["session_id"] == SID)
    assert card["prompt"] == "Current prompt"
    assert card["opencode_running"] is None
    assert not card["opencode_verifying"]
