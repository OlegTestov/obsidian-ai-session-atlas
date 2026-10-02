"""Файлы сессии для ленты: что агент читал, правил и создавал — с сабагентами, за всю сессию.

Считается по вызовам Read / Edit / MultiEdit / Write / NotebookEdit. Файлы, изменённые
командами Bash (`sed -i`, `git checkout`), сюда не попадают — это видно в подсказке ленты.
Транскрипт дочитывается с места прошлого прохода, как в costs.py: живую сессию опрашивают
каждые несколько секунд, а файл бывает в сотни мегабайт.
"""
from __future__ import annotations

import difflib
import glob
import json
import os

TOOL_MARK = b'"tool_use"'
MAX_DIFF_LINES = 4000
_cache: dict[str, tuple] = {}         # путь → (inode, прочитано байт, {файл: счётчики}, cwd)


def _lines(text) -> list[str]:
    return str(text or "").splitlines()


def _changed_lines(old, new) -> tuple[int, int]:
    """(добавлено, удалено) строк правкой old → new."""
    a, b = _lines(old), _lines(new)
    if len(a) + len(b) > MAX_DIFF_LINES:
        return len(b), len(a)
    added = removed = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag in ("replace", "delete"):
            removed += i2 - i1
        if tag in ("replace", "insert"):
            added += j2 - j1
    return added, removed


def _note(files: dict, path: str, op: str, at: str | None, added: int = 0, removed: int = 0) -> None:
    f = files.setdefault(path, {"path": path, "read": 0, "edit": 0, "write": 0,
                                "added": 0, "removed": 0, "last_at": None})
    f[op] += 1
    f["added"] += added
    f["removed"] += removed
    if at and (f["last_at"] is None or at > f["last_at"]):
        f["last_at"] = at


def _record(files: dict, rec: dict) -> None:
    at = rec.get("timestamp")
    for block in (rec.get("message") or {}).get("content") or []:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        name, a = block.get("name"), block.get("input")
        if not isinstance(a, dict):
            continue
        path = a.get("file_path") or a.get("notebook_path")
        if not path:
            continue
        path = str(path)
        if name == "Read":
            _note(files, path, "read", at)
        elif name == "Edit":
            _note(files, path, "edit", at, *_changed_lines(a.get("old_string"), a.get("new_string")))
        elif name == "MultiEdit":
            add = rem = 0
            for e in a.get("edits") or []:
                if isinstance(e, dict):
                    x, y = _changed_lines(e.get("old_string"), e.get("new_string"))
                    add, rem = add + x, rem + y
            _note(files, path, "edit", at, add, rem)
        elif name == "NotebookEdit":
            _note(files, path, "edit", at, len(_lines(a.get("new_source"))), 0)
        elif name == "Write":
            _note(files, path, "write", at, len(_lines(a.get("content"))), 0)


def _scan(path: str) -> tuple[dict, str | None]:
    try:
        st = os.stat(path)
    except OSError:
        return {}, None
    cached = _cache.get(path)
    if cached and cached[0] == st.st_ino and cached[1] <= st.st_size:
        begin, files, cwd = cached[1], cached[2], cached[3]
    else:
        begin, files, cwd = 0, {}, None
    if begin < st.st_size:
        with open(path, "rb") as fh:
            fh.seek(begin)
            blob = fh.read()
        end = blob.rfind(b"\n") + 1               # недописанную строку — следующему проходу
        for raw in blob[:end].split(b"\n"):
            if cwd is None and b'"cwd"' in raw:
                try:
                    cwd = json.loads(raw).get("cwd")
                except ValueError:
                    pass
            if TOOL_MARK not in raw:
                continue
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            if isinstance(rec, dict) and rec.get("type") == "assistant":
                _record(files, rec)
        begin += end
    _cache[path] = (st.st_ino, begin, files, cwd)
    return files, cwd


def session_files(path: str | None) -> dict:
    """{cwd, files: [...]}: изменённые — сверху, по свежести; затем только прочитанные."""
    if not path:
        return {"cwd": None, "files": []}
    merged: dict[str, dict] = {}
    main, cwd = _scan(path)
    folder = os.path.join(path[:-len(".jsonl")], "subagents")
    sources = [main] + [_scan(p)[0] for p in glob.glob(os.path.join(glob.escape(folder), "*.jsonl"))]
    for files in sources:
        for p, f in files.items():
            m = merged.setdefault(p, {"path": p, "read": 0, "edit": 0, "write": 0,
                                      "added": 0, "removed": 0, "last_at": None})
            for k in ("read", "edit", "write", "added", "removed"):
                m[k] += f[k]
            if f["last_at"] and (m["last_at"] is None or f["last_at"] > m["last_at"]):
                m["last_at"] = f["last_at"]
    out = sorted(merged.values(), key=lambda f: f["last_at"] or "", reverse=True)
    out.sort(key=lambda f: f["edit"] + f["write"] == 0)        # устойчиво: свежесть сохраняется
    return {"cwd": cwd, "files": out}
