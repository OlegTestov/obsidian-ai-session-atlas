"""Where Claude Code keeps its data: `~/.claude`, or `CLAUDE_CONFIG_DIR` when the user moved it."""
from __future__ import annotations

import os


def claude_dir() -> str:
    return os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude")
