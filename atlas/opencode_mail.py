"""Agent Mail tools restricted to a managed OpenCode tab at the registered location."""
from __future__ import annotations

import fcntl
import hashlib
import os
import re
import secrets
import stat
import sys
import threading
from contextlib import suppress
from pathlib import Path
from urllib.parse import urlencode

from . import (
    agent_mail,
    agent_opencode,
    agents,
    db,
    opencode_live_actions,
    opencode_service as service,
    opencode_tabs,
)

SESSION_META = "ai.opencode/sessionID"
TOOLS = {"mail_send", "mail_inbox", "mail_peers"}
REGISTRATION = re.compile(r"atlas-agent-mail-[a-f0-9]{12}")
LETTER = re.compile(r"\d{13}-[0-9a-f]{12}\.json")
NUDGE = ("You have new Agent Mail. Read it with mail_inbox, then answer the sender "
         'unless the letter ends with "(no reply needed)".')


def _descriptors():
    descriptions = []
    for tool in agent_mail.TOOLS:
        if tool["name"] not in TOOLS:
            continue
        schema = tool["inputSchema"]
        properties = {key: value for key, value in schema["properties"].items() if key != "as"}
        descriptions.append({**tool, "inputSchema": {**schema, "properties": properties,
                                                    "additionalProperties": False}})
    return descriptions


def _session_directory(sid):
    row = agent_opencode.session_metadata(sid)
    try:
        directory = Path(row["directory"]).resolve(strict=True) if row else None
        return directory if directory and directory.is_dir() else None
    except (TypeError, OSError, RuntimeError, ValueError):
        return None


def _advertised(root, owner, sid, mailbox):
    if not isinstance(owner, str) or not agent_mail.UUID_RE.fullmatch(owner):
        return False
    directory = Path(root) / agent_mail.TAB_DIR
    try:
        if not stat.S_ISDIR(directory.lstat().st_mode):
            return False
        snapshot = agent_mail._read_snapshot(directory / (owner + ".json"))
    except (OSError, ValueError):
        return False
    return bool(snapshot and isinstance(snapshot[1], list) and any(
        isinstance(tab, dict) and tab.get("agent") == agents.OPENCODE
        and tab.get("id") == sid and tab.get("mailbox") == mailbox for tab in snapshot[1]))


def _unread(root, mailbox, letter):
    inbox = Path(root) / mailbox / "inbox"
    try:
        return (all(stat.S_ISDIR(parent.lstat().st_mode) for parent in (inbox.parent, inbox))
                and stat.S_ISREG((inbox / letter).lstat().st_mode))
    except OSError:
        return False


class Bridge:
    def __init__(self, directory, owner, root=None):
        self.directory = Path(directory).resolve(strict=True)
        self.owner = owner
        self.root = agent_mail.HOME if root is None else root

    def _mailbox(self, meta):
        sid = meta.get(SESSION_META) if isinstance(meta, dict) else None
        if not agents.valid_id(agents.OPENCODE, sid):
            raise ValueError("Agent Mail needs the current OpenCode session.")

        tabs = opencode_tabs.active_tabs()
        if sid not in tabs:
            raise ValueError("Open this OpenCode session in Session Atlas to use Agent Mail.")
        mailbox = agent_mail._tab_mailbox(agents.OPENCODE, sid)
        if any(other != sid and agent_mail._tab_mailbox(agents.OPENCODE, other) == mailbox for other in tabs):
            raise ValueError("The OpenCode mailbox could not be identified.")

        if _session_directory(sid) != self.directory:
            raise ValueError("This OpenCode session belongs to another location.")
        if not _advertised(self.root, self.owner, sid, mailbox):
            raise ValueError("This OpenCode tab is no longer available in Agent Mail.")
        return mailbox

    def call(self, name, arguments, meta):
        if not isinstance(name, str) or name not in TOOLS:
            raise ValueError("Unknown OpenCode mail tool.")
        if not isinstance(arguments, dict) or "as" in arguments:
            raise ValueError("The OpenCode session determines the mailbox.")
        mailbox = self._mailbox(meta)
        return agent_mail._call(name, {**arguments, "as": mailbox}, before_read=lambda: self._mailbox(meta))

    def serve(self):
        agent_mail.serve(dispatch=self.call, tools=_descriptors())


def _location(directory):
    return "?" + urlencode({"location[directory]": str(directory)})


def _config(directory, root, owner):
    package = Path(__file__).resolve().parent.parent
    return {"type": "local", "cwd": str(directory), "codemode": False,
            "command": ["/usr/bin/env", f"PYTHONPATH={package}", f"ATLAS_HOME={db.atlas_home()}",
                        f"ATLAS_OPENCODE_HOME={agent_opencode.data_home()}", f"AGENT_MAIL_HOME={root}",
                        sys.executable, "-m", "atlas.opencode_mail", str(directory), owner],
            "timeout": {"startup": 3000, "catalog": 3000, "execution": 10000}}


class Registration:
    """One Atlas server's temporary native registration, independently owned at each location."""

    def __init__(self, journal=None):
        # Never overwrite a user MCP configured under the conventional base name.
        self.name = "atlas-agent-mail-" + secrets.token_hex(6)
        self.journal = journal
        self.lease = None
        self.generation = None
        self.owned = {}

    @staticmethod
    def _route(name, directory):
        return "experimental/mcp/" + name + _location(directory)

    @classmethod
    def _remove(cls, client, name, directory):
        try:
            client.call("DELETE", cls._route(name, directory), before_send=client.check_verified_database)
        except service.ServiceError as exc:
            if exc.status != 404:
                raise

    def _remember(self):
        if self.journal is None:
            return
        file = self.journal / (self.name + ".json")
        if not self.owned:
            file.unlink(missing_ok=True)
            return
        if self.lease is None:
            self.journal.mkdir(mode=0o700, parents=True, exist_ok=True)
            self.lease = file.with_suffix(".lock").open("ab")
            fcntl.flock(self.lease, fcntl.LOCK_EX)
        opencode_tabs._save(file, {"nonce": secrets.token_hex(8), "generation": self.generation,
                                   "directories": [str(path) for path in self.owned]})

    def _orphans(self):
        if self.journal is None:
            return []
        return [file for file in self.journal.glob("*.json")
                if file.stem != self.name and REGISTRATION.fullmatch(file.stem)]

    def _recover(self, client):
        for file in self._orphans():
            lock = file.with_suffix(".lock")
            try:
                with lock.open("ab") as lease:
                    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    record = opencode_tabs._record(file, opencode_tabs.LIMIT)
                    directories = record.get("directories")
                    if record.get("generation") == client.generation and isinstance(directories, list):
                        for directory in directories:
                            if isinstance(directory, str) and os.path.isabs(directory):
                                self._remove(client, file.stem, directory)
                    file.unlink(missing_ok=True)
                    lock.unlink(missing_ok=True)
            except (OSError, service.ServiceError):
                # Still in use, or a native request failed. Keep the journal for the next check.
                continue

    def close(self):
        if self.lease is not None:
            if not self.owned:
                (self.journal / (self.name + ".lock")).unlink(missing_ok=True)
            self.lease.close()
            self.lease = None

    def sync(self, client, locations, root, owner):
        if client.version != service.TESTED_VERSION:
            raise service.ServiceError("version_warning")
        self._recover(client)
        if self.generation != client.generation:
            self.generation = client.generation
            self.owned.clear()
            self._remember()

        for directory in sorted(self.owned.keys() - locations):
            self._remove(client, self.name, directory)
            del self.owned[directory]
            self._remember()

        connected = set()
        for directory in sorted(locations):
            entries = client.data("mcp" + _location(directory), expect=list)
            found = next((item for item in entries if isinstance(item, dict) and item.get("name") == self.name), None)
            if found is not None and directory not in self.owned:
                continue
            state = found.get("status") if found else None
            status = state.get("status") if isinstance(state, dict) else None
            if self.owned.get(directory) == (root, owner) and status in {"pending", "connected"}:
                if status == "connected":
                    connected.add(directory)
                continue
            # Remember the random name before submitting. A lost response can still leave it registered.
            self.owned[directory] = (root, owner)
            self._remember()
            client.call("PUT", self._route(self.name, directory), {"config": _config(directory, root, owner)},
                        before_send=client.check_verified_database)
        return connected


class Runtime:
    def __init__(self):
        self.registration = Registration(Path(db.atlas_home()) / "opencode-mail")
        self.owner = None
        self.closed = False
        self.root = None
        self.ready = {}
        self.lock = threading.Lock()

    def _sync(self, sessions, root):
        if not sessions and not self.registration.owned and not self.registration._orphans():
            return []
        client = service.verified_client(agent_opencode.data_home() / agent_opencode.DATABASE)
        connected = self.registration.sync(client, set(sessions.values()), root, self.owner)
        self.ready = {sid: directory for sid, directory in sessions.items() if directory in connected}
        return sorted(self.ready)

    def sync(self, owner, root):
        with self.lock:
            if self.closed or (root is None and self.owner is not None and self.owner != owner):
                return []
            self.ready.clear()
            self.root = root
            if root is not None:
                self.owner = owner
            sessions = ({sid: directory for sid in opencode_tabs.active_tabs()
                         if (directory := _session_directory(sid))} if root is not None else {})
            connected = self._sync(sessions, root)
            if root is None:
                self.owner = None
            return connected

    def nudge(self, owner, sid, letter):
        if not agents.valid_id(agents.OPENCODE, sid) or not isinstance(letter, str) or not LETTER.fullmatch(letter):
            raise ValueError("Invalid OpenCode mail target.")
        with self.lock:
            if self.closed or owner != self.owner or self.root is None or sid not in self.ready:
                return {"delivery": None}
            directory = self.ready[sid]
            bridge = Bridge(directory, owner, self.root)
            mailbox = bridge._mailbox({SESSION_META: sid})
            if not _unread(self.root, mailbox, letter):
                return {"delivery": None}
            client = service.verified_client(agent_opencode.data_home() / agent_opencode.DATABASE)

            def idle():
                return (client.generation == self.registration.generation
                        and sid not in client.data("session/active", expect=dict))

            def check_idle():
                if (not idle() or not _advertised(self.root, owner, sid, mailbox)
                        or not _unread(self.root, mailbox, letter)):
                    raise service.ServiceError("live_stale", 409)

            if not idle():
                return {"delivery": None}
            # Queue and transcript share this native ID. The unread letter supplies a stable
            # batch key, so retrying after a lost response or restart cannot create a new ID.
            digest = hashlib.sha256(f"atlas-mail\0{sid}\0{letter}".encode()).hexdigest()
            return opencode_live_actions._reply(sid, "reply", {
                "message_id": "msg_" + digest[:26], "text": NUDGE, "generation": client.generation,
            }, client=client, before_send=check_idle)

    def shutdown(self):
        with self.lock:
            self.closed = True
            self.ready.clear()
            try:
                with suppress(service.ServiceError):
                    self._sync({}, None)
            finally:
                self.registration.close()


if __name__ == "__main__":
    Bridge(*sys.argv[1:]).serve()
