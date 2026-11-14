"""Codex subagent threads belong to the session that spawned them, as Claude Code's subagents do.

codex-cli writes each subagent as its own rollout whose session_meta names its parent
(`parent_thread_id`, `thread_source: "subagent"`, `source.subagent`; checked on 0.167). The catalog
keeps them with the root thread: their text is found there, their turns are counted there, and their
replies stay in Statistics with the same tokens.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from atlas import db, index, search, stats
from tests.conftest import cx, cx_agent, cx_meta, cx_tokens, cx_user

ROOT = "01a1d732-b2b6-7633-a1ed-faa6cca6f06c"
SUB = "01a1d733-862a-72e3-8482-39883b3b3d68"
NESTED = "01a1d733-9999-7000-8000-000000000003"
ORPHAN = "01a1d734-0000-7000-8000-000000000004"
GONE = "01a1d734-0000-7000-8000-000000000005"
NOW = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)


def _meta(thread_id, ts, parent=None):
    rec = json.loads(cx_meta(thread_id, ts=ts))
    if parent:
        rec["payload"].update(session_id=ROOT, forked_from_id=parent, parent_thread_id=parent,
                              thread_source="subagent",
                              source={"subagent": {"thread_spawn": {"parent_thread_id": parent, "depth": 1}}})
    return json.dumps(rec, separators=(",", ":")) + "\n"


def _thread(thread_id, minute, prompt, reply, parent=None, tokens=(1000, 200, 50)):
    ts = f"2026-11-10T10:{minute:02d}:00.000Z"
    return [_meta(thread_id, ts, parent), cx_user(prompt, ts.replace("00.000Z", "02.000Z")),
            cx_agent(reply, ts.replace("00.000Z", "20.000Z")),
            cx_tokens(*tokens, ts=ts.replace("00.000Z", "21.000Z"))]


def _write(write_rollout, threads):
    return {tid: write_rollout(lines, thread_id=tid, day="2026/11/10") for tid, lines in threads.items()}


def _sessions(conn):
    return {r[0]: r[1] for r in conn.execute("SELECT session_id, subagent_turns FROM sessions")}


def test_subagents_and_theirs_are_part_of_the_root_session(atlas_env, write_rollout):
    _write(write_rollout, {
        ROOT: _thread(ROOT, 0, "plan the billing export", "spawning a helper"),
        SUB: _thread(SUB, 1, "check the ledger rounding", "zebrafinding rounding is off", ROOT),
        NESTED: _thread(NESTED, 2, "read ledger.py", "nestedfinding line 12", SUB),
    })
    conn = db.connect()
    index.index_all(conn)
    assert _sessions(conn) == {ROOT: 2}               # one reply each from the subagent and its own
    found = search.search(conn, "zebrafinding", scope="all")
    assert [r["session_id"] for r in found] == [ROOT]
    assert [r["session_id"] for r in search.search(conn, "nestedfinding", scope="all")] == [ROOT]
    assert [r["session_id"] for r in search.recent(conn)] == [ROOT]


def test_statistics_keep_every_reply_and_its_tokens(atlas_env, write_rollout):
    _write(write_rollout, {
        ROOT: _thread(ROOT, 0, "plan it", "ok", tokens=(1000, 200, 50)),
        SUB: _thread(SUB, 1, "help", "done", ROOT, tokens=(3000, 1000, 70)),
    })
    conn = db.connect()
    index.index_all(conn)
    out = stats.summary(conn, "all", automation=True, now=NOW, agents=["codex"])["totals"]
    assert out["answers"] == 2
    assert out["tokens"]["output"] == 120
    assert out["tokens"]["total"] == 1000 + 50 + 3000 + 70
    # Only the human's prompt is a prompt; the subagent's task came from the agent.
    assert out["prompts"] == 1 and out["sessions"] == 1


def test_a_subagent_without_its_root_thread_stays_its_own(atlas_env, write_rollout):
    _write(write_rollout, {ORPHAN: _thread(ORPHAN, 3, "help", "orphan reply", GONE)})
    conn = db.connect()
    index.index_all(conn)
    assert _sessions(conn) == {ORPHAN: 0}


def test_a_new_subagent_reply_refreshes_the_root(atlas_env, write_rollout):
    paths = _write(write_rollout, {ROOT: _thread(ROOT, 0, "plan it", "ok"),
                                   SUB: _thread(SUB, 1, "help", "first pass", ROOT)})
    conn = db.connect()
    index.index_all(conn)
    assert index.index_all(conn)["indexed"] == 0
    with open(paths[SUB], "a", encoding="utf-8") as fh:
        fh.write(cx_agent("latefinding in the second pass", "2026-11-10T10:05:00.000Z"))
    assert index.index_all(conn)["indexed"] == 1
    assert [r["session_id"] for r in search.search(conn, "latefinding", scope="all")] == [ROOT]


def test_subagents_indexed_as_sessions_before_are_folded_in(atlas_env, write_rollout, monkeypatch):
    _write(write_rollout, {ROOT: _thread(ROOT, 0, "plan it", "ok"),
                           SUB: _thread(SUB, 1, "help", "oldrowreply reply", ROOT)})
    conn = db.connect()
    with monkeypatch.context() as old:            # the catalog an older version left (only this patch undone)
        old.setattr(index, "codex_subagents", lambda paths: {})
        index.index_all(conn)
    assert set(_sessions(conn)) == {ROOT, SUB}
    index.index_all(conn)
    assert _sessions(conn) == {ROOT: 1}
    assert conn.execute("SELECT COUNT(*) FROM sources WHERE session_id=?", (SUB,)).fetchone()[0] == 0
    assert [r["session_id"] for r in search.search(conn, "oldrowreply", scope="all")] == [ROOT]



def test_a_subagent_with_its_parents_context_counts_only_its_own_work(atlas_env, write_rollout):
    """Spawned with fork context, a subagent's rollout starts with a copy of the parent's turn (its
    spawn_agent call, the $skill it was given, its messages): counted once, in the parent."""
    def started(turn, ts):
        return cx("event_msg", {"type": "task_started", "turn_id": turn}, ts)

    def parent_turn(ts):
        return [started("turn-root", ts),
                cx("turn_context", {"turn_id": "turn-root", "model": "gpt-6"}, ts),
                cx("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text":
                   "<skill>\n<name>review</name>\n<path>/h/.agents/skills/review/SKILL.md</path>\n</skill>"}]}, ts),
                cx_user("review the export", ts),
                cx("response_item", {"type": "function_call", "name": "spawn_agent", "call_id": "s1",
                                     "arguments": json.dumps({"agent_type": "explorer", "message": "check"})}, ts)]
    root = [_meta(ROOT, "2026-11-10T10:00:00.000Z"), *parent_turn("2026-11-10T10:00:01.000Z"),
            cx_tokens(100, 0, 10, ts="2026-11-10T10:00:02.000Z")]
    sub = [_meta(SUB, "2026-11-10T10:01:00.000Z", ROOT), *parent_turn("2026-11-10T10:01:00.000Z"),
           cx("event_msg", {"type": "turn_aborted"}, "2026-11-10T10:01:00.000Z"),
           started("turn-sub", "2026-11-10T10:01:01.000Z"),
           cx("response_item", {"type": "function_call", "name": "exec_command", "call_id": "c9", "arguments":
              json.dumps({"cmd": "sed -n 1,80p /h/.agents/skills/qa/SKILL.md"})}, "2026-11-10T10:01:02.000Z"),
           cx_agent("subownfinding", "2026-11-10T10:01:03.000Z"),
           cx_tokens(300, 0, 30, ts="2026-11-10T10:01:04.000Z")]
    _write(write_rollout, {ROOT: root, SUB: sub})
    conn = db.connect()
    index.index_all(conn)
    tools = [t for (row,) in conn.execute("SELECT tools FROM activity WHERE session_id=?", (ROOT,))
             for t in (row or "").split(",") if t]
    assert sorted(t for t in tools if t.startswith(("Agent:", "Skill:"))) == [
        "Agent:explorer", "Skill:qa", "Skill:review"]
    assert _sessions(conn) == {ROOT: 2}                   # its own command and reply, not the copied call
    assert [r["session_id"] for r in search.search(conn, "subownfinding", scope="all")] == [ROOT]


def test_a_parser_change_rereads_codex_sessions_once(atlas_env, write_rollout, monkeypatch):
    from atlas import codex_parse
    _write(write_rollout, {ROOT: _thread(ROOT, 0, "plan it", "ok")})
    conn = db.connect()
    index.index_all(conn)
    assert index.index_all(conn)["indexed"] == 0
    monkeypatch.setattr(codex_parse, "PARSE_VERSION", codex_parse.PARSE_VERSION + 1)
    assert index.index_all(conn)["indexed"] == 1
    assert index.index_all(conn)["indexed"] == 0
