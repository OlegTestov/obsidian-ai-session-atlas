"""The feed for a Codex thread: same turns, steps, paging and files as for Claude Code."""
from __future__ import annotations

import json

from atlas import codex_feed, feed, touched
from tests.conftest import cx, cx_agent, cx_context, cx_meta, cx_patch, cx_patch_end, cx_user

TID = "019e0000-cccc-7000-8000-000000000003"


def ev(payload, ts):
    return cx("event_msg", payload, ts)


def first_turn():
    return [
        cx_meta(TID), cx_context(),
        cx_user("почини сборку", ts="2026-09-01T10:00:02.000Z"),
        ev({"type": "task_started"}, "2026-09-01T10:00:02.500Z"),
        cx("response_item", {"type": "function_call", "name": "exec_command", "call_id": "c1",
                             "arguments": json.dumps({"cmd": "make build"})}, "2026-09-01T10:00:10.000Z"),
        cx("response_item", {"type": "function_call_output", "call_id": "c1",
                             "output": "Chunk ID: 1\nWall time: 0.2 seconds\nProcess exited with code 2\n"
                                       "Output:\nerror"}, "2026-09-01T10:00:12.000Z"),
        cx_patch("*** Update File: src/app.py\n@@\n-a\n+b\n"),
        cx_patch_end({"/Users/u/Code/demo/src/app.py": {"type": "update", "unified_diff": "@@\n-a\n+b\n+c\n"},
                      "/Users/u/Code/demo/NEW.md": {"type": "add", "content": "x\ny\n"}},
                     ts="2026-09-01T10:00:21.000Z"),
        cx_agent("Сборка починена", ts="2026-09-01T10:00:30.000Z"),
        ev({"type": "task_complete", "last_agent_message": "Сборка починена"}, "2026-09-01T10:00:31.000Z"),
    ]


def second_turn():
    """The newer format: items with exit codes and times, no events for the prompt and reply."""
    return [
        ev({"type": "item_completed", "item": {"type": "UserMessage",
                                               "content": [{"type": "text", "text": "прогони тесты"}]}},
           "2026-09-01T11:00:00.000Z"),
        ev({"type": "task_started"}, "2026-09-01T11:00:00.500Z"),
        cx("response_item", {"type": "custom_tool_call", "name": "exec", "call_id": "e1",
                             "input": "await tools.exec_command({cmd: 'pytest -q'})"}, "2026-09-01T11:00:01.000Z"),
        ev({"type": "item_completed", "started_at_ms": 1788260402000, "completed_at_ms": 1788260405000,
            "item": {"type": "CommandExecution", "id": "i1", "command": ["/bin/zsh", "-lc", "pytest -q"],
                     "exit_code": 0, "aggregated_output": "ok",
                     "parsed_cmd": [{"type": "read", "path": "/Users/u/Code/demo/README.md"}]}},
           "2026-09-01T11:00:05.000Z"),
        ev({"type": "exec_command_end", "call_id": "x9", "command": ["bash", "-lc", "git status"],
            "exit_code": 0, "stdout": "", "stderr": "", "duration": {"secs": 1, "nanos": 500000000}},
           "2026-09-01T11:00:08.000Z"),
        ev({"type": "item_completed", "item": {"type": "AgentMessage",
                                               "content": [{"type": "Text", "text": "Тесты зелёные"}]}},
           "2026-09-01T11:00:09.000Z"),
        ev({"type": "task_complete", "last_agent_message": "Тесты зелёные"}, "2026-09-01T11:00:10.000Z"),
    ]


def test_turns_steps_and_replies(write_rollout):
    path = write_rollout(first_turn() + second_turn(), thread_id=TID)
    turns = feed.feed(path, with_events=True)
    assert [t["prompt"] for t in turns] == ["почини сборку", "прогони тесты"]
    assert [t["reply"] for t in turns] == ["Сборка починена", "Тесты зелёные"]
    one, two = turns
    assert [(s["kind"], s["text"]) for s in one["steps"]] == [("bash", "1 command"),
                                                             ("edit", "edited 2 files")]
    events = one["events"]["events"]
    assert [(e["kind"], e["status"]) for e in events] == [("bash", "error"), ("edit", "ok"), ("edit", "ok")]
    assert events[0]["detail"] == "make build" and events[0]["error"] == "exit 2"
    assert events[0]["took"] == 2.0 and one["events"]["errors"] == 1
    assert [e["text"] for e in events[1:]] == ["edit app.py", "wrote NEW.md"]
    bash = two["events"]["events"]
    assert [(e["detail"], e["status"], e.get("took")) for e in bash] == [("pytest -q", "ok", 3.0),
                                                                         ("git status", "ok", 1.5)]
    assert two["reply_len"] == len("Тесты зелёные") and not two["interrupted"]


def test_paging_by_time_and_the_conversation_tail(write_rollout):
    path = write_rollout(first_turn() + second_turn(), thread_id=TID)
    page = feed.feed_page(path, turns=1)
    assert [t["prompt"] for t in page["turns"]] == ["прогони тесты"] and page["has_more"]
    older = feed.feed_page(path, turns=1, before=page["turns"][0]["prompt_at"])
    assert [t["prompt"] for t in older["turns"]] == ["почини сборку"] and not older["has_more"]
    live = feed.feed_page(path, since="2026-09-01T11:00:00.000Z")
    assert [t["prompt"] for t in live["turns"]] == ["прогони тесты"]
    tail = feed.messages_tail(path, 4)
    assert [(m["role"], m["text"]) for m in tail] == [("you", "почини сборку"), ("claude", "Сборка починена"),
                                                      ("you", "прогони тесты"), ("claude", "Тесты зелёные")]


def test_prompt_twice_as_event_and_item_counts_once_but_a_real_repeat_stays(write_rollout):
    item = ev({"type": "item_completed", "item": {"type": "UserMessage",
                                                  "content": [{"type": "text", "text": "дальше"}]}},
              "2026-09-01T10:00:02.000Z")
    lines = [cx_meta(TID), cx_user("дальше"), item, cx_agent("шаг 1"),
             cx_user("дальше", ts="2026-09-01T10:01:00.000Z"), cx_agent("шаг 2", ts="2026-09-01T10:01:30.000Z")]
    turns = feed.feed(write_rollout(lines, thread_id=TID))
    assert [(t["prompt"], t["reply"]) for t in turns] == [("дальше", "шаг 1"), ("дальше", "шаг 2")]


def test_aborted_turn_is_interrupted(write_rollout):
    lines = [cx_meta(TID), cx_user("долгая задача"), ev({"type": "task_started"}, "2026-09-01T10:00:03.000Z"),
             ev({"type": "turn_aborted", "reason": "interrupted"}, "2026-09-01T10:00:05.000Z")]
    [t] = feed.feed(write_rollout(lines, thread_id=TID))
    assert t["interrupted"] and t["reply"] is None


def test_images_and_reasoning_are_never_decoded(write_rollout, monkeypatch):
    seen = []
    real = json.loads
    monkeypatch.setattr(codex_feed.json, "loads", lambda raw, *a, **k: seen.append(raw) or real(raw, *a, **k))
    big = cx("response_item", {"type": "message", "role": "user",
                               "content": [{"type": "input_image", "image_url": "data:image/png;base64,QUJD"}]})
    reasoning = cx("response_item", {"type": "reasoning", "summary": [], "encrypted_content": "QUJD"})
    feed.feed(write_rollout([cx_meta(TID), big, reasoning, cx_user("привет"), cx_agent("ок")], thread_id=TID))
    assert not any(b"QUJD" in (s if isinstance(s, bytes) else s.encode()) for s in seen)


def test_files_view_from_patches_and_parsed_reads(write_rollout):
    path = write_rollout(first_turn() + second_turn(), thread_id=TID)
    got = touched.session_files(path)
    assert got["cwd"] == "/Users/u/Code/demo"
    files = {f["path"]: f for f in got["files"]}
    app = files["/Users/u/Code/demo/src/app.py"]
    assert (app["edit"], app["added"], app["removed"]) == (1, 2, 1)
    assert files["/Users/u/Code/demo/NEW.md"]["write"] == 1
    assert files["/Users/u/Code/demo/README.md"]["read"] == 1
    assert got["files"][-1]["path"].endswith("README.md")             # changed files first
    with open(path, "a") as fh:                                         # the next pass reads only the new part
        fh.write(cx_patch_end({"/Users/u/Code/demo/src/app.py": {"type": "update", "unified_diff": "+z\n"}},
                              ts="2026-09-01T12:00:00.000Z"))
    again = {f["path"]: f for f in touched.session_files(path)["files"]}
    assert again["/Users/u/Code/demo/src/app.py"]["edit"] == 2


def test_failed_patch_is_an_error_step_and_not_a_changed_file(write_rollout):
    lines = [cx_meta(TID), cx_user("правь"),
             cx_patch_end({"/Users/u/Code/demo/a.py": {"type": "update", "unified_diff": "+x\n"}},
                          success=False)]
    path = write_rollout(lines, thread_id=TID)
    [t] = feed.feed(path, with_events=True)
    assert [e["status"] for e in t["events"]["events"]] == ["error"]
    assert touched.session_files(path)["files"] == []
