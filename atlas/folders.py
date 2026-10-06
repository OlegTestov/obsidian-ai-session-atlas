"""The folder field of "+ Session": what was typed or pasted, resolved and checked, and the folders
that continue it, for suggestions while typing.

The field takes an absolute path, `~/…`, or the vault form `<vault id>/…` (how folders are shown).
Only directories are listed, hidden ones never; the final folder must exist and be a directory.
"""
from __future__ import annotations

import os

from . import config
from .messages import msg

MAX_TEXT = 4096
SCAN_LIMIT = 2000       # entries read from one folder: a huge folder must not stall the field
LIST_LIMIT = 50
# Temporary and system folders are not opened as a new session.
SKIP_PREFIXES = ("/tmp/", "/private/tmp/", "/var/tmp/", "/private/var/tmp/", "/System/")


class FolderError(ValueError):
    """The message is shown to the user as is."""


def _home() -> str:
    return os.path.expanduser("~")


def roots() -> list[dict]:
    """Quick picks: every vault root, then the home folder."""
    out = [{"kind": "vault", "path": path, "text": vault_id} for path, vault_id in config.vaults()]
    return [*out, {"kind": "home", "path": _home(), "text": "~"}]


def field_text(path: str) -> str:
    """The form the field shows: `<vault id>/…` inside a vault, `~/…` inside home, else the path."""
    for vault, vault_id in config.vaults():
        if path == vault:
            return vault_id
        if path.startswith(vault + os.sep):
            return f"{vault_id}/" + path[len(vault) + 1:]
    home = _home()
    if path == home:
        return "~"
    return "~" + path[len(home):] if path.startswith(home + os.sep) else path


def _expanded(text: str) -> str | None:
    """Absolute path for the typed text; None when it is relative and names no vault."""
    if text == "~" or text.startswith("~/"):
        return _home() + text[1:]
    if text.startswith("/"):
        return text
    head, _, rest = text.partition("/")
    for vault, vault_id in config.vaults():
        if head == vault_id:
            return os.path.join(vault, rest) if rest else vault
    return None


def resolve(text) -> str:
    """Absolute, normalized path for the typed text; whether it exists is `check`'s business."""
    if not isinstance(text, str):
        raise FolderError(msg("folder.not_text"))
    text = text.strip()
    if not text:
        raise FolderError(msg("folder.empty"))
    if len(text) > MAX_TEXT or any(ord(c) < 32 or ord(c) == 127 for c in text):
        raise FolderError(msg("folder.bad_chars"))
    path = _expanded(text)
    if path is None:
        names = ", ".join(vault_id for _, vault_id in config.vaults())
        raise FolderError(msg("folder.relative_vaults", names=names) if names else msg("folder.relative"))
    # `..` would walk out of a vault or past what the field shows; the folder itself is typed instead.
    if ".." in path.split("/"):
        raise FolderError(msg("folder.dotdot"))
    return os.path.normpath(path)


def check(text) -> str:
    """The folder a session may start in: resolved, existing, a directory, not temporary."""
    path = resolve(text)
    if not os.path.exists(path):
        raise FolderError(msg("folder.missing", path=field_text(path)))
    if not os.path.isdir(path):
        raise FolderError(msg("folder.not_dir", path=field_text(path)))
    if (path + "/").startswith(SKIP_PREFIXES):
        raise FolderError(msg("folder.temp"))
    return path


def subfolders(base: str, fragment: str = "") -> list[dict]:
    """Directories in `base` whose name starts with, then contains, the fragment (any case)."""
    found = []
    try:
        with os.scandir(base) as it:
            for n, entry in enumerate(it):
                if n >= SCAN_LIMIT:
                    break
                if entry.name.startswith("."):
                    continue
                try:
                    if entry.is_dir():
                        found.append(entry.name)
                except OSError:
                    continue
    except OSError:
        return []
    frag = fragment.casefold()
    starts = sorted((n for n in found if n.casefold().startswith(frag)), key=str.casefold)
    inside = sorted((n for n in found if frag and frag in n.casefold() and n not in starts), key=str.casefold)
    out = []
    for name in (starts + inside)[:LIST_LIMIT]:
        path = os.path.join(base, name)
        out.append({"name": name, "path": path, "text": field_text(path)})
    return out


def suggest(text) -> dict:
    """What the field holds now and the folders that continue it.

    After a trailing slash (or at a root: `~`, a vault, `/`) the typed folder's subfolders are
    listed; otherwise its siblings matching the last part, as a shell completes a path.
    """
    out = {"text": text if isinstance(text, str) else "", "folder": None, "error": None, "dirs": []}
    raw = out["text"].strip()
    if not raw:
        return out
    try:
        path = resolve(raw)
    except FolderError as exc:
        # A first word that begins a vault name is a vault being typed, not a mistake.
        if "/" not in raw:
            hits = [r for r in roots() if r["kind"] == "vault" and r["text"].casefold().startswith(raw.casefold())]
            if hits:
                out["dirs"] = [{"name": r["text"], "path": r["path"], "text": r["text"]} for r in hits]
                return out
        out["error"] = str(exc)
        return out
    try:
        out["folder"] = {"path": check(raw), "text": field_text(path)}
    except FolderError as exc:
        out["error"] = str(exc)
    at_root = raw.endswith("/") or path == "/" or field_text(path) in {r["text"] for r in roots()}
    if at_root:
        out["dirs"] = subfolders(path) if os.path.isdir(path) else []
    else:
        out["dirs"] = subfolders(os.path.dirname(path), os.path.basename(path))
    return out
