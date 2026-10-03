"""Agent tab script: what launches on first open and after an Obsidian restart.

claude is replaced by a stub that records its arguments. The registry, transcript folder and
working folder are temporary.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "obsidian-plugin" / "scripts"
SCRIPT = SCRIPTS / "agent-resume-terminal.zsh"
OLD = "11111111-2222-3333-4444-555555555555"
NEW = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def _env(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    stub = bin_dir / "claude"
    stub.write_text('#!/bin/zsh\nprint -r -- "${(pj:\\x1f:)@}" >> "$CALLS"\n', encoding="utf-8")
    stub.chmod(0o755)
    projects = tmp_path / "projects"
    (projects / "-some-project").mkdir(parents=True, exist_ok=True)
    (projects / "-some-project" / f"{OLD}.jsonl").write_text("{}\n", encoding="utf-8")
    work = tmp_path / "work dir"
    work.mkdir(exist_ok=True)
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(tmp_path), "CALLS": str(tmp_path / "calls"),
           "OBS_AGENT_TERMINAL_STATE_DIR": str(tmp_path / "state"),
           "OBS_AGENT_TERMINAL_CLAUDE_PROJECTS_DIR": str(projects),
           "OBS_AGENT_TERMINAL_NO_SHELL": "1", "OBS_AGENT_TERMINAL_ARGS_DIR": str(tmp_path / "args")}
    return env, work


def run(tmp_path, *args):
    env, work = _env(tmp_path)
    subprocess.run(["zsh", str(SCRIPT), *args], cwd=work, env=env, check=True,
                   capture_output=True, timeout=20)
    calls = (tmp_path / "calls").read_text(encoding="utf-8").splitlines()
    return [c.split("\x1f") for c in calls]


def _tail(argv):
    """Arguments after the common flags (extra ones from settings, --settings …)."""
    i = argv.index("--settings")
    return argv[i + 2:]


def test_seed_resume_then_registry_wins(tmp_path):
    first = run(tmp_path, "claude", "inst-1", "resume", OLD)[-1]
    assert _tail(first) == ["--resume", OLD]
    # The hook recorded a different session in the tab, so a restart resumes it, not the initial one.
    (tmp_path / "projects" / "-some-project" / f"{NEW}.jsonl").write_text("{}\n", encoding="utf-8")
    env, work = _env(tmp_path)
    subprocess.run(["zsh", "-c", f'source "{SCRIPTS}/agent-registry-lib.zsh"; '
                    f'upsert_resume_id claude inst-1 {NEW}'], cwd=work, env=env, check=True)
    again = run(tmp_path, "claude", "inst-1", "resume", OLD)[-1]
    assert _tail(again) == ["--resume", NEW]


def test_seed_new_passes_first_prompt_once(tmp_path):
    call = run(tmp_path, "claude", "inst-2", "new", NEW, "- сделай отчёт «x» $HOME `id`")[-1]
    assert _tail(call) == ["--session-id", NEW, "- сделай отчёт «x» $HOME `id`"]
    # No transcript yet (session closed right away): a restart starts a new one without repeating the prompt.
    again = run(tmp_path, "claude", "inst-2", "new", NEW, "первый запрос")[-1]
    assert _tail(again)[0] == "--session-id" and "первый запрос" not in again


def test_fork_seed_forks(tmp_path):
    assert _tail(run(tmp_path, "claude", "inst-3", "resume-fork", OLD)[-1]) == \
        ["--resume", OLD, "--fork-session"]


def test_missing_seed_session_starts_fresh(tmp_path):
    call = run(tmp_path, "claude", "inst-4", "resume", NEW)[-1]      # no such transcript
    assert _tail(call)[0] == "--session-id" and _tail(call)[1] != NEW


def test_ribbon_tab_without_seed_starts_a_new_session(tmp_path):
    call = run(tmp_path, "claude", "inst-5")[-1]
    assert call[0] == "--settings" and _tail(call)[0] == "--session-id"      # no extra flags


def test_extra_args_come_from_settings_file_without_expansion(tmp_path):
    (tmp_path / "args").mkdir()
    (tmp_path / "args" / "claude").write_text("--chrome --channels 'plugin:a b' $HOME `id`\n", encoding="utf-8")
    call = run(tmp_path, "claude", "inst-9")[-1]
    assert call[:5] == ["--chrome", "--channels", "plugin:a b", "$HOME", "`id`"]


def test_hook_is_passed_as_settings_and_is_valid_json(tmp_path):
    call = run(tmp_path, "claude", "inst-6", "resume", OLD)[-1]
    settings = json.loads(call[call.index("--settings") + 1])
    for event in ("SessionStart", "UserPromptSubmit"):
        command = settings["hooks"][event][0]["hooks"][0]["command"]
        assert command == f'"{SCRIPTS}/agent-session-hook.zsh"'


def test_bad_start_mode_is_refused(tmp_path):
    env, work = _env(tmp_path)
    r = subprocess.run(["zsh", str(SCRIPT), "claude", "inst-7", "exec", OLD], cwd=work, env=env,
                       capture_output=True, timeout=20)
    assert r.returncode == 64 and not (tmp_path / "calls").exists()


def test_registry_without_transcript_starts_fresh_not_the_seed(tmp_path):
    env, work = _env(tmp_path)
    subprocess.run(["zsh", "-c", f'source "{SCRIPTS}/agent-registry-lib.zsh"; '
                    f'upsert_resume_id claude inst-8 {NEW}'], cwd=work, env=env, check=True)
    call = run(tmp_path, "claude", "inst-8", "resume", OLD)[-1]       # NEW has no transcript
    assert _tail(call)[0] == "--session-id" and OLD not in call


def test_terminal_modes_are_reset_after_the_agent_exits(tmp_path):
    """The agent exited without releasing the mouse; the script turns it off, otherwise selection is dead."""
    env, work = _env(tmp_path)
    out = subprocess.run(["zsh", str(SCRIPT), "claude", "inst-modes", "new", NEW], cwd=work, env=env,
                         check=True, capture_output=True, timeout=20).stdout
    for mode in (b"1000l", b"1002l", b"1003l", b"1006l", b"2004l"):
        assert b"\x1b[?" + mode in out, mode
