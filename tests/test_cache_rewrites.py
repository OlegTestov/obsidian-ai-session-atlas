"""Cache rewrites: which replies are cold, why, and what they cost beyond a warm cache."""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from atlas import cache_rewrites as cr, costs, db, index, stats
from tests.conftest import user_text
from tests.test_stats import answer

BASE = datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)


def conn_with_names():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
      CREATE TABLE sessions (session_id TEXT, title TEXT);
      CREATE TABLE user_overrides (session_id TEXT, title TEXT);
      CREATE TABLE activity (session_id TEXT, key TEXT, kind TEXT, ts TEXT, model TEXT, input INTEGER,
        output INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL, sub INTEGER);
      CREATE TABLE session_projects (session_id TEXT, project_id TEXT, role TEXT);
      CREATE TABLE session_forks (session_id TEXT, parent_id TEXT, at TEXT);
      INSERT INTO sessions VALUES ('s1', 'First title'), ('s2', NULL);
      INSERT INTO session_projects VALUES ('s1', 'demo', 'primary');""")
    return conn


def reply(sid, sec, inp=0, cw=0, cr_=0, out=0, cost=1.0, sub=0, model="claude-opus-5", agent="claude"):
    ts = (BASE + timedelta(seconds=sec)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return {"sid": sid, "ts": ts, "kind": "a", "inp": inp, "cw": cw, "cr": cr_, "out": out,
            "cost": cost, "sub": sub, "model": model, "agent": agent}


def run(rows, period_cost=100.0, conn=None, since=None):
    return cr.summarize(conn or conn_with_names(), rows, period_cost, {}, since)


def ts_at(sec):
    return (BASE + timedelta(seconds=sec)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def writer(sid, sec, cw, life, model="claude-opus-5", inp=100, cr_=0, out=10):
    """A reply that wrote `cw` tokens to a 5-minute or 1-hour cache, priced the way Claude Code prices it."""
    usage = {"input_tokens": inp, "output_tokens": out, "cache_read_input_tokens": cr_}
    usage["cache_creation_input_tokens"] = cw
    if life == "1h":
        usage["cache_creation"] = {"ephemeral_1h_input_tokens": cw, "ephemeral_5m_input_tokens": 0}
    return reply(sid, sec, inp=inp, cw=cw, cr_=cr_, out=out, model=model,
                 cost=costs.message_cost(model, usage))


def old_reply(conn, sid, sec, key, cw=0, cost=None, sub=0, model="claude-opus-5"):
    conn.execute("INSERT INTO activity VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                 (sid, key, "a", ts_at(sec), model, 100, 10, 0, cw, cost, sub))


def causes(result):
    return {c: result["by_cause"][c]["count"] for c in cr.CAUSES}


@pytest.mark.parametrize("fresh,cold", [(19_999, False), (20_000, True)])
def test_cold_needs_twenty_thousand_fresh_tokens(fresh, cold):
    assert cr.is_cold(reply("s1", 0, inp=fresh)) is cold
    assert cr.is_cold(reply("s1", 0, inp=fresh - 5, cw=5)) is cold          # input and cache writes add up


def test_cold_needs_more_fresh_tokens_than_cache_read():
    assert not cr.is_cold(reply("s1", 0, inp=30_000, cr_=30_000))
    assert cr.is_cold(reply("s1", 0, inp=30_001, cr_=30_000))


@pytest.mark.parametrize("gap,why", [(None, "first"), (300, "changed"), (301, "pause"),
                                     (3600, "pause"), (3601, "pause_long")])
def test_cause_boundaries(gap, why):
    assert cr.cause(gap) == why


def test_first_reply_is_not_counted_but_the_next_cold_one_is():
    r = run([reply("s1", 0, cw=50_000), reply("s1", 4000, cw=50_000)])
    assert causes(r) == {"pause_long": 1, "pause": 0, "changed": 0}
    assert r["count"] == 1


def test_gaps_are_taken_from_the_previous_main_reply_not_from_row_order():
    rows = [reply("s1", 5000, cw=50_000), reply("s1", 0, cr_=10), reply("s1", 4700, cr_=10)]
    r = run(rows)                                  # sorted: 0, 4700, 5000 → the cold one follows a 300 s gap
    assert causes(r) == {"pause_long": 0, "pause": 0, "changed": 1}


def test_subagent_replies_are_neither_cold_nor_a_previous_reply():
    rows = [reply("s1", 0, cr_=10), reply("s1", 7000, cw=50_000, sub=1), reply("s1", 7100, cw=50_000)]
    r = run(rows)
    assert r["count"] == 1 and causes(r)["pause_long"] == 1                 # 7100 s after the main reply at 0


def test_prompts_are_ignored():
    prompt = dict(reply("s1", 0, cw=50_000), kind="p")
    assert run([prompt, reply("s1", 10, cr_=1)])["count"] == 0


def test_extra_cost_is_the_cost_minus_the_same_usage_read_from_cache():
    # opus-5: $5 in, $25 out, cache read ×0.1. The reply paid 100000 written at 1.25× input.
    paid = (100 * 5 + 10 * 25 + 1000 * 0.5 + 100_000 * 5 * 1.25) / 1e6
    row = reply("s1", 0, inp=100, cw=100_000, cr_=1000, out=10, cost=paid)
    warm = (10 * 25 + (1000 + 100_100) * 0.5) / 1e6
    assert cr.extra_cost(row, {}) == pytest.approx(paid - warm)
    assert cr.extra_cost(row, {}) == pytest.approx(0.57545)


def test_codex_reply_is_priced_from_the_openai_table():
    prices = {"gpt-5.5": {"input": 5.0, "cached_input": 0.5, "output": 30.0}}
    cost = (60_000 * 5 + 1000 * 0.5 + 100 * 30) / 1e6
    row = reply("s1", 0, inp=60_000, cr_=1000, out=100, cost=cost, model="gpt-5.5", agent="codex")
    assert cr.extra_cost(row, prices) == pytest.approx(60_000 * (5 - 0.5) / 1e6)


def test_unpriced_model_is_counted_without_cost():
    rows = [reply("s1", 0, cr_=1), reply("s1", 4000, cw=50_000, model="mystery-1", cost=None)]
    r = run(rows)
    assert r["count"] == 1 and r["cost"] is None and r["share"] is None      # found, but nothing to price
    assert r["by_cause"]["pause_long"] == {"count": 1, "cost": None, "tokens": 50_000}
    assert r["by_cause"]["pause"]["cost"] == 0                                # no replies: a real zero
    priced_cost_unknown_model = dict(rows[1], cost=1.0)
    assert run([rows[0], priced_cost_unknown_model])["cost"] is None         # a model without a price: skipped too


def test_share_is_the_extra_cost_over_the_period_cost_and_null_when_unknown():
    rows = [reply("s1", 0, cr_=1), reply("s1", 4000, cw=100_000, cost=0.62625, out=0)]
    extra = run(rows)["cost"]
    assert extra > 0
    assert run(rows, period_cost=extra * 4)["share"] == pytest.approx(0.25, abs=0.01)
    assert run(rows, period_cost=None)["share"] is None
    assert run(rows, period_cost=0)["share"] is None


def test_sessions_are_ranked_by_extra_cost_with_names_and_causes():
    cheap = [reply("s2", 0, cr_=1), reply("s2", 200, cw=40_000, cost=0.3)]
    dear = [reply("s1", 0, cr_=1), reply("s1", 5000, cw=300_000, cost=2.0), reply("s1", 5100, cw=300_000, cost=2.0)]
    r = run(cheap + dear)
    assert [s["session_id"] for s in r["sessions"]] == ["s1", "s2"]
    first, second = r["sessions"]
    assert (first["name"], first["project"], first["count"]) == ("First title", "demo", 2)
    assert first["causes"] == {"pause_long": 1, "pause": 0, "changed": 1}
    assert second["name"] == "s2" and second["project"] is None            # no title: the id's start
    assert len(run([r_ for i in range(12) for r_ in
                    (reply(f"x{i}", 0, cr_=1), reply(f"x{i}", 4000, cw=50_000))])["sessions"]) == 10


def test_summary_carries_cache_rewrites_end_to_end(atlas_env, write_session):
    path = write_session("p", [
        user_text("start", ts="2026-09-01T10:00:00.000Z", uuid="u1"),
        answer("m1", "2026-09-01T10:00:30.000Z", cache_creation_input_tokens=90_000),     # first: normal
        answer("m2", "2026-09-01T12:00:00.000Z", cache_creation_input_tokens=90_000),     # after a 2 h pause
    ])
    sub = os.path.join(path[:-len(".jsonl")], "subagents")
    os.makedirs(sub)
    with open(os.path.join(sub, "agent-a1.jsonl"), "w") as fh:
        fh.write(answer("s1", "2026-09-01T12:01:00.000Z", cache_creation_input_tokens=90_000))
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    out = stats.summary(conn, "all", now=datetime(2026, 9, 1, 18, 0, tzinfo=timezone.utc))["cache_rewrites"]
    assert out["count"] == 1 and out["by_cause"]["pause_long"]["count"] == 1
    assert out["by_cause"]["pause_long"]["tokens"] == 90_100
    assert out["cost"] > 0 and 0 < out["share"] < 1
    assert len(out["sessions"]) == 1 and out["sessions"][0]["count"] == 1


@pytest.mark.parametrize("life,gap,why", [
    ("5m", 200, "changed"), ("5m", 301, "pause"), ("5m", 3600, "pause"), ("5m", 3601, "pause_long"),
    ("1h", 301, "changed"), ("1h", 3600, "changed"), ("1h", 3601, "pause_long")])
def test_cause_follows_the_cache_lifetime_the_last_writer_paid_for(life, gap, why):
    rows = [writer("s1", 0, 50_000, life), reply("s1", gap, cw=50_000, cost=1.0)]
    assert causes(run(rows))[why] == 1


def test_unknown_lifetime_is_five_minutes():
    rows = [reply("s1", 0, cr_=10), reply("s1", 1800, cw=50_000)]          # nobody wrote before
    assert causes(run(rows))["pause"] == 1


def test_the_latest_writer_decides_not_a_reader_in_between():
    rows = [writer("s1", 0, 50_000, "1h"), reply("s1", 100, cr_=50_000), reply("s1", 2000, cw=50_000)]
    assert causes(run(rows))["changed"] == 1
    rows = [writer("s1", 0, 50_000, "1h"), writer("s1", 100, 50_000, "5m"), reply("s1", 2000, cw=50_000)]
    assert causes(run(rows))["pause"] == 1


def test_codex_and_unpriced_writers_count_as_five_minutes():
    codex = dict(reply("s1", 0, inp=60_000, model="gpt-5.5", agent="codex"), cw=0)
    assert causes(run([codex, reply("s1", 1800, cw=50_000)]))["pause"] == 1
    odd = reply("s1", 0, cw=50_000, model="mystery-1", cost=None)
    assert causes(run([odd, reply("s1", 1800, cw=50_000)]))["pause"] == 1


def test_period_start_uses_the_last_reply_before_the_period():
    conn = conn_with_names()
    old_reply(conn, "s1", -5000, "k1", cw=50_000, cost=costs.message_cost("claude-opus-5", {
        "input_tokens": 100, "output_tokens": 10, "cache_creation_input_tokens": 50_000,
        "cache_creation": {"ephemeral_1h_input_tokens": 50_000, "ephemeral_5m_input_tokens": 0}}))
    old_reply(conn, "s1", -9000, "k0")
    cold = reply("s1", 0, cw=50_000)
    assert causes(run([cold], conn=conn, since=ts_at(0)))["pause_long"] == 1
    assert causes(run([cold], conn=conn, since=None)) == {"pause_long": 0, "pause": 0, "changed": 0}
    close = reply("s1", 0, cw=50_000)
    old_reply(conn, "s1", -100, "k2", cw=50_000, cost=0.001)               # a 5-minute writer 100 s before
    assert causes(run([close], conn=conn, since=ts_at(0)))["changed"] == 1


def test_period_start_ignores_subagent_replies_and_other_sessions():
    conn = conn_with_names()
    old_reply(conn, "s1", -100, "k1", sub=1)
    old_reply(conn, "s2", -100, "k2")
    assert run([reply("s1", 0, cw=50_000)], conn=conn, since=ts_at(0))["count"] == 0
    old_reply(conn, "s1", -5000, "k3")                                       # the main thread's own last reply
    assert causes(run([reply("s1", 0, cw=50_000)], conn=conn, since=ts_at(0)))["pause_long"] == 1


def test_a_shared_reply_belongs_to_the_smallest_session_id_before_the_period_too():
    # stats._ROWS gives a reply shared by several sessions to MIN(session_id); the look-back must agree.
    conn = conn_with_names()
    old_reply(conn, "s1", -5000, "shared")           # the owner
    old_reply(conn, "s9", -5000, "shared")           # an unlinked copy in a session with a larger id
    assert run([reply("s9", 0, cw=50_000)], conn=conn, since=ts_at(0))["count"] == 0        # only copies before: first
    assert causes(run([reply("s1", 0, cw=50_000)], conn=conn, since=ts_at(0)))["pause_long"] == 1


def test_a_shared_reply_in_the_last_hour_is_not_a_prior_reply_of_the_copy():
    conn = conn_with_names()
    old_reply(conn, "s1", -100, "shared")
    old_reply(conn, "s9", -100, "shared")
    assert run([reply("s9", 0, cw=50_000)], conn=conn, since=ts_at(0))["count"] == 0
    assert causes(run([reply("s1", 0, cw=50_000)], conn=conn, since=ts_at(0)))["changed"] == 1


def test_the_result_does_not_depend_on_where_the_period_starts():
    # The copy session's first own reply is "first" whether the shared reply (6.5 min earlier, owned by
    # the smaller id) falls inside the period or before it.
    def summary(since_sec):
        conn = conn_with_names()
        old_reply(conn, "s1", -400, "shared", cw=50_000, cost=0.001)
        old_reply(conn, "s9", -400, "shared", cw=50_000, cost=0.001)
        inside = [reply("s9", 0, cw=50_000)]
        if since_sec < -400:
            inside.append(reply("s1", -400, cw=50_000))
        return run(inside, conn=conn, since=ts_at(since_sec))
    assert summary(-1000)["count"] == summary(-100)["count"] == summary(-400)["count"]
    assert summary(-100)["by_cause"]["changed"]["count"] == 0


def test_a_gap_over_an_hour_is_a_long_pause_whatever_the_exact_time():
    conn = conn_with_names()
    old_reply(conn, "s1", -90_000, "far")            # a day ago: outside the hour window, still a prior reply
    assert causes(run([reply("s1", 0, cw=50_000)], conn=conn, since=ts_at(0)))["pause_long"] == 1


def test_a_period_other_than_all_counts_a_reply_after_the_period_start_pause(atlas_env, write_session):
    write_session("p", [
        user_text("start", ts="2026-08-25T17:00:00.000Z", uuid="u1"),
        answer("m1", "2026-08-25T17:00:30.000Z", cache_creation_input_tokens=90_000),     # before the 7 days
        answer("m2", "2026-08-25T19:00:00.000Z", cache_creation_input_tokens=90_000),     # first in the window
    ])
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    now = datetime(2026, 9, 1, 18, 0, tzinfo=timezone.utc)
    week = stats.summary(conn, "7d", now=now)["cache_rewrites"]
    assert week["by_cause"]["pause_long"]["count"] == 1 and week["count"] == 1
    assert stats.summary(conn, "all", now=now)["cache_rewrites"]["count"] == 1


def test_lifetime_is_the_price_the_cost_is_nearer_to():
    assert cr.lifetime(writer("s1", 0, 50_000, "5m")) == cr.CHANGED_MAX_S
    assert cr.lifetime(writer("s1", 0, 50_000, "1h")) == cr.PAUSE_MAX_S
    noisy = dict(writer("s1", 0, 50_000, "5m"))
    noisy["cost"] *= 1 + 1e-6
    assert cr.lifetime(noisy) == cr.CHANGED_MAX_S


def test_a_small_one_hour_write_beside_a_big_read_is_still_one_hour():
    for life, want in (("1h", cr.PAUSE_MAX_S), ("5m", cr.CHANGED_MAX_S)):
        w = writer("s1", 0, 20, life, model="claude-opus-5-5", inp=1, cr_=300_000, out=300)
        assert cr.lifetime(w) == want


def test_an_unpriced_writer_keeps_the_lifetime_of_the_last_priced_one():
    rows = [writer("s1", 0, 50_000, "1h"), reply("s1", 100, cw=50_000, model="mystery-1", cost=None),
            reply("s1", 2000, cw=50_000, cost=1.0)]
    assert causes(run(rows))["changed"] == 2             # both follow 1-hour writers; the unpriced one changed nothing
    rows = [writer("s1", 0, 50_000, "5m"), reply("s1", 100, cw=50_000, model="mystery-1", cost=None),
            reply("s1", 2000, cw=50_000, cost=1.0)]
    assert causes(run(rows))["pause"] == 1


def test_an_unpriced_writer_before_the_period_is_skipped_for_the_last_priced_one():
    conn = conn_with_names()
    one_hour = costs.message_cost("claude-opus-5", {
        "input_tokens": 100, "output_tokens": 10, "cache_creation_input_tokens": 50_000,
        "cache_creation": {"ephemeral_1h_input_tokens": 50_000, "ephemeral_5m_input_tokens": 0}})
    old_reply(conn, "s1", -2500, "w", cw=50_000, cost=one_hour)
    old_reply(conn, "s1", -2000, "u", cw=50_000, cost=None, model="mystery-1")
    assert causes(run([reply("s1", 0, cw=50_000)], conn=conn, since=ts_at(0)))["changed"] == 1


def test_period_start_takes_the_cache_lifetime_from_the_last_writer_before_it():
    conn = conn_with_names()
    one_hour = costs.message_cost("claude-opus-5", {
        "input_tokens": 100, "output_tokens": 10, "cache_creation_input_tokens": 50_000,
        "cache_creation": {"ephemeral_1h_input_tokens": 50_000, "ephemeral_5m_input_tokens": 0}})
    old_reply(conn, "s1", -2500, "w", cw=50_000, cost=one_hour)
    old_reply(conn, "s1", -2000, "r")                                        # a reader after the writer
    assert causes(run([reply("s1", 0, cw=50_000)], conn=conn, since=ts_at(0)))["changed"] == 1


def test_an_unpriced_first_reply_does_not_hide_the_writer_before_the_period():
    """The cause must not depend on where the period starts: the 1-hour writer before it still counts."""
    one_hour = costs.message_cost("claude-opus-5", {
        "input_tokens": 100, "output_tokens": 10, "cache_creation_input_tokens": 50_000,
        "cache_creation": {"ephemeral_1h_input_tokens": 50_000, "ephemeral_5m_input_tokens": 0}})
    w = writer("s1", -100, 50_000, "1h")
    x = reply("s1", 1000, cw=50_000, cost=1.0)
    for first in (reply("s1", 0, inp=30_000, cw=500, model="mystery-1", cost=None),          # cold
                  reply("s1", 0, inp=10, cw=500, cr_=50_000, model="mystery-1", cost=None)):  # warm
        whole = causes(run([w, first, x]))
        conn = conn_with_names()
        old_reply(conn, "s1", -100, "w", cw=50_000, cost=one_hour)
        assert causes(run([first, x], conn=conn, since=ts_at(0))) == whole
        assert whole.get("pause", 0) == 0


def test_a_session_with_only_unpriced_rewrites_has_no_cost():
    rows = [reply("s1", 0, cr_=1), reply("s1", 4000, cw=50_000, model="mystery-1", cost=None),
            reply("s2", 0, cr_=1), reply("s2", 4000, cw=50_000, cost=1.0)]
    by_id = {s["session_id"]: s for s in run(rows)["sessions"]}
    assert by_id["s1"]["cost"] is None
    assert by_id["s2"]["cost"] is not None
    assert [s["session_id"] for s in run(rows)["sessions"]] == ["s2", "s1"]
