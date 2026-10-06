"""Codex rollouts: parsing into session facts, indexing next to Claude Code sessions, titles."""
from __future__ import annotations

import os

from atlas import codex_parse, db, index, resolve
from tests.conftest import (
    cx,
    cx_agent,
    cx_context,
    cx_exec,
    cx_meta,
    cx_meta_current,
    cx_patch,
    cx_patch_end,
    cx_reasoning,
    cx_tokens,
    cx_user,
    user_text,
    write_codex_state,
)

TID = "019e0000-1111-7000-8000-000000000001"
OTHER = "019e0000-2222-7000-8000-000000000002"


def _conn(atlas_env):
    return db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))


def _session(*, prompt="настроить деплой ABC-1234", originator="codex-tui", source="cli",
             thread_source="user"):
    return [
        cx_meta(TID, originator=originator, source=source, thread_source=thread_source),
        cx_context(),
        cx_user(prompt),
        cx("event_msg", {"type": "task_started", "turn_id": "t1"}, "2026-09-01T10:00:02.500Z"),
        cx_reasoning(),
        cx_exec("make deploy-check"),
        cx_patch("*** Update File: src/app.py\n@@\n-old\n+new\n*** Add File: docs/notes.md\n+hello\n"),
        cx_patch_end({"/Users/u/Code/demo/src/app.py": {"type": "update", "move_path": None,
                                                         "unified_diff": "@@ -1 +1,2 @@\n-old\n+new\n+more\n"},
                      "/Users/u/Code/demo/docs/notes.md": {"type": "add", "content": "hello\n"}}),
        cx_agent("Деплой проверен, правки готовы"),
        cx_tokens(1000, 600, 50, reasoning=20),
        cx("event_msg", {"type": "task_complete", "turn_id": "t1", "last_agent_message": "x"},
           "2026-09-01T10:00:32.000Z"),
    ]


def test_current_codex_meta_is_read_like_the_older_one(write_rollout):
    """codex-cli 0.160 opens the payload with creator_user_id and session_id, and numbers records."""
    lines = [cx_meta_current(TID), *_session()[1:]]
    facts = codex_parse.parse_file(write_rollout(lines, thread_id=TID))
    assert facts.session_id == TID and facts.cwds == ["/Users/u/Code/demo"]
    assert facts.user_text == ["настроить деплой ABC-1234"] and facts.version == "0.160.0"


def test_rollout_becomes_session_facts(write_rollout):
    facts = codex_parse.parse_file(write_rollout(_session(), thread_id=TID))
    assert facts.session_id == TID and facts.agent == "codex"
    assert facts.user_text == ["настроить деплой ABC-1234"] and facts.human_turns == 1
    assert facts.assistant_text == ["Деплой проверен, правки готовы"]
    assert facts.commands == ["make deploy-check"]
    assert facts.paths == ["src/app.py", "docs/notes.md"]
    assert "/Users/u/Code/demo/src/app.py" in facts.raw_files
    assert (facts.lines_added, facts.lines_removed) == (3, 1)
    assert facts.models == ["gpt-5.5-codex"] and facts.entrypoint == "codex-tui"
    assert facts.version == "0.160.0" and facts.cwds == ["/Users/u/Code/demo"]
    assert facts.branches == ["main"] and facts.tickets == {"ABC-1234"}
    assert facts.started_at == "2026-09-01T10:00:00.000Z"
    assert facts.last_activity_at == "2026-09-01T10:00:32.000Z"
    assert len(facts.turns) == 1 and facts.turns[0]["commands"] == ["make deploy-check"]


def test_instructions_reasoning_and_tool_output_are_never_indexed(write_rollout):
    facts = codex_parse.parse_file(write_rollout(_session(), thread_id=TID))
    blob = repr(facts.turns) + repr(facts.user_text + facts.assistant_text + facts.commands)
    for secret in ("SYSTEM-INSTRUCTIONS", "REASONING-NEVER", "RAW-TOOL-OUTPUT"):
        assert secret not in blob


def test_token_count_becomes_an_activity_row(write_rollout):
    lines = [*_session(), cx_tokens(1000, 600, 50, reasoning=20, ts="2026-09-01T10:00:33.000Z")]
    facts = codex_parse.parse_file(write_rollout(lines, thread_id=TID))
    answers = [r for r in facts.activity.values() if r["kind"] == "a"]
    prompts = [r for r in facts.activity.values() if r["kind"] == "p"]
    assert len(prompts) == 1
    assert len(answers) == 1                     # the repeat with the same total is not a reply
    row = answers[0]
    assert (row["input"], row["cache_read"], row["output"]) == (400, 600, 50)   # reasoning is inside output
    assert row["model"] == "gpt-5.5-codex" and row["cost"] is None
    assert row["tools"] == ["exec_command", "apply_patch"]


def test_model_follows_the_latest_turn_context(write_rollout):
    lines = [*_session(), cx_context(model="gpt-6-codex", ts="2026-09-01T11:00:00.000Z"),
             cx_user("ещё", ts="2026-09-01T11:00:01.000Z"),
             cx_tokens(10, 0, 5, total=9999, ts="2026-09-01T11:00:05.000Z")]
    facts = codex_parse.parse_file(write_rollout(lines, thread_id=TID))
    models = [r["model"] for r in facts.activity.values() if r["kind"] == "a"]
    assert models == ["gpt-5.5-codex", "gpt-6-codex"]
    assert facts.models == ["gpt-5.5-codex", "gpt-6-codex"]
    assert facts.human_turns == 2 and len(facts.turns) == 2


def test_compaction_is_a_summary_not_a_prompt(write_rollout):
    lines = [*_session(), cx("compacted", {"message": "Сводка: деплой настроен",
                                           "replacement_history": [{"secret": "HISTORY-COPY"}]})]
    facts = codex_parse.parse_file(write_rollout(lines, thread_id=TID))
    assert facts.summaries == ["Сводка: деплой настроен"] and facts.human_turns == 1
    assert facts.turns[-1]["summaries"] == ["Сводка: деплой настроен"]
    assert "HISTORY-COPY" not in repr(facts.turns)


def test_prompt_reported_twice_counts_once_but_a_real_repeat_counts(write_rollout):
    item = cx("event_msg", {"type": "item_completed", "turn_id": "t1",
                            "item": {"type": "UserMessage", "id": "u1",
                                     "content": [{"type": "text", "text": "продолжай"}]}})
    reply = cx("event_msg", {"type": "item_completed", "turn_id": "t1",
                             "item": {"type": "AgentMessage", "id": "a1",
                                      "content": [{"type": "Text", "text": "готово"}]}})
    lines = [cx_meta(TID), cx_user("продолжай"), item, cx_agent("готово"), reply,
             cx_user("продолжай", ts="2026-09-01T10:05:00.000Z")]
    facts = codex_parse.parse_file(write_rollout(lines, thread_id=TID))
    assert facts.user_text == ["продолжай", "продолжай"]
    assert facts.assistant_text == ["готово"]


def test_exec_prompt_arriving_only_as_an_item_is_a_prompt(write_rollout):
    item = cx("event_msg", {"type": "item_completed", "turn_id": "t1",
                            "item": {"type": "UserMessage", "id": "u1",
                                     "content": [{"type": "local_image", "path": "/x.png"},
                                                 {"type": "text", "text": "проверь ревью"}]}})
    facts = codex_parse.parse_file(write_rollout([cx_meta(TID, originator="codex_exec"), item],
                                                 thread_id=TID))
    assert facts.user_text == ["проверь ревью"] and facts.first_user_text == "проверь ревью"


def test_js_exec_tool_yields_its_shell_commands(write_rollout):
    js = 'const r = await tools.exec_command({\n  cmd: "git status && echo \\"ok\\"",\n  workdir: "/x"\n});'
    lines = [cx_meta(TID), cx("response_item", {"type": "custom_tool_call", "name": "exec",
                                                "call_id": "e1", "input": js})]
    facts = codex_parse.parse_file(write_rollout(lines, thread_id=TID))
    assert facts.commands == ['git status && echo "ok"']


def test_bad_lines_are_counted_and_unknown_records_ignored(write_rollout):
    lines = [*_session(), "{broken json\n", "[1, 2]\n", cx("brand_new_record", {"x": 1}),
             cx("event_msg", {"type": "future_event", "message": "НЕ ПРОМПТ"})]
    path = write_rollout(lines, thread_id=TID)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write('{"timestamp": "unfinished')             # a live session's tail
    facts = codex_parse.parse_file(path)
    assert facts.bad_lines == 2
    assert facts.human_turns == 1 and "НЕ ПРОМПТ" not in facts.user_text


def test_codex_exec_and_subagent_threads_are_automation(write_rollout):
    exec_facts = codex_parse.parse_file(write_rollout(_session(originator="codex_exec", source="exec"),
                                                      thread_id=TID))
    assert resolve.session_kind(exec_facts.entrypoint, exec_facts.human_turns,
                                exec_facts.spawned) == "automation"
    sub = codex_parse.parse_file(write_rollout(
        _session(source={"subagent": {"thread_spawn": {"parent_thread_id": OTHER}}},
                 thread_source="subagent"), thread_id=OTHER))
    assert sub.spawned and resolve.session_kind(sub.entrypoint, sub.human_turns, True) == "automation"
    tui = codex_parse.parse_file(write_rollout(_session(), thread_id=TID))
    assert resolve.session_kind(tui.entrypoint, tui.human_turns, tui.spawned) == "interactive"


def test_title_from_codex_state_then_first_prompt(atlas_env, write_rollout, codex_home):
    write_rollout(_session(prompt="первый запрос\nвторая строка"), thread_id=TID)
    write_rollout(_session(prompt="без заголовка"), thread_id=OTHER)
    third = "019e0000-3333-7000-8000-000000000003"
    write_rollout(_session(prompt="имя важнее"), thread_id=third)
    write_codex_state(codex_home, {TID: ("Заголовок\n из Codex", None), OTHER: ("", None),
                                   third: ("заголовок", "Имя от пользователя")})
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    titles = {r["session_id"]: (r["title"], r["title_source"])
              for r in conn.execute("SELECT session_id, title, title_source FROM sessions")}
    assert titles[TID] == ("Заголовок из Codex", "recorded")
    assert titles[OTHER] == ("без заголовка", "first-prompt")
    assert titles[third][0] == "Имя от пользователя"


def test_broken_state_database_is_ignored(atlas_env, write_rollout, codex_home):
    write_rollout(_session(prompt="запрос как заголовок"), thread_id=TID)
    with open(os.path.join(codex_home, "state_5.sqlite"), "w") as fh:
        fh.write("not a database")
    assert codex_parse.thread_titles(codex_home) == {}
    conn = _conn(atlas_env)
    assert index.index_all(conn, root=str(atlas_env["projects"]))["errors"] == 0
    assert conn.execute("SELECT title FROM sessions").fetchone()["title"] == "запрос как заголовок"


def test_codex_rollouts_are_indexed_next_to_claude(atlas_env, write_session, write_rollout):
    write_session("p", [user_text("сессия клода")])
    write_rollout(_session(), thread_id=TID)
    write_rollout(_session(originator="codex_exec", source="exec"), thread_id=OTHER, archived=True)
    conn = _conn(atlas_env)
    stats = index.index_all(conn, root=str(atlas_env["projects"]))
    assert stats["codex"] == 2 and stats["errors"] == 0
    rows = {r["session_id"]: r for r in conn.execute("SELECT * FROM sessions")}
    assert rows[TID]["agent"] == "codex" and rows[TID]["session_kind"] == "interactive"
    assert rows[OTHER]["agent"] == "codex" and rows[OTHER]["session_kind"] == "automation"
    assert [r["agent"] for r in rows.values()].count("claude") == 1
    assert rows[TID]["lines_added"] == 3 and rows[TID]["branch_last"] == "main"
    assert conn.execute("SELECT count(*) FROM activity WHERE session_id=?", (TID,)).fetchone()[0] == 2
    assert {r["resolved_path"] for r in conn.execute(
        "SELECT resolved_path FROM session_files WHERE session_id=?", (TID,))} >= {
        "/Users/u/Code/demo/src/app.py"}


def test_unchanged_rollout_is_skipped_changed_is_reread(atlas_env, write_rollout):
    path = write_rollout(_session(), thread_id=TID)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    again = index.index_all(conn, root=str(atlas_env["projects"]))
    assert again["skipped"] == 1 and again["indexed"] == 0
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(cx_user("новый запрос", ts="2026-09-02T10:00:00.000Z"))
    assert index.index_all(conn, root=str(atlas_env["projects"]))["indexed"] == 1
    assert conn.execute("SELECT human_turns FROM sessions").fetchone()[0] == 2


def test_rename_in_codex_reindexes_the_title(atlas_env, write_rollout, codex_home):
    write_rollout(_session(), thread_id=TID)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    write_codex_state(codex_home, {TID: ("Новое имя", None)})
    assert index.index_all(conn, root=str(atlas_env["projects"]))["indexed"] == 1
    assert conn.execute("SELECT title FROM sessions").fetchone()[0] == "Новое имя"


def test_removed_rollout_leaves_the_catalog(atlas_env, write_rollout):
    path = write_rollout(_session(), thread_id=TID)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    os.remove(path)
    assert index.index_all(conn, root=str(atlas_env["projects"]))["removed"] == 1
    for table in ("sessions", "fts", "activity"):
        assert conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0


def test_archived_rollout_keeps_its_session(atlas_env, write_rollout):
    path = write_rollout(_session(), thread_id=TID)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    moved = write_rollout(_session(), thread_id=TID, archived=True)
    os.remove(path)
    stats = index.index_all(conn, root=str(atlas_env["projects"]))
    assert stats["removed"] == 1
    row = conn.execute("SELECT source_path FROM sessions WHERE session_id=?", (TID,)).fetchone()
    assert row is not None and row[0] == moved
    assert conn.execute("SELECT count(*) FROM fts WHERE session_id=?", (TID,)).fetchone()[0] > 0


def test_prompts_sharing_a_timestamp_keep_their_own_rows(write_rollout):
    same = "2026-09-01T10:00:02.000Z"
    lines = [cx_meta(TID), cx_user("первый", ts=same), cx_user("второй", ts=same)]
    facts = codex_parse.parse_file(write_rollout(lines, thread_id=TID))
    assert sum(1 for r in facts.activity.values() if r["kind"] == "p") == 2


def test_huge_skipped_lines_still_move_the_clock(write_rollout):
    image = cx("response_item", {"type": "message", "role": "user",
                                 "content": [{"type": "input_image", "image_url": "data:" + "A" * 300_000}]},
               "2026-09-01T12:00:00.000Z")
    output = cx("response_item", {"type": "function_call_output", "call_id": "c1", "output": "B" * 1000},
                "2026-09-01T12:30:00.000Z")
    path = write_rollout([*_session(), image, output], thread_id=TID)
    facts = codex_parse.parse_file(path)
    assert facts.last_activity_at == "2026-09-01T12:30:00.000Z"
    with open(path, "rb") as fh:
        assert facts.records == sum(1 for _ in fh) and facts.bad_lines == 0


def test_a_fork_keeps_its_own_meta(write_rollout):
    """A forked thread carries its parent's session_meta after its own: only the first counts."""
    parent = "01a00000-0000-7000-8000-00000000beef"
    lines = [cx_meta(TID, cwd="/Users/u/Code/fork", originator="codex-tui", branch="fork-branch"),
             cx_meta(parent, cwd="/Users/u/Code/parent", originator="codex_exec", thread_source="subagent",
                     branch="parent-branch"),
             cx_user("continue here"), cx_agent("ok")]
    facts = codex_parse.parse_file(write_rollout(lines, thread_id=TID))
    assert facts.entrypoint == "codex-tui"
    assert facts.cwds == ["/Users/u/Code/fork"] and facts.branches == ["fork-branch"]
    assert not facts.spawned
