"""Codex `PermissionRequest` hook: marks a Codex thread as waiting for an approval, for the catalog.

Codex writes no approval prompt into its rollout, so a session outside an Atlas tab could not be shown
as waiting. With this hook on (an opt-in toggle in the plugin settings; Codex asks to trust it first),
Codex runs this script before it shows an approval prompt. The script only writes
`<data folder>/codex-waits/<thread id>.json` with the time, prints nothing and exits 0: Codex then
shows its usual prompt. The catalog clears the mark once the rollout moves on (`codex_waits.py`).

Standalone, stdlib only, like `statusline.py`: Codex runs it as `python codex_hook.py <data folder>`.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timezone

FOLDER = "codex-waits"
OFF_FLAG = "codex-hook-off"        # the toggle is off but the entry stays (hooks after it keep their trust)
KEEP_DAYS = 7                      # old marks of threads that never ran again
STDIN_MAX = 1024 * 1024
UUID = re.compile(r"^[0-9a-fA-F-]{36}$")


def now_iso() -> str:
    """The rollout's own timestamp format (UTC, milliseconds, Z), so the two compare as strings."""
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def _prune(folder: str) -> None:
    cutoff = time.time() - KEEP_DAYS * 86400
    with contextlib.suppress(OSError):
        for name in os.listdir(folder):
            path = os.path.join(folder, name)
            with contextlib.suppress(OSError):
                if name.endswith(".json") and os.stat(path).st_mtime < cutoff:
                    os.remove(path)


def mark(home: str, event: dict, at: str | None = None) -> str | None:
    """Writes the mark for a PermissionRequest event; returns its path, or None for anything else."""
    if not isinstance(event, dict) or event.get("hook_event_name") != "PermissionRequest":
        return None
    if os.path.exists(os.path.join(home, OFF_FLAG)):
        return None
    sid = str(event.get("session_id") or "")
    if not UUID.match(sid):
        return None
    folder = os.path.join(home, FOLDER)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    data = {"session_id": sid, "at": at or now_iso(), "tool": str(event.get("tool_name") or "")[:80]}
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".wait-")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    path = os.path.join(folder, sid + ".json")
    os.replace(tmp, path)                       # a reader never sees half a file
    _prune(folder)
    return path


def main(argv: list[str]) -> int:
    # Never in Codex's way: whatever goes wrong, exit 0 with no output, and Codex asks as usual.
    with contextlib.suppress(Exception):
        home = argv[1] if len(argv) > 1 else os.path.expanduser("~/Library/Application Support/session-atlas")
        mark(home, json.loads(sys.stdin.read(STDIN_MAX) or "{}"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
