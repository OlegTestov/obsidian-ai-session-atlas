"""Codex sessions in search, the card, AI payloads and the guarded actions; the schema upgrade."""
from __future__ import annotations

import json
import os
import shlex
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

import pytest

from atlas import actions, agents, db, index, runner, search
from tests.conftest import cx_agent, cx_context, cx_meta, cx_user, user_text

TID = "019e0000-1111-7000-8000-000000000001"
CLAUDE_ID = "11111111-2222-3333-4444-555555555555"


def _conn(atlas_env):
    return db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))


@pytest.fixture
def both(atlas_env, write_session, write_rollout, tmp_path):
    """One Claude Code session and one Codex session sharing a word; both indexed."""
    workdir = tmp_path / "it's here"
    workdir.mkdir()
    write_session("p", [user_text("общий деплой из клода", cwd=str(workdir))], session_id=CLAUDE_ID)
    rollout = write_rollout([cx_meta(TID, cwd=str(workdir)), cx_context(cwd=str(workdir)),
                             cx_user("общий деплой из кодекса"), cx_agent("готово")], thread_id=TID)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    return {"conn": conn, "cwd": str(workdir), "rollout": rollout}


def test_agent_filter_is_a_known_subset_or_nothing():
    assert agents.parse_filter(None) is None
    assert agents.parse_filter(["claude,codex"]) is None            # both = no filter
    assert agents.parse_filter(["codex"]) == ["codex"]
    assert agents.parse_filter(["Codex, gemini"]) == ["codex"]       # unknown values ignored
    assert agents.parse_filter(["claude", "codex"]) is None
    assert agents.parse_filter(["gemini", ""]) is None


def test_search_and_list_filter_by_agent(both):
    conn = both["conn"]

    def ids(**kw):
        return {r["session_id"] for r in search.search(conn, "деплой", **kw)}
    assert ids() == {CLAUDE_ID, TID}
    assert ids(agents=["claude"]) == {CLAUDE_ID}
    assert ids(agents=["codex"]) == {TID}
    assert {r["session_id"] for r in search.recent(conn, agents=["codex"])} == {TID}
    assert {r["agent"] for r in search.recent(conn)} == {"claude", "codex"}
    assert search.load_session(conn, TID)["agent"] == "codex"


def test_api_sessions_takes_the_agent_parameter(both, live_server):
    base, _ = live_server

    def get(qs):
        with urllib.request.urlopen(f"{base}/api/sessions?{qs}", timeout=20) as r:
            return {(row["session_id"], row["agent"]) for row in json.loads(r.read())["results"]}
    assert get("q=" + quote("деплой")) == {
        (CLAUDE_ID, "claude"), (TID, "codex")}
    assert get("agent=codex") == {(TID, "codex")}
    assert get("agent=claude,unknown") == {(CLAUDE_ID, "claude")}
    assert get("agent=claude,codex") == {(CLAUDE_ID, "claude"), (TID, "codex")}
    with urllib.request.urlopen(f"{base}/api/session/{TID}", timeout=20) as r:
        card = json.loads(r.read())
    assert card["agent"] == "codex"
    assert card["actions"]["resume_command"] == f"cd {shlex.quote(both['cwd'])} && codex resume {TID}"
    assert card["state"]["last_prompt"] == "общий деплой из кодекса"


def test_resume_command_per_agent(both):
    conn, cwd = both["conn"], both["cwd"]
    codex = actions.actions_for(conn, TID)
    assert codex["resume_command"].endswith(f"&& codex resume {TID}")
    assert codex["resume_command"].startswith("cd ") and "'\"'\"'" in codex["resume_command"]
    assert codex["fork_command"] is None
    claude = actions.actions_for(conn, CLAUDE_ID)
    assert claude["resume_command"].endswith(f"&& claude --resume {CLAUDE_ID}")
    assert actions.resume_command(cwd, TID, agent="codex") == codex["resume_command"]


def test_rename_keeps_codex_transcript_untouched(both):
    conn = both["conn"]
    before = Path(both["rollout"]).read_bytes()
    result = actions.rename_session(conn, TID, "Мой заголовок", write_to_transcript=True)
    assert result["written_to_transcript"] is False and "Codex" in result["error"]
    assert Path(both["rollout"]).read_bytes() == before
    assert search.load_session(conn, TID)["title"] == "Мой заголовок"     # catalog rename works
    claude = actions.rename_session(conn, CLAUDE_ID, "Клод", write_to_transcript=True)
    assert claude["written_to_transcript"] is True and claude["error"] is None


def test_ai_payload_reads_a_codex_session(both):
    payload = runner.build_payload(both["conn"], TID, "catalog_summary")
    assert "общий деплой из кодекса" in payload["text"] and "готово" in payload["text"]
    assert payload["totals"]["prompts"] == 1 and payload["totals"]["answers"] == 1


def test_upgrade_from_schema_10_rebuilds_claude_rows_as_claude(atlas_env, write_session):
    write_session("p", [user_text("старая работа")], session_id=CLAUDE_ID)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("INSERT INTO user_overrides(session_id, title, updated_at) VALUES(?,?,?)",
                 (CLAUDE_ID, "ручное", "2026-10-01"))
    # The schema before Codex support: no agent column.
    conn.execute("DROP INDEX ix_sessions_agent")
    conn.execute("ALTER TABLE sessions DROP COLUMN agent")
    conn.execute("UPDATE meta SET value='10' WHERE key='schema_version'")
    conn.commit()
    conn.close()

    conn = _conn(atlas_env)
    assert "agent" in {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
    assert db.get_meta(conn, "schema_version") == str(db.SCHEMA_VERSION)
    index.ensure_indexed(conn, root=str(atlas_env["projects"]))
    row = conn.execute("SELECT agent FROM sessions WHERE session_id=?", (CLAUDE_ID,)).fetchone()
    assert row["agent"] == "claude"
    assert search.load_session(conn, CLAUDE_ID)["title"] == "ручное"
