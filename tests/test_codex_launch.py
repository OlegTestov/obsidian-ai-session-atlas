"""Starting Codex from the catalog: "New from this one" for a Codex thread and "+ Session" with Codex.

Codex cannot start with a given id, so a launch is linked to its thread by the handoff file its
first prompt names.
"""
from __future__ import annotations

import json
import os
import shlex
import urllib.error
import urllib.request

import pytest

from atlas import actions, db, enrich, index, launch, prompts
from tests.conftest import cx_agent, cx_context, cx_meta, cx_user, user_text

SOURCE = "019e0000-aaaa-7000-8000-000000000001"     # the Codex thread a handoff was made from
NEW = "019e0000-bbbb-7000-8000-000000000002"        # the thread "New from this one" started
OTHER = "019e0000-cccc-7000-8000-000000000003"
CLAUDE_ID = "11111111-2222-3333-4444-555555555555"


def _conn(atlas_env):
    return db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))


def _words(command):
    cd, rest = command.split(" && ", 1)
    return shlex.split(cd), shlex.split(rest)


def _index(atlas_env):
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    return conn


# --- commands ---------------------------------------------------------------

def test_codex_handoff_command_is_codex_with_the_handoff_prompt():
    path = "/h/it's here/launch-019e0000-0123456789ab.md"
    cmd = actions.new_session_command("/Users/u/it's demo", CLAUDE_ID, path, agent="codex")
    cd, words = _words(cmd)
    assert cd == ["cd", "/Users/u/it's demo"]
    assert words == ["codex", prompts.resume(path)]


def test_claude_handoff_command_is_unchanged():
    cmd = actions.new_session_command("/x", CLAUDE_ID, "/h/launch-11111111.md")
    assert _words(cmd)[1] == ["claude", "--session-id", CLAUDE_ID, prompts.resume("/h/launch-11111111.md")]


@pytest.mark.parametrize("prompt, word", [
    ("--yolo", " --yolo"),                    # a flag
    ("-m o3 rm", " -m o3 rm"),
    ("resume", " resume"),                    # a Codex subcommand
    ("exec", " exec"),
    ("update", " update"),                    # a Claude Code subcommand
    ("почини тест", "почини тест"),
])
def test_prompt_is_never_a_flag_or_subcommand(prompt, word):
    for agent in ("claude", "codex"):
        words = _words(actions.agent_command("/x", agent, CLAUDE_ID, prompt))[1]
        assert words[-1] == word, (agent, prompt)


def test_handoff_names_codex_launches_uniquely():
    a, b = actions.handoff_name(SOURCE, "codex"), actions.handoff_name(SOURCE, "codex")
    assert a != b and all(actions.CODEX_HANDOFF_NAME.match(n) for n in (a, b))
    assert actions.handoff_name(CLAUDE_ID, "claude") == "launch-11111111.md"
    assert not actions.CODEX_HANDOFF_NAME.match("launch-11111111.md")


# --- linking the new thread to its source -------------------------------------

def _launch_codex(conn, home):
    path = os.path.join(str(home), actions.handoff_name(SOURCE, "codex"))
    placeholder = actions.register_pending_launch(conn, SOURCE, path)
    return path, placeholder


def test_codex_thread_naming_the_handoff_becomes_the_derived_session(atlas_env, write_rollout):
    conn = _conn(atlas_env)
    path, placeholder = _launch_codex(conn, atlas_env["home"])
    write_rollout([cx_meta(NEW), cx_context(), cx_user(prompts.resume(path)), cx_agent("читаю")], thread_id=NEW)
    write_rollout([cx_meta(OTHER), cx_user("что-то другое")], thread_id=OTHER)
    conn = _index(atlas_env)
    got = actions.lineage(conn, NEW)["derived_from"]
    assert got["source_session_id"] == SOURCE and got["handoff_path"] == path and got["confirmed_at"]
    assert actions.lineage(conn, OTHER)["derived_from"] is None
    assert actions.lineage(conn, placeholder)["derived_from"] is None        # the placeholder is gone
    assert [d["new_session_id"] for d in actions.lineage(conn, SOURCE)["derived"]] == [NEW]


def test_link_survives_a_rebuild_and_a_second_run_of_the_command(atlas_env, write_rollout):
    conn = _conn(atlas_env)
    path, _ = _launch_codex(conn, atlas_env["home"])
    write_rollout([cx_meta(NEW), cx_user(prompts.resume(path))], thread_id=NEW)
    _index(atlas_env)
    # The same command run again: a launch links one thread only.
    write_rollout([cx_meta(OTHER), cx_user(prompts.resume(path))], thread_id=OTHER, day="2026/09/02")
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]), full=True)
    assert actions.lineage(conn, NEW)["derived_from"]["source_session_id"] == SOURCE
    assert actions.lineage(conn, OTHER)["derived_from"] is None


def test_thread_waits_for_its_first_prompt(atlas_env, write_rollout):
    """Indexed right after start, before the prompt is written: linked on the next pass."""
    conn = _conn(atlas_env)
    path, _ = _launch_codex(conn, atlas_env["home"])
    rollout = write_rollout([cx_meta(NEW)], thread_id=NEW)
    conn = _index(atlas_env)
    assert actions.lineage(conn, NEW)["derived_from"] is None
    with open(rollout, "a", encoding="utf-8") as fh:
        fh.write(cx_user(prompts.resume(path)))
    conn = _index(atlas_env)
    assert actions.lineage(conn, NEW)["derived_from"]["source_session_id"] == SOURCE


def test_claude_launch_is_never_taken_by_a_codex_thread(atlas_env, write_rollout):
    conn = _conn(atlas_env)
    path = os.path.join(str(atlas_env["home"]), actions.handoff_name(CLAUDE_ID, "claude"))
    new_id = actions.register_pending_launch(conn, CLAUDE_ID, path)
    write_rollout([cx_meta(NEW), cx_user(prompts.resume(path))], thread_id=NEW)
    conn = _index(atlas_env)
    assert actions.lineage(conn, NEW)["derived_from"] is None
    assert actions.lineage(conn, new_id)["derived_from"]["source_session_id"] == CLAUDE_ID


def test_prompt_mentioning_the_handoff_later_does_not_link(atlas_env, write_rollout):
    conn = _conn(atlas_env)
    path, _ = _launch_codex(conn, atlas_env["home"])
    write_rollout([cx_meta(NEW), cx_user("привет"), cx_user(prompts.resume(path))], thread_id=NEW)
    conn = _index(atlas_env)
    assert actions.lineage(conn, NEW)["derived_from"] is None


# --- routes -----------------------------------------------------------------

def _post(base, token, route, body):
    req = urllib.request.Request(f"{base}{route}", data=json.dumps(body).encode(),
                                 headers={"Origin": base, "X-Atlas-Token": token,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def _with_handoff(conn, session_id):
    conn.execute("INSERT INTO enrichment (session_id, artifact_kind, content_hash, extractor_version, "
                 "prompt_version, model, backend, payload, created_at) "
                 "VALUES (?, 'handoff', 'h', 1, 1, 'm', 'b', '# handoff', '2026-09-01')", (session_id,))
    conn.commit()


def test_launch_route_starts_codex_for_a_codex_source_and_links_it(atlas_env, write_rollout, write_session,
                                                                    live_server, tmp_path):
    workdir = tmp_path / "it's work"
    workdir.mkdir()
    write_rollout([cx_meta(SOURCE, cwd=str(workdir)), cx_user("сделай отчёт")], thread_id=SOURCE)
    write_session("p", [user_text("клод", cwd=str(workdir))], session_id=CLAUDE_ID)
    conn = _index(atlas_env)
    _with_handoff(conn, SOURCE)
    _with_handoff(conn, CLAUDE_ID)
    base, token = live_server

    out = _post(base, token, "/api/launch", {"session_id": SOURCE})
    assert out["agent"] == "codex" and out["new_session_id"] is None
    assert actions.CODEX_HANDOFF_NAME.match(os.path.basename(out["handoff_path"]))
    assert os.path.dirname(out["handoff_path"]) == enrich.handoff_dir()
    with open(out["handoff_path"], encoding="utf-8") as fh:
        assert fh.read() == "# handoff"
    cd, words = _words(out["command"])
    assert cd == ["cd", str(workdir)] and words == ["codex", prompts.resume(out["handoff_path"])]

    # The tab starts Codex with that prompt; the indexer links the thread to its source.
    write_rollout([cx_meta(NEW, cwd=str(workdir)), cx_user(prompts.resume(out["handoff_path"]))], thread_id=NEW)
    conn = _index(atlas_env)
    assert actions.lineage(conn, NEW)["derived_from"]["source_session_id"] == SOURCE

    claude = _post(base, token, "/api/launch", {"session_id": CLAUDE_ID})
    assert claude["agent"] == "claude" and actions.valid_session_id(claude["new_session_id"])
    assert _words(claude["command"])[1][:3] == ["claude", "--session-id", claude["new_session_id"]]


@pytest.fixture
def folder(atlas_env, write_session, tmp_path, monkeypatch):
    home = tmp_path / "home"
    work = home / "work" / "app"
    work.mkdir(parents=True)
    monkeypatch.setattr(launch, "_home", lambda: str(home))
    write_session("p", [user_text("тут", cwd=str(work), ts="2026-09-27T10:00:00.000Z")])
    _index(atlas_env)
    return str(work)


def test_new_session_with_codex(atlas_env, folder):
    conn = _conn(atlas_env)
    out = launch.new_session(conn, folder, "почини 'кавычки'; rm -rf ~ && $(whoami)", "codex")
    assert out["agent"] == "codex" and out["session_id"] is None
    cd, words = _words(out["command"])
    assert cd == ["cd", folder] and words == ["codex", "почини 'кавычки'; rm -rf ~ && $(whoami)"]
    assert _words(launch.new_session(conn, folder, "  ", "codex")["command"])[1] == ["codex"]
    assert _words(launch.new_session(conn, folder, "--yolo", "codex")["command"])[1] == ["codex", " --yolo"]
    claude = launch.new_session(conn, folder, "привет мир")
    assert claude["agent"] == "claude" and _words(claude["command"])[1][:2] == ["claude", "--session-id"]


@pytest.mark.parametrize("agent", ["gemini", "", None, ["codex"], {"codex": 1}, "Codex"])
def test_unknown_agent_is_refused(atlas_env, folder, agent):
    with pytest.raises(launch.LaunchError):
        launch.new_session(_conn(atlas_env), folder, "привет", agent)


def test_new_session_route_takes_the_agent(atlas_env, folder, live_server):
    base, token = live_server
    out = _post(base, token, "/api/new-session", {"cwd": folder, "prompt": "сделай отчёт", "agent": "codex"})
    assert _words(out["command"])[1] == ["codex", "сделай отчёт"] and out["session_id"] is None
    plain = _post(base, token, "/api/new-session", {"cwd": folder, "prompt": "сделай отчёт"})
    assert plain["agent"] == "claude" and _words(plain["command"])[1][0] == "claude"
    with pytest.raises(urllib.error.HTTPError) as err:
        _post(base, token, "/api/new-session", {"cwd": folder, "prompt": "x", "agent": "codex; id"})
    assert err.value.code == 400


def test_a_linked_thread_keeps_its_one_launch(atlas_env, write_rollout):
    """A first prompt naming two launches' files links one of them, and a reindex does not try the other."""
    conn = _conn(atlas_env)
    first, _ = _launch_codex(conn, atlas_env["home"])
    second, _ = _launch_codex(conn, atlas_env["home"])
    write_rollout([cx_meta(NEW), cx_user(prompts.resume(first) + "\n" + prompts.resume(second))], thread_id=NEW)
    _index(atlas_env)
    conn = _conn(atlas_env)
    stats = index.index_all(conn, root=str(atlas_env["projects"]), full=True)
    assert stats["errors"] == 0
    assert actions.lineage(conn, NEW)["derived_from"]["source_session_id"] == SOURCE
    assert conn.execute("SELECT count(*) FROM pending_launches WHERE confirmed_at IS NULL").fetchone()[0] == 1
