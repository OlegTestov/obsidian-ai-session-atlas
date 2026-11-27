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
from contextlib import contextmanager
from urllib.parse import quote

from . import activity, agents, codex_skills, resolve
from .parse import SessionFacts, _add_seen, _harvest_all, _harvest_tickets, _turn

AGENT = agents.CODEX
PARSE_VERSION = 5     # 5: all rollout locations participate in sensitivity
_UUID = agents.id_pattern(AGENT)[1:-1]
ROLLOUT_ID = re.compile(rf"^rollout-.*?-({_UUID})(?:_({_UUID}))?\.jsonl$")
PATCH_FILE = re.compile(r"^\*\*\* (?:(?:Add|Update|Delete) File|Move to): *(.+?)\s*$", re.M)
# `exec` runs model-written JavaScript; the shell command is the `cmd:` string inside it.
JS_CMD = re.compile(r"""\bcmd\s*:\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)""")
SHELL_CALLS = ("exec_command", "shell", "local_shell", "container.exec")
# Statistics name skills and subagents as for Claude Code (atlas/activity.py): `Skill:x`, `Agent:y`.
# Codex uses a skill by reading its SKILL.md, or gets it pasted in when you type `$name`.
SKILL_MENTION = re.compile(rb'"role":\s*"user",\s*"content":\s*\[\{"type":\s*"input_text",\s*"text":\s*'
                           rb'"<skill>\\n<name>([A-Za-z0-9_.:-]{1,100})</name>')
JS_SPAWN = re.compile(r"\bspawn_agent\(\s*\{(.{0,2000}?)\}\s*\)", re.S)
JS_AGENT_TYPE = re.compile(r"""\bagent_type\s*:\s*["'`]([A-Za-z0-9_.-]{1,60})["'`]""")
TITLE_LIMIT = 200
COPIED_EVENTS = ("user_message", "agent_message", "item_completed", "patch_apply_end", "token_count")
# Records never indexed, recognised from the line head without decoding it: message items carry
# base64 images and outputs carry raw tool output, up to ~20 MB a line. Anything else is decoded.
_SKIP_HEAD = re.compile(
    rb'"type":\s*"response_item".{0,80}"payload":\s*\{"type":\s*"(?:message|reasoning|'
    rb'function_call_output|custom_tool_call_output|tool_search_output)"'
    rb'|"payload":\s*\{"type":\s*"(?:exec_command_end|mcp_tool_call_end|web_search_end)"'
    rb'|"payload":\s*\{"type":\s*"item_completed".{0,240}?"item":\s*\{"type":\s*"(?:Reasoning|'
    rb'CommandExecution|ImageView|Extension)"')
_HEAD_TS = re.compile(rb'"timestamp":\s*"([0-9T:.Z+-]{10,40})"')


def rollout_ids(path: str) -> tuple[str, str] | None:
    """(Canonical thread ID, physical rollout ID) from a Codex filename."""
    match = ROLLOUT_ID.fullmatch(os.path.basename(path))
    return (match[1], match[2] or match[1]) if match else None


def session_id_of(path: str) -> str | None:
    ids = rollout_ids(path)
    return ids[0] if ids else None


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

    def __init__(self, facts: SessionFacts, recent_locations: bool = False) -> None:
        self.facts = facts
        self.recent_locations = recent_locations
        self.meta_seen = False
        self.cwd = None
        self.locations = set()
        # A subagent spawned with its parent's context starts with a copy of the parent's turn: its
        # calls, commands, skills and messages were already counted in the parent. Turns of the
        # threads read before this one (the root, then its subagents) are skipped.
        self.known_turns: frozenset = frozenset()
        self.turn = None
        self.turn_skills: set = set()
        self.model: str | None = None
        self.last_total: str | None = None
        self.tools: list[str] = []
        # A prompt or reply may arrive twice: as an event and as a completed item. Pairs across
        # the two channels collapse; repeats inside one channel are real (a second "continue").
        self.pending = {"prompt": {}, "answer": {}}

    def location(self, places: list, value) -> None:
        if self.recent_locations and value in places:
            places.remove(value)
        _add_seen(places, value)

    def set_cwd(self, value, *, copied=False) -> None:
        if isinstance(value, str) and value:
            self.cwd = value
            self.sensitivity(value)
            if not copied:
                self.location(self.facts.cwds, value)

    def sensitivity(self, path: str) -> None:
        if not self.facts.sensitive_location and path not in self.locations:
            self.locations.add(path)
            self.facts.sensitive_location = resolve.resolve_sensitivity([], [path]) == "sensitive"

    def file_path(self, path: str, *, copied: bool = False) -> None:
        self.sensitivity(resolve.normalize(path, self.cwd))
        if not copied:
            _add_seen(self.facts.raw_files, path)

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
        self.turn_skills = set()              # rollouts without turn ids: a prompt starts the turn
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
            self.skills(codex_skills.read_in(cmd))

    def skills(self, names) -> None:
        """A skill counts once a turn: reading SKILL.md in parts, or after `$name`, is the same use."""
        for name in names:
            if name not in self.turn_skills:
                self.turn_skills.add(name)
                self.tools.append("Skill:" + name)

    def patch_paths(self, text: str, *, copied: bool = False) -> None:
        for path in PATCH_FILE.findall(text or ""):
            self.file_path(path, copied=copied)
            if not copied:
                self.facts.paths.append(path)
                _turn(self.facts)["paths"].append(path)

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
    r.set_cwd(p.get("cwd"))
    git = p.get("git") if isinstance(p.get("git"), dict) else {}
    r.location(f.branches, git.get("branch"))
    source = p.get("source")
    f.spawned = p.get("thread_source") == "subagent" or (isinstance(source, dict) and "subagent" in source)
    # `codex fork`, /fork and a Desktop fork name their source; subagent and review threads do too,
    # but they are not copies the human made.
    if p.get("forked_from_id") and not f.spawned:
        f.forked_from = str(p["forked_from_id"])
        f.forked_at = p.get("timestamp") if isinstance(p.get("timestamp"), str) else None


def _event(r: _Rollout, p: dict, ts: str | None, *, copied: bool = False) -> None:
    kind = p.get("type")
    if kind == "patch_apply_end" and isinstance(p.get("changes"), dict):
        f = r.facts
        for path, change in p["changes"].items():
            r.file_path(path, copied=copied)
            if not copied and isinstance(change, dict) and p.get("success") is not False:
                added, removed = _diff_lines(change)
                f.lines_added = (f.lines_added or 0) + added
                f.lines_removed = (f.lines_removed or 0) + removed
    elif kind == "item_completed":
        item = p.get("item") if isinstance(p.get("item"), dict) else {}
        if item.get("type") == "FileChange" and isinstance(item.get("changes"), dict):
            for path in item["changes"]:
                r.file_path(path, copied=copied)
        elif not copied and item.get("type") == "UserMessage":
            r.prompt(_texts(item.get("content"), "text"), ts, "item")
        elif not copied and item.get("type") == "AgentMessage":
            r.answer(_texts(item.get("content"), "text"), "item")
    elif copied:
        return
    elif kind == "user_message":
        r.prompt(p.get("message"), ts, "event")
    elif kind == "agent_message":
        r.answer(p.get("message"), "event")
    elif kind == "token_count":
        r.tokens(p.get("info"), ts)


def _response_item(r: _Rollout, p: dict, *, copied: bool = False) -> None:
    """Only calls: messages come from events, and reasoning or outputs are never indexed."""
    kind = p.get("type")
    if kind not in ("function_call", "custom_tool_call"):
        return
    name = str(p.get("name") or "?")
    if not copied:
        r.facts.machine_turns += 1
    if kind == "function_call":
        if copied and name != "apply_patch":
            return
        try:
            args = json.loads(p.get("arguments") or "{}")
        except (TypeError, ValueError):
            args = {}
        if not isinstance(args, dict):
            args = {}
        if name == "spawn_agent":
            name = "Agent:" + str(args.get("agent_type") or "default")
        if not copied:
            r.tools.append(name.replace(",", " "))
        if name in SHELL_CALLS:
            r.command(_shell_command(args))
        elif name == "apply_patch":
            r.patch_paths(str(args.get("input") or ""), copied=copied)
        return
    if copied:
        if name in ("apply_patch", "exec"):
            r.patch_paths(str(p.get("input") or ""), copied=True)
        return
    r.tools.append(name.replace(",", " "))
    text = str(p.get("input") or "")
    if name == "apply_patch":
        r.patch_paths(text)
    elif name == "exec":
        for literal in JS_CMD.findall(text):
            r.command(_js_string(literal))
        r.patch_paths(text)
        for call in JS_SPAWN.findall(text):
            kind_ = JS_AGENT_TYPE.search(call)
            r.tools.append("Agent:" + (kind_.group(1) if kind_ else "default"))


def _copied(facts: SessionFacts, ts: str | None) -> bool:
    return bool(facts.copied_until and ts and ts <= facts.copied_until)


def _note_time(facts: SessionFacts, ts: str | None) -> None:
    if ts:
        facts.started_at = facts.started_at or ts
        facts.last_activity_at = ts
        facts.pending_active += activity.active_part(activity.seconds_between(facts.last_main_ts, ts))
        facts.last_main_ts = ts


def _turn_id(p: dict):
    attribution = p.get("turn_attribution") if isinstance(p.get("turn_attribution"), dict) else {}
    return attribution.get("turn_id") or p.get("turn_id")


def parse_file(path: str, session_id: str | None = None, title: str | None = None,
               continued_from: str | None = None, copied_until: str | None = None,
               turns: set | None = None) -> SessionFacts:
    """Reads the whole rollout line by line: a file is never loaded into memory at once.
    A rollout "Resume with…" wrote holds copies up to `copied_until`: only its session_meta counts.
    `turns`: turn ids of the threads read before (a subagent's parent); their records here are a copy
    of the parent's history and are skipped. This thread's own turn ids are added to it."""
    return _parse(path, session_id, title, continued_from, copied_until, turns)


def parse_group(path: str, rollouts: list[str], *, title=None, continued_from=None,
                copied_until=None, turns=None) -> SessionFacts:
    """Read every physical rollout of an indexed thread into a single set of facts."""
    from . import codex_rollouts, index

    home = index.codex_home()
    paths = {*rollouts, path}
    copies = codex_rollouts.preferred_copies(paths, home)
    files = sorted(copies.values() or [path], key=lambda p: (os.path.basename(p), p))
    parts = [codex_rollouts.Part(p) for p in files]
    facts = _parse(path, None, title, continued_from, copied_until, turns, parts)
    # A losing physical copy contributes no search or stats, but may still contain a sensitive path.
    if not facts.sensitive_location:
        facts.sensitive_location = sensitive_copies(paths.difference(files))
    lineage = codex_rollouts.lineage(path, home)
    if len(parts) > 1 or len(lineage) > 1:
        current = _parse(path, None, title, continued_from, copied_until, None, lineage, project=True)
        facts.sensitive_location |= current.sensitive_location
        for field in ("first_user_text", "first_assistant_text", "last_prompt", "cwds", "branches", "entrypoint",
                      "version", "spawned", "forked_from", "forked_at", "started_at", "last_activity_at"):
            setattr(facts, field, getattr(current, field))
    return facts


def sensitive_copies(paths) -> bool:
    return any(parse_file(p).sensitive_location for p in paths)


def parse_lineage(path: str, session_id: str) -> SessionFacts:
    """The selected conversation, for excerpts, prompts and model context."""
    from . import codex_procs, codex_rollouts

    head = codex_procs.selected_rollout(session_id) or path
    parts = codex_rollouts.lineage(head)
    return _parse(head, session_id, None, None, None, None, parts, project=True)


def _keep_excerpt_record(raw: bytes) -> bytes:
    # The parser needs only the timestamp and skill marker on these potentially large records.
    return raw[:600] if _SKIP_HEAD.search(raw, 0, 480) else raw


def _parse(path, session_id, title, continued_from, copied_until, turns, parts=None, *, project=False) -> SessionFacts:
    from . import codex_projection, codex_rollouts

    facts = SessionFacts(session_id=session_id or session_id_of(path) or "", source_path=path,
                         agent=AGENT, continued_from=continued_from, copied_until=copied_until)
    if title:
        facts.title, facts.title_source = title, "codex"
    projected = project and parts and len(parts) > 1
    if projected:
        sources = ((part, (item for group in groups for item in group.lines))
                   for part, groups in codex_projection.selected(parts, _keep_excerpt_record))
    else:
        sources = ((part, codex_rollouts.lines(part)) for part in parts or [codex_rollouts.Part(path)])
    for part, records in sources:
        start, last = facts.started_at, facts.last_activity_at
        facts.started_at = facts.last_activity_at = facts.last_main_ts = None
        facts.pending_active = 0.0
        _parse_part(facts, records, turns, part.path == path, recent_locations=bool(projected))
        if start:
            facts.started_at = min(start, facts.started_at or start)
        if last:
            facts.last_activity_at = max(last, facts.last_activity_at or last)
    _harvest_all(facts)
    return facts


def _parse_part(facts: SessionFacts, source, turns, is_head: bool, *, recent_locations=False) -> None:
    r = _Rollout(facts, recent_locations)
    r.known_turns = frozenset(turns or ())
    for offset, raw in source:
        if is_head:
            facts.complete_bytes = offset
        if _SKIP_HEAD.search(raw, 0, 480):
            facts.records += 1
            head = _HEAD_TS.search(raw, 0, 480)
            head_ts = head.group(1).decode() if head else None
            if _copied(facts, head_ts):
                facts.copied += 1
                continue
            _note_time(facts, head_ts)
            skill = None if r.turn in r.known_turns else SKILL_MENTION.search(raw, 0, 600)
            if skill:
                r.skills([skill.group(1).decode()])
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
            if kind == "turn_context":
                r.set_cwd(p.get("cwd"), copied=True)
            elif kind == "event_msg":
                _event(r, p, ts, copied=True)
            elif kind == "response_item":
                _response_item(r, p, copied=True)
            continue
        if (kind == "event_msg" and p.get("type") == "task_started") or kind == "turn_context":
            turn = _turn_id(p) or r.turn
            if turn != r.turn or kind == "event_msg":
                r.turn_skills = set()          # a new turn: its skills count again
            r.turn = turn
            if turns is not None and r.turn:
                turns.add(r.turn)
        copied_turn = r.turn in r.known_turns
        if kind == "session_meta":
            _session_meta(r, p)
        elif kind == "turn_context":
            r.model = p.get("model") or r.model
            _add_seen(facts.models, p.get("model"))
            r.set_cwd(p.get("cwd"))
        elif kind == "event_msg":
            _event(r, p, ts, copied=copied_turn and p.get("type") in COPIED_EVENTS)
        elif kind == "response_item":
            _response_item(r, p, copied=copied_turn)
        elif kind == "compacted" and str(p.get("message") or "").strip():
            summary = str(p["message"]).strip()
            facts.summaries.append(summary)
            _turn(facts, start_new=True)["summaries"].append(summary)


def _state_db(home: str) -> str | None:
    """Codex versions its state database in the name: state_5.sqlite today."""
    found = glob.glob(os.path.join(glob.escape(home), "state_*.sqlite"))
    numbered = [(int(m.group(1)), p) for p in found
                for m in [re.search(r"state_(\d+)\.sqlite$", p)] if m]
    return max(numbered)[1] if numbered else None


def _clean_title(value) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return " ".join(value.split())[:TITLE_LIMIT]


def _index_names(home: str):
    """Names from Codex's `session_index.jsonl`, the latest line per thread. Codex keeps a name it
    set on a thread not yet in its state database only here."""
    try:
        with open(os.path.join(home, "session_index.jsonl"), encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                name = _clean_title(row.get("thread_name")) if isinstance(row, dict) else None
                if name and isinstance(row.get("id"), str):
                    yield row["id"], name
    except OSError:
        return


@contextmanager
def _state_connection(home: str):
    path = _state_db(home)
    conn = None
    try:
        if path:
            conn = sqlite3.connect(f"file:{quote(path)}?mode=ro", uri=True, timeout=0.25)
            conn.execute("PRAGMA query_only=ON")
        yield conn
    finally:
        if conn is not None:
            conn.close()


def selected_paths(home: str, thread_id: str | None = None) -> dict[str, str]:
    """The path selected by Codex 0.171/0.172 in threads.rollout_path."""
    try:
        with _state_connection(home) as conn:
            if conn is None:
                return {}
            sql = "SELECT id, rollout_path FROM threads"
            rows = conn.execute(sql + " WHERE id=?", (thread_id,)) if thread_id else conn.execute(sql)
            return {tid: os.path.join(home, path) for tid, path in rows if tid and isinstance(path, str) and path}
    except sqlite3.Error:
        return {}


def _state_titles(home: str) -> dict[str, tuple[str | None, str | None]]:
    """{thread id: (name, title)} from the state database. Read-only: any failure means none."""
    try:
        with _state_connection(home) as conn:
            if conn is None:
                return {}
            cols = {row[1] for row in conn.execute("PRAGMA table_info(threads)")}
            if "id" not in cols or not cols & {"name", "title"}:
                return {}
            name = "name" if "name" in cols else "NULL"
            title = "title" if "title" in cols else "NULL"
            return {str(i): (_clean_title(n), _clean_title(t))
                    for i, n, t in conn.execute(f"SELECT id, {name}, {title} FROM threads") if i}
    except sqlite3.Error:
        return {}


def _title_key(tid: str):
    # Codex's older title sidecars can spell the same UUID in either case.
    # Reconcile their metadata without rewriting an ID used by the catalog or by a CLI.
    return int(tid.replace("-", ""), 16) if agents.valid_id(AGENT, tid) else tid


def thread_titles(home: str, rollout_ids=()) -> dict[str, str]:
    """A user name wins (the state database, then the session index), then the automatic title."""
    state = _state_titles(home)
    keys = {_title_key(tid): value for tid, value in state.items()}
    spellings = set(rollout_ids) | state.keys()
    names = {}
    for tid, name in _index_names(home):
        spellings.add(tid)
        names[_title_key(tid)] = name
    out = {}
    for tid in spellings:
        key = _title_key(tid)
        name, title = keys.get(key, (None, None))
        found = name or names.get(key) or title
        if found:
            out[tid] = found
    return out
