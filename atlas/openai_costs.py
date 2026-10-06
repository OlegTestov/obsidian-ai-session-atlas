"""API-priced cost of Codex replies: OpenAI prices per 1M tokens, priced when stats are read.

Codex writes no cost of its own, only tokens, so the cost is computed from the table below at query
time: a fixed or added price in `config.json` (`openai_prices`) shows up without a reindex.
A model missing from both stays unpriced (None), never $0.
"""
from __future__ import annotations

import re

from . import config

# Standard tier, short context, from https://developers.openai.com/api/docs/pricing (03.10.2026):
# input, cached input, cache writes (None: not billed separately), output. Reasoning tokens are
# part of output_tokens. Long-context rates (>272K input) never apply: Codex's window is 258,400.
PRICES = {
    "gpt-6.1-sol": (2.00, 0.10, 2.50, 10.00),
    "gpt-6-sol": (2.00, 0.20, 2.50, 10.00),
    "gpt-5.6-sol": (4.00, 0.40, 5.00, 20.00),      # promotional price, at least to 21.11.2026
    "gpt-5.5": (5.00, 0.50, None, 30.00),
}
FIELDS = ("input", "cached_input", "cache_write", "output")
_DATED = re.compile(r"-\d{4}-\d{2}-\d{2}$")


def _override(value):
    """`{"input": 2, "cached_input": 0.2, "output": 10}` or `[2, 0.2, 10]`; null makes it unpriced."""
    if isinstance(value, (list, tuple)) and len(value) in (3, 4):
        value = dict(zip(("input", "cached_input", "output") if len(value) == 3 else FIELDS, value))
    if not isinstance(value, dict):
        return None
    try:
        price = {k: float(value[k]) for k in FIELDS if value.get(k) is not None}
    except (TypeError, ValueError):
        return None
    return price


def price_for(model: str | None) -> dict | None:
    """{input, cached_input, cache_write, output} per 1M tokens, or None when unpriced."""
    if not model:
        return None
    name = _DATED.sub("", model)
    built_in = PRICES.get(name)
    price = dict(zip(FIELDS, built_in)) if built_in else {}
    overrides = config.get("openai_prices") or {}
    if isinstance(overrides, dict) and name in overrides:
        fixed = _override(overrides[name])
        if fixed is None:
            return None
        price.update(fixed)
    if price.get("input") is None or price.get("output") is None:
        return None
    return price


def reply_cost(model: str | None, fresh: int, cached: int, written: int, output: int) -> float | None:
    """`fresh` is input without cache reads and writes, as stored in the activity rows."""
    if not (fresh or cached or written or output):
        return 0.0              # Codex writes empty token_counts, some before any turn_context names a model
    price = price_for(model)
    if price is None:
        return None
    pin = price["input"]
    cached_price = price.get("cached_input")
    write_price = price.get("cache_write")
    total = ((fresh or 0) * pin
             + (cached or 0) * (pin if cached_price is None else cached_price)
             + (written or 0) * (pin if write_price is None else write_price)
             + (output or 0) * price["output"])
    return total / 1e6
