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
            _post(base + path, dict(body, backend=runner.CLAUDE_BACKEND, excerpt_hash="fixture"), headers)
        assert refused.value.code == 409 and "Open the preview again" in json.loads(refused.value.read())["error"]
        # A page from before the update names no agent: reloading it, not a new preview, helps.
        with pytest.raises(urllib.error.HTTPError) as old_page:
            _post(base + path, body, headers)
        assert old_page.value.code == 409 and "Reload the page" in json.loads(old_page.value.read())["error"]
    with pytest.raises(urllib.error.HTTPError) as old_page:
        _post(base + "/api/job", job, dict(headers, **{"X-Atlas-Lang": "ru"}))
    assert "Обнови страницу" in json.loads(old_page.value.read())["error"]
    assert started == [] and conn.execute("SELECT count(*) FROM egress_grants").fetchone()[0] == 0
    excerpt = runner.build_payload(conn, sid, "catalog_summary")
    preview = json.load(_post(base + "/api/preview", job, headers))
    job.update(backend=preview["backend"], model_id=preview["model_id"], effort=preview["effort"],
               content_hash=preview["content_hash"])
    with pytest.raises(urllib.error.HTTPError) as stale_page:
        _post(base + "/api/job", job, headers)
    assert "Reload the page" in json.loads(stale_page.value.read())["error"]
    conn.execute("UPDATE sessions SET content_hash=?, human_turns=human_turns+1 WHERE session_id=?",
                 ("new-content", sid))
    conn.commit()
    job["excerpt_hash"] = preview["excerpt_hash"]
    first = json.load(_post(base + "/api/job", job, headers))
    duplicate = json.load(_post(base + "/api/job", job, headers))
    assert duplicate == {"job_id": first["job_id"], "created": False}
    _, _, kind, backend, model, _, fallback, payload, _, effort = started[0]
    assert effort == preview["effort"]
    assert payload == excerpt
    assert fallback is False
    assert (kind, backend, model) == ("catalog_summary", runner.CODEX_BACKEND, "default")
    grant = conn.execute("SELECT backend, model FROM egress_grants WHERE session_id=?", (sid,)).fetchone()
    assert tuple(grant) == (runner.CODEX_BACKEND, "default")
    conn.execute("UPDATE sessions SET content_hash=? WHERE session_id=?", (preview["content_hash"], sid))
    conn.commit()
    refreshed = json.load(_post(base + "/api/preview", job, headers))
    assert refreshed["excerpt_hash"] != preview["excerpt_hash"]
    second = json.load(_post(base + "/api/job", dict(job, excerpt_hash=refreshed["excerpt_hash"]), headers))
    assert second["created"] and second["job_id"] != first["job_id"]
    with pytest.raises(urllib.error.HTTPError) as outdated_settings:
        _post(base + "/api/job", dict(job, effort="high"), headers)
    assert outdated_settings.value.code == 409
    r = _post(base + "/api/classify", {"confirmed": True, "backend": runner.CODEX_BACKEND}, headers)
    assert r.status == 200 and started[2][3] == runner.CODEX_BACKEND   # the batch runs with that agent


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


@pytest.mark.parametrize("confirmed", [False, True])
def test_claude_limit_fallback_requires_its_own_grant(atlas_env, write_session, codex_cli, monkeypatch, confirmed):
    conn, sid = _indexed(atlas_env, write_session)
    kind = "catalog_summary"
    model, _ = runner.model_for(kind, runner.CLAUDE_BACKEND)
    payload = runner.build_payload(conn, sid, kind)
    digest = payload["content_hash"]
    job_id, _ = actions.claim_job(conn, sid, kind, digest)
    runner.grant_egress(conn, sid, digest, kind, runner.CLAUDE_BACKEND, model)
    if confirmed:
        runner.grant_egress(conn, sid, digest, kind, runner.CODEX_BACKEND, "gpt-6.2-sol")

    calls = []

    def run(prompt, *, model, backend_name, **kwargs):
        calls.append((prompt, backend_name, model))
        if backend_name == runner.CLAUDE_BACKEND:
            raise runner.ClaudeUsageLimit("You've hit your 5-hour limit · resets 11:50pm (Europe/Madrid)")
        return json.dumps(SUMMARY)

    monkeypatch.setattr(runner, "run_isolated", run)
    if confirmed:
        assert json.loads(enrich.produce(conn, sid, kind, job_id, backend=runner.CLAUDE_BACKEND,
                                        allow_fallback=True)["payload"])["did"] == SUMMARY["did"]
        assert calls[1] == (calls[0][0], runner.CODEX_BACKEND, "gpt-6.2-sol")
        row = conn.execute("SELECT backend, model FROM enrichment WHERE session_id=?", (sid,)).fetchone()
        assert tuple(row) == (runner.CODEX_BACKEND, "gpt-6.2-sol")
    else:
        with pytest.raises(runner.ClaudeUsageLimit):
            enrich.produce(conn, sid, kind, job_id, backend=runner.CLAUDE_BACKEND)
        assert len(calls) == 1


def test_summary_limit_fallback_from_the_confirmed_preview(
    atlas_env, write_session, codex_cli, live_server, monkeypatch, tmp_path,
):
    _set(atlas_env, llm_enabled=True, ai_agent="claude")
    monkeypatch.setenv("STANDIN_REPLY", json.dumps(SUMMARY))
    claude = tmp_path / "claude-limit"
    claude.write_text("#!/bin/sh\n"
                      "printf \"You've hit your 5-hour limit · resets 11:50pm (Europe/Madrid)\\n\"\nexit 1\n")
    claude.chmod(0o700)
    monkeypatch.setattr(runner, "find_claude", lambda: str(claude))
    conn, sid = _indexed(atlas_env, write_session)
    base, token = live_server
    headers = {"Origin": base, "X-Atlas-Token": token}
    body = {"session_id": sid, "artifact_kind": "catalog_summary"}
    preview = json.load(_post(base + "/api/preview", body, headers))
    assert preview["fallback_model"] == "gpt-6.2-sol"
    job = dict(body, confirmed=True, backend=preview["backend"], model_id=preview["model_id"],
               effort=preview["effort"], fallback_model=preview["fallback_model"],
               fallback_effort=preview["fallback_effort"], excerpt_hash=preview["excerpt_hash"])
    for wrong in ("", "old"):
        with pytest.raises(urllib.error.HTTPError) as refused:
            _post(base + "/api/job", dict(job, content_hash=wrong), headers)
        assert refused.value.code == 409
    with pytest.raises(urllib.error.HTTPError) as wrong_excerpt:
        _post(base + "/api/job", dict(job, content_hash=preview["content_hash"], excerpt_hash="old"), headers)
    assert wrong_excerpt.value.code == 409
    with pytest.raises(urllib.error.HTTPError) as wrong_effort:
        _post(base + "/api/job", dict(job, content_hash=preview["content_hash"], fallback_effort="ultra"), headers)
    assert wrong_effort.value.code == 409
    assert conn.execute("SELECT count(*) FROM egress_grants").fetchone()[0] == 0
    job_id = json.load(_post(base + "/api/job", dict(job, content_hash=preview["content_hash"]), headers))["job_id"]
    for _ in range(100):
        request = urllib.request.Request(f"{base}/api/job/{job_id}", headers=headers)
        status = json.load(urllib.request.urlopen(request, timeout=5))
        if status["state"] in ("done", "failed"):
            break
        time.sleep(0.03)
    assert status["state"] == "done", status
    run, = codex_cli["runs"]()
    args = run["argv"]
    assert args[args.index("-m") + 1] == "gpt-6.2-sol"
    assert f"model_reasoning_effort={preview['fallback_effort']}" in args


@pytest.mark.parametrize(("claude", "sol"), [
    ("low", "medium"), ("medium", "high"), ("high", "xhigh"), ("xhigh", "max"), ("max", "ultra"),
])
def test_sol_fallback_effort_is_one_step_higher(atlas_env, claude, sol):
    args = codex_exec.argv("codex", "/tmp", "/tmp/out", "gpt-6.2-sol", codex_exec.fallback_effort(claude), None)
    assert f"model_reasoning_effort={sol}" in args


@pytest.mark.parametrize(("stdout", "stderr", "exit_code", "limited"), [
    ("You've hit your 5-hour limit", "", 1, True),
    ("Model output\nYou've hit your 5-hour limit", "", 1, False),
    ("You've hit your 5-hour limit", "Connection failed", 1, False),
    ("", "Error: You've hit your weekly limit", 1, True),
    ("You've hit your 5-hour limit", "", 0, False),
])
def test_usage_limit_only_reads_the_cli_error(stdout, stderr, exit_code, limited):
    proc = subprocess.CompletedProcess([], exit_code, stdout, stderr)
    if limited:
        with pytest.raises(runner.ClaudeUsageLimit):
            runner._raise_claude_usage_limit(proc)
    else:
        runner._raise_claude_usage_limit(proc)


@pytest.mark.parametrize("refusal", ["cancelled", "sensitive"])
def test_no_fallback_if_cancelled_or_sensitive_after_claude(
    atlas_env, write_session, codex_cli, monkeypatch, refusal,
):
    conn, sid = _indexed(atlas_env, write_session)
    kind = "catalog_summary"
    payload = runner.build_payload(conn, sid, kind)
    digest = payload["content_hash"]
    job_id, _ = actions.claim_job(conn, sid, kind, digest)
    model, _ = runner.model_for(kind, runner.CLAUDE_BACKEND)
    runner.grant_egress(conn, sid, digest, kind, runner.CLAUDE_BACKEND, model)
    runner.grant_egress(conn, sid, digest, kind, runner.CODEX_BACKEND, "gpt-6.2-sol")
    calls = []

    def run(_prompt, *, backend_name, **_):
        calls.append(backend_name)
        if refusal == "cancelled":
            assert actions.cancel_job(conn, job_id)
            actions.set_job_state(conn, job_id, "running")
            assert actions.is_cancelled(conn, job_id)
        else:
            conn.execute("INSERT INTO user_overrides (session_id, sensitivity, updated_at) "
                         "VALUES (?, 'sensitive', 'now')", (sid,))
            conn.commit()
        raise runner.ClaudeUsageLimit("quota")

    monkeypatch.setattr(runner, "run_isolated", run)
    with pytest.raises((runner.ClaudeUsageLimit, runner.EgressDenied)):
        enrich.produce(conn, sid, kind, job_id, backend=runner.CLAUDE_BACKEND, allow_fallback=True,
                       confirmed_payload=payload, fallback_effort="medium")
    assert calls == [runner.CLAUDE_BACKEND]
    if refusal == "sensitive":
        assert enrich.preview(conn, sid, kind, runner.CLAUDE_BACKEND)["fallback_model"] is None


@pytest.mark.parametrize("backend", [runner.CLAUDE_BACKEND, runner.CODEX_BACKEND])
def test_oversized_confirmed_prompt_retries_only_claude(atlas_env, write_session, monkeypatch, backend):
    conn, sid = _indexed(atlas_env, write_session)
    kind = "catalog_summary"
    original = runner.budget_chars
    monkeypatch.setattr(runner, "budget_chars", lambda kind, scale: 1 if scale < 1 else original(kind, scale))
    payload = runner.build_payload(conn, sid, kind, prepare_retry=True)
    assert payload["trimmed"] is not None
    model, _ = runner.model_for(kind, backend)
    runner.grant_egress(conn, sid, payload["content_hash"], kind, backend, model)
    job_id, _ = actions.claim_job(conn, sid, kind, payload["content_hash"])
    calls = []

    def run(prompt, *, backend_name, **_):
        calls.append((prompt, backend_name))
        if len(calls) == 1:
            conn.execute("UPDATE sessions SET content_hash='grew', title='APPENDED' WHERE session_id=?", (sid,))
            conn.commit()
            raise runner.PromptTooLong("too long")
        raise runner.ClaudeUsageLimit("quota")

    monkeypatch.setattr(runner, "run_isolated", run)
    with pytest.raises(runner.ClaudeUsageLimit if backend == runner.CLAUDE_BACKEND else runner.PromptTooLong):
        enrich.produce(conn, sid, kind, job_id, backend=backend, allow_fallback=True, confirmed_payload=payload)
    assert [agent for _, agent in calls] == [backend] * (2 if backend == runner.CLAUDE_BACKEND else 1)
    if backend == runner.CLAUDE_BACKEND:
        assert payload["trimmed"]["text"] in calls[1][0]
        assert "APPENDED" not in calls[1][0]


def test_cancel_during_claude_preflight_does_not_send_the_excerpt(monkeypatch):
    monkeypatch.setattr(runner, "require_llm", lambda: None)
    monkeypatch.setattr(runner, "find_claude", lambda: "fixture-claude")
    monkeypatch.setattr(runner, "PREFLIGHT_ABOVE", 0)
    cancelled = False

    def preflight(**_):
        nonlocal cancelled
        cancelled = True

    def check():
        if cancelled:
            raise RuntimeError("cancelled during preflight")

    monkeypatch.setattr(runner, "preflight", preflight)
    monkeypatch.setattr(runner, "runner_cwd", lambda: "/tmp")

    def unexpected_send(*_, **__):
        pytest.fail("Excerpt reached Claude after cancellation")

    monkeypatch.setattr(runner.subprocess, "run", unexpected_send)
    with pytest.raises(RuntimeError, match="cancelled during preflight"):
        runner.run_isolated("excerpt", backend_name=runner.CLAUDE_BACKEND, before_send=check)


@pytest.mark.parametrize("fails", [False, True])
def test_cancelled_artifact_worker_keeps_no_result(atlas_env, write_session, monkeypatch, fails):
    conn, sid = _indexed(atlas_env, write_session)
    kind = "catalog_summary"
    backend = runner.CLAUDE_BACKEND
    payload = runner.build_payload(conn, sid, kind)
    model, _ = runner.model_for(kind, backend)
    runner.grant_egress(conn, sid, payload["content_hash"], kind, backend, model)
    job_id, _ = actions.claim_job(conn, sid, kind, payload["content_hash"])

    def run(*_, **__):
        assert actions.cancel_job(conn, job_id)
        if fails:
            raise RuntimeError("late failure")
        return json.dumps(SUMMARY)

    monkeypatch.setattr(runner, "run_isolated", run)
    server._run_job(job_id, sid, kind, backend, model, confirmed_payload=payload)
    job = actions.get_job(conn, job_id)
    assert job["state"] == "cancelled"
    assert job["result"] is None and job["error"] is None
    assert enrich.cached(conn, sid, kind) is None
