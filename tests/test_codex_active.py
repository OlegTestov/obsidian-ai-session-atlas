"""Live Codex threads in "Active": process detection, the lsof map, turn state, cards and limits."""
from __future__ import annotations

import json
import os
import subprocess
import urllib.request
from datetime import datetime, timezone

import pytest

from atlas import active, codex_live, codex_procs, codex_tail, db, index
from tests.conftest import cx, cx_agent, cx_context, cx_meta, cx_tokens, cx_user, user_text

TID = "019e0000-aaaa-7000-8000-000000000001"
SUB = "019e0000-bbbb-7000-8000-000000000002"
START = "Thu Sep 1 10:00:00 2026"
CODEX = "/opt/homebrew/Caskroom/codex/0.160.0/bin/codex"
ITERM = "/Applications/iTerm.app/Contents/MacOS/iTerm2"


def _conn(atlas_env):
    return db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))


@pytest.fixture(autouse=True)
def _fresh_caches():
    for cache in (codex_procs._map_cache, codex_procs._meta_cache, codex_procs._find_cache, codex_tail._cache):
        cache.clear()
    codex_live._last_live.clear()
    yield


class FakeLsof:
    """Answers `lsof -F pn -p <pids>` from {pid: [paths]}; counts calls."""

    def __init__(self, open_files: dict[int, list[str]], fail=None):
        self.open_files, self.fail, self.calls = open_files, fail, []

    def __call__(self, cmd, **kw):
        self.calls.append(cmd)
        if self.fail:
            raise self.fail
        pids = [int(p) for p in cmd[cmd.index("-p") + 1].split(",")]
        out = "".join(f"p{pid}\nfcwd\nn/Users/u\n" + "".join(f"f2{i}w\nn{path}\n" for i, path in
                                                          enumerate(self.open_files.get(pid, [])))
                      for pid in pids if pid in self.open_files)
        return subprocess.CompletedProcess(cmd, 1, out, "")


def turn(prompt="поправь тесты", reply="Готово", ts="2026-09-01T10:00", done=True, model="gpt-5.5-codex"):
    lines = [cx_context(model=model, ts=f"{ts}:01.000Z"), cx_user(prompt, ts=f"{ts}:02.000Z"),
             cx("event_msg", {"type": "task_started", "turn_id": "t"}, f"{ts}:02.500Z")]
    if reply:
        lines.append(cx_agent(reply, ts=f"{ts}:30.000Z"))
    lines.append(cx_tokens(5000, 4000, 300, reasoning=100, ts=f"{ts}:31.000Z"))
    if done:
        lines.append(cx("event_msg", {"type": "task_complete", "turn_id": "t", "last_agent_message": reply},
                        f"{ts}:32.000Z"))
    return lines


def table(*rows):
    """pid → (ppid, start, command); 50 is iTerm, every codex runs under it."""
    out = {50: (1, START, ITERM)}
    for pid, command in rows:
        out[pid] = (50, START, command)
    return out


# --- which processes are interactive Codex ---

@pytest.mark.parametrize("command, expected", [
    (CODEX, True),
    (f"{CODEX} resume {TID}", True),
    ("codex -m gpt-5.5 --cd /tmp fix the flaky test", True),
    ("codex -c model=o3 exec", False),              # past the option's value, "exec" is the subcommand
    ("codex exec run the linter", False),
    ("codex e hello", False),
    (f"{CODEX} app-server --listen unix://", False),
    ("/x/bin/codex app-server daemon pid-update-loop", False),
    ("/x/bin/codex-code-mode-host --port 1", False),
    ("codex mcp-server", False),
    ("node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js", False),
    ("/usr/bin/vim codex", False),
    ("/x/codex-aarch64-apple-darwin resume", True),
])
def test_interactive_codex_commands(command, expected):
    assert codex_procs.is_interactive_command(command) is expected


def test_one_lsof_for_all_processes_and_the_answer_is_cached(codex_home, write_rollout):
    a = write_rollout([cx_meta(TID), *turn()], thread_id=TID)
    b = write_rollout([cx_meta(SUB), *turn()], thread_id=SUB)
    fake = FakeLsof({101: [a], 102: [b]})
    t = table((101, CODEX), (102, f"{CODEX} resume {SUB}"), (103, "codex exec x"))
    got = codex_procs.rollouts_for(t, run=fake, now=100.0)
    assert got == {101: a, 102: b}
    assert len(fake.calls) == 1 and fake.calls[0][-1] == "101,102"     # exec is not asked about
    codex_procs.rollouts_for(t, run=fake, now=105.0)
    assert len(fake.calls) == 1, "within the TTL the map is reused"
    codex_procs.rollouts_for(t, run=fake, now=100.0 + codex_procs.MAP_TTL + 1)
    assert len(fake.calls) == 2


def test_rollouts_outside_the_codex_home_and_other_files_are_ignored(codex_home, write_rollout, tmp_path):
    foreign = tmp_path / "elsewhere" / f"rollout-2026-09-01T10-00-00-{TID}.jsonl"
    foreign.parent.mkdir()
    foreign.write_text(cx_meta(TID))
    fake = FakeLsof({101: [str(foreign), "/Users/u/notes.txt"]})
    assert codex_procs.rollouts_for(table((101, CODEX)), run=fake) == {}


@pytest.mark.parametrize("failure", [FileNotFoundError("no lsof"), subprocess.TimeoutExpired("lsof", 3)])
def test_without_lsof_the_thread_comes_from_the_command_line(codex_home, write_rollout, failure):
    path = write_rollout([cx_meta(TID), *turn()], thread_id=TID)
    t = table((101, f"{CODEX} resume {TID}"), (102, CODEX))
    assert codex_procs.rollouts_for(t, run=FakeLsof({}, fail=failure)) == {101: path}


def test_a_subagent_rollout_held_by_the_same_process_is_not_the_card(codex_home, write_rollout):
    main = write_rollout([cx_meta(TID), *turn()], thread_id=TID)
    spawned = cx_meta(SUB, source={"subagent": {"thread_spawn": {}}}, thread_source="subagent")
    sub = write_rollout([spawned, *turn()], thread_id=SUB)
    os.utime(main, (1, 1))                          # the subagent wrote last
    got = codex_procs.rollouts_for(table((101, CODEX)), run=FakeLsof({101: [main, sub]}))
    assert got == {101: main}


def test_resumed_cli_without_open_rollout_uses_only_its_daemon_held_thread(codex_home, write_rollout):
    main = write_rollout([cx_meta(TID), *turn()], thread_id=TID)
    other = write_rollout([cx_meta(SUB), *turn()], thread_id=SUB)
    t = table((101, f"{CODEX} resume {TID}"), (102, CODEX),
              (201, f"{CODEX} app-server --listen unix:// --managed-daemon"))
    fake = FakeLsof({201: [main, other]})
    assert codex_procs.rollouts_for(t, run=fake) == {101: main}
    # The daemon is shared: a file held there is not proof that a CLI may be controlled.
    assert not codex_procs.owner(101, TID, t, run=fake)
    assert not codex_procs.owner(201, TID, t, run=fake)


def test_daemon_fallback_does_not_treat_a_prompt_uuid_as_a_resume(codex_home, write_rollout):
    main = write_rollout([cx_meta(TID), *turn()], thread_id=TID)
    t = table((101, f"{CODEX} please resume {TID}"),
              (201, f"{CODEX} app-server --listen unix:// --managed-daemon"))
    assert codex_procs.rollouts_for(t, run=FakeLsof({201: [main]})) == {}


def test_daemon_fallback_requires_the_resumed_thread_to_be_open(codex_home, write_rollout):
    write_rollout([cx_meta(TID), *turn()], thread_id=TID)
    other = write_rollout([cx_meta(SUB), *turn()], thread_id=SUB)
    t = table((101, f"{CODEX} resume {TID}"),
              (201, f"{CODEX} app-server --listen unix:// --managed-daemon"))
    assert codex_procs.rollouts_for(t, run=FakeLsof({201: [other]})) == {}


# --- turn state from the rollout tail ---

def test_status_busy_until_the_turn_ends(write_rollout):
    path = write_rollout([cx_meta(TID), *turn(reply=None, done=False)], thread_id=TID)
    t = codex_tail.read(path)
    assert t["status"] == "busy" and t["prompt"] == "поправь тесты" and t["reply"] is None
    with open(path, "a") as fh:
        fh.write(cx_agent("Тесты зелёные", ts="2026-09-01T10:00:40.000Z"))
        fh.write(cx("event_msg", {"type": "task_complete", "last_agent_message": "Тесты зелёные"},
                    "2026-09-01T10:00:41.000Z"))
    t = codex_tail.read(path)
    assert t["status"] == "idle" and t["reply"] == "Тесты зелёные" and t["prompt"] is None
    assert t["last_prompt"] == "поправь тесты" and t["model"] == "gpt-5.5-codex"


def test_aborted_turn_is_idle_and_reported(write_rollout):
    lines = [cx_meta(TID), *turn(), *turn(prompt="ещё", reply=None, done=False, ts="2026-09-01T10:05")]
    lines.append(cx("event_msg", {"type": "turn_aborted", "reason": "interrupted"}, "2026-09-01T10:05:09.000Z"))
    t = codex_tail.read(write_rollout(lines, thread_id=TID))
    assert t["status"] == "idle" and t["interrupted_at"] == "2026-09-01T10:05:09.000Z"
    assert t["prompt"] == "ещё" and t["reply"] == "Готово"      # the new prompt is unanswered


def test_reply_from_task_complete_and_items_without_events(write_rollout):
    lines = [cx_meta(TID), cx_context(),
             cx("event_msg", {"type": "item_completed", "item": {"type": "UserMessage", "content": [
                 {"type": "text", "text": "сделай отчёт"}, {"type": "local_image", "path": "/tmp/a.png"}]}},
                "2026-09-01T10:00:02.000Z"),
             cx("event_msg", {"type": "task_started"}, "2026-09-01T10:00:03.000Z")]
    t = codex_tail.read(write_rollout(lines, thread_id=TID))
    assert t["prompt"] == "сделай отчёт" and t["prompt_images"] == 1 and t["status"] == "busy"
    done = cx("event_msg", {"type": "task_complete", "last_agent_message": "Отчёт готов"}, "2026-09-01T10:01:00.000Z")
    path = write_rollout([*lines, done], thread_id=TID)
    t = codex_tail.read(path)
    assert t["reply"] == "Отчёт готов" and t["reply_at"] == "2026-09-01T10:01:00.000Z"


def test_long_tail_of_tool_output_is_searched_deeper(write_rollout, monkeypatch):
    monkeypatch.setattr(codex_tail, "TAIL_BYTES", 2048)
    noise = [cx("response_item", {"type": "function_call_output", "call_id": "c", "output": "x" * 3000})] * 20
    t = codex_tail.read(write_rollout([cx_meta(TID), *turn(), *noise], thread_id=TID))
    assert t["reply"] == "Готово" and t["model"] == "gpt-5.5-codex"


# --- cards ---

@pytest.fixture
def claude_dir(tmp_path):
    folder = tmp_path / "claude-sessions"
    folder.mkdir()
    return folder


def _cards(atlas_env, claude_dir, t, fake, conn=None):
    return active.list_active(conn or _conn(atlas_env), sessions_dir=str(claude_dir),
                              projects_root=str(atlas_env["projects"]), table=t, run=fake)


def test_codex_card_has_the_claude_card_keys(atlas_env, write_session, write_rollout, claude_dir):
    claude_id = "11111111-2222-3333-4444-555555555555"
    write_session("-Users-u-Code-demo", [user_text("claude работа")], session_id=claude_id)
    (claude_dir / "201.json").write_text(json.dumps(
        {"pid": 201, "sessionId": claude_id, "kind": "interactive", "entrypoint": "cli",
         "status": "idle", "procStart": START}))
    plan = cx("response_item", {"type": "function_call", "name": "update_plan", "call_id": "u1",
                                "arguments": json.dumps({"plan": [{"step": "тесты", "status": "completed"},
                                                                  {"step": "код", "status": "in_progress"}]})},
              "2026-09-01T10:00:10.000Z")
    path = write_rollout([cx_meta(TID), *turn()[:3], plan, *turn()[3:]], thread_id=TID)
    t = table((101, CODEX), (201, "/Users/u/.local/bin/claude"))
    cards = _cards(atlas_env, claude_dir, t, FakeLsof({101: [path]}))
    by = {c["agent"]: c for c in cards}
    assert set(by) == {"claude", "codex"}
    assert set(by["codex"]) == set(by["claude"])
    c = by["codex"]
    assert c["session_id"] == TID and c["pid"] == 101 and c["host_app"] == "iTerm"
    assert c["status"] == "idle" and c["activity"] == "idle" and c["reply_tail"] == "Готово"
    assert c["model"] == "gpt-5.5-codex" and c["cwd"] == "/Users/u/Code/demo"
    assert c["context_tokens"] == 5200 and c["title"] == "поправь тесты"
    assert c["tasks"] == {"total": 2, "done": 1, "active": ["код"],
                          "items": [{"subject": "тесты", "status": "completed"},
                                    {"subject": "код", "status": "in_progress"}]}
    assert c["process_started_at"] == "2026-09-01T10:00:00+00:00"


def test_indexed_thread_uses_catalog_title_and_exec_processes_get_no_card(
        atlas_env, write_rollout, claude_dir):
    path = write_rollout([cx_meta(TID), *turn()], thread_id=TID)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("INSERT INTO user_overrides (session_id, title, updated_at) VALUES (?, 'Мой тред', 'now')", (TID,))
    conn.commit()
    t = table((101, CODEX), (102, "codex exec go"))
    cards = _cards(atlas_env, claude_dir, t, FakeLsof({101: [path], 102: [path]}), conn)
    assert [(c["session_id"], c["title"], c["indexed"]) for c in cards] == [(TID, "Мой тред", True)]


def test_two_processes_on_one_thread_make_one_card(atlas_env, write_rollout, claude_dir):
    path = write_rollout([cx_meta(TID), *turn()], thread_id=TID)
    cards = _cards(atlas_env, claude_dir, table((101, CODEX), (102, CODEX)),
                   FakeLsof({101: [path], 102: [path]}))
    assert len(cards) == 1


def test_recent_closed_lists_codex_and_filters_by_agent(atlas_env, write_rollout, write_session):
    from tests.conftest import assistant_text
    write_rollout([cx_meta(TID), *turn()], thread_id=TID)
    claude_id = "11111111-2222-3333-4444-555555555555"
    write_session("-Users-u-Code-demo", [user_text("работа", ts="2026-09-01T10:00:00.000Z"),
                                         assistant_text("ок", ts="2026-09-01T10:01:00.000Z")],
                  session_id=claude_id)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    now = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
    got = active.recently_closed(conn, set(), now=now)
    assert {(r["session_id"], r["agent"]) for r in got} == {(TID, "codex"), (claude_id, "claude")}
    assert [r["session_id"] for r in active.recently_closed(conn, set(), now=now, agents=["codex"])] == [TID]
    assert active.recently_closed(conn, {TID}, now=now, agents=["codex"]) == []


# --- limits ---

def test_codex_limits_have_the_shape_of_claude_limits(write_rollout):
    tokens = cx("event_msg", {"type": "token_count", "info": None, "rate_limits": {
        "primary": {"used_percent": 41.5, "window_minutes": 300, "resets_at": 1788264000},
        "secondary": {"used_percent": 12.0, "window_minutes": 10080, "resets_at": 1788800000}}},
        "2026-09-01T10:00:40.000Z")
    write_rollout([cx_meta(TID), *turn(), tokens], thread_id=TID)
    now = datetime(2026, 9, 1, 10, 1, 40, tzinfo=timezone.utc).timestamp()
    got = codex_live.limits(now=now)
    assert got == {"captured_at": "2026-09-01T10:00:40+00:00", "age_seconds": 60, "windows": [
        {"key": "five_hour", "label": "5 hours", "used_percentage": 41.5,
         "resets_at": "2026-09-01T12:00:00+00:00"},
        {"key": "seven_day", "label": "week", "used_percentage": 12.0,
         "resets_at": "2026-09-07T16:53:20+00:00"}], "source": "rollout", "live": False}
    odd = codex_tail.limit_windows({"primary": {"used_percent": 5, "window_minutes": 1440}}, None)
    assert odd["windows"][0]["label"] == "1 d" and odd["age_seconds"] is None


def test_no_rate_limits_no_codex_line(write_rollout):
    write_rollout([cx_meta(TID), *turn()], thread_id=TID)          # rate_limits: {}
    assert codex_live.limits() is None


# --- the route ---

def test_active_route_filters_by_agent(atlas_env, write_session, write_rollout, live_server, monkeypatch, tmp_path):
    from atlas import server
    path = write_rollout([cx_meta(TID), *turn()], thread_id=TID)
    claude_id = "11111111-2222-3333-4444-555555555555"
    write_session("-Users-u-Code-demo", [user_text("claude работа")], session_id=claude_id)
    sessions = tmp_path / "claude-sessions"
    sessions.mkdir()
    (sessions / "201.json").write_text(json.dumps(
        {"pid": 201, "sessionId": claude_id, "kind": "interactive", "entrypoint": "cli",
         "status": "idle", "procStart": START}))
    monkeypatch.setattr(active, "SESSIONS_DIR", str(sessions))
    monkeypatch.setattr(active, "process_table", lambda: table((101, CODEX), (201, "claude")))
    monkeypatch.setattr(codex_procs, "_run", FakeLsof({101: [path]}))
    monkeypatch.setitem(server._active_cached, "sessions", None)
    base, _ = live_server

    def get(query=""):
        with urllib.request.urlopen(f"{base}/api/active{query}") as r:
            return json.loads(r.read())
    both = get()
    assert {s["agent"] for s in both["sessions"]} == {"claude", "codex"} and both["count"] == 2
    assert "codex_limits" in both
    only = get("?agent=codex")
    assert [s["session_id"] for s in only["sessions"]] == [TID] and only["count"] == 1
    assert [s["agent"] for s in get("?agent=claude")["sessions"]] == ["claude"]
    assert get("?agent=gemini")["count"] == 2                         # unknown values are ignored


def test_a_run_with_empty_limit_windows_does_not_hide_older_limits(write_rollout):
    """Runs that failed on a spent limit report null windows: the last real numbers still show."""
    real = cx("event_msg", {"type": "token_count", "info": None, "rate_limits": {
        "primary": {"used_percent": 99.0, "window_minutes": 300, "resets_at": 1788264000},
        "secondary": None}}, "2026-09-01T10:00:40.000Z")
    empty = cx("event_msg", {"type": "token_count", "info": None, "rate_limits": {
        "limit_id": "premium", "primary": None, "secondary": None}}, "2026-09-01T11:00:00.000Z")
    older = write_rollout([cx_meta(TID), *turn(), real], thread_id=TID)
    newer = write_rollout([cx_meta(SUB), *turn(ts="2026-09-01T11:00"), empty], thread_id=SUB)
    os.utime(older, (1, 1))
    os.utime(newer, (2, 2))
    got = codex_live.limits()
    assert [(w["key"], w["used_percentage"]) for w in got["windows"]] == [("five_hour", 99.0)]


def test_live_card_cost_uses_openai_prices():
    """A Codex card prices its running total with the OpenAI table, never Claude's."""
    total = {"input_tokens": 1_000_000, "cached_input_tokens": 400_000, "output_tokens": 100_000}
    priced = codex_live._cost_now("gpt-6.1-sol", total)
    assert priced is not None and priced > 0
    # 600k fresh × $2 + 400k cached × $0.10 + 100k out × $10, per 1M tokens
    assert abs(priced - (0.6 * 2.00 + 0.4 * 0.10 + 0.1 * 10.00)) < 1e-6
    assert codex_live._cost_now("no-such-model", total) is None
