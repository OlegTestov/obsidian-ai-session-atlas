"""The "Active" tab: which Claude Code processes count as a person's live sessions."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pytest

from atlas import active, db, index
from tests.conftest import assistant_text, rec, user_text

START = "Sat Sep 26 15:39:21 2026"


def _conn(atlas_env):
    return db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))


@pytest.fixture
def claude_dir(tmp_path):
    folder = tmp_path / "sessions"
    folder.mkdir()

    def write(pid, sid, **kw):
        data = {"pid": pid, "sessionId": sid, "cwd": "/Users/u/Code/demo",
                "startedAt": 1790437190048, "procStart": START, "kind": "interactive",
                "entrypoint": "cli", "status": "idle", "name": "local-" + sid[:2]}
        data.update(kw)
        (folder / f"{pid}.json").write_text(json.dumps(data), encoding="utf-8")
    write.folder = str(folder)
    return write


# pid → (ppid, start time). 900 is Obsidian, 800/801 are the PTY proxies of two tabs.
TABLE = {100: (801, START), 200: (800, START), 300: (1, START), 400: (1, "Sun Sep 27 01:00:00 2026"),
         800: (900, START), 801: (900, START), 900: (1, START)}


def _list(atlas_env, claude_dir, conn=None):
    conn = conn or _conn(atlas_env)
    return active.list_active(conn, sessions_dir=claude_dir.folder,
                              projects_root=str(atlas_env["projects"]), table=TABLE)


def test_only_live_interactive_processes_are_active(atlas_env, claude_dir):
    claude_dir(100, "aaaa-live")
    claude_dir(555, "bbbb-dead")                                  # no such process
    claude_dir(400, "cccc-reused", procStart=START)               # PID reused by another process
    claude_dir(300, "dddd-print", kind="headless")                # claude -p
    claude_dir(200, "eeee-sdk", entrypoint="sdk-cli")             # reviewer, hook, nightly agent
    Path(claude_dir.folder, "666.json").write_text("{битый")
    ids = [s["session_id"] for s in _list(atlas_env, claude_dir)]
    assert ids == ["aaaa-live"]


def test_proc_start_ignores_padding_of_the_day():
    """ctime pads the day with a space: "Sep  6" and "Sep 6" are the same time."""
    table = {7: (1, "Sat Sep 6 09:00:00 2026")}
    assert active._alive(7, "Sat Sep  6 09:00:00 2026", table)
    assert not active._alive(7, "Sat Sep  6 09:00:01 2026", table)


def test_ancestors_lead_to_the_terminal_tab(atlas_env, claude_dir):
    claude_dir(100, "aaaa-live")
    assert _list(atlas_env, claude_dir)[0]["ancestors"] == [801, 900]


def test_cards_are_ordered_by_the_last_message_in_the_transcript(atlas_env, write_session,
                                                                 claude_dir):
    """The index catches up with a delay: freshness comes from the transcript tail."""
    write_session("p", [user_text("середина", ts="2026-09-20T10:00:00.000Z")], session_id="middle")
    write_session("p", [user_text("новая", ts="2026-09-10T10:00:00.000Z")], session_id="newest")
    write_session("p", [user_text("старая", ts="2026-09-15T10:00:00.000Z")], session_id="oldest")
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    # "newest" is appended after indexing, and its last line is still being written — no newline.
    with open(os.path.join(str(atlas_env["projects"]), "p", "newest.jsonl"), "a") as fh:
        fh.write(assistant_text("ответ", ts="2026-09-26T10:00:00.000Z"))
        fh.write('{"type":"assistant","timestamp":"2026-09-27')
    # File order (100, 200, 300) matches the answer neither forwards nor backwards.
    claude_dir(100, "middle")
    claude_dir(200, "newest")
    claude_dir(300, "oldest")
    cards = _list(atlas_env, claude_dir, conn)
    assert [c["session_id"] for c in cards] == ["newest", "middle", "oldest"]
    assert cards[0]["last_message_at"].startswith("2026-09-26T10:00")


def test_card_carries_what_the_index_knows(atlas_env, write_session, claude_dir):
    write_session("p", [user_text("правим ABC-1359"), assistant_text("готово"),
                        rec(type="assistant", timestamp="2026-09-01T10:05:00.000Z",
                            cwd="/Users/u/Code/demo", entrypoint="cli",
                            message={"role": "assistant", "model": "m", "content": [],
                                     "usage": {}})],
                  session_id="known")
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    claude_dir(100, "known", status="busy")
    claude_dir(200, "fresh-not-indexed")
    cards = {c["session_id"]: c for c in _list(atlas_env, claude_dir, conn)}
    known = cards["known"]
    assert known["indexed"] and known["title"] and known["human_turns"] == 1
    assert known["tickets"] == ["ABC-1359"] and known["status"] == "busy"
    assert known["started_at"].startswith("2026-09-01")
    fresh = cards["fresh-not-indexed"]
    assert not fresh["indexed"] and fresh["title"] == "local-fr"
    assert fresh["started_at"] == fresh["process_started_at"]      # from the process startedAt


def test_real_process_table_sees_this_process():
    table = active.process_table()
    pid = os.getpid()
    assert pid in table and table[pid][0] == os.getppid()
    assert len(table[pid][1].split()) == 5          # «Sat Sep 26 15:39:21 2026»


def test_api_active_lists_live_sessions(atlas_env, claude_dir, live_server, monkeypatch):
    monkeypatch.setattr(active, "SESSIONS_DIR", claude_dir.folder)
    monkeypatch.setattr(active, "process_table", lambda: TABLE)
    claude_dir(100, "aaaa-live")
    claude_dir(555, "bbbb-dead")
    base, _ = live_server
    with urllib.request.urlopen(f"{base}/api/active", timeout=10) as r:
        data = json.loads(r.read())
    assert data["count"] == 1 and data["sessions"][0]["session_id"] == "aaaa-live"
    assert data["sessions"][0]["ancestors"] == [801, 900]


def test_last_message_ignores_tool_noise_and_notifications(tmp_path):
    """A "message just now" on a session nobody wrote in must not come from service records."""
    path = tmp_path / "s.jsonl"
    tool_result = rec(type="user", timestamp="2026-09-27T09:05:00.000Z",
                      message={"role": "user", "content": [
                          {"type": "tool_result", "tool_use_id": "t", "content": "ok"}]})
    tool_use = rec(type="assistant", timestamp="2026-09-27T09:06:00.000Z",
                   message={"role": "assistant", "content": [
                       {"type": "tool_use", "id": "t", "name": "Bash", "input": {}}]})
    peer = user_text("Another Claude session sent a message: <teammate-message> idle",
                     ts="2026-09-27T09:07:00.000Z")
    task = user_text("<task-notification> done </task-notification>", ts="2026-09-27T09:08:00.000Z")
    meta = rec(type="user", timestamp="2026-09-27T09:09:00.000Z", isMeta=True,
               message={"role": "user", "content": "служебное"})
    path.write_text(user_text("вопрос", ts="2026-09-27T08:00:00.000Z")
                    + assistant_text("ответ", ts="2026-09-27T08:01:00.000Z")
                    + tool_result + tool_use + peer + task + meta, encoding="utf-8")
    assert active.last_message_at(str(path)) == "2026-09-27T08:01:00.000Z"


def test_last_message_looks_past_a_long_tail_of_tool_calls(tmp_path, monkeypatch):
    monkeypatch.setattr(active, "TAIL_BYTES", 256)
    noise = "".join(rec(type="user", timestamp="2026-09-27T09:00:00.000Z",
                        message={"role": "user", "content": [
                            {"type": "tool_result", "tool_use_id": "t", "content": "x" * 50}]})
                    for _ in range(40))
    path = tmp_path / "s.jsonl"
    path.write_text(user_text("мой запрос", ts="2026-09-27T07:00:00.000Z") + noise,
                    encoding="utf-8")
    assert active.last_message_at(str(path)) == "2026-09-27T07:00:00.000Z"


def test_reply_and_progress_come_from_the_tail(tmp_path):
    """The reply tail is Claude's last text; "now" is the note after it (Opus 5.5)."""
    path = tmp_path / "s.jsonl"
    long_answer = "начало отчёта " + "х" * 1500 + " Что делаем дальше?"
    note = rec(type="assistant", timestamp="2026-09-27T09:10:00.000Z",
               message={"role": "assistant", "content": [
                   {"type": "thinking", "thinking": "Проверяю тесты", "signature": "s"},
                   {"type": "tool_use", "id": "t", "name": "Bash", "input": {}}]})
    path.write_text(user_text("сделай", ts="2026-09-27T09:00:00.000Z")
                    + assistant_text(long_answer, ts="2026-09-27T09:05:00.000Z")
                    + user_text("продолжай", ts="2026-09-27T09:08:00.000Z") + note,
                    encoding="utf-8")
    found = active.last_messages(str(path))
    assert found["last_at"] == "2026-09-27T09:08:00.000Z"          # your "продолжай"
    assert found["reply"].endswith("Что делаем дальше?") and found["reply_at"].endswith("09:05:00.000Z")
    assert found["progress"] == "Проверяю тесты"


def test_card_shows_the_tail_of_a_long_reply(atlas_env, claude_dir, write_session):
    write_session("p", [user_text("вопрос"),
                        assistant_text("а" * 3000 + " ВОПРОС В КОНЦЕ?")], session_id="long")
    claude_dir(100, "long")
    card = _list(atlas_env, claude_dir)[0]
    assert card["reply_len"] > 3000 and len(card["reply_tail"]) == active.PREVIEW_CHARS
    assert card["reply_tail"].endswith("ВОПРОС В КОНЦЕ?")


def test_waiting_status_carries_what_it_waits_for(atlas_env, claude_dir):
    claude_dir(100, "dialog", status="waiting", waitingFor="input needed")
    claude_dir(200, "calm", status="idle", waitingFor="stale")
    cards = {c["session_id"]: c for c in _list(atlas_env, claude_dir)}
    assert cards["dialog"]["waiting_for"] == "input needed"
    assert cards["calm"]["waiting_for"] is None


def test_api_full_reply_by_id(atlas_env, write_session, live_server):
    write_session("p", [user_text("вопрос"), assistant_text("полный ответ " * 300)],
                  session_id="11111111-2222-4333-8444-555555555555")
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    base, _ = live_server
    with urllib.request.urlopen(f"{base}/api/active/reply/11111111-2222-4333-8444-555555555555",
                                timeout=10) as r:
        data = json.loads(r.read())
    assert data["text"].startswith("полный ответ") and len(data["text"]) > 3000
    with pytest.raises(urllib.error.HTTPError) as bad:
        urllib.request.urlopen(f"{base}/api/active/reply/..%2Fetc", timeout=10)
    assert bad.value.code in (400, 404)


# --- "in background": turn is over, background work (not you) wakes the session -----

SNAP = "/bin/zsh -c source /Users/u/.claude/shell-snapshots/snapshot-zsh-1-x.sh && tail -f log"


def test_background_shell_is_counted_but_mcp_servers_are_not():
    table = {100: (1, START, "claude --resume x"), 101: (100, START, SNAP),
             102: (100, START, "npm exec @zereight/mcp-gitlab"), 103: (999, START, SNAP)}
    assert active.shell_tasks(100, table) == 1


def test_fresh_subagent_transcript_means_a_live_agent(tmp_path):
    transcript = tmp_path / "sess.jsonl"
    transcript.write_text("")
    sub = tmp_path / "sess" / "subagents"
    sub.mkdir(parents=True)
    (sub / "agent-a.jsonl").write_text("{}")
    old = sub / "agent-b.jsonl"
    old.write_text("{}")
    past = time.time() - active.AGENT_FRESH_SECONDS - 10
    os.utime(old, (past, past))
    assert active.live_subagents(str(transcript)) == 1


def _tool(name, args, ts):
    return rec(type="assistant", timestamp=ts, message={"role": "assistant", "content": [
        {"type": "tool_use", "id": "t", "name": name, "input": args}]})


def test_loop_wakeup_goal_and_cron_come_from_the_transcript(tmp_path):
    now = time.time()

    def iso(t: float) -> str:
        return datetime.fromtimestamp(t, tz=timezone.utc).isoformat().replace("+00:00", "Z")

    path = tmp_path / "s.jsonl"
    path.write_text(
        _tool("CronCreate", {"cron": "*/30 * * * *", "prompt": "p"}, iso(now - 900))
        + _tool("CronCreate", {"cron": "0 9 * * *", "prompt": "q"}, iso(now - 800))
        + _tool("CronDelete", {"id": "x"}, iso(now - 700))
        + rec(type="attachment", attachment={"type": "goal_status", "met": False,
                                             "condition": "доделать"})
        + _tool("ScheduleWakeup", {"delaySeconds": 1200, "reason": "r"}, iso(now - 60)),
        encoding="utf-8")
    plan = active.schedule_state(str(path), now=now)
    assert plan["crons"] == 1 and plan["goal"] == "доделать"
    assert abs(active._as_datetime(plan["wake_at"]).timestamp() - (now + 1140)) < 2

    with open(path, "a") as fh:            # goal met, the wake-up is cleared
        fh.write(rec(type="attachment", attachment={"type": "goal_status", "met": True,
                                                    "condition": "доделать"}))
        fh.write(_tool("ScheduleWakeup", {"stop": True}, iso(now - 30)))
    plan = active.schedule_state(str(path), now=now)
    assert plan["goal"] is None and plan["wake_at"] is None


def test_wakeup_in_the_past_is_not_pending(tmp_path):
    now = time.time()
    path = tmp_path / "s.jsonl"
    stamp = datetime.fromtimestamp(now - 3600, tz=timezone.utc).isoformat()
    path.write_text(_tool("ScheduleWakeup", {"delaySeconds": 60}, stamp), encoding="utf-8")
    assert active.schedule_state(str(path), now=now)["wake_at"] is None


@pytest.mark.parametrize("status, bg, expected", [
    ("busy", {}, "busy"), ("shell", {}, "busy"), ("waiting", {"shells": 1}, "waiting"),
    ("idle", {"shells": 1}, "background"), ("idle", {"agents": 2}, "background"),
    ("idle", {"wake_at": "2026-09-27T16:30:00+00:00"}, "background"),
    ("idle", {"crons": 1}, "background"),
    ("idle", {"goal": "доделать"}, "idle"),       # goal without background work — waits for you
    ("idle", {}, "idle"),
])
def test_activity(status, bg, expected):
    full = {"shells": 0, "agents": 0, "wake_at": None, "crons": 0, "goal": None, **bg}
    assert active.activity(status, full) == expected


def test_idle_session_with_a_monitor_is_background(atlas_env, claude_dir):
    claude_dir(100, "monitoring", status="idle")
    table = dict(TABLE)
    table = {k: (v[0], v[1], "claude") for k, v in table.items()}
    table[4242] = (100, START, SNAP)
    cards = active.list_active(_conn(atlas_env), sessions_dir=claude_dir.folder,
                               projects_root=str(atlas_env["projects"]), table=table)
    assert cards[0]["activity"] == "background" and cards[0]["background"]["shells"] == 1


def test_markdown_tail_starts_at_a_line_and_keeps_code_blocks_closed():
    lines = [f"строка {i} **жирная** часть" for i in range(80)]
    text = "\n".join(lines)
    tail = active.markdown_tail(text, limit=300)
    assert tail.startswith("строка ") and len(tail) <= 300
    code = "Вступление\n```python\n" + "\n".join(f"x{i} = {i}" for i in range(100)) + "\n```\nИтог."
    tail = active.markdown_tail(code, limit=200)
    assert tail.startswith("```\n") and tail.rstrip().endswith("Итог.")
    assert active.markdown_tail("коротко", limit=200) == "коротко"


def test_unanswered_prompt_is_shown_until_claude_replies(tmp_path):
    """After sending, the card shows your message until Claude's reply arrives."""
    path = tmp_path / "s.jsonl"
    path.write_text(assistant_text("прошлый ответ", ts="2026-09-27T09:00:00.000Z")
                    + user_text("сделай вот это", ts="2026-09-27T09:05:00.000Z"), encoding="utf-8")
    found = active.last_messages(str(path))
    assert found["prompt"] == "сделай вот это" and found["reply"] == "прошлый ответ"
    with open(path, "a") as fh:
        fh.write(assistant_text("сделано", ts="2026-09-27T09:06:00.000Z"))
    found = active.last_messages(str(path))
    assert found["prompt"] is None and found["reply"] == "сделано"


def test_slash_command_is_shown_as_typed_and_harness_text_is_not_a_message(tmp_path):
    path = tmp_path / "s.jsonl"
    command = ("<command-name>/goal</command-name>\n<command-message>goal</command-message>\n"
               "<command-args>проверь поле ввода</command-args>")
    path.write_text(assistant_text("ответ", ts="2026-09-27T09:00:00.000Z")
                    + user_text(command, ts="2026-09-27T09:05:00.000Z")
                    + user_text("<local-command-stdout>Goal set: …</local-command-stdout>",
                                ts="2026-09-27T09:05:00.100Z")
                    + user_text("A session-scoped Stop hook is now active with condition: …",
                                ts="2026-09-27T09:05:00.200Z"), encoding="utf-8")
    found = active.last_messages(str(path))
    assert found["prompt"] == "/goal проверь поле ввода"
    assert found["last_at"] == "2026-09-27T09:05:00.000Z"


def test_prompt_with_an_image_counts_it(tmp_path):
    path = tmp_path / "s.jsonl"
    path.write_text(assistant_text("ответ", ts="2026-09-27T09:00:00.000Z") + rec(
        type="user", timestamp="2026-09-27T09:05:00.000Z",
        message={"role": "user", "content": [
            {"type": "text", "text": "что на скрине?"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "x"}}]}),
        encoding="utf-8")
    found = active.last_messages(str(path))
    assert found["prompt"] == "что на скрине?" and found["prompt_images"] == 1


def test_goal_clear_record_ends_the_goal(tmp_path):
    """/goal clear writes goal_status with met:true and sentinel:true — captured from a live CLI."""
    path = tmp_path / "s.jsonl"
    path.write_text(
        rec(type="attachment", attachment={"type": "goal_status", "met": False, "sentinel": True,
                                           "condition": "дождись ПОДСОЛНУХ"})
        + rec(type="attachment", attachment={"type": "goal_status", "met": True, "sentinel": True,
                                             "condition": "дождись ПОДСОЛНУХ"})
        + rec(type="system", subtype="local_command",
              content="<local-command-stdout>Goal cleared: дождись ПОДСОЛНУХ</local-command-stdout>"),
        encoding="utf-8")
    assert active.schedule_state(str(path))["goal"] is None


def test_parallel_polls_share_one_active_pass(monkeypatch):
    """The page and the plugin poll at the same time: one cold pass serves everyone."""
    import threading
    import time as _time

    from atlas import server
    calls = []

    def slow(conn):
        calls.append(1)
        _time.sleep(0.2)
        return [{"session_id": "s"}]
    monkeypatch.setattr(server.active, "list_active", slow)
    monkeypatch.setitem(server._active_cached, "sessions", None)
    out = []
    threads = [threading.Thread(target=lambda: out.append(server.active_sessions(None)))
               for _ in range(4)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(calls) == 1 and len(out) == 4
    monkeypatch.setitem(server._active_cached, "at", _time.monotonic() - 5)
    server.active_sessions(None)
    assert len(calls) == 2, "a stale answer is recomputed"


def test_interrupt_is_not_a_prompt_but_is_reported(tmp_path):
    """Esc or "Stop": the "[Request interrupted by user]" record is not your message, but the request is interrupted."""
    path = tmp_path / "s.jsonl"
    path.write_text(assistant_text("готово", ts="2026-09-27T08:00:00.000Z")
                    + user_text("перепиши всё", ts="2026-09-27T08:05:00.000Z")
                    + user_text("[Request interrupted by user]", ts="2026-09-27T08:06:00.000Z"),
                    encoding="utf-8")
    found = active.last_messages(str(path))
    assert found["prompt"] == "перепиши всё"
    assert found["last_at"] == "2026-09-27T08:05:00.000Z"
    assert found["interrupted_at"] == "2026-09-27T08:06:00.000Z"
    # An old interruption before the last message does not apply to it.
    path.write_text(user_text("[Request interrupted by user]", ts="2026-09-27T07:00:00.000Z")
                    + assistant_text("готово", ts="2026-09-27T08:00:00.000Z"), encoding="utf-8")
    assert active.last_messages(str(path))["interrupted_at"] is None
