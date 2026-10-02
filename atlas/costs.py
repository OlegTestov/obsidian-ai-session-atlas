"""Стоимость сессии: что записал Claude Code при выходе и оценка «сейчас» по токенам.

Claude Code пишет `cost-state` только при выходе из процесса. У живой сессии это сумма на
момент прошлого выхода; всё, что после, досчитывается по `message.usage` ответов.
Цены сверены с его же записями `cost-state` по всем сессиям: медианная ошибка 0%.
"""
from __future__ import annotations

import glob
import json
import os
import re

# Базовые цены за миллион токенов: вход, выход, множитель чтения кэша.
# Запись в кэш: на 5 минут — ×1.25 входа, на час — ×2 (у каждого ответа своя разбивка).
PRICES = {
    "claude-opus-5-5": (4.0, 20.0, 0.05),
    "claude-opus-5": (5.0, 25.0, 0.1),
    "claude-opus-4-8": (5.0, 25.0, 0.1),
    "claude-opus-4-7": (5.0, 25.0, 0.1),
    "claude-opus-4-6": (5.0, 25.0, 0.1),
    "claude-sonnet-5": (2.0, 10.0, 0.1),
    "claude-sonnet-4-6": (3.0, 15.0, 0.1),
    "claude-haiku-4-5": (1.0, 5.0, 0.1),
    "claude-fable-5-1": (10.0, 50.0, 0.025),
    "claude-fable-5": (10.0, 50.0, 0.025),
}
WRITE_5M, WRITE_1H = 1.25, 2.0
_SUFFIX = re.compile(r"(\[1m\]|-\d{8})$")

COST_MARK = b'"cost-state"'
USAGE_MARK = b'"usage"'
_TS_RE = re.compile(rb'"timestamp"\s*:\s*"([^"]{10,40})"')

# путь → (inode, просмотрено байт, сумма, id ответов, неизвестные модели, записано, когда)
_cache: dict[str, tuple] = {}


def price_for(model: str | None):
    if not model:
        return None
    base = _SUFFIX.sub("", model)
    return PRICES.get(base) or PRICES.get(_SUFFIX.sub("", base))


def message_cost(model: str | None, usage: dict) -> float | None:
    """Стоимость одного ответа модели так, как её считает Claude Code."""
    price = price_for(model)
    if price is None:
        return None
    pin, pout, read = price
    split = usage.get("cache_creation") or {}
    write_5m = split.get("ephemeral_5m_input_tokens")
    write_1h = split.get("ephemeral_1h_input_tokens")
    if write_5m is None and write_1h is None:            # старые записи без разбивки
        write_5m, write_1h = usage.get("cache_creation_input_tokens") or 0, 0
    tokens = ((usage.get("input_tokens") or 0) * pin
              + (usage.get("output_tokens") or 0) * pout
              + (usage.get("cache_read_input_tokens") or 0) * pin * read
              + (write_5m or 0) * pin * WRITE_5M + (write_1h or 0) * pin * WRITE_1H)
    return tokens / 1e6


SYNTHETIC = "<synthetic>"


WINDOW_DEFAULT = 200_000
WINDOW_1M = 1_000_000
NATIVE_1M = {"claude-opus-5-5"}      # окно 1M без суффикса [1m] — как в runner


def context_window(model: str | None, tokens: int | None) -> int:
    """Окно модели. Суффикса [1m] в транскрипте нет — больше 200k занято, значит окно 1M."""
    if tokens and tokens > WINDOW_DEFAULT:
        return WINDOW_1M
    return WINDOW_1M if model and _SUFFIX.sub("", model) in NATIVE_1M else WINDOW_DEFAULT


def context_tokens(usage: dict) -> int:
    """Сколько занято в окне на этом запросе: вход целиком — свежий, из кэша и в кэш."""
    return sum(int(usage.get(k) or 0) for k in
               ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))      # служебные ответы самого Claude Code, токенов в них нет


def _scan(blob: bytes, state: list) -> None:
    """Полная сумма по ответам, досчёт после последней cost-state и сама запись."""
    total, after, seen, unknown, recorded, stamp, last_ts, rows, ctx, model = state
    for raw in blob.split(b"\n"):
        if COST_MARK in raw:
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            if rec.get("type") == "cost-state" and rec.get("totalCostUSD") is not None:
                recorded, stamp, after = float(rec["totalCostUSD"]), last_ts, 0.0
            continue
        match = _TS_RE.search(raw)
        if match:
            last_ts = match.group(1).decode("ascii", "replace")
        if USAGE_MARK not in raw:
            continue
        try:
            rec = json.loads(raw)
        except ValueError:
            continue
        msg = rec.get("message") if isinstance(rec, dict) else None
        if rec.get("type") != "assistant" or not isinstance(msg, dict) or not msg.get("usage"):
            continue
        key = msg.get("id") or rec.get("uuid")
        if key in seen or msg.get("model") == SYNTHETIC:
            continue                     # один ответ пишется несколькими строками — по блоку
        seen.add(key)
        if not rec.get("isSidechain"):
            ctx, model = context_tokens(msg["usage"]), msg.get("model")
        cost = message_cost(msg.get("model"), msg["usage"])
        if cost is None:
            unknown.add(msg.get("model") or "?")
            continue
        total += cost
        after += cost
        if rows is not None:
            rows.append((rec.get("timestamp") or "", cost))
    state[:] = [total, after, seen, unknown, recorded, stamp, last_ts, rows, ctx, model]


def _file_state(path: str, keep_rows: bool = False) -> list | None:
    try:
        st = os.stat(path)
    except OSError:
        return None
    cached = _cache.get(path)
    if cached and cached[0] == st.st_ino and cached[1] <= st.st_size:
        begin, state = cached[1], list(cached[2:])
    else:
        begin, state = 0, [0.0, 0.0, set(), set(), None, None, None, [] if keep_rows else None,
                           None, None]
    if begin < st.st_size:
        try:
            with open(path, "rb") as fh:
                fh.seek(begin)
                blob = fh.read()
        except OSError:
            return None
        end = blob.rfind(b"\n") + 1          # недописанную строку оставим следующему разу
        _scan(blob[:end], state)
        begin += end
    _cache[path] = (st.st_ino, begin, *state)
    return state


def session_cost(path: str | None) -> dict:
    """{recorded, recorded_at, now, partial}.

    now — последняя сумма Claude Code плюс ответы после неё (свои и сабагентов): так число
    сопоставимо с тем, что он сам показывает. Полная сумма по токенам с ним не сходится у
    возобновлённых сессий (втрое больше), поэтому она — только пока записи ещё нет.
    Бэктест по соседним записям: медиана −3.9%; выбросы — от параллельных копий сессии.
    """
    empty = {"recorded": None, "recorded_at": None, "now": None, "partial": False,
             "context_tokens": None, "context_model": None}
    if not path:
        return empty
    main = _file_state(path)
    if main is None:
        return empty
    total, after, _, unknown, recorded, stamp = main[:6]
    unknown = set(unknown)
    folder = os.path.join(path[:-len(".jsonl")], "subagents")
    sub_total = sub_after = 0.0
    for sub in glob.glob(os.path.join(glob.escape(folder), "*.jsonl")):
        state = _file_state(sub, keep_rows=True)
        if not state:
            continue
        unknown |= state[3]
        sub_total += state[0]
        sub_after += sum(c for ts, c in state[7] or [] if stamp and ts > stamp)
    if recorded is not None:
        now = recorded + after + sub_after
    else:
        now = (total + sub_total) or None
    return {"recorded": recorded, "recorded_at": stamp, "now": now, "partial": bool(unknown),
            "context_tokens": main[8], "context_model": main[9]}
