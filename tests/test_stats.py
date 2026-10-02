"""«Статистика»: активное время, ответ считается один раз, сабагенты, дописанный файл, период."""
from __future__ import annotations

import os
from datetime import datetime, timezone

from atlas import db, index, stats
from tests.conftest import rec, tool_result, user_text

NOW = datetime(2026, 9, 1, 18, 0, tzinfo=timezone.utc)


def answer(mid, ts, tools=(), model="claude-opus-5", uuid=None, sidechain=False, **usage):
    base = {"input_tokens": 100, "output_tokens": 10, "cache_read_input_tokens": 1000,
            "cache_creation_input_tokens": 0}
    base.update(usage)
    content = [{"type": "tool_use", "id": f"t{i}", "name": name, "input": args}
               for i, (name, args) in enumerate(tools)] or [{"type": "text", "text": "ок"}]
    return rec(type="assistant", timestamp=ts, uuid=uuid or mid + ts, isSidechain=sidechain,
               cwd="/Users/u/Code/demo", entrypoint="cli",
               message={"id": mid, "role": "assistant", "model": model, "usage": base,
                        "content": content})


def prompt(text, ts, uid):
    return user_text(text, ts=ts, uuid=uid)


def _index(atlas_env):
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    return conn


def _totals(conn, period="all"):
    return stats.summary(conn, period, now=NOW)["totals"]


def test_active_time_skips_long_pauses(atlas_env, write_session):
    write_session("p", [
        prompt("сделай отчёт", "2026-09-01T10:00:00.000Z", "u1"),
        answer("m1", "2026-09-01T10:01:00.000Z", tools=[("Bash", {"command": "ls"})]),
        tool_result("ok", ts="2026-09-01T10:03:00.000Z"),
        answer("m2", "2026-09-01T10:04:00.000Z"),
        prompt("ещё", "2026-09-01T11:00:00.000Z", "u2"),          # 56 минут паузы — не работа
        answer("m3", "2026-09-01T11:02:00.000Z"),
    ])
    t = _totals(_index(atlas_env))
    assert t["active_s"] == 60 + 180 + 120
    assert t["wall_s"] == t["active_s"]
    assert (t["sessions"], t["prompts"], t["answers"]) == (1, 2, 3)


def test_answer_split_into_records_and_copied_by_resume_counts_once(atlas_env, write_session):
    first = [prompt("задача", "2026-09-01T10:00:00.000Z", "u1"),
             answer("m1", "2026-09-01T10:01:00.000Z", uuid="a"),
             answer("m1", "2026-09-01T10:01:01.000Z", uuid="b",
                    tools=[("Skill", {"skill": "browse"})])]
    write_session("p", first)
    # Возобновлённая сессия несёт копию той же истории и свой новый ответ.
    write_session("p", first + [prompt("дальше", "2026-09-01T12:00:00.000Z", "u9"),
                                answer("m2", "2026-09-01T12:01:00.000Z")])
    conn = _index(atlas_env)
    t = _totals(conn)
    assert t["answers"] == 2 and t["prompts"] == 2
    assert t["tokens"]["output"] == 20
    assert t["tokens"]["total"] == 2 * (100 + 10 + 1000)
    skills = stats.summary(conn, "all", now=NOW)["skills"]
    assert skills == [{"name": "browse", "count": 1}]


def test_subagent_tokens_count_but_its_time_does_not(atlas_env, write_session):
    path = write_session("p", [prompt("проверь", "2026-09-01T10:00:00.000Z", "u1"),
                               answer("m1", "2026-09-01T10:01:00.000Z",
                                      tools=[("Agent", {"subagent_type": "Explore"})])])
    sub = os.path.join(path[:-len(".jsonl")], "subagents")
    os.makedirs(sub)
    with open(os.path.join(sub, "agent-a1.jsonl"), "w") as fh:
        fh.write(answer("s1", "2026-09-01T10:01:30.000Z"))
        # Без пометки isSidechain время всё равно не считается: файл сабагента идёт параллельно.
        fh.write(answer("s2", "2026-09-01T10:05:00.000Z"))
    s = stats.summary(_index(atlas_env), "all", now=NOW)
    assert s["totals"]["answers"] == 3
    assert s["totals"]["active_s"] == 60
    assert s["agents"] == [{"name": "Explore", "count": 1}]


def test_appended_tail_is_not_counted_twice(atlas_env, write_session):
    path = write_session("p", [prompt("раз", "2026-09-01T10:00:00.000Z", "u1"),
                               answer("m1", "2026-09-01T10:01:00.000Z")])
    conn = _index(atlas_env)
    with open(path, "a") as fh:
        fh.write(prompt("/loop 5m", "2026-09-01T10:03:00.000Z", "u2")
                 .replace("/loop 5m", "<command-name>/loop</command-name><command-args>5m</command-args>"))
        fh.write(answer("m2", "2026-09-01T10:04:00.000Z"))
    os.utime(path, None)
    index.index_all(conn, root=str(atlas_env["projects"]))
    s = stats.summary(conn, "all", now=NOW)
    assert (s["totals"]["answers"], s["totals"]["prompts"]) == (2, 2)
    assert s["totals"]["active_s"] == 60 + 120 + 60
    assert s["skills"] == [{"name": "/loop", "count": 1}]


def test_period_takes_only_its_part_of_a_long_session(atlas_env, write_session):
    write_session("p", [prompt("вчера", "2026-08-31T10:00:00.000Z", "u1"),
                        answer("m1", "2026-08-31T10:01:00.000Z"),
                        prompt("сегодня", "2026-09-01T17:00:00.000Z", "u2"),
                        answer("m2", "2026-09-01T17:01:00.000Z")])
    conn = _index(atlas_env)
    since, _ = stats.window("today", NOW.astimezone())
    s = stats.summary(conn, "today", now=NOW.astimezone())
    expected = 1 if since <= datetime(2026, 9, 1, 17, 0, tzinfo=timezone.utc) else 2
    assert s["totals"]["answers"] == expected
    assert s["previous"]["answers"] >= 0
    assert _totals(conn)["answers"] == 2


def test_wall_time_merges_parallel_sessions():
    rows = [{"act": 600, "ts": "2026-09-01T10:10:00.000Z"},
            {"act": 600, "ts": "2026-09-01T10:15:00.000Z"},      # идёт параллельно первой
            {"act": 60, "ts": "2026-09-01T12:00:00.000Z"}]
    assert stats.wall_seconds(rows) == 900 + 60


def test_mcp_calls_group_by_server():
    assert stats.tool_group("mcp__mcp-atlassian__jira_get_issue") == ("tools", "MCP mcp-atlassian")
    assert stats.tool_group("Skill:browse") == ("skills", "browse")
    assert stats.tool_group("Bash") == ("tools", "Bash")


def test_answer_continued_in_the_next_pass_adds_its_time(atlas_env, write_session):
    path = write_session("p", [prompt("раз", "2026-09-01T10:00:00.000Z", "u1"),
                               answer("m1", "2026-09-01T10:01:00.000Z", uuid="a")])
    conn = _index(atlas_env)
    with open(path, "a") as fh:                  # второй блок того же ответа — уже в хвосте
        fh.write(answer("m1", "2026-09-01T10:02:00.000Z", uuid="b",
                        tools=[("Bash", {"command": "ls"})]))
    os.utime(path, None)
    index.index_all(conn, root=str(atlas_env["projects"]))
    s = stats.summary(conn, "all", now=NOW)
    assert s["totals"]["answers"] == 1
    assert s["totals"]["active_s"] == 120
    assert s["tools"] == [{"name": "Bash", "count": 1}]
