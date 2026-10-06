"""Live Codex processes: which interactive `codex` runs which thread.

Codex writes no per-process state file (Claude Code writes ~/.claude/sessions/<pid>.json), but an
interactive `codex` keeps its rollout open for the whole thread, so `lsof` maps a process to it.
`codex exec`, the app server and helper processes are not human tabs and are skipped.
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import time

from . import codex_parse, index

# The native binary; a platform-suffixed copy runs under the npm wrapper.
BINARY = re.compile(r"(?:^|/)codex(?:-(?:aarch64|x86_64)-(?:apple-darwin|unknown-linux-musl))?$")
# Subcommands that do not open the terminal UI. Everything else (none, `resume`, `fork`, a prompt) does.
NOT_INTERACTIVE = {"exec", "e", "review", "login", "logout", "mcp", "mcp-server", "app-server",
                   "completion", "sandbox", "debug", "apply", "a", "cloud", "features", "help",
                   "responses-api-proxy", "stdio-to-uds", "generate-ts", "proto", "app"}
# Options whose value is the next word: the value is not a subcommand.
VALUE_FLAGS = {"-m", "--model", "-c", "--config", "-C", "--cd", "-p", "--profile", "-s", "--sandbox",
               "-a", "--ask-for-approval", "-i", "--image", "--add-dir", "--enable", "--disable",
               "--local-provider", "--oss-provider", "--remote"}
UUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
LSOF = shutil.which("lsof") or "/usr/sbin/lsof"
LSOF_TIMEOUT = 3.0
# `/new` and `/resume` inside the terminal UI switch the thread without a new process.
MAP_TTL = 10.0
META_LINE_LIMIT = 4 * 1024 * 1024

def _run(cmd: list[str], **kw):
    """The one place a process is started; tests replace it with fake `lsof` output."""
    return subprocess.run(cmd, **kw)


_map_cache: dict[tuple, tuple] = {}         # (pid, start) → (checked at, rollout path or None)
_meta_cache: dict[str, dict] = {}           # rollout path → its session_meta
_find_cache: dict[str, str] = {}            # thread id → rollout path


def is_interactive_command(command: str) -> bool:
    """`ps` gives argv joined by spaces: a quoted prompt splits, but its first word is not a subcommand."""
    parts = (command or "").split()
    if not parts or not BINARY.search(parts[0]):
        return False
    skip = False
    for word in parts[1:]:
        if skip:
            skip = False
            continue
        if word.startswith("-"):
            skip = word in VALUE_FLAGS
            continue
        return word not in NOT_INTERACTIVE
    return True


def interactive_pids(table: dict) -> dict[int, str]:
    """pid → process start, for every interactive `codex` in the process table."""
    return {pid: row[1] for pid, row in table.items()
            if len(row) > 2 and is_interactive_command(row[2])}


def _inside(path: str, home: str) -> bool:
    """By path components: a rollout of another Codex home is not this catalog's thread."""
    real, root = os.path.realpath(path), os.path.realpath(home)
    return real == root or real.startswith(root.rstrip(os.sep) + os.sep)


def open_rollouts(pids, run=None, home: str | None = None) -> dict[int, list[str]] | None:
    """One `lsof` for all PIDs: {pid: [rollout paths]}. None: lsof is missing, slow or failed."""
    pids = sorted(set(pids))
    if not pids:
        return {}
    home = home or index.codex_home()
    try:
        out = (run or _run)([LSOF, "-w", "-n", "-P", "-F", "pn", "-p", ",".join(map(str, pids))],
                  capture_output=True, text=True, timeout=LSOF_TIMEOUT).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    found: dict[int, list[str]] = {}
    pid = None
    for line in (out or "").splitlines():
        if line.startswith("p") and line[1:].isdigit():
            pid = int(line[1:])
            found.setdefault(pid, [])
        elif line.startswith("n") and pid is not None:
            path = line[1:]
            if codex_parse.session_id_of(path) and _inside(path, home) and path not in found[pid]:
                found[pid].append(path)
    return found


def session_meta(path: str) -> dict:
    """The first line: thread id, cwd, originator, source. Never changes, so it is cached per path."""
    if path in _meta_cache:
        return _meta_cache[path]
    meta: dict = {}
    try:
        with open(path, "rb") as fh:
            rec = json.loads(fh.readline(META_LINE_LIMIT))
        if isinstance(rec, dict) and rec.get("type") == "session_meta" and isinstance(rec.get("payload"), dict):
            meta = rec["payload"]
    except (OSError, ValueError):
        return {}
    meta = {"id": str(meta.get("id") or meta.get("session_id") or codex_parse.session_id_of(path) or ""),
            "cwd": meta.get("cwd"), "timestamp": meta.get("timestamp"),
            "subagent": meta.get("thread_source") == "subagent"
            or (isinstance(meta.get("source"), dict) and "subagent" in meta["source"])}
    _meta_cache[path] = meta
    return meta


def thread_id(path: str) -> str | None:
    return (session_meta(path).get("id") or codex_parse.session_id_of(path) or "").lower() or None


def main_rollout(paths: list[str]) -> str | None:
    """A process with subagents holds their rollouts open too: the human thread is the one it runs."""
    own = [p for p in paths if not session_meta(p).get("subagent")] or paths

    def mtime(p: str) -> float:
        try:
            return os.stat(p).st_mtime
        except OSError:
            return 0.0
    return max(own, key=mtime) if own else None


def find_rollout(session_id: str, home: str | None = None) -> str | None:
    """The rollout of a thread id: live by date folder or archived. Cached while the file exists."""
    sid = (session_id or "").lower()
    if not UUID.fullmatch(sid):
        return None
    home = home or index.codex_home()
    cached = _find_cache.get(sid)
    if cached and os.path.exists(cached) and _inside(cached, home):
        return cached
    found = all_rollouts(sid, home)
    if not found:
        return None
    _find_cache[sid] = found[0]
    return found[0]


def all_rollouts(session_id: str, home: str | None = None) -> list[str]:
    """Every file of the thread: a live one in sessions/ and an archived copy may both exist."""
    home = glob.escape(home or index.codex_home())
    name = f"rollout-*-{glob.escape(session_id.lower())}.jsonl"
    found = glob.glob(os.path.join(home, "sessions", "**", name), recursive=True)
    found += glob.glob(os.path.join(home, "archived_sessions", name))
    return sorted(p for p in found if codex_parse.session_id_of(p) == session_id.lower())


def _from_argv(command: str, home: str) -> str | None:
    """Only an explicit resume id, never a UUID mentioned in a prompt or a fork's source."""
    parts = (command or "").split()
    skip = False
    for i, word in enumerate(parts[1:], 1):
        if skip:
            skip = False
        elif word.startswith("-"):
            skip = word in VALUE_FLAGS
        else:
            if word == "resume" and i + 1 < len(parts) and UUID.fullmatch(parts[i + 1]):
                return find_rollout(parts[i + 1], home)
            return None
    return None


def rollouts_for(table: dict, run=None, home: str | None = None, fresh: bool = False,
                 now: float | None = None) -> dict[int, str]:
    """pid → rollout path of every interactive `codex` that has one open."""
    home = home or index.codex_home()
    now = time.monotonic() if now is None else now
    live = interactive_pids(table)
    keys = {pid: (pid, start) for pid, start in live.items()}
    stale = [pid for pid, key in keys.items()
             if fresh or key not in _map_cache or now - _map_cache[key][0] > MAP_TTL]
    if stale:
        # A modern CLI delegates to a shared daemon. Its explicit resume id can be displayed
        # only while that exact file is open there; never choose the daemon's newest file.
        daemons = [pid for pid, row in table.items() if len(row) > 2
                   and len(row[2].split()) > 1 and BINARY.search(row[2].split()[0])
                   and row[2].split()[1] == "app-server"]
        candidates = daemons if any(_from_argv(table[p][2], home) for p in stale) else []
        found = open_rollouts(stale + candidates, run, home)
        shared = {p for pid in candidates for p in (found or {}).get(pid, [])}
        for pid in stale:
            if found is not None:
                path = main_rollout(found.get(pid, []))
                resumed = _from_argv(table[pid][2], home) if not path else None
                if resumed in shared and not session_meta(resumed).get("subagent"):
                    path = resumed
                _map_cache[keys[pid]] = (now, path)
            elif keys[pid] not in _map_cache:      # keep an older answer; retried next time
                _map_cache[keys[pid]] = (0.0, _from_argv(table[pid][2], home))
    for key in [k for k in _map_cache if k not in keys.values()]:
        del _map_cache[key]                         # the process is gone
    return {pid: _map_cache[key][1] for pid, key in keys.items() if _map_cache[key][1]}


def owner(pid: int, session_id: str, table: dict, run=None, home: str | None = None) -> bool:
    """This exact process runs this thread now: checked with a fresh lsof, not from the cache."""
    if pid not in interactive_pids(table):
        return False
    home = home or index.codex_home()
    found = open_rollouts([pid], run, home)
    path = main_rollout(found.get(pid, [])) if found is not None else _from_argv(table[pid][2], home)
    return bool(path) and thread_id(path) == (session_id or "").lower()


def running(session_id: str, table: dict, run=None, home: str | None = None) -> bool:
    paths = rollouts_for(table, run=run, home=home, fresh=True)
    return any(thread_id(p) == (session_id or "").lower() for p in paths.values())
