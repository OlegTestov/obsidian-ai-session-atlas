"""Лента: шаги хода по порядку и файлы сессии."""
from __future__ import annotations

import json
import os

from atlas import feed, touched
from tests.conftest import assistant_text, rec, user_text


def call(name, args, tid, ts):
    return rec(type="assistant", timestamp=ts, message={"role": "assistant", "content": [
        {"type": "tool_use", "id": tid, "name": name, "input": args}]})


def result(tid, ts, error=None):
    block = {"type": "tool_result", "tool_use_id": tid, "content": error or "ok"}
    if error:
        block["is_error"] = True
    return rec(type="user", timestamp=ts, message={"role": "user", "content": [block]})


def records(text):
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def _turn():
    text = (user_text("почини", ts="2026-09-27T10:00:00.000Z")
            + call("Read", {"file_path": "/x/a.py"}, "r1", "2026-09-27T10:00:01.000Z")
            + result("r1", "2026-09-27T10:00:02.000Z")
            + call("Grep", {"pattern": "def x"}, "g1", "2026-09-27T10:00:03.000Z")
            + result("g1", "2026-09-27T10:00:03.500Z")
            + call("Read", {"file_path": "/x/b.py"}, "r2", "2026-09-27T10:00:04.000Z")
            + result("r2", "2026-09-27T10:00:04.200Z")
            + call("Read", {"file_path": "/x/c.py"}, "r3", "2026-09-27T10:00:05.000Z")
            + result("r3", "2026-09-27T10:00:05.100Z")
            + assistant_text("вижу причину", ts="2026-09-27T10:00:06.000Z")
            + call("Bash", {"command": "pytest -q", "description": "Run tests"}, "b1", "2026-09-27T10:00:07.000Z")
            + result("b1", "2026-09-27T10:01:07.000Z", error="Exit code 1\nFAILED test_x")
            + call("Agent", {"subagent_type": "Explore", "description": "найти вызовы"}, "a1",
                   "2026-09-27T10:01:08.000Z")
            + assistant_text("готово", ts="2026-09-27T10:02:00.000Z"))
    return feed.build(records(text), with_events=True)[0]["events"]


def test_steps_speak_the_page_language():
    from atlas import messages
    assert _turn()["events"][2]["text"] == "read 2 files"          # без заголовка — английский
    with messages.use_lang("ru"):
        ev = _turn()
    assert ev["events"][2]["text"] == "прочитал 2 файла" and ev["events"][5]["text"] == "агент Explore: найти вызовы"


def test_steps_keep_order_merge_reads_and_show_errors():
    from atlas import messages
    with messages.use_lang("ru"):
        ev = _turn()
    assert [e["kind"] for e in ev["events"]] == ["read", "search", "read", "text", "bash", "agent"]
    assert ev["events"][2]["text"] == "прочитал 2 файла" and "/x/c.py" in ev["events"][2]["detail"]
    bash = ev["events"][4]
    assert bash["status"] == "error" and bash["took"] == 60.0 and "FAILED" in bash["error"]
    assert ev["events"][5]["status"] == "run"            # результата ещё нет — идёт
    assert ev["events"][5]["text"] == "агент Explore: найти вызовы"
    assert ev["errors"] == 1


def test_final_reply_is_not_repeated_as_a_step():
    assert all(e["text"] != "готово" for e in _turn()["events"])


def test_plain_feed_has_no_events():
    text = user_text("x", ts="2026-09-27T10:00:00.000Z")
    assert "events" not in feed.build(records(text))[0]


def test_long_turn_keeps_the_latest_steps(monkeypatch):
    monkeypatch.setattr("atlas.steps.MAX_EVENTS", 3)
    text = user_text("x", ts="2026-09-27T10:00:00.000Z") + "".join(
        call("Bash", {"command": f"echo {i}"}, f"b{i}", f"2026-09-27T10:00:{10 + i:02d}.000Z") for i in range(5))
    ev = feed.build(records(text), with_events=True)[0]["events"]
    assert ev["earlier"] == 2 and [e["text"] for e in ev["events"]] == ["echo 2", "echo 3", "echo 4"]


def test_files_count_edits_lines_and_subagents(tmp_path):
    touched._cache.clear()
    path = tmp_path / "s.jsonl"
    path.write_text(
        call("Read", {"file_path": "/p/a.py"}, "1", "2026-09-27T10:00:00.000Z")
        + call("Edit", {"file_path": "/p/a.py", "old_string": "x = 1\ny = 2", "new_string": "x = 1\ny = 3\nz = 4"},
               "2", "2026-09-27T10:01:00.000Z")
        + call("Write", {"file_path": "/p/new.py", "content": "a\nb\nc"}, "3", "2026-09-27T10:02:00.000Z")
        + call("Read", {"file_path": "/p/only.md"}, "4", "2026-09-27T10:03:00.000Z"))
    sub = tmp_path / "s" / "subagents"
    sub.mkdir(parents=True)
    (sub / "agent-1.jsonl").write_text(call("Edit", {"file_path": "/p/a.py", "old_string": "q", "new_string": "w"},
                                            "5", "2026-09-27T10:04:00.000Z"))
    files = touched.session_files(str(path))["files"]
    assert [f["path"] for f in files] == ["/p/a.py", "/p/new.py", "/p/only.md"]
    a = files[0]
    assert (a["read"], a["edit"], a["added"], a["removed"]) == (1, 2, 3, 2)
    assert (files[1]["write"], files[1]["added"]) == (1, 3)


def test_files_read_only_appended_tail(tmp_path):
    touched._cache.clear()
    path = tmp_path / "s.jsonl"
    path.write_text(call("Read", {"file_path": "/p/a.py"}, "1", "2026-09-27T10:00:00.000Z"))
    assert touched.session_files(str(path))["files"][0]["read"] == 1
    with open(path, "a") as fh:
        fh.write(call("Read", {"file_path": "/p/a.py"}, "2", "2026-09-27T10:01:00.000Z"))
        fh.write('{"type":"assistant","message":{"content":[{"type":"tool_use"')   # недописанная
    assert touched.session_files(str(path))["files"][0]["read"] == 2
    os.truncate(path, 0)                                     # файл переписан — считаем заново
    path.write_text(call("Write", {"file_path": "/p/b.py", "content": "x"}, "3", "2026-09-27T10:02:00.000Z"))
    got = touched.session_files(str(path))["files"]
    assert [f["path"] for f in got] == ["/p/b.py"]


def test_files_do_not_reread_what_was_already_counted(tmp_path):
    touched._cache.clear()
    path = tmp_path / "s.jsonl"
    path.write_text(call("Read", {"file_path": "/p/a.py"}, "1", "2026-09-27T10:00:00.000Z"))
    touched.session_files(str(path))
    with open(path, "r+") as fh:                  # то же место и длина: прочитанное не трогаем
        text = fh.read()
        fh.seek(0)
        fh.write(text.replace("/p/a.py", "/p/z.py"))
    with open(path, "a") as fh:
        fh.write(call("Read", {"file_path": "/p/b.py"}, "2", "2026-09-27T10:01:00.000Z"))
    assert sorted(f["path"] for f in touched.session_files(str(path))["files"]) == ["/p/a.py", "/p/b.py"]
