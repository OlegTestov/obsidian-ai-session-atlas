"""The managed OpenCode launcher and its per-tab route records."""
from __future__ import annotations

import fcntl
import json
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from . import agent_opencode, agents, db, forks, opencode_service as service
from .messages import use_lang

INSTANCE = re.compile(r"[A-Za-z0-9_.-]{1,96}")
INLINE = "OPENCODE_CLI_CONFIG_CONTENT"
JSONC = re.compile(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/|,(?=\s*[}\]])')
LIMIT = 256 << 10
LAUNCH_TIMEOUT_MS = 120_000


def tab_dir():
    return Path(db.atlas_home()) / "opencode-tabs"


@contextmanager
def action_lock():
    """Serialize native mutations with the final resume check and tab reservation."""
    with os.fdopen(os.open(Path(db.atlas_home()) / "opencode-actions.lock",
                           os.O_CREAT | os.O_RDWR, 0o600), "r+") as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        yield


def _json_file(file, limit=8192):
    with file.open("rb") as reader:
        return json.loads(reader.read(limit + 1)) if file.stat().st_size <= limit else None


def _record(file, limit=8192):
    try:
        value = _json_file(file, limit)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _sid(value):
    return value if agents.valid_id(agents.OPENCODE, value) else None


def tab_record(file):
    launch = _record(file)
    nonce = launch.get("nonce")
    if not isinstance(nonce, str) or not re.fullmatch(r"[a-f0-9]{32}", nonce):
        return {}
    route = _record(file.with_name(f"{file.stem}.{nonce}.route"))
    if route.get("nonce") == nonce and route.get("pid") == launch.get("pid"):
        launch.update(current=_sid(route.get("current")), last=_sid(route.get("last")) or _sid(launch.get("last")))
        if isinstance(route.get("at"), (int, float)):
            launch["verified"] = (0 <= time.time() * 1000 - route["at"] < 8000
                                  and (route.get("route") == "home" or
                                       (route.get("route") == "session" and launch["current"] is not None)))
    return launch


def _process_start(pid):
    try:
        result = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "lstart="], check=False,
                                capture_output=True, text=True, timeout=1,
                                env={**service.child_env(), "LC_ALL": "C", "TZ": "UTC"})
        return result.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _alive(record):
    pid = record.get("pid")
    if type(pid) is not int or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    start = record.get("start")
    current = _process_start(pid) if start else ""
    return not current or start == current


def _launch_ended(directory, instance, record):
    attempt = record.get("attempt")
    if not isinstance(attempt, str) or not re.fullmatch(r"[a-f0-9]{32}", attempt):
        return False
    try:
        with (directory / (instance + ".exited")).open("rb") as marker:
            return marker.read(33) == attempt.encode("ascii")
    except OSError:
        return False


def _unrouted_launch_expired(entry):
    started = entry.get("startedAt")
    if type(started) is not int or time.time() * 1000 - started <= LAUNCH_TIMEOUT_MS:
        return False
    root = entry.get("ptyPid")
    if root is None:
        return "ptyPid" in entry
    if type(root) is not int or root <= 1:
        return False
    try:
        result = subprocess.run(["/bin/ps", "-axww", "-o", "pid=,ppid=,stat=,comm="], check=True,
                                capture_output=True, text=True, errors="replace", timeout=1,
                                env=service.child_env())
    except (OSError, subprocess.SubprocessError):
        return False
    children = {}
    for line in result.stdout.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4 and parts[0].isdigit() and parts[1].isdigit():
            pid, ppid, state, command = parts
            children.setdefault(int(ppid), []).append((int(pid), state, os.path.basename(command)))
    names = {"opencode", "opencode2"}
    if binary := service.binary():
        names.update((os.path.basename(binary), os.path.basename(os.path.realpath(binary))))
    pending = [root]
    while pending:
        for pid, state, command in children.get(pending.pop(), ()):
            if not state.startswith("Z") and command in names:
                return False
            pending.append(pid)
    return True


def open_tabs():
    opened = set()
    unknown = False
    live = {}
    directory = tab_dir()
    for file in directory.glob("opencode-*.json"):
        info = tab_record(file)
        if _alive(info) and not _launch_ended(directory, file.stem, info):
            live[file.stem] = info.get("attempt")
            if not info.get("verified"):
                unknown = True
            elif info.get("current"):
                opened.add(info["current"])
    for file in directory.glob("layout-*.json"):
        layout = _record(file, LIMIT)
        if not _alive(layout) or not isinstance(layout.get("tabs"), list):
            continue
        for entry in layout["tabs"]:
            instance = entry.get("instance") if isinstance(entry, dict) else None
            if (not isinstance(instance, str) or not INSTANCE.fullmatch(instance)
                    or entry.get("launching") is not True or entry.get("exited") is True):
                continue
            attempt = entry.get("attempt")
            if (not isinstance(attempt, str) or not re.fullmatch(r"[a-f0-9]{32}", attempt)
                    or live.get(instance) == attempt
                    or _launch_ended(directory, instance, entry)
                    or _unrouted_launch_expired(entry)):
                continue
            # The PTY has started, but its native launcher has not reserved a route yet.
            unknown = True
    return opened, unknown


def catalog_meta(conn):
    ids, _ = open_tabs()
    nums = forks.numbers(conn) if ids else {}
    found = {}
    for sid in ids:
        row = conn.execute("SELECT s.session_id, COALESCE(NULLIF(u.title,''),s.title) title, s.last_activity_at, "
                           "COALESCE(u.title,'') <> '' AS renamed "
                           "FROM sessions s LEFT JOIN user_overrides u USING(session_id) "
                           "WHERE session_id=? AND agent='opencode'", (sid,)).fetchone()
        if row:
            found[sid] = {"title": forks.shown(row, nums), "last_activity_at": row["last_activity_at"]}
    return found


def verify_profile(client):
    expected = agent_opencode.data_home() / agent_opencode.DATABASE
    return client.require_database(expected)


def checked_directory(sid):
    directory = agent_opencode.session_directory(sid)
    if not directory:
        raise service.ServiceError("session_missing")
    return directory


def _jsonc(text):
    if len(text) > LIMIT:
        raise ValueError
    comments = re.compile(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*[\s\S]*?\*/')
    clean = comments.sub(lambda match: match[0] if match[0].startswith('"') else " ", text)
    result = json.loads(JSONC.sub(lambda match: match[0] if match[0].startswith('"') else "", clean))
    if not isinstance(result, dict):
        raise ValueError
    return result


def _cli_config(root):
    try:
        with (root / "cli.json").open(encoding="utf-8") as file:
            return _jsonc(file.read(LIMIT + 1))
    except FileNotFoundError:
        # Older TUI configuration can be migrated by the native CLI on this very launch.
        if (root / "tui.json").exists():
            raise ValueError from None
        return {}


def tracking_env(package, route_file, record, env):
    if not (package / "package.json").is_file():
        return env
    try:
        original = _cli_config(service.xdg_dir("XDG_CONFIG_HOME", ".config"))
        inline = _jsonc(env[INLINE]) if env.get(INLINE) else {}
        plugins = inline.get("plugins", original.get("plugins", []))
        tabs = inline.get("tabs", {})
        if not isinstance(plugins, list) or not isinstance(tabs, dict):
            return env
        if not all(isinstance(item, str) or (isinstance(item, dict) and isinstance(item.get("package"), str))
                   for item in plugins):
            return env
        injected = {"package": package.as_uri(),
                    "options": {"file": str(route_file), "nonce": record["nonce"],
                                "pid": record["pid"], "last": record["last"]}}
        effective = dict(inline, plugins=[*plugins, injected], tabs=dict(tabs, mode="off"))
        return dict(env, **{INLINE: json.dumps(effective, ensure_ascii=False)})
    except (OSError, ValueError, RecursionError):
        return env


def _save(file, value):
    tmp = file.with_suffix(f".{value['nonce']}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(value, fh)
    os.replace(tmp, file)


def prepare(instance, mode, seed, args, package):
    if not INSTANCE.fullmatch(instance) or mode not in ("", "new", "resume"):
        raise service.ServiceError("launch_options")
    for arg in args:
        if (arg.split("=", 1)[0] in {"--", "--session", "--continue", "--fork", "--server", "--standalone", "--prompt"}
                or re.fullmatch(r"-[^-]*[sc][^-]*", arg)):
            raise service.ServiceError("launch_options")
    if any(os.environ.get(key) for key in ("OPENCODE_SERVICE_CHANNEL", "OPENCODE_DISABLE_MANAGED_SERVICE",
                                           "OPENCODE_CHANNEL")):
        raise service.ServiceError("profile")
    executable = service.binary()
    version = service.launch_version(executable)
    home = tab_dir()
    home.mkdir(mode=0o700, exist_ok=True)
    file = home / (instance + ".json")
    with action_lock():
        previous = tab_record(file)
        sid = _sid(previous.get("last")) or (_sid(seed) if mode == "resume" else None)
        if mode == "resume" and not sid:
            raise service.ServiceError("session_missing")
        cwd = checked_directory(sid) if sid else os.getcwd()
        if not os.path.isdir(cwd):
            raise service.ServiceError("session_missing")
        found = service.ensure()
        client = service.Client(found)
        verify_profile(client)
        pid = os.getpid()
        record = {"pid": pid, "start": _process_start(pid), "nonce": secrets.token_hex(16),
                  "current": sid, "last": sid, "cwd": cwd,
                  "attempt": os.environ.get("OBS_AGENT_OPENCODE_ATTEMPT")}
        env = service.child_env()
        route = file.with_name(f"{file.stem}.{record['nonce']}.route")
        if found.version == version == service.TESTED_VERSION:
            env = tracking_env(package, route, record, env)
        # Startup and config preparation can take time. Check again before reserving.
        if sid:
            cwd = checked_directory(sid)
        client.check_listener()
        record["cwd"] = cwd
        _save(file, record)
        if nonce := previous.get("nonce"):
            file.with_name(f"{file.stem}.{nonce}.route").unlink(missing_ok=True)
        client.check_current()
    argv = [executable, cwd, *(("--session", sid) if sid else ()), *args]
    return cwd, argv, env


def main():
    instance, mode, seed, package, *args = sys.argv[1:]
    with use_lang(os.environ.get("OBS_AGENT_ATLAS_LANG")):
        try:
            cwd, argv, env = prepare(instance, mode, seed, args, Path(package))
            os.chdir(cwd)
            os.execve(argv[0], argv, env)
        except service.ServiceError as exc:
            print(str(exc), file=sys.stderr)
        except (OSError, sqlite3.Error):
            print(str(service.ServiceError("request_failed")), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
