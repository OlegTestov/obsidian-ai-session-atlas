"""Live probe of the agent tab script: does a tab opened from the catalog resume the right session, fast?

Runs obsidian-plugin/scripts/agent-resume-terminal.zsh itself in a pty, as the plugin's tab does,
against temp CODEX_HOME / CLAUDE_CONFIG_DIR and a local stand-in API (tools/probe_xresume.py):

  1. "Resume with… → Codex": a Claude Code session converted by atlas/convert.py, in a Codex home that
     also holds thousands of large rollouts; the tab must resume the copy, not start a new thread.
  2. A rollout codex-cli itself wrote (its current format) in a folder outside the vault.
  3. "Resume with… → Claude Code": the converted copy of a Codex thread.
  4. A Claude Code session running in a background job (`claude --bg`): the tab attaches to it.

Each resumed session gets one typed prompt; the request it sends must carry the session's history.
Nothing touches ~/.claude or ~/.codex, no model is called; the temp Claude daemon is stopped at the end.

    python3.11 tools/probe_tab_resume.py [--rollouts 2000] [--keep]
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
from tools.probe_xresume import ASK, KEY, check, drive, history_request, standin  # noqa: E402

SCRIPT = os.path.join(REPO, "obsidian-plugin", "scripts", "agent-resume-terminal.zsh")
FAST_S = 3.0


def filler(codex_home: str, count: int) -> None:
    """Rollouts as a machine in use has them: large session_meta lines, a day folder each."""
    meta = json.dumps({"timestamp": "2026-01-01T00:00:00.000Z", "ordinal": 0, "type": "session_meta",
                       "payload": {"creator_user_id": "u", "session_id": "x", "id": "x", "cwd": "/elsewhere",
                                   "base_instructions": {"text": "FILLER " * 4000}}}, separators=(",", ":"))
    for i in range(count):
        day = os.path.join(codex_home, "sessions", "2026", f"{1 + i % 12:02d}", f"{1 + i % 28:02d}")
        os.makedirs(day, exist_ok=True)
        with open(os.path.join(day, f"rollout-2026-01-01T00-00-00-01a00000-0000-7000-8000-{i:012d}.jsonl"), "w") as fh:
            fh.write(meta + "\n")


def tab(app: str, instance: str, seed: list[str], env: dict, cwd: str, requests: list, wanted: str) -> dict:
    marks = {wanted: None, "Starting Codex terminal": None, "Starting Claude Code session": None}
    first = len(requests)
    screen = drive(["zsh", SCRIPT, app, instance, *seed], env, cwd, requests, timeout=90, marks=marks)
    assert marks[wanted] is not None, f"{instance}: the script did not print {wanted!r}:\n{screen[-800:]}"
    assert marks["Starting Claude Code session"] is None, f"{instance}: a fresh session was started"
    try:
        body = history_request(requests[first:])["body"]
    except SystemExit:
        print(screen[-1500:])
        raise
    # Claude Code also sends side requests with the prompt alone (a title): any one with both counts.
    bodies = [json.dumps(r["body"]) for r in requests[first:] if ASK in json.dumps(r["body"])]
    return {"screen": screen, "at": marks[wanted], "body": body, "bodies": bodies}


def stop_daemon(env: dict, root: str, job: str | None) -> None:
    """The temp homes' daemons only: the probe's Claude daemon folder is read off its job's pty host
    before the job stops (the user's own daemon runs beside it)."""
    ps = ["ps", "-axo", "pid=,command="]
    table = subprocess.run(ps, capture_output=True, text=True).stdout
    dirs = set(re.findall(r"/tmp/cc-daemon-\d+/[0-9a-f]+/", "\n".join(
        line for line in table.splitlines() if job and f"/pty/{job}.sock" in line)))
    if job:
        subprocess.run(["claude", "stop", job], env=env, capture_output=True, timeout=60)
        time.sleep(1)
    for _ in range(3):          # a dying daemon may still start a spare: look again
        table = subprocess.run(ps, capture_output=True, text=True).stdout
        for line in table.splitlines():
            pid, _, command = line.strip().partition(" ")
            if root in command or any(d in command for d in dirs):
                with contextlib.suppress(ProcessLookupError, ValueError):
                    os.kill(int(pid), signal.SIGTERM)
        time.sleep(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rollouts", type=int, default=2000)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    root = os.path.realpath(tempfile.mkdtemp(prefix="atlas-tab-"))
    work, other, claude_home, codex_home, state = (os.path.join(root, n) for n in
                                                  ("work", "other", "claude", "codex", "state"))
    for d in (work, other, claude_home, codex_home, os.path.join(root, "args")):
        os.makedirs(d)
    os.environ.update(ATLAS_HOME=os.path.join(root, "atlas"), ATLAS_PROJECTS_ROOT=os.path.join(claude_home, "projects"),
                      ATLAS_CODEX_HOME=codex_home, CODEX_HOME=codex_home, CLAUDE_CONFIG_DIR=claude_home,
                      ATLAS_CLAUDE_SESSIONS=os.path.join(claude_home, "sessions"))
    from atlas import convert, db, index
    from tests import xresume_corpus as corpus

    requests: list = []
    server = standin(requests)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    with open(os.path.join(claude_home, ".claude.json"), "w") as fh:
        json.dump({"hasCompletedOnboarding": True, "theme": "dark", "numStartups": 5,
                   "customApiKeyResponses": {"approved": [KEY[-20:]], "rejected": []},
                   "projects": {d: {"hasTrustDialogAccepted": True} for d in (work, other)}}, fh)
    with open(os.path.join(codex_home, "config.toml"), "w") as fh:
        fh.write(f'model = "gpt-5.1"\nmodel_provider = "probe"\ncheck_for_update_on_startup = false\n\n'
                 f'[model_providers.probe]\nname = "probe"\nbase_url = "{base}/v1"\nwire_api = "responses"\n'
                 f'env_key = "ATLAS_PROBE_KEY"\n\n[projects."{work}"]\ntrust_level = "trusted"\n'
                 f'\n[projects."{other}"]\ntrust_level = "trusted"\n')
    # The tab's extra agent arguments, as the plugin's settings write them.
    with open(os.path.join(root, "args", "claude"), "w") as fh:
        fh.write("--model haiku\n")
    with open(os.path.join(root, "args", "codex"), "w") as fh:
        fh.write("--no-alt-screen\n")
    clean = {k: os.environ[k] for k in ("HOME", "PATH", "USER", "SHELL") if k in os.environ}
    clean.update(TERM="xterm-256color", LANG="en_US.UTF-8", CODEX_HOME=codex_home, CLAUDE_CONFIG_DIR=claude_home,
                 ATLAS_PROBE_KEY="dummy", ANTHROPIC_BASE_URL=base, ANTHROPIC_API_KEY=KEY,
                 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1", DISABLE_AUTOUPDATER="1",
                 OBS_AGENT_TERMINAL_STATE_DIR=state, OBS_AGENT_TERMINAL_NO_SHELL="1",
                 OBS_AGENT_TERMINAL_ARGS_DIR=os.path.join(root, "args"))
    job = None
    try:
        corpus.write_claude(os.path.join(claude_home, "projects"), work)
        corpus.write_codex(codex_home, work)
        # A thread codex-cli writes itself, in its current format, for another folder.
        subprocess.run(["codex", "exec", "--skip-git-repo-check", "GENUINE-THREAD-MARKER hello"], cwd=other,
                       capture_output=True, stdin=subprocess.DEVNULL, timeout=120, env=clean)
        genuine = [n for n in os.listdir(os.path.join(codex_home, "sessions", *time.strftime("%Y/%m/%d").split("/")))
                   if n.startswith("rollout-")]
        assert len(genuine) == 1, genuine
        with open(os.path.join(codex_home, "sessions", *time.strftime("%Y/%m/%d").split("/"), genuine[0])) as fh:
            head = fh.readline()
        genuine_id = genuine[0][-42:-6]
        print(f"genuine rollout head: {head[:60]}… payload keys start "
              f"{list(json.loads(head)['payload'])[:4]}")
        filler(codex_home, args.rollouts)
        conn = db.connect()
        index.index_all(conn)
        to_codex = convert.resume_with(conn, corpus.CLAUDE_ID, "codex")
        to_claude = convert.resume_with(conn, corpus.CODEX_ID, "claude")

        r = tab("codex", "probe-codex-1", ["resume", to_codex["session_id"]], clean, to_codex["cwd"], requests,
                f"Resuming Codex session: {to_codex['session_id']}")
        check("tab → converted Codex", r["body"], corpus)
        print(f"  resumed after {r['at']} s with {args.rollouts} other rollouts")
        assert r["at"] < FAST_S, r["at"]

        # The tab opens in the thread's own folder, as the catalog's command says (`cd <cwd> && …`).
        r = tab("codex", "probe-codex-2", ["resume", genuine_id], clean, other, requests,
                f"Resuming Codex session: {genuine_id}")
        assert "GENUINE-THREAD-MARKER" in json.dumps(r["body"]), "the genuine thread's history is not in the request"
        print(f"tab → codex-cli's own rollout (outside the vault): resumed after {r['at']} s, history sent")

        r = tab("claude", "probe-claude-1", ["resume", to_claude["session_id"]], clean, to_claude["cwd"], requests,
                f"Resuming Claude Code session: {to_claude['session_id']}")
        check("tab → converted Claude Code", r["body"], corpus)

        out = subprocess.run(["claude", "--bg", "--model", "haiku", "BG-JOB-MARKER say hi"], cwd=work, env=clean,
                             capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL).stdout
        job = re.search(r"claude attach ([0-9a-f]{8})", out).group(1)
        time.sleep(3)
        sessions = os.path.join(claude_home, "sessions")
        files = []
        for name in (n for n in os.listdir(sessions) if n.endswith(".json")):
            with open(os.path.join(sessions, name)) as fh:
                files.append(json.load(fh))
        job_sid = next(d["sessionId"] for d in files if d.get("jobId") == job and not d.get("spare"))
        r = tab("claude", "probe-claude-2", ["resume", job_sid], clean, work, requests,
                f"Attaching to Claude Code background session: {job}")
        assert any("BG-JOB-MARKER" in b for b in r["bodies"]), "the job's history is not in the request"
        with open(os.path.join(state, "resume.tsv")) as fh:
            assert f"claude\tprobe-claude-2\t{job_sid}\t" in fh.read()
        print(f"tab → running background job {job}: attached after {r['at']} s, the job took the prompt")
        return 0
    finally:
        server.shutdown()
        stop_daemon(clean, root, job)
        if args.keep:
            print("kept:", root)
        else:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
