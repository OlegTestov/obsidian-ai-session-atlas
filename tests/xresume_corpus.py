"""Made-up source sessions for "Resume with…": one Claude Code transcript, one Codex rollout.

Real record structure as the current CLIs write it (compact JSON; Codex 0.160 numbers its
records and opens session_meta with creator ids and session_id), invented content. Each has a turn
before its compaction (must not be copied), a compaction summary, prompts, replies, tool calls with
results, and secrets in places that must never be copied: thinking with a signature, reasoning with
encrypted content.
"""
from __future__ import annotations

import json
import os

CLAUDE_ID = "c1a0de00-1111-4111-8111-000000000001"
CODEX_ID = "019a0000-2222-7222-8222-000000000002"
BEFORE = "PRE-COMPACTION-TURN-MARKER"       # before the last compaction: never copied
SUMMARY = "SUMMARY-MARKER lighthouse keeper log"
PROMPT = "EARLY-PROMPT-MARKER: make the lamp blink twice"
REPLY = "REPLY-MARKER: the lamp now blinks twice"
COMMAND = "grep -rn blink src/lamp.py"
OUTPUT = "OUTPUT-MARKER src/lamp.py:3: blink(2)"
SECRETS = ("THINKING-SECRET", "SIGNATURE-SECRET", "ENCRYPTED-SECRET", "REASONING-SECRET")
COMPACT = "This session is being continued from a previous conversation that ran out of context. "


def _line(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"


def claude_lines(cwd: str, sid: str = CLAUDE_ID, extra_turns: int = 0) -> list[str]:
    base = {"isSidechain": False, "userType": "external", "entrypoint": "cli", "cwd": cwd,
            "sessionId": sid, "version": "2.1.289", "gitBranch": "main"}
    out, parent = [], None

    def add(kind, ts, uid, content, parent_uuid="same", **kw):
        nonlocal parent
        message = ({"role": "user", "content": content} if kind == "user" else
                   {"id": "msg_" + uid, "type": "message", "role": "assistant", "model": "claude-opus-5",
                    "content": content, "usage": {"input_tokens": 10, "output_tokens": 5}})
        rec = dict(base, type=kind, uuid=uid, timestamp=ts, message=message,
                   parentUuid=parent if parent_uuid == "same" else parent_uuid, **kw)
        out.append(_line(rec))
        parent = uid

    add("user", "2026-09-01T09:00:00.000Z", "u0", BEFORE)
    add("assistant", "2026-09-01T09:00:10.000Z", "a0", [{"type": "text", "text": "old " + BEFORE}])
    out.append(_line(dict(base, type="system", subtype="compact_boundary", uuid="b1", parentUuid=None,
                          logicalParentUuid="a0", timestamp="2026-09-01T09:30:00.000Z",
                          content="Conversation compacted")))
    parent = "b1"
    add("user", "2026-09-01T09:30:01.000Z", "s1", COMPACT + SUMMARY, isCompactSummary=True)
    add("user", "2026-09-01T10:00:00.000Z", "u1", [{"type": "text", "text": PROMPT}])
    add("assistant", "2026-09-01T10:00:05.000Z", "a1",
        [{"type": "thinking", "thinking": "THINKING-SECRET", "signature": "SIGNATURE-SECRET"}])
    add("assistant", "2026-09-01T10:00:06.000Z", "a2",
        [{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": COMMAND}}])
    add("user", "2026-09-01T10:00:07.000Z", "r1",
        [{"type": "tool_result", "tool_use_id": "toolu_1", "content": OUTPUT}])
    add("assistant", "2026-09-01T10:00:08.000Z", "a3",
        [{"type": "tool_use", "id": "toolu_2", "name": "Edit",
          "input": {"file_path": cwd + "/src/lamp.py", "old_string": "x", "new_string": "y"}}])
    add("user", "2026-09-01T10:00:09.000Z", "r2",
        [{"type": "tool_result", "tool_use_id": "toolu_2", "content": "file content dump"}])
    add("assistant", "2026-09-01T10:00:10.000Z", "a4", [{"type": "text", "text": REPLY}])
    for n in range(extra_turns):
        ts = f"2026-09-01T11:{n // 60:02d}:{n % 60:02d}.000Z"
        add("user", ts, f"xu{n}", f"filler prompt {n} " + "lorem ipsum " * 40)
        add("assistant", ts, f"xa{n}", [{"type": "text", "text": f"filler reply {n} " + "dolor sit " * 40}])
    add("user", "2026-09-01T12:00:00.000Z", "u9", "LAST-PROMPT-MARKER and the colour?")
    add("assistant", "2026-09-01T12:00:05.000Z", "a9", [{"type": "text", "text": "LAST-REPLY-MARKER amber"}])
    out.append(_line({"type": "custom-title", "customTitle": "Lighthouse lamp", "sessionId": sid}))
    return out


def codex_lines(cwd: str, sid: str = CODEX_ID) -> list[str]:
    out = []

    def add(ts, kind, payload):
        out.append(_line({"timestamp": ts, "ordinal": len(out), "type": kind, "payload": payload}))

    add("2026-09-02T09:00:00.000Z", "session_meta",
        {"creator_user_id": "user-PLACEHOLDER", "creator_account_id": "acct-PLACEHOLDER", "session_id": sid,
         "id": sid, "timestamp": "2026-09-02T09:00:00.000Z", "cwd": cwd, "runtime_workspace_roots": [cwd],
         "originator": "codex-tui", "cli_version": "0.160.0", "source": "vscode", "thread_source": "user",
         "model_provider": "openai", "base_instructions": {"text": "BASE-INSTRUCTIONS-NOT-COPIED"},
         "history_mode": "paginated", "context_window": 272000})
    add("2026-09-02T09:00:01.000Z", "turn_context", {"cwd": cwd, "model": "gpt-5.1"})
    add("2026-09-02T09:00:02.000Z", "event_msg", {"type": "user_message", "message": BEFORE})
    add("2026-09-02T09:00:03.000Z", "event_msg", {"type": "agent_message", "message": "old " + BEFORE})
    add("2026-09-02T09:30:00.000Z", "compacted", {"message": SUMMARY, "replacement_history": []})
    add("2026-09-02T10:00:00.000Z", "response_item",
        {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "DEV-NOT-COPIED"}]})
    add("2026-09-02T10:00:00.000Z", "response_item",
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": PROMPT}]})
    add("2026-09-02T10:00:00.000Z", "event_msg", {"type": "user_message", "message": PROMPT})
    add("2026-09-02T10:00:00.000Z", "event_msg",
        {"type": "item_completed", "item": {"type": "UserMessage", "content": [{"type": "text", "text": PROMPT}]}})
    add("2026-09-02T10:00:04.000Z", "response_item",
        {"type": "reasoning", "summary": [{"type": "summary_text", "text": "REASONING-SECRET"}],
         "encrypted_content": "ENCRYPTED-SECRET"})
    add("2026-09-02T10:00:05.000Z", "response_item",
        {"type": "function_call", "name": "exec_command", "call_id": "call_1",
         "arguments": json.dumps({"cmd": COMMAND, "workdir": cwd})})
    add("2026-09-02T10:00:06.000Z", "response_item",
        {"type": "function_call_output", "call_id": "call_1", "output": OUTPUT})
    add("2026-09-02T10:00:07.000Z", "response_item",
        {"type": "custom_tool_call", "name": "apply_patch", "call_id": "call_2",
         "input": "*** Begin Patch\n*** Update File: src/lamp.py\n@@\n-x\n+y\n*** End Patch"})
    add("2026-09-02T10:00:08.000Z", "response_item",
        {"type": "custom_tool_call_output", "call_id": "call_2", "output": "Success"})
    add("2026-09-02T10:00:09.000Z", "event_msg", {"type": "agent_message", "message": REPLY})
    add("2026-09-02T10:00:09.000Z", "event_msg",
        {"type": "item_completed", "item": {"type": "AgentMessage", "content": [{"type": "Text", "text": REPLY}]}})
    add("2026-09-02T10:00:10.000Z", "event_msg",
        {"type": "token_count", "info": {"last_token_usage": {"input_tokens": 100, "output_tokens": 10},
                                         "total_token_usage": {"total_tokens": 110}}})
    add("2026-09-02T12:00:00.000Z", "event_msg",
        {"type": "user_message", "message": "LAST-PROMPT-MARKER and the colour?"})
    add("2026-09-02T12:00:05.000Z", "event_msg", {"type": "agent_message", "message": "LAST-REPLY-MARKER amber"})
    return out


def write_claude(projects: str, cwd: str, sid: str = CLAUDE_ID, **kw) -> str:
    folder = os.path.join(projects, "".join(c if c.isalnum() else "-" for c in cwd))
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, sid + ".jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        fh.writelines(claude_lines(cwd, sid, **kw))
    return path


def write_codex(home: str, cwd: str, sid: str = CODEX_ID) -> str:
    folder = os.path.join(home, "sessions", "2026", "09", "02")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"rollout-2026-09-02T11-00-00-{sid}.jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        fh.writelines(codex_lines(cwd, sid))
    return path
