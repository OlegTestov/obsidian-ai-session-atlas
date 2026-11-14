"""Asking Codex itself to do something: one request to a short-lived `codex app-server` over stdio,
or one `codex delete`. Codex then writes its own state; Atlas never writes Codex's databases.

The stdio app server is a private process of this call (not the shared daemon): `initialize`, one
request, exit. No thread is loaded and no model request is made. Every failure raises CodexError
with a short reason, so the caller can fall back to what Atlas does without Codex.
"""
from __future__ import annotations

import contextlib
import json
import os
import select
import shutil
import signal
import subprocess
import time

from . import config

TIMEOUT = 15.0            # the whole exchange; a hung app server is killed
LINE_MAX = 1024 * 1024
METHOD_NOT_FOUND = -32601
# launchd and Obsidian do not pass the login shell's PATH: look where installers put codex.
CANDIDATES = ("/opt/homebrew/bin/codex", "/usr/local/bin/codex", "~/.local/bin/codex")


class CodexError(RuntimeError):
    """`code` is the JSON-RPC error code when Codex answered with one."""

    def __init__(self, message: str, code: int | None = None):
        super().__init__(message)
        self.code = code


def find_codex() -> str | None:
    """ATLAS_CODEX_BIN wins outright (tests point it at a stand-in), then settings, PATH, known places."""
    forced = os.environ.get("ATLAS_CODEX_BIN")
    if forced is not None:
        return forced if forced and os.access(forced, os.X_OK) else None
    configured = config.get("codex_bin")
    if configured and os.access(os.path.expanduser(configured), os.X_OK):
        return os.path.expanduser(configured)
    for path in [shutil.which("codex")] + [os.path.expanduser(c) for c in CANDIDATES]:
        if path and os.access(path, os.X_OK):
            return path
    return None


def _lines(fd: int, deadline: float):
    buf = b""
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("codex app-server did not answer in time")
        ready, _, _ = select.select([fd], [], [], left)
        if not ready:
            continue
        chunk = os.read(fd, 65536)
        if not chunk:
            raise EOFError("codex app-server exited")
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            yield line
        if len(buf) > LINE_MAX:
            raise ValueError("codex app-server sent an oversized line")


def _stop(proc: subprocess.Popen) -> None:
    for sig, wait in ((signal.SIGTERM, 2), (signal.SIGKILL, 2)):
        with contextlib.suppress(OSError):
            os.killpg(proc.pid, sig)                  # its own group: helpers it started go too
        try:
            proc.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


def run_group(args: list[str], timeout: float, cwd: str, env: dict | None = None,
              input: str | None = None) -> subprocess.CompletedProcess:
    """subprocess.run in a process group of its own: on timeout the whole group is stopped, so a native
    codex behind an npm wrapper does not keep calling the model after we gave up."""
    proc = subprocess.Popen(args, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=cwd, env=env,
                            start_new_session=True)
    try:
        out, err = proc.communicate(input=input, timeout=timeout)
    except subprocess.TimeoutExpired:
        _stop(proc)
        raise
    return subprocess.CompletedProcess(args, proc.returncode, out, err)


def request(binary: str, home: str, method: str, params: dict, timeout: float = TIMEOUT):
    """The `result` of one app-server request; raises on any failure, a JSON-RPC error included."""
    proc = subprocess.Popen([binary, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, cwd=home, env=dict(os.environ, CODEX_HOME=home),
                            start_new_session=True)

    def send(obj: dict) -> None:
        proc.stdin.write((json.dumps(obj) + "\n").encode())
        proc.stdin.flush()
    try:
        send({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "session-atlas", "version": "1"}}})
        for raw in _lines(proc.stdout.fileno(), time.monotonic() + timeout):
            try:
                reply = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(reply, dict) or reply.get("id") not in (1, 2):
                continue                               # notifications
            if reply.get("error") is not None:
                err = reply["error"] if isinstance(reply["error"], dict) else {"message": reply["error"]}
                raise CodexError(str(err.get("message") or err)[:200], err.get("code"))
            if reply["id"] == 1:
                send({"method": "initialized"})
                send({"id": 2, "method": method, "params": params})
            else:
                return reply.get("result")
        raise EOFError("codex app-server exited")      # pragma: no cover - _lines raises first
    finally:
        with contextlib.suppress(OSError):
            proc.stdin.close()
        _stop(proc)


def _binary() -> str:
    binary = find_codex()
    if not binary:
        raise CodexError("codex not found")
    return binary


def set_thread_name(home: str, thread_id: str, name: str, timeout: float = TIMEOUT) -> None:
    """Codex's own rename (`thread/name/set`, as `/rename` in its TUI): its thread list and
    `codex resume <name>` show the new name. The rollout itself is not touched."""
    try:
        request(_binary(), home, "thread/name/set", {"threadId": thread_id, "name": name}, timeout)
    except (OSError, ValueError, EOFError, TimeoutError) as exc:
        raise CodexError(str(exc)[:200]) from exc


def delete_thread(home: str, thread_id: str, timeout: float = 60.0) -> None:
    """`codex delete --force <uuid>`: Codex removes the thread's rollouts and its own records.
    `--force` skips the terminal confirmation; it needs a UUID, and the caller passes a valid one."""
    try:
        proc = run_group([_binary(), "delete", "--force", thread_id], timeout, home,
                         env=dict(os.environ, CODEX_HOME=home))
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CodexError(str(exc)[:200]) from exc
    if proc.returncode != 0:
        detail = " ".join(((proc.stderr or "").strip() or (proc.stdout or "").strip()).split())
        raise CodexError(detail[:200] or f"codex delete exited with {proc.returncode}")
