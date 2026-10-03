"""Building an excerpt within a budget: what goes out and in which priority."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from atlas import db, index, messages, runner, service
from tests.conftest import assistant_text, assistant_tool, rec, user_text


@pytest.fixture
def ru():
    """Section labels follow the page language; these checks pin the Russian text."""
    with messages.use_lang("ru"):
        yield


def _conn(atlas_env):
    return db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))


def _session(write_session, answers=40, padding=""):
    lines = [rec(type="user", timestamp="2026-09-01T09:00:00.000Z", cwd="/Users/u/Code/demo",
                 entrypoint="cli",
                 message={"role": "user",
                          "content": "This session is being continued from a previous "
                                     "conversation. Summary: ранее чинили ETL" + padding})]
    lines.append(user_text("первый запрос про пайплайн" + padding))
    for i in range(answers):
        lines.append(assistant_text(f"ответ номер {i} " + "детали " * 40,
                                    ts=f"2026-09-01T10:{i % 60:02d}:00.000Z"))
    lines.append(assistant_tool("Bash", {"command": "pytest -q"}))
    lines.append(user_text("последний запрос про релиз" + padding))
    return write_session("p", lines)


def test_summaries_and_prompts_survive_a_tight_budget(atlas_env, write_session, monkeypatch, ru):
    """Summaries and prompts carry the goal and decisions — they are cut last."""
    _session(write_session, answers=60)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    sid = conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]

    monkeypatch.setitem(runner.TOKEN_BUDGET, "handoff", int(4000 / runner.CHARS_PER_TOKEN))
    p = runner.build_payload(conn, sid, "handoff")
    assert p["kept"]["Сводки компактации"] == p["totals"]["summaries"]
    assert p["kept"]["Запросы пользователя"] == p["totals"]["prompts"]
    assert p["kept"].get("Ответы ассистента (хвост сессии)", 0) < p["totals"]["answers"]
    assert p["truncated"] is True
    assert p["chars"] <= 4000 + 2000          # the header may slightly exceed a tiny budget


def test_long_summaries_and_prompts_are_taken_before_answers(atlas_env, write_session, monkeypatch, ru):
    """Each summary and prompt is longer than what answers would leave over: only taking them
    first keeps them whole."""
    _session(write_session, answers=60, padding=" контекст" * 50)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    sid = conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]

    # Room for the header, the summary and both prompts, far less than the 60 answers.
    monkeypatch.setattr(runner, "budget_chars", lambda *a, **k: 4000)
    p = runner.build_payload(conn, sid, "handoff")
    assert p["kept"]["Сводки компактации"] == p["totals"]["summaries"] == 1
    assert p["kept"]["Запросы пользователя"] == p["totals"]["prompts"] == 2


def test_answers_are_taken_from_the_end(atlas_env, write_session, monkeypatch):
    """«The last part of the session» is the tail: the start is dropped before the end."""
    _session(write_session, answers=60)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    sid = conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]

    monkeypatch.setitem(runner.TOKEN_BUDGET, "handoff", int(12000 / runner.CHARS_PER_TOKEN))
    text = runner.build_payload(conn, sid, "handoff")["text"]
    assert "ответ номер 59" in text
    assert "ответ номер 0 " not in text


def test_whole_session_fits_when_budget_allows(atlas_env, write_session, ru):
    _session(write_session, answers=10)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    sid = conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]
    p = runner.build_payload(conn, sid, "handoff")
    assert p["truncated"] is False
    assert p["kept"]["Ответы ассистента (хвост сессии)"] == p["totals"]["answers"]


def test_handoff_budget_is_far_larger_than_summary_budget():
    """A catalog description does not need the whole session, a handoff does."""
    import os

    from tests.conftest import write_config
    write_config(os.environ["ATLAS_HOME"], {"models": {"handoff": ["claude-opus-5-5", "medium"]}})
    assert runner.TOKEN_BUDGET["handoff"] > 10 * runner.TOKEN_BUDGET["catalog_summary"]
    assert runner.TOKEN_BUDGET["handoff"] >= 700_000
    # Cyrillic is ~2.1 chars per token: dividing by 4 overflows the window twofold.
    assert 1.8 < runner.CHARS_PER_TOKEN < 2.6
    assert runner.has_1m_window(runner.model_for("handoff")[0])
    assert not runner.has_1m_window("claude-opus-5")          # no suffix — 200k


def test_preview_shows_head_and_tail_and_saves_the_full_text(atlas_env, write_session, ru):
    """3 MB do not fit the confirmation window — show the edges, put the full text in a file."""
    _session(write_session, answers=200)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    sid = conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]

    prev = runner.preview_payload(conn, sid, "handoff")
    assert len(prev["text"]) < prev["chars"]
    assert "пропущено" in prev["text"]
    assert os.path.exists(prev["full_path"])
    assert len(Path(prev["full_path"]).read_text(encoding="utf-8")) == prev["chars"]
    assert oct(os.stat(prev["full_path"]).st_mode)[-3:] == "600"


def test_argv_carries_the_isolation_flags():
    """Isolation is set by flags; breaking them must be caught here, not in production."""
    argv = runner._argv("/usr/bin/claude", "claude-sonnet-5", "low")
    joined = " ".join(argv)
    assert "--setting-sources  " in joined + " "     # empty setting source
    assert "--strict-mcp-config" in argv
    assert "--allowed-tools" in argv
    assert "--effort" in argv and "low" in argv
    assert "MultiEdit" not in joined                 # the CLI does not know this tool name


def test_large_prompt_triggers_preflight(monkeypatch):
    calls = []
    monkeypatch.setattr(runner, "find_claude", lambda: "/fake/bin/claude")   # no claude on CI
    monkeypatch.setattr(runner, "preflight", lambda **kw: calls.append(kw))
    monkeypatch.setattr(runner.subprocess, "run",
                        lambda *a, **k: type("P", (), {"returncode": 0, "stdout": "ok",
                                                       "stderr": ""})())
    runner.run_isolated("x" * (runner.PREFLIGHT_ABOVE + 1))
    assert len(calls) == 1
    runner.run_isolated("коротко")
    assert len(calls) == 1                            # no pre-check on a small call


def test_claude_is_found_without_a_user_path(monkeypatch, tmp_path):
    """launchd does not inherit PATH: without a fallback the server under it cannot find claude
    and classification fails."""
    monkeypatch.setattr(runner.shutil, "which", lambda name: None)
    monkeypatch.setattr(runner, "CLAUDE_CANDIDATES", ())
    with pytest.raises(RuntimeError, match="claude not found"):     # no header — en
        runner.find_claude()

    fake = tmp_path / "claude"
    fake.write_text("#!/bin/sh\n")
    fake.chmod(0o755)
    monkeypatch.setattr(runner, "CLAUDE_CANDIDATES", (str(fake),))
    assert runner.find_claude() == str(fake)


def test_launchagent_path_carries_local_bin(monkeypatch, tmp_path):
    """launchd does not inherit PATH: the plist puts ~/.local/bin, where claude is installed, first."""
    target = tmp_path / "agent.plist"
    monkeypatch.setattr(service, "plist_path", lambda: str(target))
    monkeypatch.setattr(service.subprocess, "run", lambda *a, **k: None)     # do not touch launchctl
    service.install()
    plist = target.read_text(encoding="utf-8")
    path = plist.split("<key>PATH</key><string>")[1].split("</string>")[0].split(":")
    assert path[0] == os.path.expanduser("~/.local/bin") and "/opt/homebrew/bin" in path


def test_summary_is_produced_end_to_end_with_only_the_model_call_faked(atlas_env, write_session,
                                                                       monkeypatch):
    """«What was done» end to end, except the paid call: template with a JSON sample, parsing, storing."""
    from atlas import actions, enrich
    _session(write_session)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    sid = conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]
    sent = []

    def fake_model(prompt, **kw):
        sent.append(prompt)
        return '{"did": "чинил тесты", "result": "зелёные", "open": null, "work_outcome": "done"}'
    monkeypatch.setattr(runner, "run_isolated", fake_model)
    model, _ = runner.model_for("catalog_summary")
    payload = runner.build_payload(conn, sid, "catalog_summary")
    runner.grant_egress(conn, sid, payload["content_hash"], "catalog_summary",
                        runner.EXTERNAL_BACKEND, model)
    job_id, _ = actions.claim_job(conn, sid, "catalog_summary", payload["content_hash"])
    out = enrich.produce(conn, sid, "catalog_summary", job_id)
    assert json.loads(out["payload"])["did"] == "чинил тесты"
    assert payload["text"][:200] in sent[0], "the session excerpt is in the model request"
    assert '"did"' in sent[0], "the JSON sample reaches the model as is"
    art = enrich.cached(conn, sid, "catalog_summary")
    assert art and json.loads(art["payload"])["result"] == "зелёные"
