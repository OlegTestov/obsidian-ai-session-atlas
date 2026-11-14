"""Codex approval waits outside tabs: the opt-in hook writes a mark, the card waits until the rollout
settles it (the call ran, was refused, the turn ended or moved on)."""
from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from atlas import codex_hook, codex_live, codex_procs, codex_tail, codex_waits, db
from tests.conftest import cx, cx_agent, cx_meta
from tests.test_codex_active import CODEX, TID, FakeLsof, _cards, table, turn

AT = "2026-09-01T10:00:40.000Z"
EVENT = {"hook_event_name": "PermissionRequest", "session_id": TID, "tool_name": "exec_command", "cwd": "/tmp",
         "model": "m", "permission_mode": "default", "tool_input": {"command": "rm -rf build"},
         "transcript_path": None, "turn_id": "t"}


@pytest.fixture(autouse=True)
def _fresh_caches():
    for cache in (codex_procs._map_cache, codex_procs._meta_cache, codex_procs._find_cache, codex_tail._cache):
        cache.clear()
    codex_live._last_live.clear()
    yield


@pytest.fixture
def claude_dir(tmp_path):
    folder = tmp_path / "claude-sessions"
    folder.mkdir()
    return folder


def _call(ts="2026-09-01T10:00:39.000Z"):
    return cx("response_item", {"type": "function_call", "name": "exec_command", "call_id": "c9",
                                "arguments": json.dumps({"cmd": "rm -rf build"})}, ts)


def _busy(write_rollout, *after):
    """A turn that started and asked to run a command; `after` = records written after the hook."""
    return write_rollout([cx_meta(TID), *turn(reply=None, done=False), _call(), *after], thread_id=TID)


def _card(atlas_env, claude_dir, path):
    cards = _cards(atlas_env, claude_dir, table((101, CODEX)), FakeLsof({101: [path]}))
    assert len(cards) == 1
    return cards[0]


def test_the_hook_writes_a_mark_and_nothing_else(tmp_path):
    home = tmp_path / "data folder"
    out = subprocess.run([sys.executable, codex_hook.__file__, str(home)], input=json.dumps(EVENT),
                         capture_output=True, text=True, timeout=30)
    assert out.returncode == 0 and out.stdout == "" and out.stderr == ""
    mark = json.loads((home / "codex-waits" / f"{TID}.json").read_text())
    assert mark["session_id"] == TID and mark["tool"] == "exec_command"
    assert "rm -rf" not in json.dumps(mark), "the command itself is not kept"
    assert len(mark["at"]) == len(AT) and mark["at"].endswith("Z")


def test_a_hook_turned_off_in_place_marks_nothing(tmp_path):
    # Off while a user's hook comes after it: the entry stays in hooks.json (trust is by position).
    (tmp_path / codex_hook.OFF_FLAG).write_text("off")
    out = subprocess.run([sys.executable, codex_hook.__file__, str(tmp_path)], input=json.dumps(EVENT),
                         capture_output=True, text=True, timeout=30)
    assert out.returncode == 0 and out.stdout == "" and not (tmp_path / "codex-waits").exists()


def test_the_hook_ignores_other_events_and_bad_input(tmp_path):
    for event in (dict(EVENT, hook_event_name="Stop"), dict(EVENT, session_id="../escaped"), "not json"):
        data = event if isinstance(event, str) else json.dumps(event)
        out = subprocess.run([sys.executable, codex_hook.__file__, str(tmp_path)], input=data,
                             capture_output=True, text=True, timeout=30)
        assert out.returncode == 0 and out.stdout == ""
    assert not (tmp_path / "codex-waits").exists() or not os.listdir(tmp_path / "codex-waits")
    assert not (tmp_path / "escaped.json").exists(), "a session id never leaves the marks folder"


def test_a_marked_busy_thread_waits_for_you(atlas_env, claude_dir, write_rollout):
    path = _busy(write_rollout, cx("event_msg", {"type": "token_count", "info": None}, "2026-09-01T10:00:41.000Z"))
    codex_hook.mark(db.atlas_home(), EVENT, at=AT)
    c = _card(atlas_env, claude_dir, path)
    assert (c["status"], c["activity"], c["waiting_for"], c["status_at"]) == \
        ("waiting", "waiting", "permission prompt", AT)


def test_without_the_hook_a_busy_thread_stays_busy(atlas_env, claude_dir, write_rollout):
    c = _card(atlas_env, claude_dir, _busy(write_rollout))
    assert (c["status"], c["waiting_for"], c["status_at"]) == ("busy", None, None)


def test_the_answer_in_the_rollout_ends_the_wait(atlas_env, claude_dir, write_rollout):
    for settled in (cx("response_item", {"type": "function_call_output", "call_id": "c9", "output": "ok"},
                       "2026-09-01T10:00:45.000Z"),
                    cx("event_msg", {"type": "turn_aborted", "reason": "interrupted"}, "2026-09-01T10:00:45.000Z"),
                    cx_agent("не буду", ts="2026-09-01T10:00:45.000Z")):
        codex_tail._cache.clear()
        path = _busy(write_rollout, settled)
        codex_hook.mark(db.atlas_home(), EVENT, at=AT)
        c = _card(atlas_env, claude_dir, path)
        assert c["status"] in ("busy", "idle") and c["waiting_for"] is None      # an abort ends the turn


def test_an_old_mark_before_a_new_request_does_not_count(atlas_env, claude_dir, write_rollout):
    """A mark from an earlier approval: the output after it settled it, the new call has no mark yet."""
    path = _busy(write_rollout, cx("response_item", {"type": "function_call_output", "call_id": "c9",
                                                     "output": "ok"}, "2026-09-01T10:00:45.000Z"),
                 _call("2026-09-01T10:00:50.000Z"))
    codex_hook.mark(db.atlas_home(), EVENT, at=AT)
    assert _card(atlas_env, claude_dir, path)["status"] == "busy"


def test_an_idle_thread_never_waits(atlas_env, claude_dir, write_rollout):
    path = write_rollout([cx_meta(TID), *turn()], thread_id=TID)
    codex_hook.mark(db.atlas_home(), EVENT, at="2026-09-01T11:00:00.000Z")
    assert _card(atlas_env, claude_dir, path)["status"] == "idle"


def test_waits_reads_only_the_tail(tmp_path):
    path = tmp_path / "r.jsonl"
    path.write_text(_call("2026-09-01T10:00:39.000Z") + "x" * (codex_waits.TAIL_BYTES + 10) + "\n"
                    + cx("event_msg", {"type": "token_count"}, "2026-09-01T10:00:41.000Z"))
    assert codex_waits._settled_after(str(path), AT) is False
    assert codex_waits._settled_after(str(tmp_path / "missing.jsonl"), AT) is True
