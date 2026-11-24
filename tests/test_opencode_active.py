import json
import shutil
import sqlite3
import time
from contextlib import closing, contextmanager
from pathlib import Path

import pytest

from atlas import active, opencode_live, opencode_live_actions as actions, opencode_service as service, opencode_tabs

RECORDED = json.loads((Path(__file__).parent / "fixtures/opencode/service-2.3.2-active.json").read_text())
PERMISSION = RECORDED["permission"]["body"]["data"]
FORM = RECORDED["required"]["body"]["data"]
SID = PERMISSION["sessionID"]


class Native:
    generation = "test-generation"
    poll_connected = True
    version = service.TESTED_VERSION

    def __init__(self, item):
        self.item = item
        self.calls = []

    def close_poll(self):
        pass

    def poll(self, route, expect=dict, *, budget=None):
        return self.data(route)

    def data(self, route, **kwargs):
        self.calls.append(("GET", route))
        return self.item

    def call(self, method, route, body=None, *, before_send=None):
        if before_send:
            before_send()
        self.calls.append((method, route, body))


@pytest.fixture
def attached(monkeypatch):
    monkeypatch.setattr(opencode_tabs, "active_tabs", lambda: {SID: 123})


def run_action(operation, body):
    return actions.run(operation, {"generation": Native.generation, **body})


@pytest.mark.parametrize("generation", [None, "previous-generation"])
@pytest.mark.parametrize("operation", ["reply", "stop", "permission", "form", "dismiss"])
def test_active_action_rejects_a_stale_service_generation(monkeypatch, attached, generation, operation):
    native = Native(PERMISSION)
    monkeypatch.setattr(actions, "_client", lambda: native)
    request = {"session_id": SID, "message_id": "msg_" + "x" * 26, "text": "draft"}
    if generation is not None:
        request["generation"] = generation
    with pytest.raises(service.ServiceError) as failed:
        actions.run(operation, request)
    assert (failed.value.state, failed.value.status) == ("live_stale", 409)
    assert native.calls == []


def test_external_action_is_denied(monkeypatch):
    native = Native(PERMISSION)
    monkeypatch.setattr(actions, "_client", lambda: native)
    monkeypatch.setattr(opencode_tabs, "active_tabs", lambda: {})
    with pytest.raises(service.ServiceError) as error:
        run_action("permission", {"session_id": SID, "item_id": PERMISSION["id"], "decision": "once"})
    assert error.value.state == "live_needs_tab"
    assert native.calls == []


@pytest.mark.parametrize("decision", ["once", "reject"])
def test_permission_rereads_before_answer(monkeypatch, attached, decision):
    native = Native(PERMISSION)
    monkeypatch.setattr(actions, "_client", lambda: native)
    run_action("permission", {"session_id": SID, "item_id": PERMISSION["id"], "decision": decision})
    route = f"session/{SID}/permission/{PERMISSION['id']}"
    assert native.calls == [("GET", route), ("POST", route + "/reply", {"decision": decision})]


def test_permission_declines_write_if_tab_closes_after_read(monkeypatch):
    native = Native(PERMISSION)
    route = f"session/{SID}/permission/{PERMISSION['id']}"
    monkeypatch.setattr(actions, "_client", lambda: native)
    monkeypatch.setattr(opencode_tabs, "active_tabs", lambda: {} if native.calls else {SID: 123})
    with pytest.raises(service.ServiceError) as error:
        run_action("permission", {"session_id": SID, "item_id": PERMISSION["id"], "decision": "once"})
    assert error.value.state == "live_needs_tab"
    assert native.calls == [("GET", route)]


def test_always_denied(monkeypatch, attached):
    native = Native(PERMISSION)
    monkeypatch.setattr(actions, "_client", lambda: native)
    with pytest.raises(service.ServiceError):
        run_action("permission", {"session_id": SID, "item_id": PERMISSION["id"], "decision": "always"})
    assert not any(call[0] == "POST" for call in native.calls)


@pytest.mark.parametrize("answer", [{}, {"fixed": "custom", "loose": ["green"]},
                                    {"fixed": "blue", "loose": "green"}, {"fixed": "blue", "loose": []}])
def test_invalid_form_stops_before_mutation(monkeypatch, attached, answer):
    native = Native(FORM)
    monkeypatch.setattr(actions, "_client", lambda: native)
    with pytest.raises(service.ServiceError) as error:
        run_action("form", {"session_id": SID, "item_id": FORM["id"], "answer": answer})
    assert error.value.state == "invalid_answer"
    assert len(native.calls) == 1


def test_valid_form_and_dismiss(monkeypatch, attached):
    native = Native(FORM)
    monkeypatch.setattr(actions, "_client", lambda: native)
    body = {"session_id": SID, "item_id": FORM["id"], "answer": {"fixed": "blue", "loose": ["green", "custom"]}}
    run_action("form", body)
    run_action("dismiss", body)
    assert [call[0] for call in native.calls] == ["GET", "POST", "GET", "DELETE"]
    assert native.calls[1][2] == {"answer": body["answer"]}
    assert "?message=" in native.calls[3][1]


def test_settled_form_is_stale(monkeypatch, attached):
    form = RECORDED["settled"]["body"]["data"]
    native = Native(form)
    monkeypatch.setattr(actions, "_client", lambda: native)
    with pytest.raises(service.ServiceError) as error:
        run_action("form", {"session_id": SID, "item_id": form["id"], "answer": {}})
    assert error.value.state == "live_stale"
    assert len(native.calls) == 1


def test_warm_active_reads_skip_identity_and_never_start(tmp_path, monkeypatch):
    cache = opencode_live.LiveService()
    registration = tmp_path / "service.json"
    registration.touch()
    monkeypatch.setattr(service, "binary", lambda: "/fixture/opencode")
    monkeypatch.setattr(service, "registration_path", lambda: registration)
    monkeypatch.setattr(service, "ensure", lambda: pytest.fail("A read started the service"))
    calls = []
    client = Native(RECORDED["active"]["body"]["data"])
    monkeypatch.setattr(service, "verified_client", lambda path, **_: calls.append(path) or client)
    assert cache.active(tmp_path) is None
    cache._verification.result(timeout=2)
    assert cache.active(tmp_path) == {SID}
    assert cache.active(tmp_path) == {SID}
    assert calls == [tmp_path]
    registration.write_text("new generation")
    assert cache.active(tmp_path) is None
    cache._verification.result(timeout=2)
    assert cache.active(tmp_path) == {SID}
    assert calls == [tmp_path, tmp_path]
    assert client.calls == [("GET", "session/active")] * 3


def test_feed_reuses_v2_text_projection_and_file_paths(monkeypatch):
    from atlas import agent_opencode, opencode_feed
    monkeypatch.setenv("ATLAS_OPENCODE_HOME", str(Path(__file__).parent / "fixtures/opencode"))
    with agent_opencode.open_readonly(agent_opencode.data_home() / agent_opencode.DATABASE) as source:
        sid = source.execute("SELECT id FROM session_v2 WHERE title='OpenCode fixture tools'").fetchone()[0]
    page = opencode_feed.read(sid, "steps", 1)
    assert len(page["turns"]) == 1
    assert "events" in page["turns"][0]
    assert not any("secret" in str(event).lower() for event in page["turns"][0]["events"]["events"])
    file_data = opencode_feed.read(sid, "files", 1)
    assert file_data["cwd"]
    assert any(entry["edit"] or entry["write"] for entry in file_data["files"])


def test_v2_card_uses_settled_text_context_and_outcome(atlas_env, monkeypatch):
    from atlas import db
    from atlas.opencode_live import _card

    model = RECORDED["usage"]["body"]["data"]
    stamp = model["time"]["created"]

    def pair(kind, at, data):
        return ({"type": kind, "id": "msg_" + "a" * 26, "seq": 1, "time_created": at}, data)

    tail = [pair("assistant", stamp + 100, {"time": {"created": stamp + 100}, "content": [
        {"type": "text", "text": "Unsettled text"}, {"type": "reasoning", "text": "Internal reasoning"}]}),
        pair("user", stamp + 50, {"text": "New request", "files": [{"data": "fixture-attachment"}]}),
        pair("assistant", stamp, {**model, "content": [*model["content"],
            {"type": "tool", "state": {"output": "Internal tool output"}}]})]
    live = opencode_live.LiveService()
    native = Native(RECORDED["models"]["data"])
    live.client = native
    row = {"title": "Fixture session", "directory": "/fixture/project", "time_created": stamp - 1000,
           "time_updated": stamp + 100,
           "time_idle": stamp + 55, "idle_outcome": "failed", "fork_session_id": None}
    messages = (tail, (tail[1][0], "New request"), (tail[2][0], model["content"][0]["text"]))
    with db.connect() as catalog:
        card = _card(catalog, row, messages, {}, SID, 123, False, live)
        again = _card(catalog, row, messages, {}, SID, 123, False, live)
    assert card["prompt"] == "New request"
    assert card["reply_tail"] == model["content"][0]["text"]
    assert card["model"] == "atlas/fake"
    assert card["context_tokens"] == 17
    assert card["context_window"] == again["context_window"] == 100_000
    assert len(native.calls) == 1
    assert card["interrupted_at"]
    assert card["pid"] == 123
    assert "Internal" not in json.dumps(card)


def test_lost_queue_admission_checks_again_without_reposting(monkeypatch, attached):
    entry = RECORDED["admission"]["body"]["data"]
    native = Native(None)
    inbox = iter([[], [entry]])
    native.data = lambda *_args, **_kwargs: next(inbox)
    calls = []

    def post(method, route, body=None, **_kwargs):
        calls.append((method, route, body))
        raise service.ServiceError("stopped", dispatched=True)

    native.call = post
    monkeypatch.setattr(actions, "_client", lambda: native)
    monkeypatch.setattr(actions, "_delivered", lambda client, *_args:
                        "queued" if client.data("", expect=list) else None)
    body = {"session_id": SID, "message_id": entry["id"], "text": entry["payload"]["text"]}
    assert run_action("reply", body) == {"delivery": "queued"}
    assert calls == [("POST", f"session/{SID}/prompt",
                      {"id": entry["id"], "delivery": "queue", "text": entry["payload"]["text"]})]


@pytest.mark.parametrize("inbox_available", [True, False])
def test_reply_retry_finds_the_request_in_the_transcript_even_without_a_tab(atlas_env, monkeypatch, inbox_available):
    from atlas import agent_opencode as source

    path = source.data_home() / source.DATABASE
    path.parent.mkdir(parents=True)
    shutil.copyfile(Path(__file__).parent / "fixtures/opencode/opencode.db", path)
    entry = RECORDED["admission"]["body"]["data"]
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) "
                   "VALUES (?, ?, 'user', 1, 1, 1, ?)", (entry["id"], SID, json.dumps(entry["payload"])))
    native = Native([])
    native.check_current = lambda: None
    if not inbox_available:
        def unavailable(*_args, **_kwargs):
            raise service.ServiceError("stopped")
        native.data = unavailable
    monkeypatch.setattr(actions, "_client", lambda: native)
    monkeypatch.setattr(opencode_tabs, "active_tabs", lambda: {})
    body = {"session_id": SID, "message_id": entry["id"], "text": "Retry", "ambiguous": True}
    assert run_action("reply", body) == run_action("reply-check", body) == {"delivery": "delivered"}
    expected = [("GET", f"session/{SID}/inbox")] * 2 if inbox_available else []
    assert native.calls == expected


@pytest.mark.parametrize(("status", "body", "refused"), [
    (400, {"_tag": "InvalidRequestError", "kind": "Payload", "message": "Expected string"}, True),
    (404, {"_tag": "SessionNotFoundError", "sessionID": SID, "message": "Session not found"}, True),
    (400, {"_tag": "FormInvalidAnswerError", "message": "Invalid field"}, False),
    (404, {"_tag": "SessionNotFoundError", "sessionID": "ses_" + "z" * 26}, False),
    (404, None, False), (302, None, False), (401, None, False), (409, None, False), (500, None, False),
])
def test_native_queue_errors_require_proof_of_non_admission(monkeypatch, attached, status, body, refused):
    native = Native([])

    def reject(*_args, **_kwargs):
        raise service.ServiceError("request_failed", status, dispatched=True, error_body=body)

    native.call = reject
    monkeypatch.setattr(actions, "_client", lambda: native)
    monkeypatch.setattr(actions, "_delivered", lambda *_: None)
    request = {"session_id": SID, "message_id": "msg_" + "x" * 26, "text": "Original"}
    if refused:
        with pytest.raises(service.ServiceError) as error:
            run_action("reply", request)
        assert error.value.status == status
    else:
        assert run_action("reply", request) == {"delivery": None}


def test_ambiguous_reply_requires_inbox_or_transcript_proof_after_a_successful_retry(monkeypatch, attached):
    entry = {**RECORDED["admission"]["body"]["data"], "sessionID": SID}
    native = Native([])
    native.call = lambda *_args, **_kwargs: {"data": entry}
    monkeypatch.setattr(actions, "_client", lambda: native)
    monkeypatch.setattr(actions, "_delivered", lambda *_: None)
    request = {"session_id": SID, "message_id": entry["id"], "text": "Original", "ambiguous": True}
    assert run_action("reply", request) == {"delivery": None}


@pytest.mark.parametrize("text", ["\u0085", " \x1c\u2003\u0085"])
def test_blank_reply_refused_without_native_requests(monkeypatch, attached, text):
    native = Native([])
    monkeypatch.setattr(actions, "_client", lambda: native)
    with pytest.raises(service.ServiceError) as error:
        run_action("reply", {"session_id": SID, "message_id": "msg_" + "x" * 26, "text": text})
    assert error.value.status == 400
    assert not native.calls


def test_reply_tab_gone_before_dispatch_is_definitely_refused(monkeypatch):
    native = Native([])
    monkeypatch.setattr(actions, "_client", lambda: native)
    monkeypatch.setattr(actions, "_delivered", lambda client, *_: client.data("inbox") or None)
    monkeypatch.setattr(opencode_tabs, "active_tabs", lambda: {} if native.calls else {SID: 123})
    with pytest.raises(service.ServiceError) as error:
        run_action("reply", {"session_id": SID, "message_id": "msg_" + "x" * 26, "text": "Original"})
    assert error.value.state == "live_needs_tab"
    assert native.calls == [("GET", "inbox")]


def test_reply_stays_ambiguous_when_reconciliation_is_unavailable(monkeypatch, attached):
    native = Native([])
    client = iter([native])

    def verify():
        found = next(client, None)
        if found is None:
            raise service.ServiceError("stopped")
        return found

    def lost_response(*_args, **_kwargs):
        raise service.ServiceError("stopped", dispatched=True)

    monkeypatch.setattr(actions, "_client", verify)
    monkeypatch.setattr(actions, "_delivered", lambda *_: None)
    monkeypatch.setattr(native, "call", lost_response)
    assert run_action("reply", {"session_id": SID, "message_id": "msg_" + "x" * 26,
                                 "text": "Original"}) == {"delivery": None}


@pytest.mark.parametrize(("status", "state"), [(400, "invalid_answer"), (404, "live_stale"), (409, "live_stale")])
def test_native_answer_errors_are_localized(monkeypatch, attached, status, state):
    native = Native(FORM)

    def post(*_args, **_kwargs):
        raise service.ServiceError("request_failed", status)

    monkeypatch.setattr(native, "call", post)
    monkeypatch.setattr(actions, "_client", lambda: native)
    with pytest.raises(service.ServiceError) as error:
        run_action("form", {"session_id": SID, "item_id": FORM["id"],
                             "answer": {"fixed": "blue", "loose": ["green"]}})
    assert error.value.state == state


def test_verification_retries_on_next_poll_without_file_changes(tmp_path, monkeypatch):
    cache = opencode_live.LiveService()
    registration = tmp_path / "service.json"
    registration.touch()
    client = Native(RECORDED["active"]["body"]["data"])
    attempts = []

    def verify(database, **_):
        attempts.append(database)
        if len(attempts) == 1:
            raise service.ServiceError("stopped")
        return client

    monkeypatch.setattr(service, "binary", lambda: "/fixture/opencode")
    monkeypatch.setattr(service, "registration_path", lambda: registration)
    monkeypatch.setattr(service, "verified_client", verify)
    assert cache.active(tmp_path) is None
    cache._verification.result(timeout=2)
    assert cache.active(tmp_path) is None
    cache._verification.result(timeout=2)
    assert cache.active(tmp_path) == {SID}
    assert attempts == [tmp_path, tmp_path]


@pytest.mark.parametrize("double_space_pid", [100, 300])
def test_active_tab_normalizes_single_digit_start(double_space_pid):
    folder = opencode_tabs.tab_dir()
    folder.mkdir()
    start = "Thu Jan 7 02:00:00 2027"
    attempt = "a" * 32
    nonce = "b" * 32
    instance = "opencode-test"

    def recorded(pid):
        return start.replace("Jan ", "Jan  ") if pid == double_space_pid else start

    (folder / "layout-test.json").write_text(json.dumps({
        "pid": 100, "start": recorded(100),
        "tabs": [{"instance": instance, "attempt": attempt, "ptyPid": 200}],
    }))
    (folder / f"{instance}.json").write_text(json.dumps({
        "pid": 300, "start": recorded(300), "attempt": attempt, "nonce": nonce,
    }))
    (folder / f"{instance}.{nonce}.route").write_text(json.dumps({
        "pid": 300, "nonce": nonce, "current": SID, "route": "session", "at": time.time() * 1000,
    }))
    table = {100: (1, start), 200: (100, start), 300: (200, start)}
    assert opencode_tabs.active_tabs(table) == {SID: 200}
    table[double_space_pid] = (table[double_space_pid][0], start.replace("Jan 7", "Jan 8"))
    assert opencode_tabs.active_tabs(table) == {}


def test_failed_pending_read_preserves_waiting_until_authoritative_empty(monkeypatch):
    from atlas import db

    live = opencode_live.LiveService()
    monkeypatch.setattr(opencode_tabs, "active_tabs", lambda _table: {SID: 123})
    running = {SID}
    forms = [FORM]
    monkeypatch.setattr(live, "active", lambda _database: running)
    monkeypatch.setattr(live, "read", lambda route, _expect: forms if route.endswith("/form") else [])

    with db.connect() as catalog:
        def poll():
            card, = opencode_live.list_live(catalog, {}, live)
            return card["status"], card["opencode_dialog"], card["opencode_pending_known"]

        status, dialog, known = poll()
        assert status == "waiting" and known and dialog["id"] == FORM["id"]
        forms = None
        assert poll() == ("waiting", dialog, False)
        running = None
        assert poll() == ("idle", None, False)
        running = {SID}
        assert poll() == ("waiting", dialog, False)
        forms = []
        assert poll() == ("busy", None, True)


def test_pending_state_is_unknown_without_a_verified_tab(monkeypatch):
    live = opencode_live.LiveService()
    monkeypatch.setattr(live, "read", lambda route, _expect: [FORM] if route.endswith("/form") else [])
    assert opencode_live._pending(SID, None, True, live) == ("question", None, [], False)
    assert opencode_live._pending(SID, None, False, live) == (None, None, None, False)


def test_message_projection_reaches_beyond_cost_tail(tmp_path):
    path = tmp_path / "opencode.db"
    with closing(sqlite3.connect(path)) as db, db:
        db.row_factory = sqlite3.Row
        db.execute("CREATE TABLE session_message (id, session_id, type, seq, time_created, data)")
        records = [
            ("assistant", {"time": {"completed": 1}, "content": [{"type": "text", "text": "Last answer"}]}),
            ("user", {"text": "Current prompt"}),
            ("user", {"text": "  "}),
            ("assistant", {"content": [{"type": "text", "text": "Still streaming"}]}),
            *[("assistant", {"time": {"completed": 1}, "content": [{"type": "tool"}]})]
            * (opencode_live.TAIL_ROWS + 1),
        ]
        db.executemany("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)", [
            (f"msg_{i}", SID, kind, i, i + 1, json.dumps(data))
            for i, (kind, data) in enumerate(records)
        ])
        tail, prompt, answer = opencode_live._messages(db, SID)
    assert len(tail) == opencode_live.TAIL_ROWS
    assert (prompt[0]["time_created"], prompt[1]) == (2, "Current prompt")
    assert (answer[0]["time_created"], answer[1]) == (1, "Last answer")


def test_long_history_prefers_the_live_prompt_and_uses_the_completed_indexed_answer(atlas_env, tmp_path, monkeypatch):
    from atlas import db, index

    path = tmp_path / "opencode.db"
    monkeypatch.setenv("ATLAS_OPENCODE_HOME", str(tmp_path))
    shutil.copyfile(Path(__file__).parent / "fixtures/opencode/opencode.db", path)
    tool = json.dumps({"time": {"completed": 2}, "content": [{"type": "tool", "tool": "review",
                       "state": {"status": "completed", "input": {"argument": "x" * 4096}}}]})
    with db.connect() as catalog:
        index.index_all(catalog, root=str(tmp_path / "claude"))
        sid = catalog.execute("SELECT session_id FROM sessions WHERE title='OpenCode fixture plain'").fetchone()[0]
    with closing(sqlite3.connect(path)) as source, source:
        source.execute("DELETE FROM session_message WHERE session_id=?", (sid,))
        source.execute("UPDATE session_v2 SET time_updated=123000 WHERE id=?", (sid,))
        source.execute("INSERT INTO session_message VALUES ('user', ?, 'user', 1, 0, 1, ?)",
                       (sid, '{"text":"Newest live prompt"}'))
        source.executemany("INSERT INTO session_message VALUES (?, ?, 'assistant', ?, ?, ?, ?)",
                           ((str(i), sid, i, i, i, tool) for i in range(2, 12002)))
    count = 0
    original = opencode_live._data

    def read(row):
        nonlocal count
        count += 1
        return original(row)

    original_open = opencode_live.source.open_readonly
    statements = []

    @contextmanager
    def trace(*args, **kwargs):
        with original_open(*args, **kwargs) as source:
            source.set_trace_callback(statements.append)
            yield source

    monkeypatch.setattr(opencode_live, "_data", read)
    monkeypatch.setattr(opencode_live.source, "open_readonly", trace)
    with db.connect() as catalog:
        row, messages = opencode_live._snapshot(path, sid)
        card = opencode_live._card(catalog, row, messages, {}, sid, 123, False, opencode_live.LiveService())
    assert count <= 97
    assert any("LIMIT" in statement and "FROM session_message" in statement for statement in statements)
    assert any("type='user'" in statement and "FROM session_message" in statement for statement in statements)
    assert card["prompt"] == card["last_prompt"] == "Newest live prompt"
    assert card["reply_tail"] == "Synthetic assistant reply"
    assert card["reply_at"] == card["last_message_at"] == active._iso_ms(1795342628707)
    with db.connect() as catalog:
        catalog.execute("DELETE FROM opencode_answer_times WHERE session_id=?", (sid,))
        card = opencode_live._card(catalog, row, messages, {}, sid, 123, False, opencode_live.LiveService())
    assert card["reply_tail"] == "Synthetic assistant reply"
    assert card["reply_at"] is None
    assert card["last_message_at"] == card["prompt_at"]


def test_card_uses_indexed_prompt_when_transcript_is_missing(atlas_env, monkeypatch):
    from atlas import db, search

    monkeypatch.setattr(search, "_load_session", lambda *_: {
        "last_prompt": "Indexed prompt", "last_activity_at": "2026-11-23T10:00:00+00:00"})
    with db.connect() as catalog:
        card = opencode_live._card(catalog, None, ([], None, None), {}, SID, 123, False, opencode_live.LiveService())
    assert card["prompt"] == "Indexed prompt"
    assert card["prompt_at"] == card["last_message_at"] == "2026-11-23T10:00:00+00:00"


def test_snapshot_discards_data_if_readonly_context_rejects_it(tmp_path, monkeypatch):
    from atlas import agent_opencode as source

    path = tmp_path / "opencode.db"
    shutil.copyfile(Path(__file__).parent / "fixtures/opencode/opencode.db", path)
    with source.open_readonly(path) as db:
        sid = db.execute("SELECT session_id FROM session_message LIMIT 1").fetchone()[0]
    assert opencode_live._snapshot(path, sid)[0] is not None
    original = source.open_readonly

    @contextmanager
    def changing_snapshot(database, **kwargs):
        with original(database, **kwargs) as db:
            yield db
        raise OSError("snapshot invalidated")

    monkeypatch.setattr(source, "open_readonly", changing_snapshot)
    assert opencode_live._snapshot(path, sid) == (None, ([], None, None))
