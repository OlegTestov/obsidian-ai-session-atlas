"""Statistics per agent: the filter narrows every number, Codex replies get OpenAI prices."""
from __future__ import annotations

import json
import urllib.request
from datetime import datetime, timezone

import pytest

from atlas import db, index, openai_costs, stats
from tests.conftest import cx, cx_context, cx_exec, cx_meta, cx_user, write_config
from tests.test_stats import answer, prompt

NOW = datetime(2026, 9, 1, 18, 0, tzinfo=timezone.utc)
CLAUDE_ID = "11111111-2222-3333-4444-555555555555"
TID = "019e0000-1111-7000-8000-000000000002"
OLD_TID = "019e0000-1111-7000-8000-000000000003"


def tokens(inp, cached, out, written=0, n=1, ts="2026-09-01T10:00:31.000Z"):
    """A token_count as real rollouts write it: reasoning is inside output, total = input + output."""
    last = {"input_tokens": inp, "cached_input_tokens": cached, "output_tokens": out,
            "reasoning_output_tokens": out // 2, "total_tokens": inp + out}
    if written:
        last["cache_write_input_tokens"] = written
    return cx("event_msg", {"type": "token_count", "rate_limits": {},
                            "info": {"last_token_usage": last,
                                     "total_token_usage": dict(last, total_tokens=n * 100000)}}, ts)


def codex_lines(tid, model="gpt-6-sol", day="2026-09-01"):
    return [cx_meta(tid, ts=f"{day}T10:00:00.000Z"), cx_context(model=model, ts=f"{day}T10:00:01.000Z"),
            cx_user("почини тесты", ts=f"{day}T10:00:02.000Z"),
            cx_exec("pytest -q", ts=f"{day}T10:00:10.000Z"),
            tokens(1_000_000, 600_000, 100_000, written=100_000, ts=f"{day}T10:00:31.000Z"),
            cx_user("ещё", ts=f"{day}T10:01:00.000Z"),
            tokens(200_000, 0, 50_000, n=2, ts=f"{day}T10:02:00.000Z")]


# gpt-6-sol: 2.00 input, 0.20 cached, 2.50 cache write, 10.00 output per 1M.
CODEX_COST = (300_000 * 2.0 + 600_000 * 0.2 + 100_000 * 2.5 + 100_000 * 10.0
              + 200_000 * 2.0 + 50_000 * 10.0) / 1e6


@pytest.fixture
def mixed(atlas_env, write_session, write_rollout):
    write_session("p", [prompt("сделай отчёт", "2026-09-01T09:00:00.000Z", "u1"),
                        answer("m1", "2026-09-01T09:01:00.000Z", tools=[("Bash", {"command": "ls"})]),
                        prompt("ещё", "2026-09-01T09:03:00.000Z", "u2"),
                        answer("m2", "2026-09-01T09:04:00.000Z")], session_id=CLAUDE_ID)
    write_rollout(codex_lines(TID), thread_id=TID)
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    return conn


def run(conn, agents=None, period="all"):
    return stats.summary(conn, period, now=NOW, agents=agents)


def test_agent_filter_narrows_every_statistic(mixed):
    both, claude, codex = run(mixed), run(mixed, ["claude"]), run(mixed, ["codex"])
    assert codex["agent_filter"] == ["codex"] and both["agent_filter"] is None
    assert [s["session_id"] for s in claude["sessions"]] == [CLAUDE_ID]
    assert [s["session_id"] for s in codex["sessions"]] == [TID]
    assert {m["name"] for m in claude["models"]} == {"opus-5"}
    assert {m["name"] for m in codex["models"]} == {"gpt-6-sol"}
    assert {t["name"] for t in claude["tools"]} == {"Bash"}
    assert {t["name"] for t in codex["tools"]} == {"exec_command"}
    assert [a["name"] for a in claude["by_agent"]] == ["claude"]
    assert [a["name"] for a in codex["by_agent"]] == ["codex"]
    assert (claude["totals"]["sessions"], codex["totals"]["sessions"], both["totals"]["sessions"]) == (1, 1, 2)
    assert codex["totals"]["tokens"]["total"] == 1_100_000 + 250_000
    for part in ("domains", "topics", "projects"):
        assert sum(r["tokens"] for r in codex[part]) == codex["totals"]["tokens"]["total"]
    assert sum(p["tokens"] for p in codex["series"]["points"]) == codex["totals"]["tokens"]["total"]
    # The heatmap: Claude worked at 09:xx UTC, Codex at 10:xx UTC; each sees only its own hours.
    assert sum(claude["hours"]) == claude["totals"]["active_s"] > 0
    assert sum(codex["hours"]) == codex["totals"]["active_s"] > 0
    assert sum(both["hours"]) == claude["totals"]["active_s"] + codex["totals"]["active_s"]


def test_by_agent_rows_equal_the_per_agent_runs(mixed):
    both = run(mixed)
    rows = {r["name"]: r for r in both["by_agent"]}
    assert set(rows) == {"claude", "codex"}
    for agent, row in rows.items():
        t = run(mixed, [agent])["totals"]
        assert row["cost"] == pytest.approx(t["cost"], abs=0.011)
        assert row["tokens"] == t["tokens"]["total"]
        assert row["sessions"] == t["sessions"]
        assert row["active_s"] == t["active_s"]
        assert (row["prompts"], row["answers"]) == (t["prompts"], t["answers"])
    assert sum(r["tokens"] for r in rows.values()) == both["totals"]["tokens"]["total"]
    assert sum(r["sessions"] for r in rows.values()) == both["totals"]["sessions"]
    assert sum(r["cost"] for r in rows.values()) == pytest.approx(both["totals"]["cost"], abs=0.011)


def test_codex_replies_are_priced_at_openai_rates(mixed):
    t = run(mixed, ["codex"])["totals"]
    assert t["cost"] == round(CODEX_COST, 2) and t["unpriced_models"] == []
    assert openai_costs.reply_cost("gpt-6-sol", 300_000, 600_000, 100_000, 100_000) == pytest.approx(
        (300_000 * 2.0 + 600_000 * 0.2 + 100_000 * 2.5 + 100_000 * 10.0) / 1e6)
    # gpt-5.5 bills cache writes as plain input: no separate price.
    assert openai_costs.reply_cost("gpt-5.5", 0, 0, 1_000_000, 0) == pytest.approx(5.0)


def test_codex_cache_hit_is_cached_over_all_input(mixed):
    t = run(mixed, ["codex"])["totals"]
    assert t["cache_hit"] == pytest.approx(600_000 / 1_200_000)
    assert t["tokens"]["input"] + t["tokens"]["cache_read"] == 1_200_000


def test_unpriced_model_is_none_not_zero(atlas_env, write_session, write_rollout):
    write_session("p", [prompt("x", "2026-09-01T09:00:00.000Z", "u1"),
                        answer("m1", "2026-09-01T09:01:00.000Z")], session_id=CLAUDE_ID)
    write_rollout(codex_lines(TID, model="gpt-5-codex"), thread_id=TID)
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert openai_costs.reply_cost("gpt-5-codex", 1, 1, 0, 1) is None
    assert openai_costs.reply_cost(None, 0, 0, 0, 0) == 0.0       # an empty token_count is not "unpriced"
    codex = run(conn, ["codex"])
    assert codex["totals"]["cost"] is None
    assert codex["totals"]["unpriced_models"] == ["gpt-5-codex"]
    assert codex["models"][0]["cost"] is None and codex["by_agent"][0]["cost"] is None
    both = run(conn)
    assert both["totals"]["cost"] == run(conn, ["claude"])["totals"]["cost"] is not None
    assert {r["name"]: r["cost"] for r in both["by_agent"]}["codex"] is None


def test_config_price_override_applies_without_reindex(mixed, atlas_env):
    write_config(str(atlas_env["home"]), {"openai_prices": {
        "gpt-6-sol": {"output": 20.0},                           # a fix keeps the other fields
        "gpt-7": [1.0, 0.1, 8.0]}})
    assert openai_costs.price_for("gpt-6-sol") == {"input": 2.0, "cached_input": 0.2,
                                                   "cache_write": 2.5, "output": 20.0}
    assert openai_costs.price_for("gpt-7-2026-12-01")["output"] == 8.0
    assert run(mixed, ["codex"])["totals"]["cost"] == round(CODEX_COST + 150_000 * 10.0 / 1e6, 2)
    write_config(str(atlas_env["home"]), {"openai_prices": {"gpt-6-sol": None}})
    t = run(mixed, ["codex"])["totals"]
    assert t["cost"] is None and t["unpriced_models"] == ["gpt-6-sol"]


def test_previous_period_uses_the_same_filter(atlas_env, write_session, write_rollout):
    # Current week: Claude only. The week before: Codex only.
    write_session("p", [prompt("x", "2026-09-01T09:00:00.000Z", "u1"),
                        answer("m1", "2026-09-01T09:01:00.000Z")], session_id=CLAUDE_ID)
    write_rollout(codex_lines(OLD_TID, day="2026-08-24"), thread_id=OLD_TID, day="2026/08/24")
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    now = datetime(2026, 9, 2, 18, 0, tzinfo=timezone.utc)
    claude = stats.summary(conn, "7d", now=now, agents=["claude"])
    codex = stats.summary(conn, "7d", now=now, agents=["codex"])
    assert (claude["totals"]["sessions"], claude["previous"]["sessions"]) == (1, 0)
    assert (codex["totals"]["sessions"], codex["previous"]["sessions"]) == (0, 1)
    assert codex["previous"]["cost"] == round(CODEX_COST, 2)


def test_api_stats_takes_the_agent_parameter(mixed, live_server):
    base, _ = live_server

    def get(qs):
        with urllib.request.urlopen(f"{base}/api/stats?period=all&{qs}", timeout=20) as r:
            return json.loads(r.read())
    assert {r["name"] for r in get("agent=codex")["by_agent"]} == {"codex"}
    assert {r["name"] for r in get("agent=claude,unknown")["by_agent"]} == {"claude"}
    assert {r["name"] for r in get("agent=claude,codex")["by_agent"]} == {"claude", "codex"}
    assert get("")["agent_filter"] is None
