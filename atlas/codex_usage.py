"""Codex's usage limits as its `/status` shows them, read from Codex's own app server.

Rollouts hold the limits only as of the last model reply, and a run stopped by a spent limit
writes none. `/status` asks the app server (`account/rateLimits/read`), which reads the account's
usage with Codex's own login. Atlas does the same over stdio (`codex_app.request`): `initialize`, that one call,
exit — no thread, no model request. Any failure (not logged in, timeout, an odd answer) leaves the
rollout numbers in place, and the next attempt waits `TTL`.
"""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone

from . import codex_app, codex_tail, limits

TTL = 300                 # seconds between reads of the backend, failed or not
TIMEOUT = codex_app.TIMEOUT
BUCKET = "codex"          # the account-wide limit; other buckets are per-model quotas

_lock = threading.Lock()
_state: dict = {"home": None, "tried": None, "data": None, "running": False}
find_codex = codex_app.find_codex


def read_rate_limits(binary: str, home: str, timeout: float = TIMEOUT) -> dict:
    """The `account/rateLimits/read` result; raises on any failure, a JSON-RPC error included."""
    result = codex_app.request(binary, home, "account/rateLimits/read",
                               {"excludeResetCreditDetails": True}, timeout)
    if not isinstance(result, dict):
        raise ValueError("codex app-server sent no rate limits")
    return result


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
    except (OSError, ValueError, RuntimeError, EOFError, TimeoutError):  # CodexError is a RuntimeError
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
