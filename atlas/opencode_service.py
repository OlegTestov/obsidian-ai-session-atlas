"""Native OpenCode 2 control through its authenticated, managed loopback service."""
from __future__ import annotations

import base64
import http.client
import ipaddress
import json
import os
import re
import shutil
import stat
import subprocess
import threading
import time
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from .messages import msg

TESTED_VERSION = "2.3.2"
REGISTRATION_LIMIT = 8192
RESPONSE_LIMIT = 4 << 20
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?")
PASSWORD_VARIABLES = {"OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"}
AUTHORITY = re.compile(r"(?:[0-9.]+|\[[0-9a-fA-F:]+\]):[0-9]+")
_start_lock = threading.Lock()
_starting = threading.Event()


class ServiceError(ValueError):
    def __init__(self, state, status=None, **details):
        self.state = state
        self.status = status
        key = "profile_unknown" if state == "profile" and not details else state
        super().__init__(msg("opencode." + key, **details))


@dataclass(frozen=True)
class Registration:
    id: str
    url: str
    host: str
    port: int
    pid: int
    version: str
    password: str = field(repr=False)


@dataclass(frozen=True)
class Discovery:
    state: str
    registration: Registration | None = field(default=None, repr=False)
    info: dict = field(default_factory=dict, repr=False)
    file: Path | None = field(default=None, repr=False)

    @property
    def version(self):
        return self.registration.version if self.registration else None


def binary():
    override = os.environ.get("ATLAS_OPENCODE_BIN")
    return override or None if override is not None else shutil.which("opencode") or shutil.which("opencode2")


def child_env():
    return {key: value for key, value in os.environ.items() if key not in PASSWORD_VARIABLES}


def launch_version(executable):
    if not executable:
        raise ServiceError("not_installed")
    try:
        result = subprocess.run([executable, "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=3, check=False, text=True, env=child_env())
        version = result.stdout.strip().split()[-1].lstrip("v")
    except (OSError, subprocess.TimeoutExpired, IndexError, UnicodeError):
        raise ServiceError("request_failed") from None
    if result.returncode or not VERSION.fullmatch(version):
        raise ServiceError("request_failed")
    if version.startswith("1."):
        raise ServiceError("v1")
    return version


def xdg_dir(key, default):
    return (Path(os.environ.get(key) or Path.home() / default).expanduser() / "opencode").absolute()


def registration_path():
    return xdg_dir("XDG_STATE_HOME", ".local/state") / "service.json"


def _registration(file):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(file, flags), "rb") as file:
        st = os.fstat(file.fileno())
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid()
                or stat.S_IMODE(st.st_mode) & ~0o600 or st.st_size > REGISTRATION_LIMIT):
            raise ServiceError("unauthorized")
        data = file.read(REGISTRATION_LIMIT + 1)
    try:
        if len(data) > REGISTRATION_LIMIT:
            raise ValueError
        value = json.loads(data)
        url, pid, version, password = (value[key] for key in ("url", "pid", "version", "password"))
        generation = value["id"]
        address = urlsplit(url)
        if (not isinstance(url, str) or any(c.isspace() or ord(c) < 32 for c in url)
                or address.scheme != "http" or not AUTHORITY.fullmatch(address.netloc)
                or url != f"http://{address.netloc}{address.path}"
                or address.path not in ("", "/") or not address.port or not address.hostname
                or not ipaddress.ip_address(address.hostname).is_loopback
                or not isinstance(generation, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", generation)
                or type(pid) is not int or pid <= 0 or not VERSION.fullmatch(version)
                or not isinstance(password, str) or not password or len(password) > 4096):
            raise ValueError
        password.encode("utf-8")
        return Registration(generation, url, address.hostname, address.port, pid, version, password)
    except (ValueError, TypeError, AttributeError, KeyError, UnicodeError):
        raise ServiceError("unauthorized") from None


def _lsof(*args):
    executable = shutil.which("lsof")
    if not executable:
        raise ServiceError("lsof_missing")
    try:
        result = subprocess.run([executable, "-nP", *args], capture_output=True, env=child_env(),
                                stdin=subprocess.DEVNULL, timeout=2)
    except FileNotFoundError:
        raise ServiceError("lsof_missing") from None
    except (OSError, subprocess.TimeoutExpired):
        raise ServiceError("unauthorized") from None
    return result.stdout if result.returncode == 0 else b""


def _listener_pid(host, port):
    endpoint = _endpoint(host, port)
    output = _lsof("-iTCP@" + endpoint, "-sTCP:LISTEN", "-F0pfnT")
    pids = _listener_pids(_file_sets(output), endpoint)
    return next(iter(pids)) if len(pids) == 1 else None


def _endpoint(host, port):
    address = ipaddress.ip_address(host)
    return f"[{address}]:{port}" if address.version == 6 else f"{address}:{port}"


def _listens_at(fields, endpoint):
    if b"TST=LISTEN" not in fields:
        return False
    for value in fields:
        if not value.startswith(b"n"):
            continue
        try:
            host, port = value[1:].decode("ascii").rsplit(":", 1)
            if host == "*":
                return endpoint.endswith(":" + port)
            return _endpoint(host.strip("[]"), int(port)) == endpoint
        except ValueError:
            return False
    return False


def _listener_pids(files, endpoint):
    return {pid for pid, fields in files if _listens_at(fields, endpoint)}


def _file_sets(output):
    pid = None
    for record in output.split(b"\0\n"):
        fields = record.split(b"\0")
        first = fields[0]
        if first.startswith(b"p") and first[1:].isdigit():
            pid = int(first[1:])
        elif pid is not None and first.startswith(b"f"):
            yield pid, fields


def _matches_database(files, expected):
    def identity(path):
        info = path.stat()
        return info.st_dev, info.st_ino

    try:
        wanted = identity(expected), identity(expected.with_name(expected.name + "-wal"))
    except OSError:
        return False

    opened = {}
    for fields in files:
        values = {field[:1]: field[1:] for field in fields}
        name = values.get(b"n", b"")
        if values.get(b"t") != b"REG" or not name.startswith(b"/"):
            continue
        try:
            key = int(values[b"D"], 16), int(values[b"i"])
        except (KeyError, ValueError):
            continue
        opened.setdefault(name, set()).add(key)
    # lsof escapes names. Use them only to pair each open main file with its WAL.
    candidates = {(main, wal) for name, mains in opened.items()
                  for main in mains for wal in opened.get(name + b"-wal", ())}
    return candidates == {wanted}


def _check_registration(registration, file):
    try:
        if _registration(file) == registration:
            return
    except (OSError, ServiceError):
        pass
    raise ServiceError("service_changed")


def _call(registration, method, path, body=None, *, timeout=3, file=None, before_send=None, check_target=None):
    file = file or registration_path()
    # Direct sockets ignore proxies, and an already connected socket cannot reach a replacement listener.
    connection = http.client.HTTPConnection(registration.host, registration.port, timeout=timeout)
    auth = base64.b64encode(("opencode:" + registration.password).encode()).decode("ascii")
    headers = {"Authorization": "Basic " + auth, "Content-Type": "application/json"}
    try:
        _check_registration(registration, file)
        connection.connect()
        if check_target is not None:
            check_target()
        elif _listener_pid(registration.host, registration.port) != registration.pid:
            raise ServiceError("unauthorized")
        if before_send is not None:
            before_send()
        _check_registration(registration, file)
        connection.request(method, path, json.dumps(body) if body is not None else None, headers=headers)
        with connection.getresponse() as response:
            code = response.status
            if not 200 <= code < 300:
                status = "unauthorized" if code in (401, 403) or 300 <= code < 400 else (
                    "session_missing" if code == 404 else "request_failed")
                raise ServiceError(status, code)
            raw = response.read(RESPONSE_LIMIT + 1)
        if len(raw) > RESPONSE_LIMIT:
            raise ServiceError("request_failed")
        return json.loads(raw) if raw else None
    except (OSError, http.client.HTTPException):
        raise ServiceError("stopped") from None
    except (ValueError, UnicodeError) as exc:
        if isinstance(exc, ServiceError):
            raise
        raise ServiceError("request_failed") from None
    finally:
        connection.close()


def _registered(starting=False):
    if not binary():
        return Discovery("not_installed")
    file = registration_path()
    try:
        registration = _registration(file)
    except FileNotFoundError:
        return Discovery("starting" if starting or _starting.is_set() else "stopped")
    except (OSError, ServiceError):
        return Discovery("unauthorized")
    return Discovery("registered", registration, file=file)


def discover(*, starting=False):
    found = _registered(starting)
    if found.registration is None:
        return found
    registration, file = found.registration, found.file
    try:
        identity = _call(registration, "GET", "/api/info", timeout=0.8, file=file)
    except ServiceError as exc:
        if exc.state == "stopped":
            return Discovery("starting" if starting or _starting.is_set() else "stopped")
        return Discovery(exc.state if exc.state in {"lsof_missing", "service_changed"} else "unauthorized")
    if (not isinstance(identity, dict) or type(identity.get("pid")) is not int
            or identity["pid"] != registration.pid or identity.get("version") != registration.version):
        return Discovery("unauthorized")
    state = "ready" if registration.version == TESTED_VERSION else "version_warning"
    return Discovery(state, registration, identity, file)


def active_sessions(expected):
    found = discover()
    client = Client(found)
    registration = found.registration
    endpoint = _endpoint(registration.host, registration.port)

    def check_target():
        # OR selects the service's open files and any process listening on the endpoint.
        output = _lsof("-p", str(registration.pid), "-iTCP@" + endpoint, "-sTCP:LISTEN", "-F0pftDinT")
        files = list(_file_sets(output))
        listeners = _listener_pids(files, endpoint)
        if listeners != {registration.pid}:
            raise ServiceError("unauthorized")
        client.require_database(expected, files=(fields for pid, fields in files if pid == registration.pid))

    result = _call(registration, "GET", "/api/session/active", file=found.file, check_target=check_target)
    client.check_current()
    return _response_data(result, dict)


def _start():
    env = child_env()
    env.pop("OPENCODE_CLI_CONFIG_CONTENT", None)
    with suppress(OSError, subprocess.TimeoutExpired):
        subprocess.run([binary(), "service", "start"], env=env, stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8, check=False)


def ensure():
    with _start_lock:
        found = discover()
        if found.state != "stopped":
            if found.registration:
                return found
            raise ServiceError(found.state)
        if not shutil.which("lsof"):
            raise ServiceError("lsof_missing")
        _starting.set()
        try:
            launch_version(binary())
            _start()
            deadline = time.monotonic() + 3
            while True:
                found = discover(starting=True)
                if found.registration:
                    return found
                if found.state != "starting" or time.monotonic() >= deadline:
                    raise ServiceError(found.state)
                time.sleep(0.15)
        finally:
            _starting.clear()


def _real_file(path):
    if isinstance(path, str) and os.path.isabs(path):
        try:
            resolved = Path(path).resolve(strict=True)
            return resolved if resolved.is_file() else None
        except (OSError, RuntimeError, ValueError):
            pass
    return None


def _response_data(value, expect):
    if not isinstance(value, dict) or not isinstance(value.get("data"), expect):
        raise ServiceError("request_failed")
    return value["data"]


class Client:
    def __init__(self, discovery):
        if discovery.registration is None:
            raise ServiceError(discovery.state)
        self.state = discovery.state
        self.version = discovery.version
        self._registration = discovery.registration
        self._file = discovery.file or registration_path()
        self.info = discovery.info

    @property
    def generation(self):
        return self._registration.id

    def check_current(self):
        _check_registration(self._registration, self._file)

    def check_listener(self):
        if _listener_pid(self._registration.host, self._registration.port) != self._registration.pid:
            raise ServiceError("unauthorized")
        self.check_current()

    def require_database(self, expected, *, files=None):
        try:
            expected = expected.resolve(strict=True)
        except (OSError, RuntimeError):
            raise ServiceError("profile") from None
        actual = self.database_path(expected, files=files)
        if actual is None:
            raise ServiceError("profile")
        if actual != expected:
            raise ServiceError("profile", path=actual)
        return actual

    def database_path(self, expected, *, files=None):
        self.check_current()
        paths = self.info.get("paths")
        reported = paths.get("database") if isinstance(paths, dict) else None
        if reported is not None:
            return _real_file(reported)
        if self.version == TESTED_VERSION:
            # 2.3.2 reports only paths.tmp.
            if files is None:
                pid = self._registration.pid
                output = _lsof("-a", "-p", str(pid), "-F0pftDin")
                files = (fields for owner, fields in _file_sets(output) if owner == pid)
            matches = _matches_database(files, expected)
            self.check_current()
            if matches:
                return expected
        return None

    def call(self, method, route, body=None, *, before_send=None):
        try:
            return _call(self._registration, method, "/api/" + route, body, file=self._file, before_send=before_send)
        finally:
            self.check_current()

    def data(self, route, method="GET", body=None, expect=dict):
        return _response_data(self.call(method, route, body), expect)

    def sessions(self, **filters):
        cursor = None
        seen = set()
        for _ in range(200):
            query = dict(filters, limit=100)
            if cursor:
                query["cursor"] = cursor
            page = self.call("GET", "session?" + urlencode(query))
            if (not isinstance(page, dict) or not isinstance(page.get("data"), list)
                    or not isinstance(page.get("cursor"), dict)):
                raise ServiceError("request_failed")
            yield from page["data"]
            cursor = page["cursor"].get("next")
            if cursor is None:
                return
            if not isinstance(cursor, str) or not cursor or cursor in seen:
                break
            seen.add(cursor)
        raise ServiceError("request_failed")
