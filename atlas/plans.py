"""Plan text for the "plan ready" dialog: `~/.claude/plans/<slug>.md`.

The file is written before the dialog, and Claude Code writes the session slug into every
transcript entry. A path from the tab's screen also works, but only as a file name inside
the plans folder.
"""
from __future__ import annotations

import os
import re

from . import paths

PLANS_DIR = os.path.join(paths.claude_dir(), "plans")
NAME = re.compile(r"[\w.-]+\.md")
SLUG = re.compile(rb'"slug"\s*:\s*"([\w.-]+)"')
TAIL = 512 * 1024
MAX_CHARS = 100_000


def _slug(transcript: str) -> str | None:
    try:
        size = os.path.getsize(transcript)
        with open(transcript, "rb") as fh:
            fh.seek(max(0, size - TAIL))
            found = SLUG.findall(fh.read())
    except OSError:
        return None
    return found[-1].decode() if found else None


def plan_text(transcript: str | None, screen_path: str | None = None,
              plans_dir: str | None = None) -> dict | None:
    """{name, text, truncated} or None. The on-screen name goes first: it is the plan in the dialog."""
    folder = plans_dir or PLANS_DIR
    names = []
    if screen_path:
        name = os.path.basename(screen_path)
        if NAME.fullmatch(name) and screen_path.startswith("~/.claude/plans/"):
            names.append(name)
    slug = _slug(transcript) if transcript else None
    if slug:
        names.append(slug + ".md")
    for name in names:
        path = os.path.join(folder, name)
        try:
            with open(path, encoding="utf-8") as fh:
                text = fh.read(MAX_CHARS + 1)
        except OSError:
            continue
        return {"name": name, "text": text[:MAX_CHARS], "truncated": len(text) > MAX_CHARS}
    return None
