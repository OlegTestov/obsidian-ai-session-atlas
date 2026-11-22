import base64
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock

import pytest

from atlas import opencode_service as oc


@pytest.fixture
def service(tmp_path, monkeypatch):
    state = tmp_path / "state"
    monkeypatch.setenv("XDG_STATE_HOME", str(state))
    monkeypatch.setenv("ATLAS_OPENCODE_BIN", "/fixture/opencode")
    registry = state / "opencode/service.json"
    registry.parent.mkdir(parents=True)
    requests = []
    reply = Mock(return_value=(200, {"version": "2.3.2", "pid": os.getpid()}))
    password = "synthetic-secret"

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            requests.append((self.path, self.headers.get("Authorization")))
            code, body = reply(self.path)
            self.send_response(code)
            if code == 302:
                self.send_header("Location", "/escaped")
            self.end_headers()
            self.wfile.write(json.dumps(body).encode())

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
    monkeypatch.setattr(oc, "_listener_pid", lambda *_: os.getpid(), raising=False)
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
