import base64
import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock

import pytest

from atlas import opencode_service as oc


@pytest.fixture
def service(tmp_path, monkeypatch, request):
    state = tmp_path / "state"
    monkeypatch.setenv("XDG_STATE_HOME", str(state))
    monkeypatch.setenv("ATLAS_OPENCODE_BIN", "/fixture/opencode")
    registry = state / "opencode/service.json"
    registry.parent.mkdir(parents=True)
    requests = []
    reply = Mock(return_value=(200, {"version": "2.3.2", "pid": os.getpid()}))
    password = "synthetic-secret"

    class Handler(BaseHTTPRequestHandler):
        protocol_version = getattr(request, "param", "HTTP/1.0")

        def log_message(self, *_args):
            pass

        def do_GET(self):
            requests.append((self.path, self.headers.get("Authorization")))
            code, body = reply(self.path)
            if callable(body):
                body(self)
                return
            payload = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Length", str(len(payload)))
            if code == 302:
                self.send_header("Location", "/escaped")
            self.end_headers()
            self.wfile.write(payload)

        do_POST = do_GET

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        url = f"http://127.0.0.1:{server.server_port}"
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()

        def register(**overrides):
            values = {"url": url, "id": "fixture-generation", "pid": os.getpid(),
                      "version": "2.3.2", "password": password}
            registry.write_text(json.dumps(dict(values, **overrides)))
            registry.chmod(0o600)

        yield registry, register, requests, reply, password
        server.shutdown()
        worker.join()


def test_discovery_states(service, monkeypatch):
    _, register, requests, reply, password = service
    assert oc.discover().state == "stopped"
    monkeypatch.setenv("ATLAS_OPENCODE_BIN", "")
    assert oc.discover().state == "not_installed"
    monkeypatch.setenv("ATLAS_OPENCODE_BIN", "/fixture/opencode")
    register()
    monkeypatch.setenv("http_proxy", "http://127.0.0.1:1")
    monkeypatch.setenv("no_proxy", "")
    ready = oc.discover()
    assert ready.state == "ready"
    assert password not in repr(ready)
    assert requests == [("/api/info", "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode())]
    reply.return_value = (401, {"message": password})
    assert oc.discover().state == "unauthorized"
    reply.return_value = (200, {"version": "2.3.2", "pid": os.getpid() + 1})
    assert oc.discover().state == "unauthorized"
    register(version="2.4.0")
    reply.return_value = (200, {"version": "2.4.0", "pid": os.getpid()})
    assert oc.discover().state == "version_warning"
    assert oc.discover(starting=True).state == "version_warning"


@pytest.mark.parametrize("url", [
    "http://localhost:1234", "http://192.0.2.1:1234", "https://127.0.0.1:1234",
    "http://127.0.0.1:1234/api", "http://127.0.0.1:1234?foo", "http://user@127.0.0.1:1234",
    "http://127.1:1234", "http://127.0.0.1", "http://[::]:1234",
])
def test_registration_refuses_nonliteral_endpoint(service, url, monkeypatch):
    _, register, requests, _, _ = service
    register(url=url)
    call = Mock(return_value={"version": "2.3.2", "pid": os.getpid()})
    monkeypatch.setattr(oc, "_call", call)
    assert oc.discover().state == "unauthorized"
    call.assert_not_called()
    assert not requests


@pytest.mark.parametrize("invalid", ["mode", "owner", "size", "symlink", "fifo"])
def test_registration_file_checks(service, monkeypatch, invalid):
    registry, register, requests, _, _ = service
    register()
    if invalid == "mode":
        registry.chmod(0o640)
    elif invalid == "owner":
        uid = os.getuid()
        monkeypatch.setattr(oc.os, "getuid", lambda: uid + 1)
    elif invalid == "size":
        registry.write_bytes(b"x" * 20000)
    elif invalid == "symlink":
        real = registry.rename(registry.with_suffix(".real"))
        registry.symlink_to(real)
    else:
        registry.unlink()
        os.mkfifo(registry, 0o600)
    assert oc.discover().state == "unauthorized"
    assert not requests


def test_redirect_cannot_forward_header(service, capsys):
    _, register, requests, reply, password = service
    register()
    reply.return_value = (302, {"secret": password})
    assert oc.discover().state == "unauthorized"
    assert [path for path, _ in requests] == ["/api/info"]
    assert password not in str(capsys.readouterr())


def test_start_only_when_needed_and_without_credentials(service, monkeypatch, capsys):
    _, register, _, reply, password = service
    assert oc.discover(starting=True).state == "starting"

    def run(argv, **kwargs):
        assert "OPENCODE_PASSWORD" not in kwargs["env"]
        assert "OPENCODE_SERVER_PASSWORD" not in kwargs["env"]
        if argv == ["/fixture/opencode", "--version"]:
            return Mock(returncode=0, stdout="opencode v2.3.2")
        assert argv == ["/fixture/opencode", "service", "start"]
        assert password not in str(argv)
        assert "OPENCODE_PASSWORD" not in kwargs["env"]
        register()
        return Mock(returncode=0)

    monkeypatch.setenv("OPENCODE_PASSWORD", password)
    monkeypatch.setenv("OPENCODE_SERVER_PASSWORD", password)
    monkeypatch.setattr(oc, "_check_peer", lambda *_: None)
    start = Mock(side_effect=run)
    monkeypatch.setattr(oc.subprocess, "run", start)
    assert oc.discover().state == "stopped"
    start.assert_not_called()
    assert oc.ensure().state == "ready"
    assert oc.ensure().state == "ready"
    assert start.call_count == 2
    reply.return_value = (401, {"message": password})
    with pytest.raises(oc.ServiceError) as failure:
        oc.ensure()
    assert failure.value.state == "unauthorized"
    assert password not in str(failure.value) + str(capsys.readouterr())


def test_client_aborts_when_registration_rotates(service):
    _, register, requests, reply, password = service
    register()
    client = oc.Client(oc.discover())
    new_password = "new-fixture-secret"
    changed = False

    def probe(path):
        nonlocal changed
        if path == "/api/info":
            return 200, {"pid": os.getpid(), "version": "2.3.2"}
        if not changed:
            changed = True
            register(password=new_password)
            return 401, {}
        return 200, {"data": {}}

    reply.side_effect = probe
    with pytest.raises(oc.ServiceError) as error:
        client.data("session/active")
    assert error.value.state == "service_changed"
    assert [path for path, _ in requests] == ["/api/info", "/api/session/active"]
    assert all(base64.b64decode(sent.split()[1]).decode() == "opencode:" + password for _, sent in requests)


def test_same_listener_replacement_generation_aborts_before_write(service):
    _, register, requests, _, _ = service
    register()
    client = oc.Client(oc.discover())
    register(id="different-generation")
    with pytest.raises(oc.ServiceError) as error:
        client.call("DELETE", "session/target")
    assert error.value.state == "service_changed"
    assert [path for path, _ in requests] == ["/api/info"]


def test_registration_cannot_send_credentials_to_wrong_listener(service):
    _, register, requests, reply, _ = service
    foreign_pid = os.getpid() + 1
    register(pid=foreign_pid)
    reply.return_value = (200, {"pid": foreign_pid, "version": "2.3.2"})
    assert oc.discover().state == "unauthorized"
    assert not requests


@pytest.mark.parametrize("service", ["HTTP/1.1"], indirect=True)
@pytest.mark.parametrize("warm", [False, True])
def test_verified_discovery_checks_connected_peer_before_sending_credentials(service, monkeypatch, warm):
    from atlas import opencode_live

    registry, register, requests, reply, _ = service
    database = registry.parent / "fixture.db"
    database.touch()
    register()
    reply.return_value = (200, {"version": "2.3.2", "pid": os.getpid(), "paths": {"database": str(database)},
                               "data": {}})
    live = opencode_live.LiveService()
    if warm:
        assert live.active(database) is None
        live._verification.result(timeout=3)
        assert live.active(database) == set()
        live.checked -= opencode_live.IDENTITY_TTL
    requests.clear()
    monkeypatch.setattr(oc, "_listener_pid", lambda *_: os.getpid())
    monkeypatch.setattr(oc, "_lsof", lambda *args, **kwargs: b"")
    try:
        assert live.active(database) is None
        assert live._verification.result(timeout=3)[1] is None
        assert requests == []
    finally:
        live.close_poll()


def test_native_mutation_checks_its_connected_peer_before_sending_credentials(service, monkeypatch):
    _, register, requests, _, _ = service
    register()
    client = oc.Client(oc.discover())
    monkeypatch.setattr(oc, "_listener_pid", lambda *_: os.getpid())
    monkeypatch.setattr(oc, "_lsof", lambda *_: b"")
    with pytest.raises(oc.ServiceError) as error:
        client.call("POST", "session/fixture/interrupt")
    assert error.value.state == "unauthorized" and not error.value.dispatched
    assert [path for path, _ in requests] == ["/api/info"]


def test_peer_check_waits_briefly_for_the_same_connection_to_be_accepted(service, monkeypatch):
    _, register, requests, _, _ = service
    register()
    lsof = oc._lsof
    attempts = 0

    def sample(*args):
        nonlocal attempts
        assert not requests
        attempts += 1
        return b"" if attempts == 1 else lsof(*args)

    monkeypatch.setattr(oc, "_lsof", sample)
    assert oc.discover().state == "ready"
    assert attempts >= 2
    assert [path for path, _ in requests] == ["/api/info"]


def test_missing_lsof_refuses_service_actions(service, monkeypatch):
    _, register, requests, _, _ = service
    register()
    monkeypatch.setattr(oc.shutil, "which", lambda _name: None)
    with pytest.raises(oc.ServiceError, match="lsof"):
        oc.ensure()
    assert not requests


def test_v1_is_refused_before_managed_start(service, monkeypatch):
    start = Mock(return_value=Mock(returncode=0, stdout="1.19.4"))
    monkeypatch.setattr(oc.subprocess, "run", start)
    with pytest.raises(oc.ServiceError) as error:
        oc.ensure()
    assert error.value.state == "v1"
    assert start.call_args.args[0] == ["/fixture/opencode", "--version"]
    start.assert_called_once()


@pytest.mark.parametrize("service,checks", [("HTTP/1.0", 2), ("HTTP/1.1", 1)], indirect=["service"])
def test_poll_checks_each_new_connection(service, checks, monkeypatch):
    _, register, requests, reply, _ = service
    register()
    client = oc.Client(oc.discover())
    peer_check = Mock(wraps=oc._check_peer)
    monkeypatch.setattr(oc, "_check_peer", peer_check)
    reply.return_value = (200, {"data": {}})
    try:
        assert client.poll("session/active") == {}
        assert client.poll("session/active") == {}
    finally:
        client.close_poll()
    assert peer_check.call_count == checks
    assert [route for route, _ in requests] == ["/api/info", "/api/session/active", "/api/session/active"]


@pytest.mark.parametrize("service", ["HTTP/1.1"], indirect=True)
def test_poll_reconnects_after_keep_alive_socket_closes(service, monkeypatch):
    _, register, requests, reply, _ = service
    register()
    client = oc.Client(oc.discover())
    peer_check = Mock(wraps=oc._check_peer)
    monkeypatch.setattr(oc, "_check_peer", peer_check)
    reply.return_value = (200, {"data": {}})
    try:
        assert client.poll("session/active") == {}
        client._poll_connection.sock.shutdown(socket.SHUT_RDWR)
        assert client.poll("session/active") == {}
    finally:
        client.close_poll()
    assert peer_check.call_count == 2
    assert [route for route, _ in requests] == ["/api/info", "/api/session/active", "/api/session/active"]


@pytest.mark.parametrize("service", ["HTTP/1.1"], indirect=True)
def test_background_verification_caps_peer_lookup_and_retries(service, tmp_path, monkeypatch):
    from atlas import opencode_live

    _, register, requests, reply, _ = service
    database = tmp_path / "opencode.db"
    database.touch()
    register()
    identity = {"version": "2.3.2", "pid": os.getpid(), "paths": {"database": str(database)}}
    reply.side_effect = lambda route: (200, identity if route == "/api/info" else {"data": {}})
    run = oc.subprocess.run
    timeouts = []

    def slow_lookup(argv, *, timeout, **kwargs):
        timeouts.append(timeout)
        assert 0 < timeout < 2
        raise oc.subprocess.TimeoutExpired(argv, timeout)

    cache = opencode_live.LiveService()
    monkeypatch.setattr(oc.subprocess, "run", slow_lookup)
    assert cache.active(database) is None
    assert cache._verification.result(timeout=3)[1] is None
    assert len(timeouts) == 1
    assert requests == []

    monkeypatch.setattr(oc.subprocess, "run", run)
    try:
        assert cache.active(database) is None
        cache._verification.result(timeout=3)
        assert cache.active(database) == set()
    finally:
        cache.close_poll()


@pytest.mark.parametrize("service", ["HTTP/1.1"], indirect=True)
def test_active_pass_caps_slow_http_reads_including_a_warm_connection(service, tmp_path, monkeypatch):
    from atlas import db, opencode_live, opencode_tabs

    _, register, _, reply, _ = service
    database = tmp_path / "opencode.db"
    database.touch()
    register()
    sid = "ses_" + "a" * 26
    identity = {"version": "2.3.2", "pid": os.getpid(), "paths": {"database": str(database)}}
    slow = False
    tabs = {"ses_" + f"{n:026d}": n + 10 for n in range(30)}
    tabs[sid] = 123

    def half_response(handler):
        handler.send_response(200)
        handler.send_header("Content-Length", "11")
        handler.end_headers()
        handler.wfile.write(b'{"data":')
        time.sleep(0.5)

    def response(route):
        if route == "/api/info":
            return 200, identity
        if route == "/api/session/active":
            return 200, {"data": {sid: {"type": "running"}}}
        return 200, half_response if slow else {"data": []}

    reply.side_effect = response
    monkeypatch.setenv("ATLAS_OPENCODE_HOME", str(tmp_path))
    monkeypatch.setattr(opencode_tabs, "active_tabs", lambda _table: tabs)
    cache = opencode_live.LiveService()
    with db.connect() as catalog:
        assert cache.active(database) is None
        cache._verification.result(timeout=3)
        assert cache.active(database) == {sid}
        slow = True
        start = time.monotonic()
        cards = opencode_live.list_live(catalog, {}, cache)
        assert time.monotonic() - start < 0.3
        assert not cache.available
        assert len(cards) == 31
        assert all(card["opencode_running"] is None for card in cards)
    cache.close_poll()


def test_native_prompt_preserves_recorded_error_body_for_classification(service):
    _, register, _, reply, _ = service
    register()
    client = oc.Client(oc.discover())
    body = {"_tag": "InvalidRequestError", "kind": "Payload", "message": "Expected string"}
    reply.return_value = (400, body)
    with pytest.raises(oc.ServiceError) as error:
        client.call("POST", "session/fixture/prompt", {"text": 123})
    assert error.value.dispatched and error.value.status == 400 and error.value.error_body == body


def test_recursive_json_is_a_request_failure(service):
    _, register, _, reply, _ = service
    register()
    client = oc.Client(oc.discover())
    reply.return_value = (200, b"[" * 1100 + b"]" * 1100)
    with pytest.raises(oc.ServiceError) as exc:
        client.data("session/active")
    assert exc.value.state == "request_failed"


@pytest.mark.parametrize("service", ["HTTP/1.1"], indirect=True)
def test_discovery_closes_the_connection_after_invalid_json(service, monkeypatch):
    _, register, _, reply, _ = service
    register()
    reply.return_value = (200, b"{")
    original = oc.http.client.HTTPConnection
    connections = []

    def connect(*args, **kwargs):
        conn = original(*args, **kwargs)
        connections.append(conn)
        return conn

    monkeypatch.setattr(oc.http.client, "HTTPConnection", connect)
    try:
        assert oc.discover(budget=oc.PollBudget(2, 2)).state == "unauthorized"
        assert len(connections) == 1
        assert connections[0].sock is None
    finally:
        for conn in connections:
            conn.close()


def test_active_peer_budget_defaults_to_150ms(monkeypatch):
    monkeypatch.setattr(oc.time, "monotonic", lambda: 1.0)
    budget = oc.PollBudget()
    with budget.peer_time() as seconds:
        assert seconds == pytest.approx(0.150)


@pytest.mark.parametrize("service", ["HTTP/1.1"], indirect=True)
def test_warm_active_reuses_socket_after_503_and_reverifies_after_close(service, tmp_path):
    from atlas import opencode_live

    _, register, requests, reply, _ = service
    database = tmp_path / "opencode.db"
    database.touch()
    register()
    identity = {"version": "2.3.2", "pid": os.getpid(), "paths": {"database": str(database)}}
    code = 200
    reply.side_effect = lambda route: (200, identity) if route == "/api/info" else (code, {"data": {}})
    cache = opencode_live.LiveService()
    try:
        assert cache.active(database) is None
        cache._verification.result(timeout=3)
        assert cache.active(database) == set()
        old_connection = cache.client._poll_connection.sock

        code = 503
        assert cache.active(database) is None
        assert cache.client._poll_connection.sock is old_connection
        assert not cache.available
        assert not cache.verifying

        code = 200
        assert cache.active(database) == set()
        old_connection.shutdown(socket.SHUT_RDWR)
        assert cache.active(database) is None
        assert cache.verifying
        assert not cache.available
        cache._verification.result(timeout=3)
        assert cache.active(database) == set()
        assert cache.client._poll_connection.sock is not old_connection
    finally:
        cache.close_poll()
    assert [route for route, _ in requests].count("/api/info") == 2
