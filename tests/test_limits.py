"""Subscription limits: the status line writes a file, the catalog reads it."""
from __future__ import annotations

import json
import os
import subprocess
import sys

from atlas import limits

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(HERE, "atlas", "statusline.py")      # this is how Claude Code calls it
SHIM = os.path.join(HERE, "tools", "statusline.py")


def run_statusline(home, payload, script=SCRIPT):
    return subprocess.run([sys.executable, "-I", script], input=payload, capture_output=True, text=True,
                          env=dict(os.environ, ATLAS_HOME=str(home)), timeout=20)


def test_statusline_saves_limits_and_prints_a_line(tmp_path):
    payload = json.dumps({"model": {"display_name": "Opus 5.5"}, "rate_limits": {
        "five_hour": {"used_percentage": 41.6, "resets_at": 1790548575},
        "seven_day": {"used_percentage": 87.2, "resets_at": "2026-10-01T00:00:00Z"}}})
    out = run_statusline(tmp_path, payload)
    assert out.returncode == 0 and out.stdout.startswith("Opus 5.5 · 5h 42%") and "week 87%" in out.stdout
    (tmp_path / "config.json").write_text(json.dumps({"language": "ru"}), encoding="utf-8")
    out = run_statusline(tmp_path, payload, script=SHIM)
    assert out.stdout.startswith("Opus 5.5 · 5ч 42%") and "нед 87% до" in out.stdout
    captured_at = json.loads((tmp_path / "rate-limits.json").read_text())["captured_at"]
    got = limits.read_limits(str(tmp_path), now=captured_at + 5)
    assert got["age_seconds"] == 5 and got["live"] is True and got["source"] == "statusline"
    assert limits.read_limits(str(tmp_path), now=captured_at + limits.LIVE_FOR + 1)["live"] is False
    assert [(w["key"], w["used_percentage"]) for w in got["windows"]] == [("five_hour", 41.6), ("seven_day", 87.2)]
    assert got["windows"][0]["resets_at"].startswith("2026-")
    assert got["windows"][1]["resets_at"] == "2026-10-01T00:00:00+00:00"


def test_statusline_without_limits_keeps_old_file_and_never_fails(tmp_path):
    (tmp_path / "rate-limits.json").write_text(json.dumps(
        {"captured_at": 1, "rate_limits": {"seven_day": {"used_percentage": 10}}}), encoding="utf-8")
    for payload in ("{}", "не json", json.dumps({"rate_limits": "мусор"})):
        out = run_statusline(tmp_path, payload)
        assert out.returncode == 0
    # Garbage in the limits does not drop the model from the line.
    out = run_statusline(tmp_path, json.dumps({"model": {"display_name": "Opus 5.5"},
                                               "rate_limits": {"seven_day": "мусор"}}))
    assert out.stdout.strip() == "Opus 5.5"
    out = run_statusline(tmp_path, json.dumps({"model": {"display_name": "Opus 5.5"},
                                               "rate_limits": "мусор"}))
    assert out.stdout.strip() == "Opus 5.5"
    assert limits.read_limits(str(tmp_path))["windows"][0]["used_percentage"] == 10


def test_read_limits_without_file_or_with_garbage(tmp_path):
    assert limits.read_limits(str(tmp_path)) is None
    (tmp_path / "rate-limits.json").write_text("{", encoding="utf-8")
    assert limits.read_limits(str(tmp_path)) is None
    (tmp_path / "rate-limits.json").write_text(json.dumps({"rate_limits": {"x": {}}}), encoding="utf-8")
    assert limits.read_limits(str(tmp_path)) is None


def test_reset_given_as_digits_in_a_string(tmp_path):
    (tmp_path / "rate-limits.json").write_text(json.dumps({"captured_at": 1, "rate_limits": {
        "seven_day": {"used_percentage": 50, "resets_at": "1790548575"}}}), encoding="utf-8")
    assert limits.read_limits(str(tmp_path))["windows"][0]["resets_at"].startswith("2026-09-")
