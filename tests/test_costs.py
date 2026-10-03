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
