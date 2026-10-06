"""Codex's usage limits as its `/status` shows them, read from Codex's own app server.

Rollouts hold the limits only as of the last model reply, and a run stopped by a spent limit
writes none. `/status` asks the app server (`account/rateLimits/read`), which reads the account's
usage with Codex's own login. Atlas does the same over stdio: `initialize`, that one call, exit —
no thread, no model request. Any failure (not logged in, timeout, an odd answer) leaves the
rollout numbers in place, and the next attempt waits `TTL`.
"""
from __future__ import annotations

import contextlib
import json
import os
import select
import shutil
import signal
import subprocess
import threading
import time
from datetime import datetime, timezone

from . import codex_tail, config, limits

TTL = 300                 # seconds between reads of the backend, failed or not
TIMEOUT = 15.0            # the whole exchange; a hung app server is killed
LINE_MAX = 1024 * 1024
BUCKET = "codex"          # the account-wide limit; other buckets are per-model quotas
# launchd and Obsidian do not pass the login shell's PATH: look where installers put codex.
CANDIDATES = ("/opt/homebrew/bin/codex", "/usr/local/bin/codex", "~/.local/bin/codex")

_lock = threading.Lock()
_state: dict = {"home": None, "tried": None, "data": None, "running": False}


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


def read_rate_limits(binary: str, home: str, timeout: float = TIMEOUT) -> dict:
    """The `account/rateLimits/read` result; raises on any failure, a JSON-RPC error included."""
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
                raise RuntimeError(str((reply["error"] or {}).get("message") or reply["error"])[:200])
            if reply["id"] == 1:
                send({"method": "initialized"})
                send({"id": 2, "method": "account/rateLimits/read",
                      "params": {"excludeResetCreditDetails": True}})
            elif isinstance(reply.get("result"), dict):
                return reply["result"]
            else:
                raise ValueError("codex app-server sent no rate limits")
        raise EOFError("codex app-server exited")      # pragma: no cover - _lines raises first
    finally:
        with contextlib.suppress(OSError):
            proc.stdin.close()
        _stop(proc)


def _has_windows(snap) -> bool:
    return isinstance(snap, dict) and any(isinstance(snap.get(k), dict) for k in ("primary", "secondary"))


def bucket(result: dict) -> dict | None:
    """The `codex` bucket; the single-bucket view only when it is that bucket (or unnamed)."""
    by_id = result.get("rateLimitsByLimitId")
    if isinstance(by_id, dict) and _has_windows(by_id.get(BUCKET)):
        return by_id[BUCKET]
    single = result.get("rateLimits")
    if _has_windows(single) and single.get("limitId") in (None, BUCKET):
        return single
    return None


def to_limits(result: dict, captured: float, now: float | None = None) -> dict | None:
    """The app server's snapshot in the shape of `codex_tail.limit_windows`, marked live."""
    snap = bucket(result)
    if not snap:
        return None
    rl = {}
    for name in ("primary", "secondary"):
        w = snap.get(name)
        if isinstance(w, dict) and isinstance(w.get("usedPercent"), (int, float)):
            rl[name] = {"used_percent": w["usedPercent"], "window_minutes": w.get("windowDurationMins"),
                        "resets_at": w.get("resetsAt")}
    when = datetime.fromtimestamp(captured, timezone.utc).isoformat()
    out = codex_tail.limit_windows(rl, when, now)
    if out:
        out["source"] = "live"
        out["live"] = out["age_seconds"] is not None and out["age_seconds"] <= limits.LIVE_FOR
    return out


def refresh(home: str, now: float | None = None) -> None:
    """One read of the backend into the cache; a failure keeps the last good numbers."""
    binary = find_codex()
    try:
        data = read_rate_limits(binary, home) if binary else None
    except (OSError, ValueError, RuntimeError, EOFError, TimeoutError):
        data = None
    with _lock:
        if _state["home"] == home and data is not None:
            _state["data"] = (data, now or time.time())
        _state["running"] = False


def current(home: str, start: bool = False, now: float | None = None, wait: bool = False) -> dict | None:
    """Cached live limits, or None. `start` begins a background read when the cache is due."""
    with _lock:
        if _state["home"] != home:
            _state.update(home=home, tried=None, data=None, running=False)
        due = _state["tried"] is None or time.monotonic() - _state["tried"] >= TTL
        go = start and due and not _state["running"] and os.path.isdir(home) and find_codex() is not None
        if go:
            _state["tried"], _state["running"] = time.monotonic(), True
        data = _state["data"]
    if go:
        worker = threading.Thread(target=refresh, args=(home,), daemon=True)
        worker.start()
        if wait:
            worker.join()
            with _lock:
                data = _state["data"]
    return to_limits(data[0], data[1], now) if data else None


def reset() -> None:
    with _lock:
        _state.update(home=None, tried=None, data=None, running=False)
