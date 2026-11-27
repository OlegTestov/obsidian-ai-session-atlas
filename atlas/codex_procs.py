"""Live Codex processes: which interactive `codex` runs which thread.

Codex writes no per-process state file (Claude Code writes ~/.claude/sessions/<pid>.json), but an
interactive `codex` keeps its rollout open for the whole thread, so `lsof` maps a process to it.
`codex exec`, the app server and helper processes are not human tabs and are skipped.
"""
from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import time

from . import agents, codex_parse, codex_rollouts, index
from .codex_rollouts import session_meta as session_meta

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
LSOF = shutil.which("lsof") or "/usr/sbin/lsof"
LSOF_TIMEOUT = 3.0
# `/new` and `/resume` inside the terminal UI switch the thread without a new process.
MAP_TTL = 10.0

def _run(cmd: list[str], **kw):
    """The one place a process is started; tests replace it with fake `lsof` output."""
    return subprocess.run(cmd, **kw)


_map_cache: dict[tuple, tuple] = {}         # (home, pid, start) → (checked at, rollout, pending cwd, had rollout)
_open_cache: dict[tuple, list] = {}         # (home, pid, start) → rollouts observed at that check


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


def _process_files(pids, run) -> tuple[dict, dict] | None:
    """One lsof for all PIDs: rollouts and cwd by PID."""
    pids = sorted(set(pids))
    if not pids:
        return {}, {}
    try:
        out = (run or _run)([LSOF, "-w", "-n", "-P", "-F", "pfna", "-p", ",".join(map(str, pids))],
                  capture_output=True, text=True, timeout=LSOF_TIMEOUT).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    found: dict[int, dict[str, bool]] = {}
    cwd: dict[int, str] = {}
    pid = None
    fd = ""
    writable = False
    for line in (out or "").splitlines():
        if line.startswith("p") and line[1:].isdigit():
            pid = int(line[1:])
            found.setdefault(pid, {})
            fd = ""
            writable = False
        elif line.startswith("f"):
            fd = line[1:]
            writable = False
        elif line.startswith("a"):
            writable = line[1:] in ("w", "u")
        elif line.startswith("n") and pid is not None:
            path = line[1:]
            if fd == "cwd":
                if os.path.isabs(path):
                    cwd[pid] = path
            elif codex_parse.session_id_of(path):
                found[pid][path] = writable or found[pid].get(path, False)
    return found, cwd


def _rollouts_in_home(found: dict, home: str) -> dict:
    return {pid: {path: writable for path, writable in paths.items() if _inside(path, home)}
            for pid, paths in found.items()}


def thread_id(path: str) -> str | None:
    return codex_parse.session_id_of(path) or session_meta(path).get("id")


def _root_head(path: str, opened: dict, home: str) -> str | None:
    seen = {thread_id(path)}
    while session_meta(path).get("subagent"):
        parent = session_meta(path).get("parent")
        if not parent or parent in seen:
            return None
        seen.add(parent)
        path = opened.get(parent) or codex_rollouts.select(all_rollouts(parent, home), allow_subagent=True)
        if not path:
            return None
    return find_rollout(thread_id(path), home)


def restore_thread(session_id: str, home: str) -> tuple[str | None, str | None]:
    """Resolve a saved tab id, including ids recorded when a child owned its parent's card."""
    path = codex_rollouts.select(all_rollouts(session_id, home), allow_subagent=True)
    if not path or not session_meta(path).get("subagent"):
        return session_id, None
    head = _root_head(path, {}, home)
    return (thread_id(head), head) if head else (None, None)


def _open_head(paths: dict[str, bool], resume_id: str | None = None) -> str | None:
    human = [p for p in paths if os.path.isfile(p) and not session_meta(p).get("subagent")]
    return max(human, key=lambda p: (
        paths[p], thread_id(p) == resume_id if not paths[p] else False,
        codex_rollouts.mtime(p), thread_id(p) == resume_id, p,
    ), default=None)


def main_rollout(paths: dict[str, bool], resume_id: str | None = None, home: str | None = None) -> str | None:
    """Prefer an open human rollout. If only children are open, find their root on disk."""
    if not paths or any(not session_meta(p).get("subagent") for p in paths):
        return _open_head(paths, resume_id)
    home = home or index.codex_home()
    opened = {thread_id(p): p for p in paths}
    for path in sorted(paths, key=lambda p: (paths[p], codex_rollouts.mtime(p)), reverse=True):
        head = _root_head(path, opened, home)
        if head:
            return head
    return None


def find_rollout(session_id: str | None, home: str | None = None) -> str | None:
    """The selected human rollout, from Codex's own state or the latest write."""
    if not agents.valid_id(agents.CODEX, session_id):
        return None
    home = home or index.codex_home()
    paths = all_rollouts(session_id, home)
    if not paths:
        return None
    copies, saved = codex_rollouts.saved_copy(paths, codex_parse.selected_paths(home, session_id).get(session_id), home)
    return codex_rollouts.select(copies, saved)


def selected_rollout(session_id: str, home: str | None = None, table: dict | None = None) -> str | None:
    """A recently observed live writer takes priority for transcript views."""
    home = home or index.codex_home()
    if table is not None:
        rollouts_for(table, home=home)
    now = time.monotonic()
    held = [path for key, (checked, path, _, _) in _map_cache.copy().items()
            if key[0] == home and path in _open_cache.get(key, ()) and now - checked <= MAP_TTL
            and thread_id(path) == session_id]
    return codex_rollouts.select(held) or find_rollout(session_id, home)


def all_rollouts(session_id: str, home: str | None = None) -> list[str]:
    return codex_rollouts.all_rollouts(session_id, home or index.codex_home())


def _resume_id(command: str) -> str | None:
    """Only an explicit resume id, never a UUID mentioned in a prompt or a fork's source."""
    parts = (command or "").split()
    skip = False
    for i, word in enumerate(parts[1:], 1):
        if skip:
            skip = False
        elif word.startswith("-"):
            skip = word in VALUE_FLAGS
        else:
            if word == "resume" and i + 1 < len(parts) and agents.valid_id(agents.CODEX, parts[i + 1]):
                return parts[i + 1]
            return None
    return None


def _from_argv(command: str, home: str) -> str | None:
    return find_rollout(_resume_id(command), home)


def rollouts_for(table: dict, run=None, home: str | None = None, fresh: bool = False,
                 now: float | None = None, pending_cwds: dict[int, str] | None = None) -> dict[int, str]:
    """Map interactive Codex processes to rollouts and optionally collect cwd for pending cards."""
    home = home or index.codex_home()
    now = time.monotonic() if now is None else now
    live = interactive_pids(table)
    keys = {pid: (home, pid, start) for pid, start in live.items()}
    stale = [pid for pid, key in keys.items()
             if fresh or key not in _map_cache or now - _map_cache[key][0] > MAP_TTL]
    if stale:
        # A modern CLI delegates to a shared daemon. Its explicit resume id can be displayed
        # only while that exact file is open there; never choose the daemon's newest file.
        daemons = [pid for pid, row in table.items() if len(row) > 2
                   and len(row[2].split()) > 1 and BINARY.search(row[2].split()[0])
                   and row[2].split()[1] == "app-server"]
        resume_ids = {pid: _resume_id(table[pid][2]) for pid in stale}
        candidates = daemons if any(resume_ids.values()) else []
        files = _process_files(stale + candidates, run)
        all_files, cwd = files if files is not None else ({}, {})
        found = _rollouts_in_home(all_files, home)
        shared = {}
        for pid in candidates:
            for p, writable in found.get(pid, {}).items():
                shared[p] = writable or shared.get(p, False)
        for pid in stale:
            if files is not None:
                opened = found.get(pid, {})
                resume_id = resume_ids[pid]
                own = [p for p in opened if not session_meta(p).get("subagent")]
                resumed = {p: shared[p] for p in shared if resume_id and thread_id(p) == resume_id}
                path = main_rollout(opened, resume_id, home)
                if not own and resumed:
                    path = _open_head(resumed) or path
                only_children = bool(opened) and not own and len(opened) == len(all_files.get(pid, []))
                previous = _map_cache.get(keys[pid])
                had_rollout = not only_children and bool(path or all_files.get(pid) or (previous and previous[3]))
                _map_cache[keys[pid]] = (now, path, cwd.get(pid), had_rollout)
                _open_cache[keys[pid]] = list(opened) + ([path] if path in resumed and path not in opened else [])
            elif keys[pid] not in _map_cache:      # keep an older answer; retried next time
                path = _from_argv(table[pid][2], home)
                _map_cache[keys[pid]] = (0.0, path, None, bool(path))
    for key in [k for k in _map_cache if k[0] == home and k not in keys.values()]:
        del _map_cache[key]                         # the process is gone
        _open_cache.pop(key, None)
    # A client of the shared daemon or of a --remote server never holds its rollout, so its
    # placeholder would never turn into a card. Atlas tabs start Codex with --no-daemon.
    shared_daemon = any(len(row) > 2 and _is_shared_daemon(row[2]) for row in table.values())
    paths = {}
    for pid, key in keys.items():
        _, path, folder, had_rollout = _map_cache[key]
        if path:
            paths[pid] = path
        elif pending_cwds is not None and folder and not had_rollout \
                and _owns_rollouts(table[pid][2], shared_daemon):
            pending_cwds[pid] = folder
    return paths


def _owns_rollouts(command: str, shared_daemon: bool) -> bool:
    words = command.split()
    if any(w == "--remote" or w.startswith("--remote=") for w in words):
        return False
    return not shared_daemon or "--no-daemon" in words


def _is_shared_daemon(command: str) -> bool:
    parts = command.split()
    return len(parts) > 1 and bool(BINARY.search(parts[0])) and parts[1] == "app-server" \
        and "--managed-daemon" in parts


def subagent_rollouts(pid: int, table: dict, session_id: str, home: str | None = None) -> list[str]:
    """Subagent threads of this thread the process held open at its last check (rollouts_for).
    A subagent's own subagents count too: each names its parent, up to this thread."""
    row = table.get(pid)
    paths = _open_cache.get((home or index.codex_home(), pid, row[1]), []) if row else []
    parents = {thread_id(p): session_meta(p).get("parent") for p in paths if session_meta(p).get("subagent")}
    sid = (session_id or "")

    def under(tid: str) -> bool:
        seen = set()
        while tid and tid not in seen:
            seen.add(tid)
            tid = parents.get(tid)
            if tid == sid:
                return True
        return False
    return [p for p in paths if session_meta(p).get("subagent") and under(thread_id(p))]


def subagents_on_disk(session_id: str, home: str | None = None, now: float | None = None) -> list[str]:
    """Subagent rollouts of this thread started today or yesterday, whichever process writes them: a
    Codex started outside an Atlas tab runs its threads in the app-server daemon, not in the process
    the card follows, so the open files of that process do not show them."""
    home = home or index.codex_home()
    now = time.time() if now is None else now
    paths = []
    for day in sorted({time.strftime("%Y/%m/%d", time.localtime(now - back)) for back in (0, 86400)}):
        paths += glob.glob(os.path.join(glob.escape(home), "sessions", day, "rollout-*.jsonl"))
    subs = [p for p in paths if session_meta(p).get("subagent")]
    parents = {thread_id(p): session_meta(p).get("parent") for p in subs}
    sid = (session_id or "")

    def under(tid: str) -> bool:
        seen = set()
        while tid and tid not in seen:
            seen.add(tid)
            tid = parents.get(tid)
            if tid == sid:
                return True
        return False
    return [p for p in subs if under(thread_id(p))]


def owner_rollout(pid: int, session_id: str, table: dict, run=None, home: str | None = None) -> str | None:
    """This exact process runs this thread now: checked with a fresh lsof."""
    if pid not in interactive_pids(table):
        return None
    home = home or index.codex_home()
    files = _process_files([pid], run)
    if files is None:
        return None
    opened = _rollouts_in_home(files[0], home).get(pid, {})
    path = main_rollout(opened, _resume_id(table[pid][2]), home)
    return path if path and thread_id(path) == session_id else None


def owner(pid: int, session_id: str, table: dict, run=None, home: str | None = None) -> bool:
    return bool(owner_rollout(pid, session_id, table, run, home))


def _codex_pids(table: dict) -> list[int]:
    return [pid for pid, row in table.items() if len(row) > 2
            and (words := row[2].split()) and BINARY.search(words[0])]


def running(session_id: str, table: dict, run=None, home: str | None = None) -> bool:
    """Guard file mutations using every open rollout, including those held by a daemon."""
    home = home or index.codex_home()
    files = _process_files(_codex_pids(table), run)
    if files is None:
        return True             # a failed inspection cannot establish that deletion is safe
    return _held(session_id, _rollouts_in_home(files[0], home).values(), home)


def move_owner(pid: int, session_id: str, table: dict, run=None) -> tuple[str | None, bool]:
    """Read the current owner and all other holders from the same lsof snapshot."""
    if pid not in interactive_pids(table):
        return None, False
    home = index.codex_home()
    files = _process_files(_codex_pids(table), run)
    if files is None:
        return None, False
    opened = _rollouts_in_home(files[0], home)
    path = main_rollout(opened.pop(pid, {}), _resume_id(table[pid][2]), home)
    if path and thread_id(path) == session_id:
        return path, _held(session_id, opened.values(), home)
    return None, False


def _held(session_id, processes, home):
    for opened in processes:
        if any(thread_id(path) == session_id for path in opened):
            return True
        by_thread = {thread_id(path): path for path in opened}
        for path in opened:
            if session_meta(path).get("parent"):
                root = _root_head(path, by_thread, home)
                if root and thread_id(root) == session_id:
                    return True     # deletion also removes the root thread's child rollouts
    return False
