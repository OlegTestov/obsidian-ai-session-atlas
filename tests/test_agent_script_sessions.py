"""Agent tab script: finding the session to resume in the agents' real current formats.

Codex rollouts are looked up by file name (rollout-<time>-<thread id>.jsonl), in any folder and in
archived_sessions; a Claude Code session parked in a background job opens with `claude attach`.
The agents are stubs that record their arguments; homes, registry and working folder are temporary.
"""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from atlas import convert_write
from tests.conftest import cx, cx_meta_current, rec

SCRIPTS = Path(__file__).resolve().parent.parent / "obsidian-plugin" / "scripts"
SCRIPT = SCRIPTS / "agent-resume-terminal.zsh"
TID = "01a10b52-ae81-779d-8311-cc151b1e5634"
OTHER = "01a10b55-a179-7ab2-acc6-8aa1f5b5ce3b"
PARENT = "aaaaaaaa-1111-4111-8111-111111111111"
JOB_SID = "eeeeeeee-2222-4222-8222-222222222222"
JOB = "eeeeeeee"
STUB = '#!/bin/zsh\nprint -r -- "${(pj:\\x1f:)@}" >> "$CALLS"\n'


@pytest.fixture
def tab(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name in ("claude", "codex"):
        (bin_dir / name).write_text(STUB, encoding="utf-8")
        (bin_dir / name).chmod(0o755)
    work = tmp_path / "work dir"
    work.mkdir()
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(tmp_path / "home"),
           "CALLS": str(tmp_path / "calls"), "OBS_AGENT_TERMINAL_STATE_DIR": str(tmp_path / "state"),
           "OBS_AGENT_TERMINAL_NO_SHELL": "1", "OBS_AGENT_TERMINAL_ARGS_DIR": str(tmp_path / "args"),
           "CODEX_HOME": str(tmp_path / "codex"), "CLAUDE_CONFIG_DIR": str(tmp_path / "claude")}

    def run(*args, timeout=20):
        started = time.monotonic()
        subprocess.run(["zsh", str(SCRIPT), *args], cwd=work, env=env, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=timeout)
        calls = (tmp_path / "calls").read_text(encoding="utf-8").splitlines()
        return [c.split("\x1f") for c in calls][-1], time.monotonic() - started

    return {"run": run, "env": env, "work": work, "codex": tmp_path / "codex",
            "claude": tmp_path / "claude", "state": tmp_path / "state"}


def _rollout(codex: Path, thread_id: str, lines: str, day="2026/10/05", archived=False) -> Path:
    folder = codex / "archived_sessions" if archived else codex / "sessions" / day
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"rollout-{day.replace('/', '-')}T11-08-50-{thread_id}.jsonl"
    path.write_text(lines, encoding="utf-8")
    return path


def _current(thread_id: str, cwd: str) -> str:
    return cx_meta_current(thread_id, cwd) + cx("event_msg", {"type": "task_started", "turn_id": "t1"})


# --- Codex ---------------------------------------------------------------------------------------

def test_current_codex_rollout_resumes_in_any_folder(tab):
    """codex-cli 0.160: payload opens with creator_user_id, the session ran outside the tab's folder."""
    _rollout(tab["codex"], TID, _current(TID, "/Users/u/Code/elsewhere"))
    call, _ = tab["run"]("codex", "cx-1", "resume", TID)
    assert call == ["resume", TID]


def test_converted_rollout_from_atlas_resumes(tab):
    at = datetime(2026, 10, 5, 9, 8, 50, tzinfo=timezone.utc)
    path = convert_write.codex_path(str(tab["codex"]), TID, at)
    convert_write.write_new(path, convert_write.codex_records(
        [("user", "вопрос", None), ("assistant", "ответ", None)], TID, str(tab["work"]), at))
    call, _ = tab["run"]("codex", "cx-2", "resume", TID)
    assert call == ["resume", TID]


def test_archived_rollout_resumes(tab):
    _rollout(tab["codex"], TID, _current(TID, str(tab["work"])), archived=True)
    assert tab["run"]("codex", "cx-3", "resume", TID)[0] == ["resume", TID]


def test_missing_thread_starts_a_bare_codex_not_another_thread(tab):
    _rollout(tab["codex"], OTHER, _current(OTHER, str(tab["work"])))
    assert tab["run"]("codex", "cx-4", "resume", TID)[0] == [""]


def test_resume_does_not_read_every_rollout(tab):
    """A home with thousands of large rollouts: the old script read each first line (a minute)."""
    big = _current(OTHER, "/x") * 3
    for i in range(2500):
        _rollout(tab["codex"], f"01a10b52-0000-7000-8000-{i:012d}", big, day=f"2026/{1 + i % 12:02d}/{1 + i % 28:02d}")
    _rollout(tab["codex"], TID, _current(TID, "/Users/u/Code/elsewhere"), day="2026/03/09")
    call, took = tab["run"]("codex", "cx-5", "resume", TID)
    assert call == ["resume", TID] and took < 5, took


def test_registry_thread_in_current_format_resumes_after_restart(tab):
    _rollout(tab["codex"], TID, _current(TID, "/Users/u/Code/elsewhere"))
    subprocess.run(["zsh", "-c", f'source "{SCRIPTS}/agent-registry-lib.zsh"; upsert_resume_id codex cx-6 {TID}'],
                   cwd=tab["work"], env=tab["env"], check=True)
    assert tab["run"]("codex", "cx-6", "new", "", "сделай отчёт")[0] == ["resume", TID]


# --- Claude Code ---------------------------------------------------------------------------------

def _transcript(claude: Path, sid: str, *records) -> None:
    folder = claude / "projects" / "-Users-u-Code-other"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{sid}.jsonl").write_text("".join(records) or "{}\n", encoding="utf-8")


def _proc_start(pid: int) -> str:
    out = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True,
                         env=dict(os.environ, TZ="UTC", LC_ALL="C")).stdout
    return " ".join(out.split())


@pytest.fixture
def job(tab):
    """A live background job: its process file (`kind: bg`, `jobId`) points at a running process."""
    proc = subprocess.Popen(["sleep", "60"])
    sessions = tab["claude"] / "sessions"
    sessions.mkdir(parents=True)

    def write(pid=proc.pid, started=None, sid=JOB_SID, job_id=JOB, **extra):
        started = _proc_start(proc.pid) if started is None else started
        data = dict({"pid": pid, "sessionId": sid, "cwd": "/Users/u/Code/other", "startedAt": 1,
                     "procStart": started, "version": "2.1.289",
                     "kind": "bg", "entrypoint": "cli", "jobId": job_id, "status": "busy"}, **extra)
        (sessions / f"{pid}.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    yield write
    proc.kill()
    proc.wait()


def test_claude_sessions_under_claude_config_dir_resume(tab):
    _transcript(tab["claude"], PARENT)
    assert tab["run"]("claude", "cl-1", "resume", PARENT)[0][-2:] == ["--resume", PARENT]


def test_running_job_attaches_instead_of_resume(tab, job):
    """Claude Code refuses `--resume` of a session running in the background."""
    _transcript(tab["claude"], JOB_SID)
    job()
    assert tab["run"]("claude", "cl-2", "resume", JOB_SID)[0] == ["attach", JOB]


def test_parent_whose_transcript_continued_in_a_running_job_attaches(tab, job):
    _transcript(tab["claude"], PARENT, rec(type="continued-in", sessionId=PARENT, continuedInSessionId=JOB_SID))
    _transcript(tab["claude"], JOB_SID)
    job()
    assert tab["run"]("claude", "cl-3", "resume", PARENT)[0] == ["attach", JOB]


def test_parked_parent_process_file_names_the_job(tab, job):
    _transcript(tab["claude"], PARENT)
    job()
    job(pid=1, sid=PARENT, job_id="", kind="interactive", parkedJobId=JOB, started="")
    assert tab["run"]("claude", "cl-4", "resume", PARENT)[0] == ["attach", JOB]


@pytest.mark.parametrize("kw", [{"pid": 999999}, {"started": "Thu Jan  1 00:00:00 2026"}, {"spare": True}],
                         ids=["dead", "pid-reused", "spare"])
def test_job_that_is_not_running_is_resumed(tab, job, kw):
    _transcript(tab["claude"], JOB_SID)
    job(**kw)
    assert tab["run"]("claude", "cl-5", "resume", JOB_SID)[0][-2:] == ["--resume", JOB_SID]


def test_fork_of_a_running_job_still_forks(tab, job):
    _transcript(tab["claude"], JOB_SID)
    job()
    assert tab["run"]("claude", "cl-6", "resume-fork", JOB_SID)[0][-3:] == ["--resume", JOB_SID, "--fork-session"]


def test_attach_seed_records_the_job_session_and_follows_it_after_restart(tab, job):
    _transcript(tab["claude"], JOB_SID)
    job()
    assert tab["run"]("claude", "cl-7", "attach", JOB)[0] == ["attach", JOB]
    assert f"claude\tcl-7\t{JOB_SID}\t" in (tab["state"] / "resume.tsv").read_text(encoding="utf-8")
    assert tab["run"]("claude", "cl-7", "attach", JOB)[0] == ["attach", JOB]     # still running
    for f in (tab["claude"] / "sessions").iterdir():
        f.unlink()                                                                  # the job ended
    assert tab["run"]("claude", "cl-7", "attach", JOB)[0][-2:] == ["--resume", JOB_SID]


@pytest.mark.parametrize("bad", ["eeeeeee", "eeeeeeeee", "EEEEEEEE", "../eeeee", "--help", JOB_SID])
def test_attach_takes_only_a_job_id(tab, bad):
    r = subprocess.run(["zsh", str(SCRIPT), "claude", "cl-8", "attach", bad], cwd=tab["work"], env=tab["env"],
                       capture_output=True, timeout=20)
    assert r.returncode == 64 and not Path(tab["env"]["CALLS"]).exists()


def test_attach_seed_of_a_job_that_ended_resumes_its_transcript(tab, job):
    _transcript(tab["claude"], JOB_SID)
    job(pid=999999)                                           # the file outlives the process
    assert tab["run"]("claude", "cl-9", "attach", JOB)[0][-2:] == ["--resume", JOB_SID]


def _codex_writes(tab, thread_id, cwd):
    """codex records its arguments and writes the rollout of the thread it starts, as 0.160 does."""
    line = cx_meta_current(thread_id, cwd).strip().replace("'", "")
    (Path(tab["env"]["PATH"].split(":")[0]) / "codex").write_text(
        STUB + 'd="$CODEX_HOME/sessions/2026/10/05"; mkdir -p "$d"\n'
        f"print -r -- '{line}' > \"$d/rollout-2026-10-05T11-08-50-{thread_id}.jsonl\"\n", encoding="utf-8")


def test_new_thread_in_this_folder_is_recorded(tab):
    _codex_writes(tab, TID, str(tab["work"]))
    tab["run"]("codex", "cx-7", "new", "", "сделай отчёт")
    assert f"codex\tcx-7\t{TID}\t" in (tab["state"] / "resume.tsv").read_text(encoding="utf-8")


def test_new_thread_of_another_folder_is_not_claimed(tab):
    """Another tab's Codex started a thread at the same moment, elsewhere: not this tab's."""
    _codex_writes(tab, OTHER, "/Users/u/Code/elsewhere")
    tab["run"]("codex", "cx-8", "new", "", "сделай отчёт")
    assert OTHER not in (tab["state"] / "resume.tsv").read_text(encoding="utf-8")


# --- a session already running in another process: the tab never starts a second one ---

def _run_out(tab, *args, answer):
    env = dict(tab["env"], OBS_AGENT_RUNNING_ANSWER=answer)
    out = subprocess.run(["zsh", str(SCRIPT), *args], cwd=tab["work"], env=env, capture_output=True,
                         text=True, timeout=20).stdout
    calls = Path(tab["env"]["CALLS"])
    return out, [c.split("\x1f") for c in calls.read_text(encoding="utf-8").splitlines()] if calls.exists() else []


@pytest.fixture
def running(tab):
    """An interactive Claude Code process in PARENT, started outside this tab (a terminal app)."""
    proc = subprocess.Popen(["sleep", "60"])
    # Reaped at once when it ends, as a process of another app is: a zombie still answers kill -0.
    threading.Thread(target=proc.wait, daemon=True).start()
    sessions = tab["claude"] / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    data = {"pid": proc.pid, "sessionId": PARENT, "cwd": "/Users/u/Code/other", "startedAt": 1,
            "procStart": _proc_start(proc.pid), "version": "2.1.289", "kind": "interactive",
            "entrypoint": "cli", "status": "idle"}
    (sessions / f"{proc.pid}.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    yield proc
    proc.kill()
    proc.wait()


def test_running_elsewhere_is_not_started_twice(tab, running):
    _transcript(tab["claude"], PARENT)
    out, calls = _run_out(tab, "claude", "cl-r1", "resume", PARENT, answer="n")
    assert "already running in another process" in out and f"pid {running.pid}" in out
    assert calls == []                              # no second claude on the same conversation
    assert running.poll() is None                   # and the other one is left alone


def test_running_elsewhere_taken_over_on_yes(tab, running):
    _transcript(tab["claude"], PARENT)
    _out, calls = _run_out(tab, "claude", "cl-r2", "resume", PARENT, answer="y")
    running.wait(timeout=5)                         # ended there first
    assert calls[-1][-2:] == ["--resume", PARENT]


def test_tab_restored_after_restart_checks_too(tab, running):
    """Obsidian brings the tab back by itself; its registry entry must not start a duplicate."""
    _transcript(tab["claude"], PARENT)
    sessions = tab["claude"] / "sessions"
    hidden = {p: p.read_text() for p in sessions.iterdir()}
    for p in hidden:
        p.unlink()                                  # first open: nothing else runs, the tab records it
    tab["run"]("claude", "cl-r3", "resume", PARENT)
    for p, text in hidden.items():
        p.write_text(text)
    Path(tab["env"]["CALLS"]).unlink()
    out, calls = _run_out(tab, "claude", "cl-r3", answer="n")
    assert "already running" in out and calls == []


def test_fork_of_a_running_session_still_forks(tab, running):
    _transcript(tab["claude"], PARENT)
    _out, calls = _run_out(tab, "claude", "cl-r4", "resume-fork", PARENT, answer="n")
    assert calls[-1][-3:] == ["--resume", PARENT, "--fork-session"]


def test_codex_thread_open_in_another_codex_is_not_resumed_twice(tab):
    path = _rollout(tab["codex"], TID, _current(TID, str(tab["work"])))
    holder = subprocess.Popen(["/bin/bash", "-c", 'exec -a codex sleep 60 < "$1"', "x", str(path)])
    try:
        time.sleep(0.3)
        out, calls = _run_out(tab, "codex", "cx-r1", "resume", TID, answer="n")
        assert "already running in another process" in out
        assert calls == []
    finally:
        holder.kill()
        holder.wait()
