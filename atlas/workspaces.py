"""User-owned card layouts, stored outside the rebuildable session index."""
from __future__ import annotations

import fcntl
import json
import os
import re
import tempfile
from pathlib import Path

from .db import atlas_home

SIZE_MAX = 5
NAME_MAX = 80
BOARD_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


class Conflict(Exception):
    """A different page saved a newer layout."""


def _boards(values):
    if not isinstance(values, list):
        raise ValueError("boards")
    result = []
    ids = set()
    sessions = set()
    for board in values:
        if not isinstance(board, dict):
            raise ValueError("board")
        ident, name = board.get("id"), board.get("name")
        columns, rows, slots = board.get("columns"), board.get("rows"), board.get("slots")
        if not isinstance(ident, str) or not BOARD_ID.fullmatch(ident) or ident in ids:
            raise ValueError("id")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= NAME_MAX or not name.strip().isprintable():
            raise ValueError("name")
        if any(type(n) is not int or not 1 <= n <= SIZE_MAX for n in (columns, rows)):
            raise ValueError("size")
        if not isinstance(slots, list) or len(slots) != columns * rows:
            raise ValueError("slots")
        for sid in slots:
            if sid is None:
                continue
            if not isinstance(sid, str) or not 1 <= len(sid) <= 200 or not sid.isprintable() or sid in sessions:
                raise ValueError("session id")
            sessions.add(sid)
        ids.add(ident)
        result.append({"id": ident, "name": name.strip(), "columns": columns, "rows": rows, "slots": slots})
    return result


def _read(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"revision": 0, "boards": []}
    if not isinstance(value, dict) or type(value.get("revision")) is not int or value["revision"] < 0:
        raise ValueError("workspace file")
    return {"revision": value["revision"], "boards": _boards(value.get("boards"))}


def read() -> dict:
    return _read(Path(atlas_home()) / "workspaces.json")


def save(revision: int, boards: list) -> dict:
    if type(revision) is not int or revision < 0:
        raise ValueError("revision")
    clean = _boards(boards)
    home = Path(atlas_home())
    path = home / "workspaces.json"
    with open(home / "workspaces.lock", "ab") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        current = _read(path)
        if current["revision"] != revision:
            raise Conflict
        if clean == current["boards"]:
            return current
        value = {"revision": revision + 1, "boards": clean}
        # Keep a previous snapshot readable until the replacement is fully written.
        with tempfile.NamedTemporaryFile(dir=home, prefix=".workspaces-", delete=False) as output:
            temporary = output.name
            try:
                output.write(json.dumps(value, ensure_ascii=False).encode("utf-8"))
                output.flush()
                os.fsync(output.fileno())
                os.replace(temporary, path)
            finally:
                Path(temporary).unlink(missing_ok=True)
        return value
