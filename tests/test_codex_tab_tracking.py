"""Codex tab: the registry follows the thread the tab's codex holds open, and Copy session forks.

Codex gets no hook in the tab. It keeps every rollout it opened in the process open (seen on
codex-cli 0.167: /new, /resume and /fork add one, none is closed), so the tab script reads the open
rollouts of its own codex: one opened since the last look is the switch, otherwise the one written
last. The stand-in codex is a Python process named `codex` that opens and writes rollouts on cue.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from pathlib import Path

import pytest

from tests import test_agent_script_sessions as sessions
from tests.conftest import cx_meta_current
from tests.test_agent_script_sessions import OTHER, SCRIPT, STUB, TID, _rollout

tab = sessions.tab                    # the same fixture: stub agents, temp homes and registry

THIRD = "01a10b58-0000-7000-8000-000000000003"
SUB = "01a10b59-0000-7000-8000-000000000004"

# Opens and writes rollouts as the plan says: "open <path>", "write <path>", "sleep <seconds>",
# "spawn <path>" (a `codex exec` holding its own rollout, as a command the agent runs would).
# zsh, because Homebrew's Python re-executes itself and loses the name `codex`.
HOLDER = r'''
local step verb arg fd
local -a kids
for step in ${(s:;:)CODEX_PLAN}; do
  step="${step## }" verb="${step%% *}" arg="${step#* }"
  case "$verb" in
    open) exec {fd}>>"$arg" ;;
    write) print '{}' >> "$arg" ;;
    sleep) sleep "$arg" ;;
    spawn) /bin/bash -c 'exec -a "codex exec" sleep 30 < "$0"' "$arg" & kids+=($!) ;;
  esac
done
(( ${#kids} )) && kill "${kids[@]}"
:
'''


def _meta(thread_id: str, cwd: str, **extra) -> str:
    rec = json.loads(cx_meta_current(thread_id, cwd))
    rec["payload"].update(extra)
    return json.dumps(rec, separators=(",", ":")) + "\n"


def _holder(tab, plan: str) -> None:
    bin_dir = Path(tab["env"]["PATH"].split(":")[0])
    (bin_dir / "holder.zsh").write_text(HOLDER, encoding="utf-8")
    (bin_dir / "codex").write_text(
        STUB + f'exec -a codex /bin/zsh -c "source {bin_dir / "holder.zsh"}; :"\n', encoding="utf-8")
    tab["env"].update(CODEX_PLAN=plan, OBS_AGENT_CODEX_TRACK_EVERY="0.2")


def _registry(tab, instance: str) -> list[str]:
    rows = (tab["state"] / "resume.tsv").read_text(encoding="utf-8").splitlines()
    return [r.split("\t")[2] for r in rows if r.split("\t")[:2] == ["codex", instance]]


def _watch(tab, instance: str, *seed, timeout=40) -> list[str]:
    """Every id the tab's registry entry held while the tab ran, in order."""
    proc = subprocess.Popen(["zsh", str(SCRIPT), "codex", instance, *seed], cwd=tab["work"], env=tab["env"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    seen: list[str] = []
    end = time.monotonic() + timeout
    while proc.poll() is None and time.monotonic() < end:
        now = _registry(tab, instance) if (tab["state"] / "resume.tsv").exists() else []
        if now and (not seen or seen[-1] != now[-1]):
            seen.append(now[-1])
        time.sleep(0.05)
    proc.wait(timeout=10)
    now = _registry(tab, instance)
    if now and (not seen or seen[-1] != now[-1]):
        seen.append(now[-1])
    return seen


def test_new_and_resume_inside_the_tab_move_the_registry(tab):
    """/new then /resume back: the thread opened last wins, then the one written after the switch."""
    a = _rollout(tab["codex"], TID, _meta(TID, str(tab["work"])))
    b = _rollout(tab["codex"], OTHER, _meta(OTHER, str(tab["work"])), day="2026/10/06")
    _holder(tab, f"open {a}; sleep 1.2; open {b}; write {b}; sleep 1.2; write {a}; sleep 1.2")
    assert _watch(tab, "cx-t1", "resume", TID) == [TID, OTHER, TID]


def test_resume_of_an_older_thread_moves_the_registry_before_any_prompt(tab):
    """/resume opens the older rollout and writes nothing to it until the next prompt."""
    b = _rollout(tab["codex"], OTHER, _meta(OTHER, str(tab["work"])), day="2026/10/06")
    a = _rollout(tab["codex"], TID, _meta(TID, str(tab["work"])))
    os.utime(a, (time.time() - 86400, time.time() - 86400))
    _holder(tab, f"open {b}; write {b}; sleep 1.2; open {a}; sleep 1.5")
    assert _watch(tab, "cx-t6", "resume", OTHER) == [OTHER, TID]


def test_a_copy_made_inside_the_tab_is_recorded(tab):
    a = _rollout(tab["codex"], TID, _meta(TID, str(tab["work"])))
    fork = _rollout(tab["codex"], THIRD, _meta(THIRD, str(tab["work"]), forked_from_id=TID))
    _holder(tab, f"open {a}; sleep 1.2; open {fork}; sleep 1.2")
    assert _watch(tab, "cx-t2", "resume", TID) == [TID, THIRD]


def test_subagent_threads_and_nested_codex_runs_are_never_the_tab_thread(tab):
    a = _rollout(tab["codex"], TID, _meta(TID, str(tab["work"])))
    sub = _rollout(tab["codex"], SUB, _meta(SUB, str(tab["work"]), thread_source="subagent",
                                            source={"subagent": {"thread_spawn": {"parent_thread_id": TID}}}))
    nested = _rollout(tab["codex"], OTHER, _meta(OTHER, str(tab["work"])), day="2026/10/06")
    _holder(tab, f"open {a}; sleep 0.8; open {sub}; write {sub}; spawn {nested}; sleep 1.5")
    assert _watch(tab, "cx-t3", "resume", TID) == [TID]


def test_a_fresh_tab_records_its_first_thread_while_codex_runs(tab):
    new = _rollout(tab["codex"], THIRD, _meta(THIRD, str(tab["work"])))
    _holder(tab, f"sleep 0.6; open {new}; write {new}; sleep 1.5")
    assert _watch(tab, "cx-t4")[-1] == THIRD


def test_tracker_stops_with_codex(tab):
    a = _rollout(tab["codex"], TID, _meta(TID, str(tab["work"])))
    _holder(tab, f"open {a}; sleep 0.6")
    tab["env"]["OBS_AGENT_CODEX_TRACK_EVERY"] = "4"      # a lone tracker would outlive the check
    instance = f"cx-t5-{uuid.uuid4().hex[:12]}"
    tab["run"]("codex", instance, "resume", TID)
    table = subprocess.run(["ps", "-axo", "command="], capture_output=True, text=True).stdout
    left = [line for line in table.splitlines() if SCRIPT.name in line and instance in line]
    assert not left, f"the tracker outlived the tab's codex: {left}"


def test_commands_codex_runs_never_see_the_tab_as_theirs(tab):
    """A Claude Code that Codex starts as a command would record its session as this tab's."""
    _rollout(tab["codex"], TID, _meta(TID, str(tab["work"])))
    seen = Path(tab["env"]["CALLS"]).with_name("env")
    (Path(tab["env"]["PATH"].split(":")[0]) / "codex").write_text(
        STUB + f'print -r -- "kind=${{OBS_AGENT_KIND-}} instance=${{OBS_AGENT_INSTANCE-}}" > "{seen}"\n',
        encoding="utf-8")
    tab["run"]("codex", "cx-e1", "resume", TID)
    assert seen.read_text(encoding="utf-8").strip() == "kind= instance="


# --- Copy session: `codex fork <id>` ---------------------------------------------------------------

def test_copy_start_forks_and_records_the_copy(tab):
    _rollout(tab["codex"], TID, _meta(TID, str(tab["work"])))
    line = _meta(THIRD, str(tab["work"]), forked_from_id=TID).strip().replace("'", "")
    (Path(tab["env"]["PATH"].split(":")[0]) / "codex").write_text(
        STUB + 'd="$CODEX_HOME/sessions/2026/11/13"; mkdir -p "$d"\n'
        f"print -r -- '{line}' > \"$d/rollout-2026-11-13T11-08-50-{THIRD}.jsonl\"\n", encoding="utf-8")
    call, _ = tab["run"]("codex", "cx-f1", "resume-fork", TID)
    assert call == ["fork", TID]
    assert _registry(tab, "cx-f1")[-1] == THIRD


def test_copy_of_a_running_thread_does_not_ask_to_end_it(tab):
    """A copy is a new thread: the source may stay open in its own tab."""
    path = _rollout(tab["codex"], TID, _meta(TID, str(tab["work"])))
    holder = subprocess.Popen(["/bin/bash", "-c", 'exec -a codex sleep 60 < "$1"', "x", str(path)])
    try:
        time.sleep(0.3)
        call, _ = tab["run"]("codex", "cx-f2", "resume-fork", TID)
        assert call == ["fork", TID] and holder.poll() is None
    finally:
        holder.kill()
        holder.wait()


@pytest.mark.parametrize("missing", ["01a10b5a-0000-7000-8000-000000000009"])
def test_copy_of_a_missing_thread_starts_nothing_of_it(tab, missing):
    assert tab["run"]("codex", "cx-f3", "resume-fork", missing)[0] == [""]
