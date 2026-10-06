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
    stub.write_text('#!/bin/zsh\n[[ "$1" == --help ]] && exit 0\nprint -r -- "${(pj:\\x1f:)@}" >> "$CALLS"\n',
                    encoding="utf-8")
    stub.chmod(0o755)
    projects = tmp_path / "projects"
    (projects / "-some-project").mkdir(parents=True, exist_ok=True)
    (projects / "-some-project" / f"{OLD}.jsonl").write_text("{}\n",
                    encoding="utf-8")
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
    (tmp_path / "projects" / "-some-project" / f"{NEW}.jsonl").write_text("{}\n",
                    encoding="utf-8")
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
    (tmp_path / "args" / "claude").write_text("--chrome --channels 'plugin:a b' $HOME `id`\n",
                    encoding="utf-8")
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


def test_codex_tab_finds_sessions_in_a_moved_codex_home(tmp_path):
    """CODEX_HOME moves Codex's data; the tab script looks there, not in ~/.codex."""
    env, work = _env(tmp_path)
    stub = tmp_path / "bin" / "codex"
    stub.write_text('#!/bin/zsh\n[[ "$1" == --help ]] && exit 0\nprint -r -- "${(pj:\\x1f:)@}" >> "$CALLS"\n',
                    encoding="utf-8")
    stub.chmod(0o755)
    moved = tmp_path / "elsewhere" / "codex"
    day = moved / "sessions" / "2026" / "09" / "01"
    day.mkdir(parents=True)
    meta = {"type": "session_meta", "payload": {"id": NEW, "cwd": str(work)}}
    (day / f"rollout-2026-09-01T10-00-00-{NEW}.jsonl").write_text(json.dumps(meta, separators=(",", ":")) + "\n",
                                                                  encoding="utf-8")
    env["CODEX_HOME"] = str(moved)
    subprocess.run(["zsh", str(SCRIPT), "codex", "codex-tab-1", "resume", NEW], cwd=work, env=env,
                   check=True, capture_output=True, timeout=20)
    calls = [c.split("\x1f") for c in (tmp_path / "calls").read_text(encoding="utf-8").splitlines()]
    assert calls and calls[-1][-2:] == ["resume", NEW]


def _codex_stub(tmp_path, env, work):
    """codex records its arguments and, like the real one, writes a rollout for the thread it starts."""
    home = tmp_path / "codex-home"
    env["CODEX_HOME"] = str(home)
    stub = tmp_path / "bin" / "codex"
    stub.write_text(
        '#!/bin/zsh\n[[ "$1" == --help ]] && exit 0\nprint -r -- "${(pj:\\x1f:)@}" >> "$CALLS"\n'
        'd="$CODEX_HOME/sessions/2026/10/03"; mkdir -p "$d"\n'
        f'print -r -- \'{{"timestamp":"t","type":"session_meta","payload":{{"id":"{NEW}","cwd":"\'"$PWD"\'"}}}}\' '
        f'> "$d/rollout-2026-10-03T10-00-00-{NEW}.jsonl"\n',
                    encoding="utf-8")
    stub.chmod(0o755)


def _codex_run(tmp_path, *args):
    env, work = _env(tmp_path)
    _codex_stub(tmp_path, env, work)
    # The thread watcher runs in the background and would hold a captured stdout open.
    subprocess.run(["zsh", str(SCRIPT), "codex", *args], cwd=work, env=env, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
    calls = [c.split("\x1f") for c in (tmp_path / "calls").read_text(encoding="utf-8").splitlines()]
    registry = (tmp_path / "state" / "resume.tsv").read_text(encoding="utf-8")
    return calls, registry


def test_codex_new_starts_with_the_first_prompt_and_records_the_thread(tmp_path):
    prompt = "Прочитай /h/launch-x.md и продолжи; $HOME `id` «x»"
    calls, registry = _codex_run(tmp_path, "codex-tab-2", "new", "", prompt)
    assert calls == [[prompt]]
    assert f"codex\tcodex-tab-2\t{NEW}\t" in registry
    # After a restart the tab resumes the recorded thread; the prompt is not sent again.
    calls, _ = _codex_run(tmp_path, "codex-tab-2", "new", "", prompt)
    assert calls[-1] == ["resume", NEW]


def test_codex_new_prompt_never_becomes_a_flag(tmp_path):
    calls, _ = _codex_run(tmp_path, "codex-tab-3", "new", "", "--yolo")
    assert calls == [[" --yolo"]]


def test_codex_new_without_a_thread_does_not_repeat_the_prompt(tmp_path):
    """No thread was recorded (Codex quit at once): a restart opens a bare Codex, not the prompt again."""
    env, work = _env(tmp_path)
    stub = tmp_path / "bin" / "codex"
    stub.write_text('#!/bin/zsh\n[[ "$1" == --help ]] && exit 0\nprint -r -- "${(pj:\\x1f:)@}" >> "$CALLS"\n',
                    encoding="utf-8")
    stub.chmod(0o755)
    env["CODEX_HOME"] = str(tmp_path / "codex-home")
    for _ in range(2):
        subprocess.run(["zsh", str(SCRIPT), "codex", "codex-tab-4", "new", "", "сделай отчёт"], cwd=work,
                       env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
    calls = (tmp_path / "calls").read_text(encoding="utf-8").splitlines()
    assert calls == ["сделай отчёт", ""]


def test_codex_new_without_a_prompt_is_a_bare_codex(tmp_path):
    calls, _ = _codex_run(tmp_path, "codex-tab-5", "new", "")
    assert calls == [[""]]
