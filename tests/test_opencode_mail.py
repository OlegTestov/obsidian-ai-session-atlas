"""The managed OpenCode bridge derives its mailbox from the native request."""
import io
import json
import os
import time
from pathlib import Path

import pytest

from atlas import agent_mail, opencode_mail

SID = "ses_" + "aB" * 13
OTHER = "ses_" + "b" * 26
OWNER = "00000000-0000-4000-8000-000000000001"


@pytest.fixture
def bridge(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_mail, "HOME", str(tmp_path / "mail"))
    monkeypatch.setenv("ATLAS_HOME", str(tmp_path / "atlas"))
    monkeypatch.setattr(agent_mail, "_own_route", lambda *_: None)
    directory = tmp_path / "project"
    directory.mkdir()
    owned = {SID: 42}
    monkeypatch.setattr(opencode_mail.opencode_tabs, "active_tabs", lambda: owned)
    monkeypatch.setattr(opencode_mail.agent_opencode, "session_metadata",
                        lambda sid: {"directory": str(directory)} if sid == SID else None)
    snapshot = Path(agent_mail.HOME) / agent_mail.TAB_DIR / (OWNER + ".json")
    snapshot.parent.mkdir(parents=True)
    snapshot.write_text(json.dumps([{
        "agent": "opencode", "id": SID, "mailbox": agent_mail._tab_mailbox("opencode", SID),
        "title": "Fixture", "pid": 42,
    }]))
    return directory, owned


def test_mail_is_read_from_the_verified_session_mailbox(bridge):
    directory, _ = bridge
    mailbox = agent_mail._tab_mailbox("opencode", SID)
    agent_mail.send("fixture-peer", mailbox, "Hello from a fixture.")
    sender = opencode_mail.Bridge(directory, OWNER)
    result = sender.call("mail_inbox", {"peek": True}, {"ai.opencode/sessionID": SID})
    assert "Hello from a fixture." in result
    assert agent_mail.inbox(mailbox, peek=True)
    sender.call("mail_send", {"to": "fixture-peer", "text": "Reply."}, {"ai.opencode/sessionID": SID})
    [letter] = agent_mail.inbox("fixture-peer", peek=True)
    assert (letter["from"], letter["text"]) == (mailbox, "Reply.")


@pytest.mark.parametrize(("meta", "arguments"), [
    (None, {}),
    ({"ai.opencode/sessionID": OTHER}, {}),
    ({"ai.opencode/sessionID": SID}, {"as": "some-other-mailbox"}),
    ({}, {"_meta": {"ai.opencode/sessionID": SID}}),
])
def test_mail_refuses_unowned_or_overridden_caller(bridge, meta, arguments):
    directory, _ = bridge
    with pytest.raises(ValueError):
        opencode_mail.Bridge(directory, OWNER).call("mail_inbox", arguments, meta)


def test_mail_refuses_another_location_and_ambiguous_mailbox(bridge, tmp_path):
    directory, tabs = bridge
    metadata = {"ai.opencode/sessionID": SID}
    other_location = tmp_path / "other"
    other_location.mkdir()
    with pytest.raises(ValueError):
        opencode_mail.Bridge(other_location, OWNER).call("mail_inbox", {}, metadata)
    tabs["ses_" + "Ab" * 13] = 123
    with pytest.raises(ValueError):
        opencode_mail.Bridge(directory, OWNER).call("mail_inbox", {}, metadata)


def test_native_stdio_tools_use_top_level_mcp_metadata(bridge, monkeypatch, capsys):
    directory, _ = bridge
    requests = [
        {"id": 1, "method": "tools/list"},
        {"id": 2, "method": "tools/call", "params": {"name": "mail_inbox", "arguments": {},
          "_meta": {"ai.opencode/sessionID": SID}}},
        {"id": 3, "method": "tools/call", "params": {"name": "mail_inbox",
          "arguments": {"_meta": {"ai.opencode/sessionID": SID}}}},
    ]
    monkeypatch.setattr(agent_mail.sys, "stdin", io.StringIO("\n".join(map(json.dumps, requests))))
    opencode_mail.Bridge(directory, OWNER).serve()
    tools, good, invalid = [json.loads(line)["result"] for line in capsys.readouterr().out.splitlines()]
    assert {row["name"] for row in tools["tools"]} == {"mail_inbox", "mail_send", "mail_peers"}
    assert all("as" not in row["inputSchema"]["properties"] for row in tools["tools"])
    assert good["content"][0]["text"] == "No new messages."
    assert invalid["isError"]


class Native:
    generation = "fixture"
    version = "2.3.2"

    def __init__(self):
        self.entries = {}
        self.mutations = []
        self.verified = True

    def check_verified_database(self):
        if not self.verified:
            raise opencode_mail.service.ServiceError("profile")

    @staticmethod
    def _location(route):
        from urllib.parse import parse_qs
        return parse_qs(route.split("?", 1)[1])["location[directory]"][0]

    def data(self, route, *, expect):
        assert expect is list and route.startswith("mcp?")
        return [{"name": name, "status": {"status": state}}
                for name, state in self.entries.setdefault(self._location(route), {}).items()]

    def call(self, method, route, body=None, *, before_send):
        before_send()
        name = route.split("?", 1)[0].rsplit("/", 1)[-1]
        location = self._location(route)
        self.mutations.append((method, location, name))
        if method == "PUT":
            assert body["config"]["type"] == "local"
            assert "atlas.opencode_mail" in body["config"]["command"]
            self.entries[location][name] = "connected"
        else:
            self.entries.setdefault(location, {}).pop(name, None)


def test_native_registration_tracks_location_and_generation_without_touching_other_tools(tmp_path):
    directory = tmp_path / "project"
    directory.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "mail"
    native = Native()
    native.entries[str(directory)] = {"user-tool": "connected"}
    native.entries[str(outside)] = {"outside-tool": "connected"}
    registry = opencode_mail.Registration()
    registry.sync(native, {directory}, root, OWNER)
    registry.sync(native, {directory}, root, OWNER)
    assert native.mutations == [("PUT", str(directory), registry.name)]
    assert set(native.entries[str(directory)]) == {registry.name, "user-tool"}
    assert native.entries[str(outside)] == {"outside-tool": "connected"}

    native.generation = "new-fixture"
    native.entries[str(directory)].pop(registry.name)
    registry.sync(native, {directory}, root, OWNER)
    registry.sync(native, set(), root, OWNER)
    assert native.mutations[-2:] == [("PUT", str(directory), registry.name), ("DELETE", str(directory), registry.name)]
    assert native.entries[str(directory)] == {"user-tool": "connected"}


def test_native_registration_respects_a_changed_database(tmp_path):
    native = Native()
    native.verified = False
    with pytest.raises(opencode_mail.service.ServiceError):
        opencode_mail.Registration().sync(native, {tmp_path}, tmp_path / "mail", OWNER)
    assert not native.mutations


def test_runtime_registers_only_its_current_tabs_and_stale_host_cannot_remove_them(bridge, tmp_path, monkeypatch):
    directory, tabs = bridge
    root = tmp_path / "mail"
    native = Native()
    monkeypatch.setattr(opencode_mail.service, "verified_client", lambda *_: native)
    runtime = opencode_mail.Runtime()
    tabs[OTHER] = 99  # no matching catalog location
    assert runtime.sync("previous-host", root) == []
    assert runtime.sync(OWNER, root) == []
    assert runtime.sync(OWNER, root) == [SID]
    assert runtime.sync("previous-host", None) == []
    assert [method for method, *_ in native.mutations] == ["PUT", "PUT"]
    runtime.sync(OWNER, None)
    assert [method for method, *_ in native.mutations] == ["PUT", "PUT", "DELETE"]
    assert all(location == str(directory.resolve()) for _, location, _ in native.mutations)


def test_runtime_nudge_is_idle_only_and_reuses_the_same_native_id(bridge, tmp_path, monkeypatch):
    directory, _ = bridge
    native = Native()
    root = tmp_path / "mail"
    mailbox = agent_mail._tab_mailbox("opencode", SID)
    item = "1700000000000-" + "a" * 12 + ".json"
    inbox = root / mailbox / "inbox"
    inbox.mkdir(parents=True)
    (inbox / item).write_text("{}")
    monkeypatch.setattr(opencode_mail.service, "verified_client", lambda *_: native)
    runtime = opencode_mail.Runtime()
    assert runtime.sync(OWNER, root) == []
    assert runtime.sync(OWNER, root) == [SID]
    assert str(directory.resolve()) in native.entries

    calls = []

    def reply(sid, method, payload, **_):
        calls.append((sid, method, payload))
        return {"delivery": "queued"}

    monkeypatch.setattr(opencode_mail.opencode_live_actions, "_reply", reply)
    original = native.data
    native.data = lambda route, **kw: {SID: {"type": "running"}} if route == "session/active" else original(route, **kw)
    assert runtime.nudge(OWNER, SID, item) == {"delivery": None}
    assert not calls
    native.data = lambda route, **kw: {} if route == "session/active" else original(route, **kw)
    assert runtime.nudge("other-host", SID, item) == {"delivery": None}
    assert not calls
    for _ in range(2):
        assert runtime.nudge(OWNER, SID, item) == {"delivery": "queued"}
    assert calls[0] == calls[1]
    assert calls[0][2]["message_id"].startswith("msg_")
    (inbox / item).unlink()
    assert runtime.nudge(OWNER, SID, item) == {"delivery": None}
    assert len(calls) == 2


def test_bridge_loses_access_when_its_host_snapshot_expires_or_is_removed(bridge):
    directory, _ = bridge
    snapshot = Path(agent_mail.HOME) / agent_mail.TAB_DIR / (OWNER + ".json")
    sender = opencode_mail.Bridge(directory, OWNER)
    meta = {opencode_mail.SESSION_META: SID}
    assert sender.call("mail_inbox", {}, meta) == "No new messages."
    age = time.time() - agent_mail.TAB_TTL - 1
    os.utime(snapshot, (age, age))
    with pytest.raises(ValueError, match="no longer"):
        sender.call("mail_inbox", {}, meta)
    snapshot.unlink()
    with pytest.raises(ValueError, match="no longer"):
        sender.call("mail_inbox", {}, meta)


def test_next_runtime_recovers_only_registrations_from_a_crashed_runtime(tmp_path):
    native = Native()
    journal = tmp_path / "ownership"
    root = tmp_path / "mail"
    project = tmp_path / "project"
    project.mkdir()
    native.entries[str(project)] = {"user-tool": "connected"}

    crashed = opencode_mail.Registration(journal)
    crashed.sync(native, {project}, root, OWNER)
    survivor = opencode_mail.Registration(journal)
    survivor.sync(native, set(), None, None)
    assert set(native.entries[str(project)]) == {"user-tool", crashed.name}

    # The OS releases the ownership lock on process exit even without Atlas cleanup.
    crashed.close()
    restarted = opencode_mail.Registration(journal)
    restarted.sync(native, set(), None, None)
    assert set(native.entries[str(project)]) == {"user-tool"}
    assert not list(journal.glob("*.json"))
