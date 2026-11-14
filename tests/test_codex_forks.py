"""Codex copies (`codex fork <id>`, /fork, a Desktop fork) and skills/subagents in Statistics.

codex-cli 0.167 writes a copy as a new rollout whose session_meta names the source
(`forked_from_id`, `forked_from_ordinal_exclusive`) and holds none of the source's history. Subagent
and review threads carry `forked_from_id` too, but `thread_source`/`source.subagent` mark them.
Made-up content in the real record shapes (checked against a `codex fork` in a temp CODEX_HOME).
"""
from __future__ import annotations

import json

from atlas import codex_parse, db, index, search, stats
from tests.conftest import cx, cx_agent, cx_meta, cx_tokens, cx_user, write_codex_state

SRC = "01a1d6ca-bd63-7293-b388-c27d61712cbe"
COPY = "01a1d6cb-0245-7c50-a0b7-0fe001e07fdb"
COPY2 = "01a1d6cb-93b3-7990-8c4d-df0ade4f1623"
SUB = "01a1d6cc-0000-7000-8000-000000000001"


def _meta(thread_id, ts, **extra):
    rec = json.loads(cx_meta(thread_id, ts=ts))
    rec["payload"].update(extra)
    return json.dumps(rec, separators=(",", ":")) + "\n"


def _thread(thread_id, ts, prompt, **meta):
    day = ts[:10].replace("-", "/")
    return [_meta(thread_id, ts, **meta), cx_user(prompt, ts.replace("00.000Z", "02.000Z")),
            cx_agent("done", ts.replace("00.000Z", "30.000Z"))], day


def _index(write_rollout, threads):
    for thread_id, (lines, day) in threads.items():
        write_rollout(lines, thread_id=thread_id, day=day)
    conn = db.connect()
    index.index_all(conn)
    return conn


def _forks(conn):
    return dict(conn.execute("SELECT session_id, parent_id FROM session_forks").fetchall())


def test_a_user_fork_is_a_copy_of_its_source(atlas_env, write_rollout):
    conn = _index(write_rollout, {
        SRC: _thread(SRC, "2026-11-13T21:22:00.000Z", "first hello"),
        COPY: _thread(COPY, "2026-11-13T21:23:00.000Z", "after the fork", forked_from_id=SRC,
                      forked_from_ordinal_exclusive=14),
    })
    assert _forks(conn) == {COPY: SRC}
    card = search.load_session(conn, COPY)
    assert card["forked_from"]["session_id"] == SRC
    assert [c["session_id"] for c in search.load_session(conn, SRC)["forks"]] == [COPY]


def test_copies_keeping_the_source_title_are_numbered(atlas_env, write_rollout, codex_home):
    """Same rule as Claude Code: while the titles are equal, the copies are numbered."""
    write_codex_state(codex_home, {SRC: ("Billing export", None), COPY: ("Billing export", None),
                                   COPY2: ("Billing export", None)})
    conn = _index(write_rollout, {
        SRC: _thread(SRC, "2026-11-13T21:22:00.000Z", "first hello"),
        COPY2: _thread(COPY2, "2026-11-13T21:24:00.000Z", "later copy", forked_from_id=SRC),
        COPY: _thread(COPY, "2026-11-13T21:23:00.000Z", "earlier copy", forked_from_id=SRC),
    })
    titles = {sid: search.load_session(conn, sid)["title"] for sid in (SRC, COPY, COPY2)}
    assert titles == {SRC: "Billing export", COPY: "Billing export (2)", COPY2: "Billing export (3)"}


def test_subagent_and_review_threads_are_not_copies(atlas_env, write_rollout):
    conn = _index(write_rollout, {
        SRC: _thread(SRC, "2026-11-13T21:22:00.000Z", "first hello"),
        SUB: _thread(SUB, "2026-11-13T21:23:00.000Z", "review this", forked_from_id=SRC,
                     parent_thread_id=SRC, thread_source="subagent",
                     source={"subagent": {"thread_spawn": {"parent_thread_id": SRC, "depth": 1}}}),
        COPY: _thread(COPY, "2026-11-13T21:24:00.000Z", "check", parent_thread_id=SRC,
                      thread_source="guardian_review", source={"subagent": {"other": "guardian"}},
                      forked_from_id=SRC),
    })
    assert _forks(conn) == {}


def test_forks_indexed_before_copies_were_recorded_are_read_again_once(atlas_env, write_rollout):
    conn = _index(write_rollout, {
        SRC: _thread(SRC, "2026-11-13T21:22:00.000Z", "first hello"),
        COPY: _thread(COPY, "2026-11-13T21:23:00.000Z", "after the fork", forked_from_id=SRC),
    })
    # The catalog an older version left: the same files, no Codex copy rows, no scan marker.
    conn.execute("DELETE FROM session_forks")
    conn.execute("DELETE FROM meta WHERE key='codex_copies_scanned'")
    conn.commit()
    assert index.index_all(conn)["indexed"] == 1        # only the fork is read again
    assert _forks(conn) == {COPY: SRC}
    assert index.index_all(conn)["indexed"] == 0


# --- Statistics: skills and subagents ------------------------------------------------------------

def _calls(folder, lines):
    path = folder / f"rollout-2026-11-13T10-00-00-{SRC}.jsonl"
    path.write_text("".join(lines), encoding="utf-8")
    facts = codex_parse.parse_file(str(path))
    return [t for a in facts.activity.values() for t in a["tools"]]


def test_skill_mention_and_skill_read_are_skill_calls(tmp_path):
    mention = cx("response_item", {"type": "message", "role": "user", "content": [
        {"type": "input_text", "text": "<skill>\n<name>demo-skill</name>\n<path>/h/.codex/skills/demo-skill/SKILL.md"
                                       "</path>\nbody\n</skill>"}]}, "2026-11-13T10:00:03.000Z")
    read = cx("response_item", {"type": "custom_tool_call", "name": "exec", "call_id": "e1", "input":
              'text(await tools.exec_command({cmd:"sed -n \'1,200p\' /h/.agents/skills/qa/SKILL.md"}))'},
              "2026-11-13T10:00:04.000Z")
    edit = cx("response_item", {"type": "custom_tool_call", "name": "exec", "call_id": "e2", "input":
              'text(await tools.exec_command({cmd:"git diff skills/mine/SKILL.md"}))'}, "2026-11-13T10:00:05.000Z")
    prompt = cx_user("$demo-skill say hi", "2026-11-13T10:00:02.000Z")
    reply = cx_tokens(10, 0, 2, ts="2026-11-13T10:00:06.000Z")
    calls = _calls(tmp_path, [cx_meta(SRC), prompt, mention, read, edit, reply])
    assert sorted(t for t in calls if t.startswith("Skill:")) == ["Skill:demo-skill", "Skill:qa"]


def test_skill_reads_by_codex_names_once_a_turn_and_never_writes(tmp_path):
    upstream = tmp_path / "plugins" / "cache" / "mkt" / "vercel" / "1.0" / "skills" / "ai-sdk" / "upstream"
    upstream.mkdir(parents=True)
    (upstream / "SKILL.md").write_text("---\nname: ai-sdk\ndescription: x\n---\n", encoding="utf-8")
    n = iter(range(100))

    def run(cmd):
        return cx("response_item", {"type": "function_call", "name": "exec_command", "call_id": f"c{next(n)}",
                                    "arguments": json.dumps({"cmd": cmd})}, "2026-11-13T10:00:04.000Z")

    def turn(turn_id):
        return cx("event_msg", {"type": "task_started", "turn_id": turn_id}, "2026-11-13T10:00:01.000Z")
    lines = [cx_meta(SRC), turn("t1"), cx_user("go", "2026-11-13T10:00:02.000Z"),
             run("sed -n '1,240p' /h/.agents/skills/gstack/browse/SKILL.md"),
             run("sed -n '241,520p' /h/.agents/skills/gstack/browse/SKILL.md"),     # the same read, in parts
             run("cat /h/.codex/skills/.system/imagegen/SKILL.md | head -50"),
             run("nl -ba /h/.codex/plugins/cache/claude-plugins-official/figma/2.2.157/skills/figma-use/SKILL.md"),
             run(f"head -40 {upstream / 'SKILL.md'}"),
             run("sed -i '' 's/a/b/' /h/.agents/skills/mine/SKILL.md"),             # writes are not uses
             run("cat > /h/.agents/skills/new/SKILL.md <<'EOF'\n---\nname: new\n---\nEOF"),
             run("rg -n browse /h/.agents/skills/gstack/browse/SKILL.md"),
             cx_tokens(10, 0, 2, ts="2026-11-13T10:00:06.000Z"),
             turn("t2"),                                         # a turn of its own, no prompt (a /goal step)
             run("sed -n '1,80p' /h/.agents/skills/gstack/browse/SKILL.md"),         # a new turn: counts again
             cx_tokens(20, 0, 4, ts="2026-11-13T10:01:06.000Z"),
             cx_user("again", "2026-11-13T10:02:02.000Z"),      # an older rollout: a prompt, no turn id
             run("sed -n '1,80p' /h/.agents/skills/gstack/browse/SKILL.md"),
             cx_tokens(30, 0, 6, ts="2026-11-13T10:02:06.000Z")]
    calls = _calls(tmp_path, lines)
    assert sorted(t for t in calls if t.startswith("Skill:")) == [
        "Skill:browse", "Skill:browse", "Skill:browse", "Skill:figma:figma-use", "Skill:imagegen",
        "Skill:vercel:ai-sdk"]


def test_spawned_subagents_are_agent_calls_by_type(tmp_path):
    direct = cx("response_item", {"type": "function_call", "name": "spawn_agent", "call_id": "s1",
                "arguments": json.dumps({"task_name": "audit", "agent_type": "explorer", "message": "x"})})
    untyped = cx("response_item", {"type": "function_call", "name": "spawn_agent", "call_id": "s2",
                 "arguments": json.dumps({"task_name": "tests", "message": "x"})})
    in_code = cx("response_item", {"type": "custom_tool_call", "name": "exec", "call_id": "s3", "input":
                 'await tools.spawn_agent({task_name:"r", agent_type:"worker", message:"go"})'})
    calls = _calls(tmp_path, [cx_meta(SRC), cx_user("go"), direct, untyped, in_code, cx_tokens(10, 0, 2)])
    assert sorted(t for t in calls if t.startswith("Agent:")) == ["Agent:default", "Agent:explorer", "Agent:worker"]
    assert "spawn_agent" not in calls


def test_statistics_panels_count_codex_skills_and_agents(atlas_env, write_rollout):
    call = cx("response_item", {"type": "function_call", "name": "spawn_agent", "call_id": "s1",
              "arguments": json.dumps({"task_name": "audit", "agent_type": "explorer"})}, "2026-11-13T10:00:03.000Z")
    read = cx_exec_read("/h/.codex/skills/page-design/SKILL.md", "2026-11-13T10:00:04.000Z")
    write_rollout([cx_meta(SRC, ts="2026-11-13T10:00:00.000Z"), cx_user("go", "2026-11-13T10:00:02.000Z"),
                   call, read, cx_tokens(10, 0, 2, ts="2026-11-13T10:00:05.000Z")], thread_id=SRC, day="2026/11/13")
    conn = db.connect()
    index.index_all(conn)
    out = stats.summary(conn, "all", agents=["codex"])
    names = {p: {r["name"] for r in out[p]} for p in ("skills", "agents")}
    assert names == {"skills": {"page-design"}, "agents": {"explorer"}}


def cx_exec_read(path, ts):
    return cx("response_item", {"type": "function_call", "name": "exec_command", "call_id": "r1",
                                "arguments": json.dumps({"cmd": f"cat {path}"})}, ts)
