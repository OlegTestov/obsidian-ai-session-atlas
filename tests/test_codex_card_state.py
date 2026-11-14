"""A live Codex card's goal, subagents, background commands and queued messages.

The goal and the queue are Codex's own SQLite files (goals_1.sqlite, queue_1.sqlite) with the schema
and payload codex-cli 0.167 writes (checked against a temporary CODEX_HOME). Background commands are
child processes of the codex process; its MCP servers and helpers are not.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time

import pytest

from atlas import codex_live, codex_state
from tests import test_codex_active as live
from tests.conftest import cx_meta
from tests.test_codex_active import CODEX, START, SUB, TID, FakeLsof, _cards, table, turn

fresh_caches = live._fresh_caches     # the same fixtures: caches emptied, a temp Claude sessions folder
claude_dir = live.claude_dir

OTHER = "019e0000-cccc-7000-8000-000000000003"
NESTED = "019e0000-dddd-7000-8000-000000000004"
FOREIGN = "019e0000-eeee-7000-8000-000000000005"
QUIET = "019e0000-ffff-7000-8000-000000000006"


@pytest.fixture
def codex_home(codex_home):
    os.makedirs(codex_home, exist_ok=True)
    return codex_home


def _goals(home, rows):
    conn = sqlite3.connect(os.path.join(home, codex_state.GOALS_DB))
    conn.execute("""CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY NOT NULL, goal_id TEXT NOT NULL,
                    objective TEXT NOT NULL, status TEXT NOT NULL, token_budget INTEGER,
                    tokens_used INTEGER NOT NULL DEFAULT 0, time_used_seconds INTEGER NOT NULL DEFAULT 0,
                    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)""")
    conn.executemany("INSERT INTO thread_goals VALUES (?, 'g', ?, ?, NULL, 0, 0, 1, 1)", rows)
    conn.commit()
    conn.close()


def _payload(*parts):
    return json.dumps({"UserInput": {"content": list(parts), "client_id": "m1"}})


def _queue(home, rows):
    conn = sqlite3.connect(os.path.join(home, codex_state.QUEUE_DB))
    conn.execute("""CREATE TABLE queued_items (id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL, queue_order INTEGER NOT NULL,
                    created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)""")
    conn.executemany("INSERT INTO queued_items VALUES (?,?,?,?,?,?)", rows)
    conn.commit()
    conn.close()


def _sub_meta(thread_id, parent):
    rec = json.loads(cx_meta(thread_id))
    rec["payload"].update(thread_source="subagent", parent_thread_id=parent,
                          source={"subagent": {"thread_spawn": {"parent_thread_id": parent, "depth": 1}}})
    return json.dumps(rec) + "\n"


def test_only_an_active_goal_is_shown(codex_home):
    _goals(codex_home, [(TID, "ship the notes file", "active"), (SUB, "paused one", "paused"),
                        (OTHER, "done", "complete")])
    assert codex_state.goals([TID, SUB, OTHER, NESTED], codex_home) == {TID: "ship the notes file"}


def test_queued_messages_in_order_text_only(codex_home):
    text = {"type": "text", "text": "also check b.md", "text_elements": []}
    _queue(codex_home, [
        ("q2", TID, _payload({"type": "text", "text": "then run the tests", "text_elements": []}), 1,
         1794612138593, 1),
        ("q1", TID, _payload(text, {"type": "localImage", "path": "/tmp/a.png"}), 0, 1794612130000, 1),
        ("q3", TID, _payload({"type": "localImage", "path": "/tmp/b.png"}), 2, 1794612140000, 1),
        ("q4", OTHER, _payload(text), 0, 1, 1),
        ("q5", TID, "{not json", 3, 1, 1)])
    assert codex_state.queued([TID], codex_home) == {TID: [
        {"text": "also check b.md", "at": "2026-11-13T23:22:10.000Z"},
        {"text": "then run the tests", "at": "2026-11-13T23:22:18.593Z"}]}


def test_no_databases_no_goal_no_queue(codex_home):
    assert codex_state.goals([TID], codex_home) == {} and codex_state.queued([TID], codex_home) == {}
    with open(os.path.join(codex_home, codex_state.GOALS_DB), "w") as fh:
        fh.write("not a database")
    assert codex_state.goals([TID], codex_home) == {}


def test_background_commands_are_children_that_are_not_mcp_servers(codex_home):
    with open(os.path.join(codex_home, "config.toml"), "w", encoding="utf-8") as fh:
        fh.write('model = "gpt-5.5"\n\n[mcp_servers.context7]\ncommand = "npx"\n'
                 'args = ["-y", "@upstash/context7-mcp"]\n\n[mcp_servers.rea]\n'
                 'command = "/usr/local/bin/node"\nargs = ["/opt/tools/bin/rea", "mcp"]\n\n'
                 '[mcp_servers.rea.env]\nKEY = "x"\n\n[mcp_servers.plain]\ncommand = "/usr/bin/plain-mcp"\n')
    t = table((101, CODEX))
    t.update({
        201: (101, START, "sleep 600"),
        202: (101, START, "/bin/zsh -lc npm run dev"),
        203: (101, START, "npm exec @upstash/context7-mcp"),
        204: (101, START, "/usr/local/bin/node /opt/tools/bin/rea mcp"),
        205: (101, START, "/usr/bin/plain-mcp"),
        206: (101, START, f"/usr/bin/git -C {codex_home}/.tmp/plugins-clone-x reset --hard"),
        207: (101, START, "/x/bin/codex-code-mode-host --port 1"),
        208: (201, START, "sleep 5"),                          # a grandchild: its parent counts already
        209: (50, START, "sleep 700"),                          # not under codex
    })
    assert codex_state.background_commands(101, t, codex_home) == 2


def test_only_the_exact_server_command_is_hidden(codex_home):
    # "run" from `uv run …` must not hide `npm run dev`; a multi-line array keeps its arguments, so an
    # unrelated python3 child still counts.
    with open(os.path.join(codex_home, "config.toml"), "w", encoding="utf-8") as fh:
        fh.write('[mcp_servers.docs]\ncommand = "uv"\nargs = ["run", "docs_mcp.py"]\n\n'
                 '[mcp_servers.notes]\ncommand = "python3"\nargs = [\n  "/srv/notes_mcp.py",  # the server\n'
                 '  "--stdio",\n]\n\n[mcp_servers.lit]\ncommand = "npx"\nargs = [\'-y\', \'@acme/lit-mcp\']\n')
    assert codex_state.mcp_servers(codex_home) == [
        ["uv", "run", "docs_mcp.py"], ["python3", "/srv/notes_mcp.py", "--stdio"], ["npx", "-y", "@acme/lit-mcp"]]
    t = table((101, CODEX))
    t.update({
        201: (101, START, "uv run docs_mcp.py"),                       # servers: hidden
        202: (101, START, "/opt/homebrew/bin/python3 /srv/notes_mcp.py --stdio"),
        203: (101, START, "npm exec @acme/lit-mcp"),
        204: (101, START, "npm run dev"),                              # the user's work: counted
        205: (101, START, "cargo run"),
        206: (101, START, "python3 /srv/report.py"),
        207: (101, START, "uv run other.py"),
    })
    assert codex_state.background_commands(101, t, codex_home) == 4


def test_servers_are_known_by_how_they_run(codex_home):
    # A configured command often runs under another name: python3 as the framework's Python, uvx as
    # `uv tool uvx`, npx as `npm exec`. The arguments still have to match exactly, in order.
    with open(os.path.join(codex_home, "config.toml"), "w", encoding="utf-8") as fh:
        fh.write('[mcp_servers.mine]\ncommand = "python3"\nargs = ["-m", "my_mcp"]\n\n'
                 '[mcp_servers.fetch]\ncommand = "uvx"\nargs = ["mcp-server-fetch"]\n\n'
                 '[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "@acme/docs-mcp"]\n')
    py = "/opt/homebrew/Cellar/python@3.13/3.13.1/Frameworks/Python.framework/Versions/3.13/Resources/" \
         "Python.app/Contents/MacOS/Python"
    t = table((101, CODEX))
    t.update({
        201: (101, START, f"{py} -m my_mcp"),                            # servers: hidden
        202: (101, START, "/Users/u/.local/bin/uv tool uvx mcp-server-fetch"),
        203: (101, START, "npm exec @acme/docs-mcp"),
        204: (101, START, "npm run dev"),                                 # the user's work: counted
        205: (101, START, f"{py} -m http.server"),
        206: (101, START, "/Users/u/.local/bin/uv tool run ruff"),
        207: (101, START, "node /srv/tools/my_mcp"),
    })
    assert codex_state.background_commands(101, t, codex_home) == 4


def test_a_comment_after_an_array_does_not_swallow_the_next_servers(codex_home):
    with open(os.path.join(codex_home, "config.toml"), "w", encoding="utf-8") as fh:
        fh.write('[mcp_servers.a]\ncommand = "npx"\nargs = ["-y", "@acme/a-mcp"]  # the docs server\n\n'
                 '[mcp_servers.b]\ncommand = "uvx"\nargs = ["b-mcp"]\n\n'
                 '[mcp_servers.c]\ncommand = "node"\nargs = ["/srv/c # not a comment.js"]  # quoted hash kept\n\n'
                 '[mcp_servers.d]\ncommand = "node"\nargs = [\n  "/srv/d.js",  # the entry point\n  "--stdio"\n]\n')
    assert codex_state.mcp_servers(codex_home) == [
        ["npx", "-y", "@acme/a-mcp"], ["uvx", "b-mcp"], ["node", "/srv/c", "#", "not", "a", "comment.js"],
        ["node", "/srv/d.js", "--stdio"]]


def test_card_shows_goal_queue_commands_and_live_subagents(atlas_env, codex_home, write_rollout, claude_dir):
    main = write_rollout([cx_meta(TID), *turn()], thread_id=TID)
    fresh = write_rollout([_sub_meta(SUB, TID), *turn()], thread_id=SUB)
    nested = write_rollout([_sub_meta(NESTED, SUB), *turn()], thread_id=NESTED)
    stale = write_rollout([_sub_meta(OTHER, TID), *turn()], thread_id=OTHER)
    old = time.time() - 600
    os.utime(stale, (old, old))
    _goals(codex_home, [(TID, "ship the notes file", "active")])
    _queue(codex_home, [("q1", TID, _payload({"type": "text", "text": "also check b.md"}), 0, 1, 1)])
    t = table((101, CODEX))
    t[201] = (101, START, "sleep 600")
    [c] = _cards(atlas_env, claude_dir, t, FakeLsof({101: [main, fresh, nested, stale]}))
    assert c["session_id"] == TID
    assert c["background"] == {"shells": 1, "agents": 2, "wake_at": None, "crons": 0,
                               "goal": "ship the notes file"}
    assert c["activity"] == "background"
    assert [q["text"] for q in c["queued"]] == ["also check b.md"]


def test_subagents_of_a_daemon_run_codex_are_found_on_disk(codex_home, write_rollout):
    # Started outside an Atlas tab, Codex runs its threads in the app-server daemon: the card's
    # process holds none of the subagent rollouts. Those written lately under this thread count,
    # held or not, each once; another thread's and a quiet one do not.
    today = time.strftime("%Y/%m/%d")
    main = write_rollout([cx_meta(TID), *turn()], thread_id=TID, day=today)
    sub = write_rollout([_sub_meta(SUB, TID), *turn()], thread_id=SUB, day=today)
    write_rollout([_sub_meta(NESTED, SUB), *turn()], thread_id=NESTED, day=today)
    write_rollout([_sub_meta(FOREIGN, OTHER), *turn()], thread_id=FOREIGN, day=today)
    quiet = write_rollout([_sub_meta(QUIET, TID), *turn()], thread_id=QUIET, day=today)
    old = time.time() - 600
    os.utime(quiet, (old, old))
    t = table((101, CODEX))
    codex_live.codex_procs.rollouts_for(t, run=FakeLsof({101: [main]}))
    assert codex_live.live_subagents(101, t, TID, home=codex_home) == 2
    codex_live.codex_procs.rollouts_for(t, run=FakeLsof({101: [main, sub]}), fresh=True)   # held and on disk
    assert codex_live.codex_procs.subagent_rollouts(101, t, TID) == [sub]
    assert codex_live.live_subagents(101, t, TID, home=codex_home) == 2


def test_another_threads_subagents_are_not_counted(codex_home, write_rollout):
    main = write_rollout([cx_meta(TID), *turn()], thread_id=TID)
    foreign = write_rollout([_sub_meta(SUB, OTHER), *turn()], thread_id=SUB)
    t = table((101, CODEX))
    codex_live.codex_procs.rollouts_for(t, run=FakeLsof({101: [main, foreign]}))
    assert codex_live.live_subagents(101, t, TID) == 0
