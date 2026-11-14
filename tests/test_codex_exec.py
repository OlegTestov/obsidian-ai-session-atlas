"""AI features through `codex exec` (a stand-in codex): which agent runs them, the isolation flags,
the preview naming the agent, and the summary/classification round trips."""
from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error

import pytest

from atlas import actions, classify, codex_exec, config, db, enrich, index, runner, server
from tests.conftest import user_text, write_config
from tests.test_actions_security import _post

TITLE = "чинил тесты в кодексе"
SUMMARY = {"did": "чинил тесты", "result": "зелёные", "open": None, "work_outcome": "done"}


def _set(atlas_env, **extra):
    write_config(str(atlas_env["home"]), extra)
    config.reset()


@pytest.fixture(autouse=True)
def _never_real_claude(monkeypatch):
    """Even a broken backend choice cannot reach the real `claude -p` from these tests."""
    def refuse():
        raise RuntimeError("claude is not available in these tests")
    monkeypatch.setattr(runner, "find_claude", refuse)


@pytest.fixture
def no_claude(monkeypatch):
    monkeypatch.setattr(runner, "has_claude", lambda: False)


def _indexed(atlas_env, write_session):
    write_session("p", [user_text(TITLE)])
    conn = db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))
    index.index_all(conn, root=str(atlas_env["projects"]))
    return conn, conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]


@pytest.mark.parametrize("choice,claude,codex,expected", [
    ("auto", True, True, runner.CLAUDE_BACKEND),       # both installed: Claude Code stays the default
    ("auto", False, True, runner.CODEX_BACKEND),       # only Codex: Codex runs them
    ("auto", False, False, runner.CLAUDE_BACKEND),     # neither: Claude Code's error says what is missing
    ("codex", True, True, runner.CODEX_BACKEND),
    ("claude", False, True, runner.CLAUDE_BACKEND),
])
def test_which_agent_runs_the_ai_features(atlas_env, codex_cli, monkeypatch, choice, claude, codex, expected):
    _set(atlas_env, ai_agent=choice)
    monkeypatch.setattr(runner, "has_claude", lambda: claude)
    if not codex:
        monkeypatch.setenv("ATLAS_CODEX_BIN", "")
    assert runner.backend() == expected


def test_codex_exec_runs_isolated_with_the_prompt_on_stdin(atlas_env, codex_cli, no_claude, monkeypatch):
    monkeypatch.setenv("STANDIN_REPLY", "  готово \n")
    prompt = "--summarise this " + "x" * 300
    assert runner.run_isolated(prompt, model="default", effort="low") == "готово"
    run, = codex_cli["runs"]()
    args = run["argv"]
    assert args[0] == "exec" and args[-1] == "-" and run["stdin"] == prompt
    assert prompt not in args                               # never on the command line
    for flag in ("--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"):
        assert flag in args
    assert args[args.index("--sandbox") + 1] == "read-only"
    disabled = {args[i + 1] for i, a in enumerate(args) if a == "--disable"}
    # No tool for an untrusted transcript to drive: commands, files, web, agents, images, goals, apps.
    assert {"hooks", "shell_tool", "unified_exec", "multi_agent", "goals", "view_image", "apps", "plugins",
            "image_generation", "browser_use", "computer_use"} <= disabled
    assert args[args.index('web_search="disabled"') - 1] == "-c"
    assert args[args.index("skills.include_instructions=false") - 1] == "-c"
    assert args[args.index("-C") + 1] == runner.runner_cwd() == run["cwd"]
    assert "model_reasoning_effort=low" in args and "-m" not in args and run["schema"] is None


def test_configured_model_effort_and_overrides_reach_codex(atlas_env, codex_cli, no_claude):
    _set(atlas_env, codex_model=["gpt-5.5", "xhigh"], codex_exec_config=['model_provider="corp"', "junk"])
    model, effort = runner.model_for("handoff")
    assert (model, effort) == ("gpt-5.5", "xhigh")
    runner.run_isolated("p", model=model, effort=effort, schema=codex_exec.SUMMARY_SCHEMA)
    run, = codex_cli["runs"]()
    args = run["argv"]
    assert args[args.index("-m") + 1] == "gpt-5.5" and "model_reasoning_effort=high" in args
    assert 'model_provider="corp"' in args and "junk" not in args
    assert run["schema"] == codex_exec.SUMMARY_SCHEMA


def test_a_codex_failure_brings_its_reason(atlas_env, codex_cli, no_claude):
    codex_cli["mode"]("exec_fails")
    with pytest.raises(RuntimeError, match="usage limit"):
        runner.run_isolated("p")


def test_an_overlong_input_is_retried_smaller(atlas_env, codex_cli, no_claude):
    codex_cli["mode"]("exec_too_long")
    with pytest.raises(runner.PromptTooLong):
        runner.run_isolated("p")


def test_ai_off_stops_codex_too(atlas_env, codex_cli, no_claude):
    _set(atlas_env, llm_enabled=False)
    with pytest.raises(runner.LlmDisabled):
        runner.run_isolated("p")
    assert codex_cli["runs"]() == []


def test_preview_names_codex_and_its_default_model(atlas_env, write_session, codex_cli, no_claude):
    conn, sid = _indexed(atlas_env, write_session)
    prev = enrich.preview(conn, sid, "catalog_summary")
    assert prev["backend"] == runner.CODEX_BACKEND and prev["agent_name"] == "Codex"
    assert prev["model"] == "default / low"
    batch = classify.preview_batch(conn)
    assert batch["backend"] == runner.CODEX_BACKEND and batch["agent_name"] == "Codex"


def test_summary_through_codex_end_to_end(atlas_env, write_session, codex_cli, no_claude, monkeypatch):
    monkeypatch.setenv("STANDIN_REPLY", json.dumps(SUMMARY, ensure_ascii=False))
    conn, sid = _indexed(atlas_env, write_session)
    payload = runner.build_payload(conn, sid, "catalog_summary")
    job_id, _ = actions.claim_job(conn, sid, "catalog_summary", payload["content_hash"])
    with pytest.raises(runner.EgressDenied):             # a Claude grant does not cover Codex
        runner.grant_egress(conn, sid, payload["content_hash"], "catalog_summary", runner.CLAUDE_BACKEND,
                            runner.DEFAULT_MODEL)
        enrich.produce(conn, sid, "catalog_summary", job_id)
    assert codex_cli["runs"]() == []
    model, _ = runner.model_for("catalog_summary")
    runner.grant_egress(conn, sid, payload["content_hash"], "catalog_summary", runner.CODEX_BACKEND, model)
    out = enrich.produce(conn, sid, "catalog_summary", job_id)
    assert json.loads(out["payload"])["did"] == "чинил тесты"
    run, = codex_cli["runs"]()
    assert TITLE in run["stdin"] and run["schema"] == codex_exec.SUMMARY_SCHEMA
    row = conn.execute("SELECT backend, model FROM enrichment WHERE session_id=?", (sid,)).fetchone()
    assert tuple(row) == (runner.CODEX_BACKEND, "default")


def test_classification_through_codex_reads_the_wrapped_array(atlas_env, write_session, codex_cli, no_claude,
                                                              monkeypatch):
    conn, sid = _indexed(atlas_env, write_session)
    domain = config.domain_ids()[0]
    monkeypatch.setenv("STANDIN_REPLY", json.dumps({"sessions": [
        {"n": 1, "domain": domain, "topic": "тесты", "summary": "чинил тесты", "confidence": 0.9}]}))
    result = classify.classify_batch(conn, [sid])
    assert result["classified"] == 1 and result["failed"] == 0
    run = codex_cli["runs"]()[0]
    assert run["schema"] == codex_exec.CLASSIFY_SCHEMA and "model_reasoning_effort=low" in run["argv"]
    row = conn.execute("SELECT topic, backend FROM classification WHERE session_id=?", (sid,)).fetchone()
    assert tuple(row) == ("тесты", runner.CODEX_BACKEND)


def test_the_job_starts_only_with_the_agent_the_preview_showed(atlas_env, write_session, codex_cli, no_claude,
                                                              live_server, monkeypatch):
    conn, sid = _indexed(atlas_env, write_session)
    started = []
    monkeypatch.setattr(server, "_run_job", lambda *a: started.append(a))
    monkeypatch.setattr(server, "_run_classify", lambda *a: started.append(a))
    base, token = live_server
    headers = {"Origin": base, "X-Atlas-Token": token}
    job = {"session_id": sid, "artifact_kind": "catalog_summary", "confirmed": True}
    # The preview named Claude Code, the settings now resolve to Codex: nothing is sent, re-preview.
    for path, body in (("/api/job", job), ("/api/classify", {"confirmed": True})):
        with pytest.raises(urllib.error.HTTPError) as refused:
            _post(base + path, dict(body, backend=runner.CLAUDE_BACKEND), headers)
        assert refused.value.code == 409 and "Open the preview again" in json.loads(refused.value.read())["error"]
        # A page from before the update names no agent: reloading it, not a new preview, helps.
        with pytest.raises(urllib.error.HTTPError) as old_page:
            _post(base + path, body, headers)
        assert old_page.value.code == 409 and "Reload the page" in json.loads(old_page.value.read())["error"]
    with pytest.raises(urllib.error.HTTPError) as old_page:
        _post(base + "/api/job", job, dict(headers, **{"X-Atlas-Lang": "ru"}))
    assert "Обнови страницу" in json.loads(old_page.value.read())["error"]
    assert started == [] and conn.execute("SELECT count(*) FROM egress_grants").fetchone()[0] == 0
    r = _post(base + "/api/job", dict(job, backend=runner.CODEX_BACKEND), headers)
    assert r.status == 200
    _, _, kind, backend, model, _ = started[0]
    assert (kind, backend, model) == ("catalog_summary", runner.CODEX_BACKEND, "default")
    grant = conn.execute("SELECT backend, model FROM egress_grants WHERE session_id=?", (sid,)).fetchone()
    assert tuple(grant) == (runner.CODEX_BACKEND, "default")
    r = _post(base + "/api/classify", {"confirmed": True, "backend": runner.CODEX_BACKEND}, headers)
    assert r.status == 200 and started[1][3] == runner.CODEX_BACKEND   # the batch runs with that agent


def test_a_timeout_stops_codex_and_what_it_started(atlas_env, codex_cli, no_claude, tmp_path, monkeypatch):
    # The npm `codex` is a node wrapper around the native binary: killing only the wrapper would leave
    # the native process calling the model. The whole process group goes.
    _set(atlas_env, llm_enabled=True)
    codex_cli["mode"]("exec_hang")
    with pytest.raises(subprocess.TimeoutExpired):
        runner.run_isolated("p", timeout=2)
    pid = int((tmp_path / "codex-standin.log.child").read_text())
    for _ in range(30):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        os.kill(pid, 9)
        pytest.fail("the child of codex kept running after the timeout")


def test_the_confirmed_batch_runs_with_its_agent(atlas_env, monkeypatch):
    seen = []
    monkeypatch.setattr(classify, "classify_batch", lambda conn, ids, job_id=None, backend=None: seen.append(backend)
                        or {"classified": 0})
    monkeypatch.setattr(actions, "set_job_state", lambda *a, **kw: None)
    server._run_classify("job", ["s"], "en", runner.CODEX_BACKEND)
    assert seen == [runner.CODEX_BACKEND]
