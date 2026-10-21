"""Restarting Atlas releases its indexer and makes interrupted jobs retryable."""
from __future__ import annotations

import contextlib
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

from atlas import actions, db


def test_only_interrupted_jobs_are_failed():
    conn = db.connect()
    jobs = {}
    for state in ("queued", "running", "cancel_requested", "done", "failed"):
        job, _ = actions.claim_job(conn, state, "classification", "h")
        actions.set_job_state(conn, job, state, result="saved", error="old" if state == "failed" else None)
        jobs[state] = job
    actions.interrupt_jobs(conn)
    for state, job in jobs.items():
        value = actions.get_job(conn, job)
        assert value["state"] == (state if state in ("done", "failed") else "failed")
        assert value["result"] == "saved"
        if state == "done":
            assert value["error"] is None
        elif state == "failed":
            assert value["error"] == "old"
        else:
            assert "Atlas" in value["error"]
    assert actions.claim_job(conn, "running", "classification", "h")[1]
    conn.close()


@pytest.mark.parametrize("shutdown", ["signal", "http"])
def test_server_shutdown_reaps_its_indexer(tmp_path, shutdown):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    pidfile = tmp_path / "indexer.pid"
    child = "import os,time;open(" + repr(str(pidfile)) + ",'w').write(str(os.getpid()));time.sleep(60)"
    script = ("import sys;from atlas import server;"
              "server._catchup_proc=server._Pass([sys.executable,'-c'," + repr(child) + "]);"
              f"server.serve({port})")
    proc = subprocess.Popen([sys.executable, "-c", script], env=dict(os.environ),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    child_pid = None
    try:
        assert "listening" in proc.stdout.readline()
        deadline = time.monotonic() + 5
        while not pidfile.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        child_pid = int(pidfile.read_text())
        os.kill(child_pid, 0)
        if shutdown == "signal":
            proc.send_signal(signal.SIGTERM)
        else:
            from atlas import server
            request = urllib.request.Request(f"http://127.0.0.1:{port}/api/shutdown", data=b"{}",
                headers={"Origin": f"http://127.0.0.1:{port}", "X-Atlas-Token": server.csrf_token()})
            with urllib.request.urlopen(request, timeout=5) as reply:
                assert reply.status == 200
        _, err = proc.communicate(timeout=10)
        assert proc.returncode == 0, err
        with pytest.raises(ProcessLookupError):
            os.kill(child_pid, 0)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.communicate(timeout=5)
        if child_pid is not None:
            with contextlib.suppress(ProcessLookupError):
                os.kill(child_pid, signal.SIGTERM)
