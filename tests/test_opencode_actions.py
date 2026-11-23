from __future__ import annotations

import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest

from atlas import agent_opencode, cli, db, index, opencode_actions as actions, opencode_service, opencode_tabs, server

REPO = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).parent / "fixtures/opencode"
FORK = "ses_" + "f" * 26
TOKEN = "fixture-request-001"


@pytest.fixture
def native(tmp_path, monkeypatch):
    home = tmp_path / "isolated home"
    home.mkdir()
    state = tmp_path / "state/opencode"
    state.mkdir(parents=True)
    source = tmp_path / "data/opencode/opencode.db"
    source.parent.mkdir(parents=True)
    cwd = tmp_path / "O'Reilly project"
    cwd.mkdir()
    binary = tmp_path / "opencode"
    argv_file = tmp_path / "argv.json"
    binary.write_text(f"#!{sys.executable}\nimport json, sys\n"
                      "import os\nassert 'OPENCODE_PASSWORD' not in os.environ\n"
                      "assert 'OPENCODE_SERVER_PASSWORD' not in os.environ\n"
                      "if sys.argv[1:] == ['--version']: print('opencode v2.3.2'); sys.exit(0)\n"
                      f"with open({str(argv_file)!r}, 'w') as f: json.dump(sys.argv[1:], f)\n")
    binary.chmod(0o700)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("XDG_STATE_HOME", str(state.parent))
    monkeypatch.setenv("XDG_DATA_HOME", str(source.parent.parent))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("ATLAS_OPENCODE_HOME", str(source.parent))
    monkeypatch.setenv("ATLAS_OPENCODE_BIN", str(binary))
    shutil.copyfile(FIXTURES / "opencode.db", source)
    with closing(sqlite3.connect(source)) as writer, writer:
        writer.execute("UPDATE session_v2 SET directory=?", (str(cwd),))
        session, child, empty = [
            writer.execute(f"SELECT id FROM session_v2 WHERE {where}").fetchone()[0]
            for where in (
                "title='OpenCode fixture parent'", "parent_id IS NOT NULL", "title='OpenCode fixture empty'")
        ]
    contract = json.loads((FIXTURES / "service-2.3.2.json").read_text())
    contract["info"]["pid"] = os.getpid()
    data = {session: dict(contract["changed"]["data"], id=session, title="Original", time={"created": 1}),
            child: dict(contract["children"]["data"][0], id=child, parentID=session),
            empty: dict(contract["empty"]["data"], id=empty)}
    seen = []
    switches = SimpleNamespace(active={}, reject_rename=False, lose_fork=False,
                               conceal_fork=False, retain_on_delete=False, database=str(source),
                               on_active=lambda: None, on_delete=lambda: None)

    def write(sql, params):
        with closing(sqlite3.connect(source)) as writer, writer:
            writer.execute(sql, params)

    def reparent(child, parent):
        data[child]["parentID"] = parent
        write("UPDATE session_v2 SET parent_id=? WHERE id=?", (parent, child))

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.handle_native()

        do_PATCH = do_POST = do_DELETE = do_GET

        def handle_native(self):
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else None
            seen.append((self.command, self.path, body))
            parsed = urlsplit(self.path)
            route = parsed.path.split("/")[2:]
            if route == ["info"]:
                info = dict(contract["info"], paths=dict(contract["info"]["paths"]))
                if switches.database:
                    info["paths"]["database"] = switches.database
                return self.send_json(200, info)
            if route == ["session", "active"]:
                switches.on_active()
                return self.send_json(200, dict(contract["active"], data=switches.active))
            if route == ["session"]:
                query = parse_qs(parsed.query)
                if "cursor" in query:
                    return self.send_json(200, {"data": [], "cursor": {}})
                parent = query.get("parentID", [None])[0]
                rows = [v for k, v in data.items()
                        if (not parent or v.get("parentID") == parent) and not (k == FORK and switches.conceal_fork)]
                return self.send_json(200, {"data": rows, "cursor": {"next": "opaque"} if rows else {}})
            if route[-1] == "fork":
                value = dict(contract["fork"]["data"], id=FORK,
                             fork=dict(contract["fork"]["data"]["fork"], sessionID=session))
                data[FORK] = value
                write("INSERT INTO session_v2(id,title,directory,time_created,time_updated,slug,project_id,version) "
                      "SELECT ?,?,directory,time_created,time_updated,slug,project_id,version "
                      "FROM session_v2 WHERE id=?",
                      (FORK, value["title"], session))
                if switches.lose_fork:
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                return self.send_json(200, {"data": value})
            sid = route[-1]
            if sid not in data:
                return self.send_json(404, {"name": "SessionNotFoundError"})
            if self.command == "GET":
                return self.send_json(200, {"data": data[sid]})
            if self.command == "PATCH":
                if "title" in body and not switches.reject_rename:
                    data[sid]["title"] = body["title"]
                    write("UPDATE session_v2 SET title=?,time_updated=time_updated+1 WHERE id=?", (body["title"], sid))
                if "archived" in body:
                    if body["archived"]:
                        data[sid]["time"]["archived"] = 1795345168009
                    else:
                        data[sid]["time"].pop("archived", None)
                    write("UPDATE session_v2 SET time_archived=?,time_updated=time_updated+1 WHERE id=?",
                          (data[sid]["time"].get("archived"), sid))
            if self.command == "DELETE":
                switches.on_delete()
                for key in [sid, *[key for key, v in data.items() if v.get("parentID") == sid]]:
                    del data[key]
                    if not switches.retain_on_delete:
                        write("DELETE FROM session_v2 WHERE id=?", (key,))
            self.send_json(204, None)

        def send_json(self, code, body):
            self.send_response(code)
            self.end_headers()
            if body is not None:
                self.wfile.write(json.dumps(body).encode())

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server, closing(db.connect()) as conn:
        registration = {"url": f"http://127.0.0.1:{server.server_port}", "version": "2.3.2",
                        "pid": os.getpid(), "id": "fixture-generation", "password": "only-in-fixture-registration"}
        (state / "service.json").write_text(json.dumps(registration))
        (state / "service.json").chmod(0o600)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            def scan():
                return index.index_all(conn, root=str(tmp_path / "claude"))

            scan()
            yield SimpleNamespace(conn=conn, source=source, sid=session, child=child, empty=empty,
                                  seen=seen, scan=scan, data=data, cwd=cwd, argv_file=argv_file,
                                  switches=switches, reparent=reparent, write=write)
        finally:
            server.shutdown()
            thread.join()


def test_resume_cli_checks_current_db(native, capsys):
    args = SimpleNamespace(session_id=native.sid, no_refresh=True)
    assert cli.cmd_resume(native.conn, args) == cli.EXIT_OK
    command = json.loads(capsys.readouterr().out)["resume_command"]
    assert command.startswith("cd ") and native.sid in command and "--session" in command
    with closing(sqlite3.connect(native.source)) as source, source:
        source.execute("DELETE FROM session_v2 WHERE id=?", (native.sid,))
    assert cli.cmd_resume(native.conn, args) == cli.EXIT_NOT_FOUND
    assert "could not be confirmed" in capsys.readouterr().err


def test_open_code_zsh_argv_and_resume_refusal(native, tmp_path, monkeypatch):
    monkeypatch.setenv("OPENCODE_PASSWORD", "fixture-password")
    monkeypatch.setenv("OPENCODE_SERVER_PASSWORD", "fixture-alias")
    args_dir = tmp_path / "arguments"
    args_dir.mkdir()
    (args_dir / "opencode").write_text("--model 'example/one two' --fixture '$(literal)'\n")
    monkeypatch.setenv("OBS_AGENT_TERMINAL_ARGS_DIR", str(args_dir))
    monkeypatch.setenv("OBS_AGENT_TERMINAL_STATE_DIR", str(tmp_path / "registry"))
    monkeypatch.setenv("OBS_AGENT_TERMINAL_NO_SHELL", "1")
    monkeypatch.setenv("OBS_AGENT_ATLAS_PYTHON", sys.executable)
    monkeypatch.setenv("OBS_AGENT_OPENCODE_ATTEMPT", "b" * 32)
    argv = ["/bin/zsh", str(REPO / "obsidian-plugin/scripts/agent-resume-terminal.zsh"),
            "opencode", "opencode-fixture", "resume", native.sid]
    result = subprocess.run(argv, cwd=native.cwd, capture_output=True, text=True, timeout=10, check=False)
    assert json.loads(native.argv_file.read_text()) == [str(native.cwd), "--session", native.sid,
                                                       "--model", "example/one two", "--fixture", "$(literal)"]
    assert "only-in-fixture-registration" not in result.stdout + result.stderr
    marker = opencode_tabs.tab_dir() / "opencode-fixture.exited"
    assert marker.read_text() == "b" * 32
    marker.unlink()
    native.argv_file.unlink()
    with closing(sqlite3.connect(native.source)) as source, source:
        source.execute("DELETE FROM session_v2 WHERE id=?", (native.sid,))
    result = subprocess.run(argv, cwd=native.cwd, capture_output=True, text=True, timeout=10, check=False)
    assert not native.argv_file.exists()
    assert "could not be confirmed" in result.stderr
    assert marker.read_text() == "b" * 32


@pytest.mark.parametrize("key", sorted(opencode_service.PASSWORD_VARIABLES))
def test_shared_launcher_scrubs_login_shell_password_before_helpers(tmp_path, key):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "helpers"
    exports = " ".join(f"{name}=synthetic-password" for name in sorted(opencode_service.PASSWORD_VARIABLES))
    (tmp_path / ".zshrc").write_text(f'export {exports}\nexport PATH="{bin_dir}:$PATH"\n')
    for name, command in (("mkdir", "/bin/mkdir"), ("touch", "/usr/bin/touch"),
                          ("date", "/bin/date"), ("python", "/usr/bin/true")):
        helper = bin_dir / name
        helper.write_text(f'#!/bin/sh\nprintf "%s:%s\\n" {name} "${{{key}:+present}}" >> "$FIXTURE_LOG"\n'
                          f'exec {command} "$@"\n')
        helper.chmod(0o700)
    env = {"HOME": str(tmp_path), "ZDOTDIR": str(tmp_path), "PATH": f"{bin_dir}:/usr/bin:/bin",
           "OBS_AGENT_TERMINAL_STATE_DIR": str(tmp_path / "registry"), "OBS_AGENT_TERMINAL_NO_SHELL": "1",
           "OBS_AGENT_ATLAS_PYTHON": str(bin_dir / "python"), "FIXTURE_LOG": str(log)}
    subprocess.run(["/bin/zsh", "-lic", 'exec "$@"', "zsh", str(REPO / "obsidian-plugin/scripts/"
                    "agent-resume-terminal.zsh"), "opencode", "opencode-fixture"],
                   env=env, cwd=tmp_path, check=True, capture_output=True, timeout=10)
    seen = log.read_text().splitlines()
    assert {line.partition(":")[0] for line in seen} == {"mkdir", "touch", "date", "python"}
    assert all(line.endswith(":") for line in seen), seen


def test_rename_clears_override_only_after_read_back(native):
    native.conn.execute("INSERT INTO user_overrides(session_id,title,updated_at) VALUES (?,?,?)",
                        (native.sid, "Atlas override", "now"))
    native.conn.commit()

    def override():
        return native.conn.execute("SELECT title FROM user_overrides WHERE session_id=?", (native.sid,)).fetchone()[0]

    native.switches.reject_rename = True
    with pytest.raises(opencode_service.ServiceError, match="verify"):
        actions.rename(native.conn, native.sid, "Renamed")
    assert override() == "Atlas override"
    native.switches.reject_rename = False
    assert actions.rename(native.conn, native.sid, "Renamed")["written_to_transcript"]
    assert override() is None


@pytest.mark.parametrize("archived", [True, False])
def test_archive_is_projected_on_next_scan(native, archived):
    actions.archive(native.sid, not archived)
    native.scan()
    actions.archive(native.sid, archived)
    assert native.conn.execute("SELECT archived FROM opencode_details WHERE session_id=?",
                               (native.sid,)).fetchone()[0] != archived
    native.scan()
    assert native.conn.execute("SELECT archived FROM opencode_details WHERE session_id=?",
                               (native.sid,)).fetchone()[0] == archived


def test_delete_preview_and_revalidation(native):
    plan = actions.delete_preview(native.sid)
    assert [row["session_id"] for row in plan["children"]] == [native.child]
    assert plan["disabled_reason"] is None
    with pytest.raises(opencode_service.ServiceError) as wrong_children:
        actions.delete(native.sid, [])
    assert wrong_children.value.state == "children_changed"
    native.switches.active = {native.child: {"type": "running"}}
    assert "running" in actions.delete_preview(native.sid)["disabled_reason"]
    with pytest.raises(opencode_service.ServiceError, match="running"):
        actions.delete(native.sid, [native.child])
    assert not any(method == "DELETE" for method, *_ in native.seen)
    native.switches.active = {}
    assert actions.delete(native.sid, [native.child]) == {"deleted": True}
    native.scan()
    assert native.conn.execute("SELECT 1 FROM sessions WHERE session_id=?", (native.sid,)).fetchone() is None


def test_delete_refuses_session_reserved_for_resume(native):
    assert actions.delete_preview(native.sid)["disabled_reason"] is None
    opencode_tabs.prepare("opencode-test", "resume", native.sid, [], REPO / "obsidian-plugin/opencode-tab")
    _set_route(native.sid)
    with pytest.raises(opencode_service.ServiceError) as error:
        actions.delete(native.sid, [native.child])
    assert error.value.state == "open_tab"
    assert not any(method == "DELETE" for method, *_ in native.seen)


def test_delete_requires_db_absence_after_native_404(native):
    native.switches.retain_on_delete = True
    with pytest.raises(opencode_service.ServiceError, match="verify"):
        actions.delete(native.sid, [native.child])
    assert agent_opencode.session_directory(native.sid) == str(native.cwd)


def test_empty_fork_is_never_posted(native):
    with pytest.raises(opencode_service.ServiceError, match="empty"):
        actions.fork(native.conn, native.empty, TOKEN)
    assert not [entry for entry in native.seen if entry[0] == "POST"]


def test_fork_id_survives_launch_error(native):
    created = actions.fork(native.conn, native.sid, TOKEN)
    assert created["session_id"] == FORK
    stored = native.conn.execute("SELECT fork_id FROM opencode_fork_intents WHERE request_id=?", (TOKEN,)).fetchone()
    assert stored["fork_id"] == FORK
    assert actions.fork(native.conn, native.sid, TOKEN) == created
    assert len([entry for entry in native.seen if entry[0] == "POST"]) == 1


def test_retry_after_atlas_drops_committed_fork_response(native, monkeypatch):
    def drop_response(_status, _data):
        raise BrokenPipeError

    body = {"session_id": native.sid, "request_id": TOKEN}
    with pytest.raises(BrokenPipeError):
        server.Handler._opencode_fork(SimpleNamespace(_json=drop_response), native.conn, body)
    assert native.conn.execute("SELECT fork_id FROM opencode_fork_intents WHERE request_id=?",
                               (TOKEN,)).fetchone()["fork_id"] == FORK
    monkeypatch.setattr(server, "catch_up", lambda **_: None)
    responses = []
    server.Handler._opencode_fork(SimpleNamespace(_json=lambda *args: responses.append(args)), native.conn, body)
    assert responses[0][0] == 200
    assert responses[0][1]["session_id"] == FORK
    assert sum(method == "POST" and route.endswith("/fork") for method, route, _ in native.seen) == 1


def test_ambiguous_fork_lists_and_never_posts_twice(native):
    native.switches.lose_fork = True
    native.switches.conceal_fork = True
    assert actions.fork(native.conn, native.sid, TOKEN)["status"] == "unknown"
    native.switches.conceal_fork = False
    result = actions.fork(native.conn, native.sid, "fixture-request-002")
    assert result["status"] == "unknown"
    assert [item["session_id"] for item in result["candidates"]] == [FORK]
    assert actions.fork(native.conn, native.sid, TOKEN)["status"] == "unknown"
    assert len([entry for entry in native.seen if entry[0] == "POST"]) == 1


def test_tracking_config_preserves_plugins_and_inline_options(tmp_path, monkeypatch):
    root = tmp_path / "config"
    config = root / "opencode"
    config.mkdir(parents=True)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(root))
    original = """{
      // User CLI plugin options and relative target
      "plugins": ["-opencode.feature.*", {"package":"./local", "options":{"url":"file:///kept"}},],
      "tabs": {"mode":"on"},
    }"""
    file = config / "cli.json"
    file.write_text(original)
    package = REPO / "obsidian-plugin/opencode-tab"
    record = {"nonce": "abc", "pid": 12, "last": FORK}
    inline = {"tabs": {"mode": "auto"}, "other": "keep"}
    env = {opencode_tabs.INLINE: json.dumps(inline)}
    result = opencode_tabs.tracking_env(package, tmp_path / "route", record, env)
    merged = json.loads(result[opencode_tabs.INLINE])
    assert merged["plugins"][:2] == [
        "-opencode.feature.*", {"package": "./local", "options": {"url": "file:///kept"}},
    ]
    assert merged["plugins"][2]["package"] == package.as_uri()
    assert merged["plugins"][2]["options"]["last"] == FORK
    assert merged["tabs"]["mode"] == "off"
    assert merged["other"] == "keep"
    assert file.read_text() == original
    file.write_text("{ cannot decode")
    assert opencode_tabs.tracking_env(package, tmp_path / "route", record, env) is env


def test_open_code_route_restore_follows_last_even_from_home(native):
    instance = "opencode-track"
    package = REPO / "obsidian-plugin/opencode-tab"
    _, argv, _ = opencode_tabs.prepare(instance, "resume", native.sid, [], package)
    assert argv[-1] == native.sid
    file = opencode_tabs.tab_dir() / (instance + ".json")
    launch = json.loads(file.read_text())
    route = file.with_name(f"{file.stem}.{launch['nonce']}.route")
    route.write_text(json.dumps({"nonce": launch["nonce"], "pid": os.getpid(),
                                 "current": None, "last": native.empty, "route": "home"}))
    assert opencode_tabs.tab_record(file)["current"] is None
    assert opencode_tabs.tab_record(file)["last"] == native.empty
    _, argv, _ = opencode_tabs.prepare(instance, "resume", native.sid, [], package)
    assert argv[-1] == native.empty


def test_archive_handler_reads_the_database_before_returning(native, monkeypatch):
    from atlas import server

    response = []
    respond = SimpleNamespace(_json=lambda status, data: response.append((status, data)))
    monkeypatch.setattr(server, "catch_up", lambda **_kwargs: False)
    server.Handler._opencode_archive(respond, native.conn, {"session_id": native.sid, "archived": True})
    assert response == [(200, {"archived": True})]
    assert native.conn.execute("SELECT archived FROM opencode_details WHERE session_id=?",
                               (native.sid,)).fetchone()[0] == 1


@pytest.mark.parametrize("operation", ["rename", "archive", "fork", "delete", "resume"])
@pytest.mark.parametrize("known", [True, False])
def test_native_action_requires_matching_database(native, tmp_path, operation, known):
    other = tmp_path / "other.db"
    shutil.copyfile(native.source, other)
    native.switches.database = str(other) if known else None
    calls = {
        "rename": lambda: actions.rename(native.conn, native.sid, "Wrong profile"),
        "archive": lambda: actions.archive(native.sid, True),
        "fork": lambda: actions.fork(native.conn, native.sid, TOKEN),
        "delete": lambda: actions.delete(native.sid, [native.child]),
        "resume": lambda: opencode_tabs.prepare("opencode-test", "resume", native.sid, [], Path("/missing")),
    }
    with pytest.raises(opencode_service.ServiceError) as error:
        calls[operation]()
    assert error.value.state == "profile"
    if known:
        assert str(other) in str(error.value)
    assert not any(method in {"POST", "PATCH", "DELETE"} for method, *_ in native.seen)


@pytest.mark.parametrize("route_state", ["fallback", "first_route", "expired"])
def test_unknown_live_tab_blocks_every_delete_but_allows_rename_and_archive(native, route_state):
    package = Path("/missing") if route_state == "fallback" else REPO / "obsidian-plugin/opencode-tab"
    mode = "new" if route_state == "first_route" else "resume"
    opencode_tabs.prepare("opencode-test", mode, native.sid, [], package)
    if route_state == "expired":
        _set_route(native.sid, at=1)
    assert "current session" in actions.delete_preview(native.empty)["disabled_reason"]
    with pytest.raises(opencode_service.ServiceError) as error:
        actions.delete(native.empty, [])
    assert error.value.state == "unknown_tab"
    actions.archive(native.empty, True)
    actions.rename(native.conn, native.empty, "Still allowed")


def _set_route(sid, *, at=None, route="session"):
    file = opencode_tabs.tab_dir() / "opencode-test.json"
    launch = json.loads(file.read_text())
    file.with_name(f"{file.stem}.{launch['nonce']}.route").write_text(json.dumps({
        "pid": launch["pid"], "nonce": launch["nonce"], "current": sid,
        "route": route, "at": time.time() * 1000 if at is None else at,
    }))


def test_verified_home_does_not_block_unrelated_delete(native):
    opencode_tabs.prepare("opencode-test", "resume", native.sid, [], REPO / "obsidian-plugin/opencode-tab")
    _set_route(None, route="home")
    assert actions.delete(native.empty, [])["deleted"]


def test_final_delete_snapshot_sees_child_added_during_active_check(native):
    native.switches.on_active = lambda: native.reparent(native.empty, native.sid)
    with pytest.raises(opencode_service.ServiceError) as error:
        actions.delete(native.sid, [native.child])
    assert error.value.state == "children_changed"
    assert not any(method == "DELETE" for method, *_ in native.seen)


def test_delete_reports_unconfirmed_session_that_disappeared(native):
    native.switches.on_delete = lambda: native.reparent(native.empty, native.sid)
    result = actions.delete(native.sid, [native.child])
    assert {item["session_id"] for item in result["extra_deleted"]} == {native.empty}


def test_resume_id_disappears_during_service_startup(native, monkeypatch):
    ensure = opencode_service.ensure

    def start():
        native.write("DELETE FROM session_v2 WHERE id=?", (native.sid,))
        return ensure()

    monkeypatch.setattr(opencode_service, "ensure", start)
    with pytest.raises(opencode_service.ServiceError) as error:
        opencode_tabs.prepare("opencode-test", "resume", native.sid, [], Path("/missing"))
    assert error.value.state == "session_missing"
    assert not (opencode_tabs.tab_dir() / "opencode-test.json").exists()


def test_expired_unsent_fork_requires_explicit_confirmation(native):
    with native.conn:
        native.conn.execute("INSERT INTO opencode_fork_intents(request_id,source_id,baseline,state,started_at) "
                            "VALUES (?,?,?,'pending',?)", (TOKEN, native.sid, "[]", time.time()))
    with pytest.raises(opencode_service.ServiceError) as error:
        actions.fork(native.conn, native.sid, "fixture-request-002")
    assert error.value.state == "fork_pending"
    with native.conn:
        native.conn.execute("UPDATE opencode_fork_intents SET started_at=0 WHERE request_id=?", (TOKEN,))
    result = actions.fork(native.conn, native.sid, "fixture-request-002")
    assert result["status"] == "unknown"
    assert result["candidates"] == []
    assert not [entry for entry in native.seen if entry[0] == "POST"]
    created = actions.fork(native.conn, native.sid, "fixture-request-002", confirm_unknown=TOKEN)
    assert created["session_id"] == FORK
    assert actions.fork(native.conn, native.sid, TOKEN)["status"] == "unknown"
    stale = actions.fork(native.conn, native.sid, "fixture-request-003", confirm_unknown=TOKEN)
    assert stale["status"] == "unknown" and stale["confirmation_id"] is None
    assert len([entry for entry in native.seen if entry[0] == "POST"]) == 1


def test_verified_nondefault_database_and_symlink_are_allowed(native, tmp_path, monkeypatch):
    data = tmp_path / "custom"
    data.mkdir()
    actual = data / native.source.name
    native.source.rename(actual)
    alias = tmp_path / "alias.db"
    alias.symlink_to(actual)
    native.switches.database = str(alias)
    monkeypatch.setenv("ATLAS_OPENCODE_HOME", str(data))
    plan = actions.delete_preview(native.sid)
    assert plan["database"] == str(actual.resolve())
    assert plan["disabled_reason"] is None


def test_resume_environment_scrubs_both_passwords(native, monkeypatch):
    monkeypatch.setenv("OPENCODE_PASSWORD", "fixture-password")
    monkeypatch.setenv("OPENCODE_SERVER_PASSWORD", "fixture-alias")
    _, _, env = opencode_tabs.prepare("opencode-test", "resume", native.sid, [], Path("/missing"))
    assert "OPENCODE_PASSWORD" not in env
    assert "OPENCODE_SERVER_PASSWORD" not in env


def test_delete_aborts_on_service_change_during_active_check(native):
    def replace_registration():
        path = opencode_service.registration_path()
        row = json.loads(path.read_text())
        row["id"] = "replacement-generation"
        path.write_text(json.dumps(row))

    native.switches.on_active = replace_registration
    with pytest.raises(opencode_service.ServiceError) as error:
        actions.delete(native.sid, [native.child])
    assert error.value.state == "service_changed"
    assert not any(method == "DELETE" for method, *_ in native.seen)


def test_only_matching_exit_marker_exempts_a_layout_tab():
    folder = opencode_tabs.tab_dir()
    folder.mkdir()
    instance = "opencode-test"
    attempt = "a" * 32
    (folder / "layout-test.json").write_text(json.dumps({
        "pid": os.getpid(), "tabs": [{"instance": instance, "attempt": attempt, "launching": True}],
    }))
    marker = folder / (instance + ".exited")
    assert opencode_tabs.open_tabs() == (set(), True)
    marker.write_text("b" * 32)
    assert opencode_tabs.open_tabs() == (set(), True)
    marker.write_text(attempt)
    assert opencode_tabs.open_tabs() == (set(), False)

def test_deferred_leaf_allows_delete_until_an_attempt_starts(native):
    folder = opencode_tabs.tab_dir()
    folder.mkdir()
    layout = folder / "layout-test.json"
    instance = "opencode-deferred"

    def write_layout(**entry):
        layout.write_text(json.dumps({"pid": os.getpid(), "tabs": [{"instance": instance, **entry}]}))

    write_layout(exited=False)
    assert opencode_tabs.open_tabs() == (set(), False)
    assert actions.delete_preview(native.empty)["disabled_reason"] is None
    write_layout(attempt="a" * 32, launching=True)
    assert opencode_tabs.open_tabs() == (set(), True)
    write_layout(attempt="a" * 32, launching=True, exited=True)
    assert opencode_tabs.open_tabs() == (set(), False)
    assert actions.delete(native.empty, []) == {"deleted": True}


def test_unrouted_launch_expires_only_when_no_opencode_remains(native):
    folder = opencode_tabs.tab_dir()
    folder.mkdir()
    layout = folder / "layout-test.json"
    now = int(time.time() * 1000)
    # Keep the wrapper alive after its child exits, as with the PTY's waiting input pipe.
    with subprocess.Popen(["/bin/bash", "-c", '(exec -a opencode2 /bin/sleep 30) & echo $!; read stop'],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as wrapper:
        pid = int(wrapper.stdout.readline())

        def write_layout(started_at):
            entry = {"instance": "opencode-starting", "attempt": "a" * 32, "launching": True,
                     "startedAt": started_at, "ptyPid": wrapper.pid}
            layout.write_text(json.dumps({"pid": os.getpid(), "tabs": [entry]}))

        try:
            write_layout(now)
            assert actions.delete_eligibility(native.empty)["disabled_reason"]
            write_layout(now - 121_000)
            assert actions.delete_eligibility(native.empty)["disabled_reason"]
        finally:
            os.kill(pid, 15)
            # The wrapper reaps the child and keeps waiting on stdin.
            for _ in range(100):
                if not opencode_tabs._alive({"pid": pid}):
                    break
                time.sleep(0.02)
            assert not opencode_tabs._alive({"pid": pid})
        assert wrapper.poll() is None
        write_layout(now)
        assert actions.delete_eligibility(native.empty)["disabled_reason"]
        write_layout(now - 121_000)
        assert actions.delete_eligibility(native.empty)["disabled_reason"] is None
        wrapper.stdin.close()


@contextmanager
def file_probe(*paths, address="127.0.0.1", registered=None):
    file = opencode_service.registration_path()
    original = file.read_text()
    registration = json.loads(original)
    script = FIXTURES / "file-probe.py"
    with subprocess.Popen([sys.executable, str(script)], cwd=REPO, stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, text=True) as process:
        try:
            process.stdin.write(json.dumps({"url": registration["url"], "paths": list(map(str, paths)),
                                            "address": address}) + "\n")
            process.stdin.close()
            port = int(process.stdout.readline())
            host = registered or address
            host = f"[{host}]" if ":" in host else host
            file.write_text(json.dumps(dict(registration, url=f"http://{host}:{port}", pid=process.pid)))
            yield
        finally:
            process.terminate()
            file.write_text(original)


@pytest.mark.parametrize("directory", ["Каталог", "line\nbreak"])
def test_native_232_database_identity_survives_escaped_paths(native, monkeypatch, tmp_path, directory):
    catalog = tmp_path / directory
    catalog.mkdir()
    database = catalog / native.source.name
    native.source.rename(database)
    native.source.symlink_to(database)  # The stub writes through its original path.
    alias = tmp_path / "alias"
    alias.symlink_to(catalog, target_is_directory=True)
    other = tmp_path / "other.db"
    shutil.copyfile(database, other)
    native.switches.database = None
    monkeypatch.setenv("ATLAS_OPENCODE_HOME", str(alias))
    monkeypatch.setenv("LC_ALL", "C")
    for paths in ((), (other,), (database, other)):
        with file_probe(*paths), pytest.raises(opencode_service.ServiceError, match="database"):
            actions.archive(native.sid, True)
    assert not any(method == "PATCH" for method, *_ in native.seen)
    with file_probe(database):
        assert actions.archive(native.sid, True) == {"archived": True}
    with closing(sqlite3.connect(database)) as conn:
        assert conn.execute("SELECT time_archived FROM session_v2 WHERE id=?", (native.sid,)).fetchone()[0]


@pytest.mark.parametrize("wrong_pid", [True, False])
def test_passive_delete_refuses_unverified_listener_or_profile(native, tmp_path, wrong_pid):
    other = tmp_path / "other.db"
    shutil.copyfile(native.source, other)
    native.switches.database = None
    native.seen.clear()
    with file_probe(native.source if wrong_pid else other):
        if wrong_pid:
            file = opencode_service.registration_path()
            record = json.loads(file.read_text())
            file.write_text(json.dumps(dict(record, pid=os.getppid())))
        with pytest.raises(opencode_service.ServiceError) as error:
            actions.delete_eligibility(native.sid)
    assert error.value.state == ("unauthorized" if wrong_pid else "profile")
    assert native.seen == ([] if wrong_pid else [("GET", "/api/info", None)])


def test_passive_delete_rechecks_listener_for_active_request(native, monkeypatch):
    monkeypatch.setattr(opencode_service, "_listener_pids", lambda *_: {os.getppid()})
    with pytest.raises(opencode_service.ServiceError) as error:
        actions.delete_eligibility(native.empty)
    assert error.value.state == "unauthorized"
    assert native.seen == [("GET", "/api/info", None)]


def test_passive_delete_accepts_explicit_database_without_wal(native):
    assert not native.source.with_name(native.source.name + "-wal").exists()
    assert actions.delete_preview(native.empty)["disabled_reason"] is None
    assert actions.delete_eligibility(native.empty)["disabled_reason"] is None


def test_passive_delete_prefers_explicit_database_to_detected_wal(native, tmp_path):
    other = tmp_path / "other.db"
    shutil.copyfile(native.source, other)
    native.switches.database = str(other)
    with file_probe(native.source):
        for check in (actions.delete_preview, actions.delete_eligibility):
            with pytest.raises(opencode_service.ServiceError) as error:
                check(native.empty)
            assert error.value.state == "profile"
    assert all(route == "/api/info" for _, route, _ in native.seen)


def test_passive_delete_accepts_expanded_ipv6_listener(native):
    with socket.socket(socket.AF_INET6) as probe:
        try:
            probe.bind(("::1", 0))
        except OSError:
            pytest.skip("IPv6 loopback unavailable")
    native.switches.database = None
    with file_probe(native.source, address="::1", registered="0:0:0:0:0:0:0:1"):
        assert actions.delete_preview(native.empty)["disabled_reason"] is None
        assert actions.delete_eligibility(native.empty)["disabled_reason"] is None


def test_database_matches_main_and_wal_by_device_and_inode(tmp_path):
    source = tmp_path / "opencode.db"
    wal = source.with_name(source.name + "-wal")
    source.touch()
    wal.touch()
    main_stat, wal_stat = source.stat(), wal.stat()

    def fields(file, device, inode):
        return [b"f3", b"tREG", b"D" + hex(device).encode(), b"i" + str(inode).encode(), b"n" + os.fsencode(file)]

    main = fields(source, main_stat.st_dev, main_stat.st_ino)
    journal = fields(wal, wal_stat.st_dev, wal_stat.st_ino)
    matches = opencode_service._matches_database
    assert matches([main, journal], source)
    assert not matches([fields(source, main_stat.st_dev + 1, main_stat.st_ino), journal], source)
    assert not matches([main, fields(wal, wal_stat.st_dev + 1, wal_stat.st_ino)], source)
    assert not matches([main, fields(wal, wal_stat.st_dev, wal_stat.st_ino + 1)], source)


def test_passive_delete_checks_identity_and_activity_without_walking_children(native, monkeypatch):
    for number in range(12):
        child = f"ses_{number:026x}"
        native.data[child] = dict(native.data[native.child], id=child)
    seen = []
    lsof = opencode_service._lsof

    def timed_lsof(*args):
        start = time.monotonic()
        try:
            return lsof(*args)
        finally:
            seen.append(time.monotonic() - start)

    monkeypatch.setattr(opencode_service, "_lsof", timed_lsof)
    native.switches.database = None
    response = []
    respond = SimpleNamespace(_json=lambda status, data: response.append((status, data)))
    native.switches.active = {native.sid: {}}
    native.seen.clear()
    with file_probe(native.source):
        start = time.monotonic()
        server.Handler._delete_preview(respond, native.conn, {"session_id": native.sid, "passive": True})
        elapsed = time.monotonic() - start
        assert response[0][0] == 200
        assert "running" in response[0][1]["disabled_reason"]
        assert native.seen == [("GET", "/api/info", None), ("GET", "/api/session/active", None)]
        assert len(seen) == 3  # Discovery peer, listener and profile, active read peer.
        print(f"13 descendants: {len(seen)} lsof subprocesses, {sum(seen):.3f}s in lsof, "
              f"{elapsed:.3f}s poll wall time")
        seen.clear()
        native.seen.clear()
        plan = actions.delete_preview(native.sid)
        assert len(plan["children"]) == 13
        assert len(seen) == 19  # Full-profile lsof, discovery and per-request peer checks.
