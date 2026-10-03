"""Moving a session into an Obsidian tab: only the right live process outside Obsidian is stopped."""
from __future__ import annotations

import json
import subprocess
import sys

import pytest

from atlas import active, relocate

ITERM = "/Applications/iTerm.app/Contents/MacOS/iTerm2"
OBSIDIAN = "/Applications/Obsidian.app/Contents/MacOS/Obsidian"
PROXY = "/opt/homebrew/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python pty.py"


@pytest.fixture
def child():
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    yield proc
    if proc.poll() is None:
        proc.kill()
    proc.wait()


def fake_table(child_pid, app_command):
    """A real table, but the process parents are a made-up app and a proxy."""
    def table_fn():
        table = dict(active.process_table())
        if child_pid in table:
            _, start, command = table[child_pid]
            table[child_pid] = (900001, start, command)
        table[900001] = (900002, "x", PROXY)
        table[900002] = (1, "x", app_command)
        return table
    return table_fn


def write_state(tmp_path, pid, session_id="sess-1", **extra):
    start = active.process_table()[pid][1]
    data = {"pid": pid, "sessionId": session_id, "kind": "interactive", "entrypoint": "cli",
            "procStart": start}
    data.update(extra)
    (tmp_path / f"{pid}.json").write_text(json.dumps(data), encoding="utf-8")


def test_host_app_is_the_topmost_app_not_the_pty_proxy(child):
    table = fake_table(child.pid, ITERM)()
    assert relocate.host_app(child.pid, table) == "iTerm"


def test_stops_the_session_outside_obsidian(tmp_path, child):
    write_state(tmp_path, child.pid)
    out = relocate.stop_for_move("sess-1", child.pid, sessions_dir=str(tmp_path),
                                 table_fn=fake_table(child.pid, ITERM))
    assert out["stopped"] and out["host_app"] == "iTerm"
    assert child.wait(timeout=5) != 0


@pytest.mark.parametrize("case", ["other-session", "obsidian", "headless", "bad-pid", "no-file"])
def test_refuses_and_does_not_touch_the_process(tmp_path, child, case):
    app = OBSIDIAN if case == "obsidian" else ITERM
    if case != "no-file":
        write_state(tmp_path, child.pid, entrypoint="sdk-cli" if case == "headless" else "cli")
    session = "sess-чужая" if case == "other-session" else "sess-1"
    pid = "123" if case == "bad-pid" else child.pid
    with pytest.raises(relocate.RelocateError):
        relocate.stop_for_move(session, pid, sessions_dir=str(tmp_path),
                               table_fn=fake_table(child.pid, app))
    assert child.poll() is None, "the process is untouched"


def test_reused_pid_is_not_killed(tmp_path, child):
    write_state(tmp_path, child.pid, procStart="Mon Jan  1 00:00:00 2024")
    with pytest.raises(relocate.RelocateError):
        relocate.stop_for_move("sess-1", child.pid, sessions_dir=str(tmp_path),
                               table_fn=fake_table(child.pid, ITERM))
    assert child.poll() is None


def test_process_that_ignores_sigterm_is_reported(tmp_path):
    stubborn = subprocess.Popen([sys.executable, "-c",
                                 "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"])
    try:
        import time as _t
        _t.sleep(0.3)                              # give it time to install the signal handler
        write_state(tmp_path, stubborn.pid)
        with pytest.raises(relocate.RelocateError, match="did not exit"):   # no header means en
            relocate.stop_for_move("sess-1", stubborn.pid, sessions_dir=str(tmp_path),
                                   table_fn=fake_table(stubborn.pid, ITERM), wait=0.5)
    finally:
        stubborn.kill()
        stubborn.wait()
