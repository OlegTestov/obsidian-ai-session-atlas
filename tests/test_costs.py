"""Session cost: the Claude Code record and the token-based "now" estimate."""
from __future__ import annotations

import os

import pytest

from atlas import costs
from tests.conftest import rec, user_text


def _answer(mid, model, ts, **usage):
    base = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0}
    base.update(usage)
    return rec(type="assistant", timestamp=ts, uuid=mid + ts,
               message={"id": mid, "role": "assistant", "model": model, "usage": base,
                        "content": [{"type": "text", "text": "ок"}]})


@pytest.fixture(autouse=True)
def _fresh_cache():
    costs._cache.clear()


def test_message_cost_matches_claude_code_rates():
    """Checked against the cost-state of a Haiku probe: 13·1 + 209·5 + 25318·0.1 + 13285·1.25 + 17794·2 = $0.055784."""
    usage = {"input_tokens": 13, "output_tokens": 209, "cache_read_input_tokens": 25318,
             "cache_creation": {"ephemeral_5m_input_tokens": 13285,
                                "ephemeral_1h_input_tokens": 17794}}
    assert costs.message_cost("claude-haiku-4-5-20251001", usage) == pytest.approx(0.05578405)
    # Opus 5.5: $4/$20, cache read ×0.05 ($0.20); the [1m] suffix has the same price
    assert costs.message_cost("claude-opus-5-5[1m]", {"cache_read_input_tokens": 1_000_000}) \
        == pytest.approx(0.20)
    assert costs.message_cost("gpt-5", {"input_tokens": 10}) is None



def test_current_sonnet_and_haiku_have_prices():
    """Matched to Claude Code's per-model costUSD (1,005 Sonnet 5.5 and 4 Haiku 5.5 single-run sessions)."""
    # Sonnet 5.5: $2/$10, cache read ×0.05 ($0.10)
    assert costs.message_cost("claude-sonnet-5-5", {"input_tokens": 1_000_000}) == pytest.approx(2.0)
    assert costs.message_cost("claude-sonnet-5-5", {"output_tokens": 1_000_000}) == pytest.approx(10.0)
    assert costs.message_cost("claude-sonnet-5-5[1m]", {"cache_read_input_tokens": 1_000_000}) \
        == pytest.approx(0.10)
    # Haiku 5.5 up to a 100K prompt: $0.10/$0.50, cache read ×0.1, writes ×1.25 / ×2
    short = {"input_tokens": 10_000, "output_tokens": 2_000, "cache_read_input_tokens": 50_000,
             "cache_creation": {"ephemeral_5m_input_tokens": 20_000, "ephemeral_1h_input_tokens": 10_000}}
    assert costs.message_cost("claude-haiku-5-5", short) == pytest.approx(
        (10_000 * 0.1 + 2_000 * 0.5 + 50_000 * 0.01 + 20_000 * 0.125 + 10_000 * 0.2) / 1e6)


def test_fable_5_2_has_its_published_price():
    """platform.claude.com pricing, 10.11.2026: $8 input, $40 output, cache read $0.20, writes $10 / $16."""
    usage = {"input_tokens": 1_000_000, "output_tokens": 1_000_000, "cache_read_input_tokens": 1_000_000,
             "cache_creation": {"ephemeral_5m_input_tokens": 1_000_000, "ephemeral_1h_input_tokens": 1_000_000}}
    assert costs.message_cost("claude-fable-5-2", usage) == pytest.approx(8 + 40 + 0.20 + 10 + 16)


def test_haiku_5_5_long_prompt_uses_the_higher_rate():
    """Above 100K prompt tokens (fresh + cache read + cache write) Haiku 5.5 is $0.50/$2.50."""
    at_limit = {"input_tokens": 100_000, "output_tokens": 1_000}
    assert costs.message_cost("claude-haiku-5-5", at_limit) == pytest.approx((100_000 * 0.1 + 1_000 * 0.5) / 1e6)
    long = {"input_tokens": 1_000, "output_tokens": 1_000, "cache_read_input_tokens": 100_000}
    assert costs.message_cost("claude-haiku-5-5", long) == pytest.approx(
        (1_000 * 0.5 + 1_000 * 2.5 + 100_000 * 0.05) / 1e6)
    # other models keep one rate at any length
    assert costs.message_cost("claude-sonnet-5-5", {"input_tokens": 500_000}) == pytest.approx(1.0)

def test_estimate_is_the_last_record_plus_answers_after_it(tmp_path):
    path = tmp_path / "s.jsonl"
    path.write_text(
        _answer("m1", "claude-sonnet-5", "2026-09-27T08:00:00.000Z", output_tokens=1_000_000)
        + user_text("дальше", ts="2026-09-27T08:30:00.000Z")
        + rec(type="cost-state", totalCostUSD=50.0)
        + _answer("m2", "claude-sonnet-5", "2026-09-27T09:00:00.000Z", input_tokens=1_000_000)
        # the same reply as a second line (next block) is not counted twice
        + _answer("m2", "claude-sonnet-5", "2026-09-27T09:00:01.000Z", input_tokens=1_000_000),
        encoding="utf-8")
    got = costs.session_cost(str(path))
    assert got["recorded"] == 50.0 and got["recorded_at"] == "2026-09-27T08:30:00.000Z"
    assert got["now"] == pytest.approx(52.0) and not got["partial"]


def test_without_a_record_the_estimate_is_all_answers(tmp_path):
    path = tmp_path / "s.jsonl"
    path.write_text(_answer("m1", "claude-opus-5-5", "2026-09-27T08:00:00.000Z",
                            output_tokens=100_000), encoding="utf-8")
    got = costs.session_cost(str(path))
    assert got["recorded"] is None and got["now"] == pytest.approx(2.0)


def test_subagent_answers_after_the_record_are_added(tmp_path):
    path = tmp_path / "s.jsonl"
    path.write_text(user_text("x", ts="2026-09-27T08:00:00.000Z")
                    + rec(type="cost-state", totalCostUSD=10.0), encoding="utf-8")
    sub = tmp_path / "s" / "subagents"
    sub.mkdir(parents=True)
    (sub / "agent-a.jsonl").write_text(
        _answer("a1", "claude-haiku-4-5", "2026-09-27T07:00:00.000Z", output_tokens=1_000_000)
        + _answer("a2", "claude-haiku-4-5", "2026-09-27T09:00:00.000Z", output_tokens=1_000_000),
        encoding="utf-8")
    assert costs.session_cost(str(path))["now"] == pytest.approx(15.0)   # only after the record


def test_synthetic_answers_are_not_an_unknown_model(tmp_path):
    path = tmp_path / "s.jsonl"
    path.write_text(_answer("m1", "<synthetic>", "2026-09-27T08:00:00.000Z", output_tokens=5)
                    + _answer("m2", "gpt-5", "2026-09-27T08:01:00.000Z", output_tokens=5),
                    encoding="utf-8")
    got = costs.session_cost(str(path))
    assert got["partial"]                              # gpt-5 has no price
    path.write_text(_answer("m1", "<synthetic>", "2026-09-27T08:00:00.000Z", output_tokens=5),
                    encoding="utf-8")
    costs._cache.clear()
    assert not costs.session_cost(str(path))["partial"]


def test_only_new_bytes_are_read_on_the_next_call(tmp_path):
    path = tmp_path / "s.jsonl"
    path.write_text(_answer("m1", "claude-sonnet-5", "2026-09-27T08:00:00.000Z",
                            output_tokens=100_000), encoding="utf-8")
    assert costs.session_cost(str(path))["now"] == pytest.approx(1.0)
    first = costs._cache[str(path)][1]
    with open(path, "a") as fh:
        fh.write(_answer("m2", "claude-sonnet-5", "2026-09-27T08:05:00.000Z",
                         output_tokens=100_000))
        fh.write('{"type":"assistant"')                  # partially written line
    assert costs.session_cost(str(path))["now"] == pytest.approx(2.0)
    assert first < costs._cache[str(path)][1] < os.path.getsize(path)


def test_no_cost_state_and_no_answers_means_no_cost(tmp_path):
    path = tmp_path / "s.jsonl"
    path.write_text(user_text("только началась"), encoding="utf-8")
    assert costs.session_cost(str(path))["now"] is None


def test_context_is_the_last_main_request_not_a_subagent(tmp_path):
    """Window usage is the input of the session's last request: fresh, cache read and cache write."""
    path = tmp_path / "s.jsonl"
    side = rec(type="assistant", timestamp="2026-09-27T10:03:00.000Z", isSidechain=True, uuid="x",
               message={"id": "m3", "role": "assistant", "model": "claude-haiku-4-5",
                        "usage": {"input_tokens": 5, "cache_read_input_tokens": 999_999},
                        "content": [{"type": "text", "text": "ок"}]})
    path.write_text(
        _answer("m1", "claude-sonnet-5", "2026-09-27T10:00:00.000Z", input_tokens=10,
                cache_read_input_tokens=50_000)
        + _answer("m2", "claude-sonnet-5", "2026-09-27T10:02:00.000Z", input_tokens=20,
                  cache_read_input_tokens=100_000, cache_creation_input_tokens=30_000,
                  output_tokens=4_000)
        + side, encoding="utf-8")
    got = costs.session_cost(str(path))
    assert got["context_tokens"] == 130_020 and got["context_model"] == "claude-sonnet-5"
    assert costs.context_window("claude-sonnet-5", 130_020) == 200_000


def test_context_window_sizes():
    assert costs.context_window("claude-opus-5-5", 10_000) == 1_000_000
    assert costs.context_window("claude-opus-5-5[1m]", 10_000) == 1_000_000
    assert costs.context_window("claude-sonnet-5", 250_000) == 1_000_000, "over 200k means 1M"
    assert costs.context_window("claude-haiku-4-5", 150_000) == 200_000
    assert costs.context_window(None, None) == 200_000


def test_replies_indexed_before_their_model_had_a_price_are_priced_later(atlas_env, write_session, monkeypatch):
    """A price added in an update reaches sessions indexed before it: they are read again once."""
    from atlas import db, index
    from tests.test_stats import answer, prompt
    write_session("p", [prompt("задача", "2026-09-01T10:00:00.000Z", "u1"),
                        answer("m1", "2026-09-01T10:01:00.000Z", model="claude-sonnet-5-5")])
    write_session("q", [prompt("другая", "2026-09-01T11:00:00.000Z", "u2"),
                        answer("m2", "2026-09-01T11:01:00.000Z", model="claude-opus-5")])
    conn = db.connect()
    priced = costs.PRICES
    monkeypatch.setattr(costs, "PRICES", {k: v for k, v in priced.items() if k != "claude-sonnet-5-5"})
    index.index_all(conn, root=str(atlas_env["projects"]))

    def cost():
        return [r[0] for r in conn.execute("SELECT cost FROM activity WHERE kind='a' ORDER BY ts")]

    assert cost()[0] is None and cost()[1] is not None
    monkeypatch.setattr(costs, "PRICES", priced)              # the update that adds the price
    first = index.index_all(conn, root=str(atlas_env["projects"]))
    assert cost()[0] == pytest.approx(costs.message_cost("claude-sonnet-5-5", {
        "input_tokens": 100, "output_tokens": 10, "cache_read_input_tokens": 1000}))
    assert first["full"] == 1, "only the session with the newly priced model is read again"
    again = index.index_all(conn, root=str(atlas_env["projects"]))
    assert again["full"] == 0 and again["skipped"] == 2
    assert db.get_meta(conn, "needs_reindex") != "1", "no full rebuild of the catalog"


def _sonnet_session(write_session, name, ts):
    from tests.test_stats import answer, prompt
    return write_session(name, [prompt("задача", ts.replace("01:00", "00:00"), "u-" + name),
                                answer("m-" + name, ts, model="claude-sonnet-5-5")])


def test_a_session_whose_file_vanished_before_repricing_still_leaves_the_catalog(atlas_env, write_session,
                                                                                    monkeypatch):
    from atlas import db, index
    path = _sonnet_session(write_session, "p", "2026-09-01T10:01:00.000Z")
    conn = db.connect()
    priced = costs.PRICES
    monkeypatch.setattr(costs, "PRICES", {k: v for k, v in priced.items() if k != "claude-sonnet-5-5"})
    index.index_all(conn, root=str(atlas_env["projects"]))
    os.remove(path)
    monkeypatch.setattr(costs, "PRICES", priced)
    stats = index.index_all(conn, root=str(atlas_env["projects"]))
    assert stats["removed"] == 1
    assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0


def test_replies_an_older_process_stores_without_a_price_are_priced_by_the_next_pass(atlas_env, write_session):
    """An old server keeps running its own code after the update: its rows come in after the reprice."""
    from atlas import db, index
    _sonnet_session(write_session, "p", "2026-09-01T10:01:00.000Z")
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("UPDATE activity SET cost = NULL")     # as the old process stores a Sonnet 5.5 reply
    conn.commit()
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert conn.execute("SELECT COUNT(*) FROM activity WHERE cost IS NULL AND model IS NOT NULL").fetchone()[0] == 0


def test_a_long_backlog_is_priced_a_batch_per_pass_newest_first(atlas_env, write_session, monkeypatch):
    from atlas import db, index
    for i, day in enumerate(("01", "02", "03")):
        _sonnet_session(write_session, f"s{i}", f"2026-09-{day}T10:01:00.000Z")
    conn = db.connect()
    priced = costs.PRICES
    monkeypatch.setattr(costs, "PRICES", {k: v for k, v in priced.items() if k != "claude-sonnet-5-5"})
    index.index_all(conn, root=str(atlas_env["projects"]))
    monkeypatch.setattr(costs, "PRICES", priced)
    monkeypatch.setattr(index, "REPRICE_BATCH", 2)

    def unpriced_days():
        return sorted(r[0][:10] for r in conn.execute(
            "SELECT ts FROM activity WHERE cost IS NULL AND model IS NOT NULL"))

    assert index.index_all(conn, root=str(atlas_env["projects"]))["full"] == 2
    assert unpriced_days() == ["2026-09-01"], "the newest sessions first"
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert unpriced_days() == []
