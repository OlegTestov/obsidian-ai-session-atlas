"""Codex skills by the names Codex itself gives them: for the `$` list in a reply box and for Statistics.

Codex names a skill by the `name:` in its SKILL.md (the folder name without one), wherever it sits:
`~/.agents/skills/gstack/browse/SKILL.md` is `browse`, `$CODEX_HOME/skills/.system/imagegen` is
`imagegen`, and a plugin's skill gets the plugin's name in front (`figma:figma-use`). Each session
starts with Codex's own "Available skills" list in a developer message; the `$` list takes it from the
newest rollout, and falls back to the skill folders when there is none. Everything is read only.
"""
from __future__ import annotations

import glob
import json
import os
import re
import shlex
from functools import lru_cache

from .commands import _frontmatter, _short

# One line of Codex's list: "- name: description (file: r1/gstack/browse/SKILL.md)".
LISTED = re.compile(r"^- ([^\s:][^\n]*?): (.*?) \(file: [^)\n]*SKILL\.md\)\s*$", re.M)
PLUGIN = re.compile(r"/plugins/cache/[^/]+/([^/]+)/")
READERS = {"cat", "sed", "head", "tail", "nl", "less", "more", "bat", "awk"}
SEPARATORS = re.compile(r"&&|\|\||[;|\n]")
HEAD_LINES = 40                    # the list comes in the first developer messages
HEAD_BYTES = 8 * 1024 * 1024
FOLDER_DEPTH = 5


@lru_cache(maxsize=512)
def _declared(path: str) -> str | None:
    return _frontmatter(path).get("name") if os.path.isabs(path) else None


def name_for(path: str) -> str | None:
    """The skill a SKILL.md path is, named as Codex names it; None for any other file."""
    path = os.path.expanduser(path.strip("'\""))
    if os.path.basename(path) != "SKILL.md" or not os.path.dirname(path):
        return None
    name = _declared(path) or os.path.basename(os.path.dirname(path))
    if not name or name.startswith("."):
        return None
    plugin = PLUGIN.search(path)
    return f"{plugin.group(1)}:{name}" if plugin and ":" not in name else name


def read_in(command: str) -> list[str]:
    """Skills whose SKILL.md this shell command reads: not written (`sed -i`, `>`), not just named."""
    out = []
    for part in SEPARATORS.split(command or ""):
        try:
            words = shlex.split(part)
        except ValueError:
            words = part.split()
        if not words or os.path.basename(words[0]) not in READERS:
            continue
        if any(w.startswith((">", "1>", "2>")) or ">" in w for w in words[1:]) \
                or (os.path.basename(words[0]) == "sed" and any(w.startswith(("-i", "--in-place")) for w in words)):
            continue
        out += [n for n in (name_for(w) for w in words[1:] if w.endswith("SKILL.md")) if n and n not in out]
    return out


def _newest_rollout(home: str) -> str | None:
    days = sorted(glob.glob(os.path.join(glob.escape(home), "sessions", "*", "*", "*")), reverse=True)
    for day in days[:7]:
        files = glob.glob(os.path.join(glob.escape(day), "rollout-*.jsonl"))
        if files:
            return max(files, key=lambda p: os.stat(p).st_mtime)
    return None


def _from_rollout(path: str) -> list[dict]:
    """Codex's own list, from a developer message near the top. Other records name "Available skills"
    too (session_meta's base instructions, an instruction about skills) without listing any."""
    try:
        with open(path, "rb") as fh:
            for _ in range(HEAD_LINES):
                raw = fh.readline(HEAD_BYTES)
                if not raw:
                    break
                if b"Available skills" not in raw:
                    continue
                try:
                    rec = json.loads(raw)
                except ValueError:
                    continue
                payload = rec.get("payload") if isinstance(rec, dict) else None
                if not isinstance(rec, dict) or rec.get("type") != "response_item" or not isinstance(payload, dict) \
                        or payload.get("type") != "message" or payload.get("role") != "developer":
                    continue
                content = payload.get("content") if isinstance(payload.get("content"), list) else []
                text = "\n".join(str(c.get("text") or "") for c in content if isinstance(c, dict))
                found = [{"name": n.strip(), "description": _short(d)} for n, d in LISTED.findall(text)]
                if found:
                    return found
    except OSError:
        pass
    return []


def _from_folders(roots: list[str]) -> list[dict]:
    """Every SKILL.md under the roots, nested and hidden folders too (`gstack/browse`, `.system/imagegen`)."""
    out = []
    for root in roots:
        for folder, dirs, files in os.walk(root, followlinks=True):     # a skill folder may be a link
            dirs.sort()
            if os.path.relpath(folder, root).count(os.sep) >= FOLDER_DEPTH:
                dirs[:] = []
            name = name_for(os.path.join(folder, "SKILL.md")) if "SKILL.md" in files and folder != root else None
            if name:
                md = os.path.join(folder, "SKILL.md")
                out.append({"name": name, "description": _short(_frontmatter(md).get("description", ""))})
    return out


def available(home: str, roots: list[str]) -> list[dict]:
    """[{name, description}] as Codex lists them; the first of a name wins."""
    newest = _newest_rollout(home)
    found = (_from_rollout(newest) if newest else []) or _from_folders(roots)
    out, seen = [], set()
    for skill in found:
        if skill["name"] not in seen:
            seen.add(skill["name"])
            out.append(skill)
    return out
