"""Codex limits straight from Codex (`codex app-server`, `account/rateLimits/read`), via a stand-in binary."""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

import pytest

from atlas import codex_live, codex_tail, codex_usage
from tests.conftest import cx, cx_meta

TID = "019e0000-aaaa-7000-8000-000000000001"
RESET_5H, RESET_WEEK = 1791215885, 1791748025          # 17:58 today, 21:47 on 11 Oct (local)
LIVE = {"rateLimits": {
    "limitId": "codex", "limitName": None, "planType": "plus", "rateLimitReachedType": "rate_limit_reached",
    "primary": {"usedPercent": 100, "windowDurationMins": 300, "resetsAt": RESET_5H},
    "secondary": {"usedPercent": 68, "windowDurationMins": 10080, "resetsAt": RESET_WEEK}}}

# Speaks the app server's JSON-RPC on stdio like codex 0.160.0. STANDIN_MODE picks the answer;
# every run appends its argv, CODEX_HOME and the methods it was asked to STANDIN_LOG.
STANDIN = r'''
import json, os, sys, time
mode = os.environ.get("STANDIN_MODE", "ok")
calls = []
def log():
    with open(os.environ["STANDIN_LOG"], "a") as fh:
        fh.write(json.dumps({"argv": sys.argv[1:], "home": os.environ.get("CODEX_HOME"),
                             "cwd": os.getcwd(), "methods": calls}) + "\n")
def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    req = json.loads(line)
    calls.append(req.get("method"))
    if req.get("method") == "initialize":
        out({"method": "remoteControl/status/changed", "params": {}})
        out({"id": req["id"], "result": {"userAgent": "standin", "codexHome": os.environ.get("CODEX_HOME")}})
    elif req.get("method") == "account/rateLimits/read":
        log()
        if mode == "hang":
            time.sleep(60)
        elif mode == "malformed":
            out({"id": req["id"], "result": "not an object"})
        elif mode == "garbage":
            sys.stdout.write("{not json\n"); sys.stdout.flush(); sys.exit(3)
        elif mode == "logged_out":
            out({"id": req["id"], "error": {"code": -32600,
                 "message": "codex account authentication required to read rate limits"}})
        else:
            out({"method": "account/updated", "params": {}})
            out({"id": req["id"], "result": json.loads(os.environ["STANDIN_RESULT"])})
'''


@pytest.fixture
def standin(tmp_path, monkeypatch):
    home = tmp_path / "codex-home"
    home.mkdir(exist_ok=True)
    script = tmp_path / "codex"
    script.write_text(f"#!{sys.executable}\n{STANDIN}")
    script.chmod(0o755)
    log = tmp_path / "standin.log"
    monkeypatch.setenv("ATLAS_CODEX_BIN", str(script))
    monkeypatch.setenv("STANDIN_LOG", str(log))
    monkeypatch.setenv("STANDIN_RESULT", json.dumps(LIVE))

    def runs():
        return [json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []
    return {"home": str(home), "script": str(script), "runs": runs}


def test_reads_the_codex_bucket_through_the_app_server(standin):
    got = codex_usage.read_rate_limits(standin["script"], standin["home"])
    assert got == LIVE
    run, = standin["runs"]()
    # Only the handshake and the usage read: no thread, no turn, no model request.
    assert run["argv"] == ["app-server"] and run["methods"] == ["initialize", "initialized", "account/rateLimits/read"]
    assert run["home"] == standin["home"] and os.path.realpath(run["cwd"]) == os.path.realpath(standin["home"])


def test_live_limits_in_the_toolbar_shape():
    now = RESET_5H - 3600
    got = codex_usage.to_limits(LIVE, now - 30, now)
    assert got["source"] == "live" and got["live"] is True and got["age_seconds"] == 30
    assert [(w["key"], w["used_percentage"]) for w in got["windows"]] == [("five_hour", 100), ("seven_day", 68)]
    assert got["windows"][0]["resets_at"] == datetime.fromtimestamp(RESET_5H, timezone.utc).isoformat()
    assert codex_usage.to_limits(LIVE, now - 3600, now)["live"] is False


@pytest.mark.parametrize("mode", ["hang", "malformed", "garbage", "logged_out"])
def test_failures_raise(standin, monkeypatch, mode):
    monkeypatch.setenv("STANDIN_MODE", mode)
    started = time.monotonic()
    with pytest.raises((OSError, ValueError, RuntimeError, EOFError, TimeoutError)):
        codex_usage.read_rate_limits(standin["script"], standin["home"], timeout=1.5)
    assert time.monotonic() - started < 6                  # the hung server is killed, not waited for


def test_bucket_selection():
    win = {"usedPercent": 40, "windowDurationMins": 300, "resetsAt": RESET_5H}
    premium_null = {"limitId": "premium", "primary": None, "secondary": None}
    premium = {"limitId": "premium", "primary": {"usedPercent": 3, "windowDurationMins": 300}}
    codex = {"limitId": "codex", "primary": win}
    # The multi-bucket view wins; a null or foreign bucket never replaces the codex one.
    assert codex_usage.bucket({"rateLimits": premium_null, "rateLimitsByLimitId": {"codex": codex}}) is codex
    assert codex_usage.bucket({"rateLimits": premium, "rateLimitsByLimitId": {"premium": premium}}) is None
    assert codex_usage.bucket({"rateLimits": codex, "rateLimitsByLimitId": {"premium": premium_null}}) is codex
    assert codex_usage.bucket({"rateLimits": {"primary": win}}) == {"primary": win}     # unnamed: older Codex


def test_rollout_ignores_other_buckets(write_rollout):
    """A per-model `premium` bucket with numbers must not stand in for the account's limits."""
    def tokens(ts, rl):
        return cx("event_msg", {"type": "token_count", "info": None, "rate_limits": rl}, ts)
    codex = {"limit_id": "codex", "primary": {"used_percent": 22, "window_minutes": 300}, "secondary": None}
    premium = {"limit_id": "premium", "primary": {"used_percent": 3, "window_minutes": 300}, "secondary": None}
    path = write_rollout([cx_meta(TID), tokens("2026-09-01T10:00:00.000Z", codex),
                          tokens("2026-09-01T11:00:00.000Z", premium)], thread_id=TID)
    assert codex_tail.read(path)["rate_limits"]["primary"]["used_percent"] == 22


def test_cache_fallback_and_live_preference(standin, write_rollout, monkeypatch):
    home = standin["home"]
    monkeypatch.setenv("ATLAS_CODEX_HOME", home)
    old = cx("event_msg", {"type": "token_count", "info": None, "rate_limits": {
        "limit_id": "codex", "primary": {"used_percent": 22, "window_minutes": 300, "resets_at": RESET_5H},
        "secondary": {"used_percent": 54, "window_minutes": 10080, "resets_at": RESET_WEEK}}},
        "2026-10-05T11:06:00.000Z")
    write_rollout([cx_meta(TID), old], thread_id=TID, day="2026/10/05")
    # Not asked: no app server, the rollout numbers with their age.
    seen = codex_live.limits(home=home)
    assert seen["source"] == "rollout" and seen["live"] is False and seen["age_seconds"] > 0
    assert [w["used_percentage"] for w in seen["windows"]] == [22, 54] and standin["runs"]() == []
    # Asked: one read, then the cache answers for TTL.
    assert codex_usage.current(home, start=True, wait=True)["source"] == "live"
    for _ in range(3):
        got = codex_live.limits(home=home, live=True)
        assert got["source"] == "live" and [w["used_percentage"] for w in got["windows"]] == [100, 68]
    assert len(standin["runs"]()) == 1
    # Due again: a failed read keeps the last good numbers.
    monkeypatch.setattr(codex_usage, "TTL", 0)
    monkeypatch.setenv("STANDIN_MODE", "logged_out")
    assert codex_usage.current(home, start=True, wait=True)["windows"][0]["used_percentage"] == 100
    assert len(standin["runs"]()) == 2


def test_not_logged_in_falls_back_to_rollouts(standin, write_rollout, monkeypatch):
    home = standin["home"]
    monkeypatch.setenv("ATLAS_CODEX_HOME", home)
    monkeypatch.setenv("STANDIN_MODE", "logged_out")
    write_rollout([cx_meta(TID), cx("event_msg", {"type": "token_count", "info": None, "rate_limits": {
        "primary": {"used_percent": 22, "window_minutes": 300}}}, "2026-10-05T11:06:00.000Z")],
        thread_id=TID, day="2026/10/05")
    assert codex_usage.current(home, start=True, wait=True) is None
    got = codex_live.limits(home=home, live=True)
    assert got["source"] == "rollout" and got["windows"][0]["used_percentage"] == 22
    assert len(standin["runs"]()) == 1                     # backed off: no second spawn within TTL


def test_no_codex_home_or_binary_no_spawn(standin, tmp_path, monkeypatch):
    assert codex_usage.current(str(tmp_path / "missing"), start=True, wait=True) is None
    monkeypatch.setenv("ATLAS_CODEX_BIN", "")
    assert codex_usage.find_codex() is None
    assert codex_usage.current(standin["home"], start=True, wait=True) is None
    assert standin["runs"]() == []


def test_binary_lookup_order(tmp_path, monkeypatch):
    from tests.conftest import write_config
    exe = tmp_path / "my-codex"
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    monkeypatch.delenv("ATLAS_CODEX_BIN")
    write_config(os.environ["ATLAS_HOME"], {"codex_bin": str(exe)})
    assert codex_usage.find_codex() == str(exe)
    monkeypatch.setenv("ATLAS_CODEX_BIN", str(tmp_path / "absent"))
    assert codex_usage.find_codex() is None                # a forced path is never searched around


def test_active_route_asks_codex_only_on_request(standin, atlas_env, live_server, monkeypatch):
    from atlas import server
    monkeypatch.setenv("ATLAS_CODEX_HOME", standin["home"])
    monkeypatch.setitem(server._active_cached, "sessions", None)
    monkeypatch.setattr(server, "active_sessions", lambda conn: [])
    base, _ = live_server

    def get(query=""):
        with urllib.request.urlopen(f"{base}/api/active{query}") as r:
            return json.loads(r.read())
    assert get()["codex_limits"] is None                                  # the plugin's poll:
    assert codex_usage._state["tried"] is None and not codex_usage._state["running"]   # no read started
    get("?codex_usage=1")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and not (get()["codex_limits"] or {}).get("live"):
        time.sleep(0.1)
    assert get()["codex_limits"]["source"] == "live" and len(standin["runs"]()) == 1


def test_a_newer_rollout_beats_older_live_numbers(standin, write_rollout, monkeypatch):
    """Codex ran after the last live read: its token count is the fresher number."""
    home = standin["home"]
    monkeypatch.setenv("ATLAS_CODEX_HOME", home)
    codex_usage.current(home, start=True, wait=True)
    later = datetime.fromtimestamp(time.time() + 120, timezone.utc).isoformat().replace("+00:00", "Z")
    write_rollout([cx_meta(TID), cx("event_msg", {"type": "token_count", "info": None, "rate_limits": {
        "limit_id": "codex", "primary": {"used_percent": 3, "window_minutes": 300}}}, later)],
        thread_id=TID, day=later[:10].replace("-", "/"))
    got = codex_live.limits(home=home, live=True)
    assert got["source"] == "rollout" and got["windows"][0]["used_percentage"] == 3
