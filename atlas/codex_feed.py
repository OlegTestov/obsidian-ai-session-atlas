"""The feed for a Codex thread: its rollout turned into the records the Claude Code feed reads.

`feed.build` understands user/assistant records with text, `tool_use` and `tool_result` blocks.
A Codex rollout reports prompts, agent messages, shell commands with exit codes and applied patches
as events; converting them keeps one feed for both agents: turns, steps, paging by time, the
conversation tail. Session files (the feed's "files" view) come from patches and parsed commands.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
from datetime import datetime, timedelta, timezone

from . import codex_parse

# Reasoning and message items (they carry base64 images) are never needed here: skipped undecoded.
_SKIP = re.compile(rb'"payload":\s*\{"type":\s*"(?:message|reasoning)"'
                   rb'|"item":\s*\{"type":\s*"(?:Reasoning|ImageView)"')
_EXIT = re.compile(r"Process exited with code (-?\d+)")
INTERRUPTED = "[Request interrupted by user]"
ERROR_TAIL = 400


def _ts(ms) -> str | None:
    if not isinstance(ms, (int, float)):
        return None
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds")


def _minus(ts: str | None, duration) -> str | None:
    """Start time of a call from its end time and Codex's {secs, nanos} duration."""
    if not ts or not isinstance(duration, dict):
        return ts
    try:
        end = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return ts
    took = float(duration.get("secs") or 0) + float(duration.get("nanos") or 0) / 1e9
    return (end - timedelta(seconds=took)).isoformat(timespec="milliseconds")


def _command(cmd) -> str:
    return codex_parse._shell_command({"command": cmd}) or ""


def _user(ts, content) -> dict:
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": content}}


def _assistant(ts, blocks: list) -> dict:
    return {"type": "assistant", "timestamp": ts, "message": {"role": "assistant", "content": blocks}}


def _call(ts, call_id, name, args) -> dict:
    return _assistant(ts, [{"type": "tool_use", "id": call_id, "name": name, "input": args}])


def _result(ts, call_id, error: str | None = None) -> dict:
    block = {"type": "tool_result", "tool_use_id": call_id, "content": error or "ok"}
    if error is not None:
        block["is_error"] = True
    return _user(ts, [block])


def _failure(code, output) -> str | None:
    if code in (None, 0):
        return None
    tail = str(output or "").strip()[-ERROR_TAIL:]
    return f"exit {code}" + (f": {tail}" if tail else "")


class Converter:
    """Rollout records in file order → Claude-shaped records. One instance per window."""

    def __init__(self) -> None:
        self.calls: set[str] = set()          # call ids whose start is already emitted
        self.ended: set[str] = set()
        self.last = {"user": None, "assistant": None}   # dedupe the event and item copies

    def _text(self, role: str, ts, text: str, images: int = 0) -> list[dict]:
        text = (text or "").strip()
        if not text or self.last[role] == text:
            return []
        self.last[role] = text
        self.last["assistant" if role == "user" else "user"] = None   # a real repeat comes after a reply
        if role == "user":
            blocks = [{"type": "text", "text": text}] + [{"type": "image"}] * images
            return [_user(ts, blocks)]
        return [_assistant(ts, [{"type": "text", "text": text}])]

    def _end(self, ts, call_id, error) -> list[dict]:
        if call_id in self.ended:
            return []
        self.ended.add(call_id)
        return [_result(ts, call_id, error)]

    def _shell(self, start, end, call_id, cmd, error) -> list[dict]:
        out = [] if call_id in self.calls else [_call(start, call_id, "Bash", {"command": cmd})]
        self.calls.add(call_id)
        return out + self._end(end, call_id, error)

    def _patch(self, ts, call_id, changes, error) -> list[dict]:
        if call_id in self.ended or not isinstance(changes, dict):
            return []
        self.ended.add(call_id)
        out = []
        for i, (path, change) in enumerate(changes.items()):
            kind = change.get("type") if isinstance(change, dict) else None
            cid = f"{call_id}:{i}"
            out += [_call(ts, cid, "Write" if kind == "add" else "Edit", {"file_path": path}),
                    _result(ts, cid, error)]
        return out

    def event(self, ts, p: dict) -> list[dict]:
        kind = p.get("type")
        if kind == "user_message":
            images = sum(len(p.get(k) or []) for k in ("images", "local_images") if isinstance(p.get(k), list))
            return self._text("user", ts, p.get("message"), images)
        if kind == "agent_message":
            return self._text("assistant", ts, p.get("message"))
        if kind == "task_complete":
            return self._text("assistant", ts, p.get("last_agent_message"))
        if kind == "turn_aborted":
            return [_user(ts, INTERRUPTED)]
        if kind == "exec_command_end":
            call_id = str(p.get("call_id") or f"x{ts}")
            return self._shell(_minus(ts, p.get("duration")), ts, call_id, _command(p.get("command")),
                               _failure(p.get("exit_code"), p.get("stderr") or p.get("aggregated_output")))
        if kind == "patch_apply_end":
            return self._patch(ts, str(p.get("call_id") or f"p{ts}"), p.get("changes"),
                               None if p.get("success") is not False else (p.get("stderr") or "failed"))
        if kind != "item_completed" or not isinstance(p.get("item"), dict):
            return []
        item = p["item"]
        itype = item.get("type")
        if itype in ("UserMessage", "AgentMessage"):
            role = "user" if itype == "UserMessage" else "assistant"
            content = item.get("content") if isinstance(item.get("content"), list) else []
            images = sum(1 for b in content if isinstance(b, dict) and str(b.get("type", "")).lower() != "text")
            return self._text(role, ts, codex_parse._texts(content, "text"), images if role == "user" else 0)
        end = _ts(p.get("completed_at_ms")) or ts
        if itype == "CommandExecution":
            return self._shell(_ts(p.get("started_at_ms")) or end, end, str(item.get("id") or f"c{ts}"),
                               _command(item.get("command")),
                               _failure(item.get("exit_code"), item.get("aggregated_output")))
        if itype == "FileChange":
            return self._patch(end, str(item.get("id") or f"f{ts}"), item.get("changes"),
                               None if item.get("status") != "failed" else "failed")
        return []

    def response(self, ts, p: dict) -> list[dict]:
        kind = p.get("type")
        call_id = str(p.get("call_id") or p.get("id") or "")
        name = str(p.get("name") or "?")
        if kind == "function_call":
            try:
                args = json.loads(p.get("arguments") or "{}")
            except (TypeError, ValueError):
                args = {}
            args = args if isinstance(args, dict) else {}
            if name == "apply_patch":
                return []                               # reported by patch_apply_end
            self.calls.add(call_id)
            if name in codex_parse.SHELL_CALLS:
                return [_call(ts, call_id, "Bash", {"command": codex_parse._shell_command(args) or ""})]
            return [_call(ts, call_id, name, args)]
        if kind == "custom_tool_call":
            if name in ("apply_patch", "exec"):         # patches and commands report their own ends
                return []
            self.calls.add(call_id)
            return [_call(ts, call_id, name, {"input": str(p.get("input") or "")[:300]})]
        if kind in ("function_call_output", "custom_tool_call_output") and call_id in self.calls:
            output = p.get("output")
            text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
            m = _EXIT.search(text[:600])
            return self._end(ts, call_id, _failure(int(m.group(1)), "") if m else None)
        if kind == "web_search_call":
            action = p.get("action") if isinstance(p.get("action"), dict) else {}
            cid = call_id or f"w{ts}"
            return [_call(ts, cid, "WebSearch", {"query": action.get("query") or ""}), _result(ts, cid)]
        return []

    def convert(self, rec: dict) -> list[dict]:
        ts = rec.get("timestamp") if isinstance(rec.get("timestamp"), str) else None
        p = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
        if rec.get("type") == "event_msg":
            return self.event(ts, p)
        if rec.get("type") == "response_item":
            return self.response(ts, p)
        return []


def records(lines: list[bytes]) -> list[dict]:
    """Raw rollout lines (the window's first, cut line already dropped) → Claude-shaped records."""
    conv = Converter()
    out: list[dict] = []
    for raw in lines:
        if not raw or _SKIP.search(raw, 0, 480):
            continue
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        if isinstance(rec, dict):
            out += conv.convert(rec)
    return out


# --- session files ---

_FILE_MARKS = (b'"patch_apply_end"', b'"FileChange"', b'"parsed_cmd"')
_cache: dict[str, tuple] = {}         # path → (inode, bytes read, {file: counters}, cwd)


def _note(files: dict, path: str, op: str, at, added: int = 0, removed: int = 0) -> None:
    f = files.setdefault(path, {"path": path, "read": 0, "edit": 0, "write": 0,
                                "added": 0, "removed": 0, "last_at": None})
    f[op] += 1
    f["added"] += added
    f["removed"] += removed
    if at and (f["last_at"] is None or at > f["last_at"]):
        f["last_at"] = at


def _changes(files: dict, changes, at, failed: bool) -> None:
    if failed or not isinstance(changes, dict):
        return
    for path, change in changes.items():
        change = change if isinstance(change, dict) else {}
        added, removed = codex_parse._diff_lines(change)
        _note(files, str(path), "write" if change.get("type") == "add" else "edit", at, added, removed)


def _reads(files: dict, parsed, at) -> None:
    for part in parsed if isinstance(parsed, list) else []:
        if isinstance(part, dict) and part.get("type") == "read" and part.get("path"):
            _note(files, str(part["path"]), "read", at)


def _file_record(files: dict, rec: dict) -> None:
    at = rec.get("timestamp")
    p = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
    kind = p.get("type")
    if kind == "patch_apply_end":
        _changes(files, p.get("changes"), at, p.get("success") is False)
    elif kind == "exec_command_end":
        _reads(files, p.get("parsed_cmd"), at)
    elif kind == "item_completed" and isinstance(p.get("item"), dict):
        item = p["item"]
        if item.get("type") == "FileChange":
            _changes(files, item.get("changes"), at, item.get("status") == "failed")
        elif item.get("type") == "CommandExecution":
            _reads(files, item.get("parsed_cmd"), at)


def session_files(path: str) -> dict:
    """{cwd, files}: like `touched.session_files`; read from where the last pass stopped."""
    try:
        st = os.stat(path)
    except OSError:
        return {"cwd": None, "files": []}
    cached = _cache.get(path)
    if cached and cached[0] == st.st_ino and cached[1] <= st.st_size:
        begin, files, cwd = cached[1], cached[2], cached[3]
    else:
        begin, files, cwd = 0, {}, None
    if begin < st.st_size:
        with open(path, "rb") as fh:
            fh.seek(begin)
            blob = fh.read()
        end = blob.rfind(b"\n") + 1               # leave a partial line to the next pass
        for raw in blob[:end].split(b"\n"):
            if cwd is None and b'"session_meta"' in raw[:200]:
                with contextlib.suppress(ValueError, AttributeError):
                    cwd = json.loads(raw)["payload"].get("cwd")
            if not any(m in raw for m in _FILE_MARKS) or _SKIP.search(raw, 0, 480):
                continue
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            if isinstance(rec, dict):
                _file_record(files, rec)
        begin += end
    _cache[path] = (st.st_ino, begin, files, cwd)
    out = sorted(files.values(), key=lambda f: f["last_at"] or "", reverse=True)
    out.sort(key=lambda f: f["edit"] + f["write"] == 0)
    return {"cwd": cwd, "files": [dict(f) for f in out]}
