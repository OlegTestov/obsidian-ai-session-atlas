"""Where the agents keep their data: `~/.claude` (or `CLAUDE_CONFIG_DIR`) and `~/.codex` (or `CODEX_HOME`)."""
from __future__ import annotations

import os


def claude_dir() -> str:
    return os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude")


def codex_dir() -> str:
    return os.path.expanduser(os.environ.get("CODEX_HOME") or "~/.codex")
