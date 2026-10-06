"""Parses a Codex rollout (.jsonl) into the same SessionFacts the Claude parser produces.

A rollout line is `{"timestamp", "type", "payload"}`. Only human prompts, assistant text, shell
commands, patched file paths and compaction summaries are indexed. Developer/system messages,
reasoning and tool outputs never are: they hold instructions and megabytes of raw output.
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import sqlite3
from urllib.parse import quote

from . import activity
from .parse import SessionFacts, _add_seen, _harvest_all, _harvest_tickets, _turn, iter_complete_lines

AGENT = "codex"
ROLLOUT_ID = re.compile(r"^rollout-.*-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                        r"[0-9a-fA-F]{12})\.jsonl$")
PATCH_FILE = re.compile(r"^\*\*\* (?:(?:Add|Update|Delete) File|Move to): *(.+?)\s*$", re.M)
# `exec` runs model-written JavaScript; the shell command is the `cmd:` string inside it.
JS_CMD = re.compile(r"""\bcmd\s*:\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)""")
SHELL_CALLS = ("exec_command", "shell", "local_shell", "container.exec")
TITLE_LIMIT = 200
# Records never indexed, recognised from the line head without decoding it: message items carry
# base64 images and outputs carry raw tool output, up to ~20 MB a line. Anything else is decoded.
_SKIP_HEAD = re.compile(
    rb'"type":\s*"response_item".{0,80}"payload":\s*\{"type":\s*"(?:message|reasoning|'
    rb'function_call_output|custom_tool_call_output|tool_search_output)"'
    rb'|"payload":\s*\{"type":\s*"(?:exec_command_end|mcp_tool_call_end|web_search_end)"'
    rb'|"payload":\s*\{"type":\s*"item_completed".{0,240}?"item":\s*\{"type":\s*"(?:Reasoning|'
    rb'CommandExecution|ImageView|Extension)"')
_HEAD_TS = re.compile(rb'"timestamp":\s*"([0-9T:.Z+-]{10,40})"')


def session_id_of(path: str) -> str | None:
    m = ROLLOUT_ID.match(os.path.basename(path))
    return m.group(1).lower() if m else None


def _js_string(literal: str) -> str:
    if literal.startswith('"'):
        try:
            return str(json.loads(literal))
        except ValueError:
            pass
    return literal[1:-1]


def _shell_command(args: dict) -> str | None:
    cmd = args.get("cmd") if "cmd" in args else args.get("command")
    if isinstance(cmd, list):
        # ["bash", "-lc", "<script>"] is how older versions wrapped the command.
        if len(cmd) >= 3 and cmd[1] in ("-lc", "-c"):
            return str(cmd[2])
        return " ".join(str(c) for c in cmd)
    return str(cmd) if cmd else None


def _texts(content, kind: str) -> str:
    """Text parts of an item's content: `text` in user items, `Text` in agent items."""
    if not isinstance(content, list):
        return ""
    parts = [str(b.get("text") or "") for b in content
             if isinstance(b, dict) and str(b.get("type", "")).lower() == kind]
    return "\n".join(p for p in parts if p).strip()


def _diff_lines(change: dict) -> tuple[int, int]:
    kind = change.get("type")
    if kind == "add":
        return len(str(change.get("content") or "").splitlines()), 0
    if kind == "delete":
        return 0, len(str(change.get("content") or "").splitlines())
    added = removed = 0
    for line in str(change.get("unified_diff") or "").splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return added, removed


class _Rollout:
    """Per-file reading state that does not belong in SessionFacts."""

    def __init__(self, facts: SessionFacts) -> None:
        self.facts = facts
        self.meta_seen = False
        self.model: str | None = None
        self.last_total: str | None = None
        self.tools: list[str] = []
        # A prompt or reply may arrive twice: as an event and as a completed item. Pairs across
        # the two channels collapse; repeats inside one channel are real (a second "continue").
        self.pending = {"prompt": {}, "answer": {}}

    def _first_copy(self, what: str, channel: str, text: str) -> bool:
        waiting = self.pending[what]
        other = waiting.setdefault("item" if channel == "event" else "event", {})
        if other.get(text):
            other[text] -= 1
            return False
        mine = waiting.setdefault(channel, {})
        mine[text] = mine.get(text, 0) + 1
        return True

    def prompt(self, text: str, ts: str | None, channel: str) -> None:
        text = (text or "").strip()
        if not text or not self._first_copy("prompt", channel, text):
            return
        f = self.facts
        f.user_text.append(text)
        _turn(f, start_new=True)["user_text"].append(text)
        if f.first_user_text is None:
            f.first_user_text = text
        f.last_prompt = text
        f.human_turns += 1
        _harvest_tickets(f, text)
        # Several prompts share a timestamp where Codex replays history (forks): key on the text too.
        key = f"cx-p:{ts or f.human_turns}:{hashlib.sha1(text.encode()).hexdigest()[:12]}"
        f.activity[key] = {
            "kind": activity.PROMPT, "ts": ts or "", "active_s": f.pending_active, "model": None,
            "input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "cost": None, "tools": []}
        f.pending_active = 0.0

    def answer(self, text: str, channel: str) -> None:
        text = (text or "").strip()
        if not text or not self._first_copy("answer", channel, text):
            return
        f = self.facts
        f.machine_turns += 1
        f.assistant_text.append(text)
        _turn(f)["assistant_text"].append(text)
        if f.first_assistant_text is None:
            f.first_assistant_text = text

    def command(self, cmd: str | None) -> None:
        if cmd:
            self.facts.commands.append(cmd)
            _turn(self.facts)["commands"].append(cmd)

    def patch_paths(self, text: str) -> None:
        for path in PATCH_FILE.findall(text or ""):
            self.facts.paths.append(path)
            _turn(self.facts)["paths"].append(path)
            _add_seen(self.facts.raw_files, path)

    def tokens(self, info, ts: str | None) -> None:
        """One reply's usage. Codex repeats the same token_count when only rate limits change."""
        if not isinstance(info, dict) or not isinstance(info.get("last_token_usage"), dict):
            return
        total = info.get("total_token_usage") if isinstance(info.get("total_token_usage"), dict) else {}
        signature = json.dumps(total, sort_keys=True)
        if signature == self.last_total:
            return
        self.last_total = signature
        usage = info["last_token_usage"]
        cached = int(usage.get("cached_input_tokens") or 0)
        written = int(usage.get("cache_write_input_tokens") or 0)
        f = self.facts
        # Content-based key: a forked thread copies its parent's history, and stats collapse by key.
        f.activity[f"cx-a:{ts or len(f.activity)}:{total.get('total_tokens', '')}"] = {
            "kind": activity.ANSWER, "ts": ts or "", "active_s": f.pending_active,
            "model": self.model,
            # input_tokens includes cache reads and writes; output_tokens already includes reasoning
            # (total_tokens = input + output in real rollouts). Cost is priced at query time (stats).
            "input": max(0, int(usage.get("input_tokens") or 0) - cached - written),
            "output": int(usage.get("output_tokens") or 0),
            "cache_read": cached, "cache_write": written, "cost": None, "tools": self.tools}
        f.pending_active = 0.0
        self.tools = []


def _session_meta(r: _Rollout, p: dict) -> None:
    """Only the first one describes this thread; a fork carries its parent's after it."""
    if r.meta_seen:
        return
    r.meta_seen = True
    f = r.facts
    f.session_id = f.session_id or str(p.get("id") or p.get("session_id") or "")
    f.entrypoint = p.get("originator") or None
    f.version = p.get("cli_version") or None
    _add_seen(f.cwds, p.get("cwd"))
    git = p.get("git") if isinstance(p.get("git"), dict) else {}
    _add_seen(f.branches, git.get("branch"))
    source = p.get("source")
    f.spawned = p.get("thread_source") == "subagent" or (isinstance(source, dict) and "subagent" in source)


def _event(r: _Rollout, p: dict, ts: str | None) -> None:
    kind = p.get("type")
    if kind == "user_message":
        r.prompt(p.get("message"), ts, "event")
    elif kind == "agent_message":
        r.answer(p.get("message"), "event")
    elif kind == "item_completed":
        item = p.get("item") if isinstance(p.get("item"), dict) else {}
        if item.get("type") == "UserMessage":
            r.prompt(_texts(item.get("content"), "text"), ts, "item")
        elif item.get("type") == "AgentMessage":
            r.answer(_texts(item.get("content"), "text"), "item")
        elif item.get("type") == "FileChange" and isinstance(item.get("changes"), dict):
            for path in item["changes"]:
                _add_seen(r.facts.raw_files, path)
    elif kind == "token_count":
        r.tokens(p.get("info"), ts)
    elif kind == "patch_apply_end" and isinstance(p.get("changes"), dict):
        f = r.facts
        for path, change in p["changes"].items():
            _add_seen(f.raw_files, path)
            if isinstance(change, dict) and p.get("success") is not False:
                added, removed = _diff_lines(change)
                f.lines_added = (f.lines_added or 0) + added
                f.lines_removed = (f.lines_removed or 0) + removed


def _response_item(r: _Rollout, p: dict) -> None:
    """Only calls: messages come from events, and reasoning or outputs are never indexed."""
    kind = p.get("type")
    if kind not in ("function_call", "custom_tool_call"):
        return
    name = str(p.get("name") or "?")
    r.facts.machine_turns += 1
    r.tools.append(name.replace(",", " "))
    if kind == "function_call":
        try:
            args = json.loads(p.get("arguments") or "{}")
        except (TypeError, ValueError):
            args = {}
        if not isinstance(args, dict):
            return
        if name in SHELL_CALLS:
            r.command(_shell_command(args))
        elif name == "apply_patch":
            r.patch_paths(str(args.get("input") or ""))
        return
    text = str(p.get("input") or "")
    if name == "apply_patch":
        r.patch_paths(text)
    elif name == "exec":
        for literal in JS_CMD.findall(text):
            r.command(_js_string(literal))
        r.patch_paths(text)


def _copied(facts: SessionFacts, ts: str | None) -> bool:
    return bool(facts.copied_until and ts and ts <= facts.copied_until)


def _note_time(facts: SessionFacts, ts: str | None) -> None:
    if ts:
        facts.started_at = facts.started_at or ts
        facts.last_activity_at = ts
        facts.pending_active += activity.active_part(activity.seconds_between(facts.last_main_ts, ts))
        facts.last_main_ts = ts


def parse_file(path: str, session_id: str | None = None, title: str | None = None,
               continued_from: str | None = None, copied_until: str | None = None) -> SessionFacts:
    """Reads the whole rollout line by line: a file is never loaded into memory at once.
    A rollout "Resume with…" wrote holds copies up to `copied_until`: only its session_meta counts."""
    facts = SessionFacts(session_id=session_id or session_id_of(path) or "", source_path=path,
                         agent=AGENT, continued_from=continued_from, copied_until=copied_until)
    if title:
        facts.title, facts.title_source = title, "codex"
    r = _Rollout(facts)
    with open(path, "rb") as fh:
        for offset, raw in iter_complete_lines(fh):
            facts.complete_bytes = offset
            if _SKIP_HEAD.search(raw, 0, 480):
                facts.records += 1
                head = _HEAD_TS.search(raw, 0, 480)
                head_ts = head.group(1).decode() if head else None
                if _copied(facts, head_ts):
                    facts.copied += 1
                else:
                    _note_time(facts, head_ts)
                continue
            try:
                rec = json.loads(raw)
            except ValueError:
                facts.bad_lines += 1
                continue
            if not isinstance(rec, dict):
                facts.bad_lines += 1
                continue
            facts.records += 1
            ts = rec.get("timestamp") if isinstance(rec.get("timestamp"), str) else None
            p = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
            kind = rec.get("type")
            if not _copied(facts, ts):
                _note_time(facts, ts)
            elif kind != "session_meta":
                facts.copied += 1
                continue
            if kind == "session_meta":
                _session_meta(r, p)
            elif kind == "turn_context":
                r.model = p.get("model") or r.model
                _add_seen(facts.models, p.get("model"))
                _add_seen(facts.cwds, p.get("cwd"))
            elif kind == "event_msg":
                _event(r, p, ts)
            elif kind == "response_item":
                _response_item(r, p)
            elif kind == "compacted" and str(p.get("message") or "").strip():
                summary = str(p["message"]).strip()
                facts.summaries.append(summary)
                _turn(facts, start_new=True)["summaries"].append(summary)
    _harvest_all(facts)
    return facts


def _state_db(home: str) -> str | None:
    """Codex versions its state database in the name: state_5.sqlite today."""
    found = glob.glob(os.path.join(glob.escape(home), "state_*.sqlite"))
    numbered = [(int(m.group(1)), p) for p in found
                for m in [re.search(r"state_(\d+)\.sqlite$", p)] if m]
    return max(numbered)[1] if numbered else None


def thread_titles(home: str) -> dict[str, str]:
    """Codex's own thread names: {thread id: title}. Read-only and optional: any failure means none."""
    path = _state_db(home)
    if not path:
        return {}
    try:
        conn = sqlite3.connect(f"file:{quote(path)}?mode=ro", uri=True, timeout=1.0)
    except sqlite3.Error:
        return {}
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(threads)")}
        pick = [c for c in ("name", "title") if c in cols]      # a name the user gave wins
        if "id" not in cols or not pick:
            return {}
        out = {}
        for row in conn.execute(f"SELECT id, {', '.join(pick)} FROM threads"):
            title = next((v for v in row[1:] if isinstance(v, str) and v.strip()), None)
            if title and row[0]:
                out[str(row[0]).lower()] = " ".join(title.split())[:TITLE_LIMIT]
        return out
    except sqlite3.Error:
        return {}
    finally:
        conn.close()
