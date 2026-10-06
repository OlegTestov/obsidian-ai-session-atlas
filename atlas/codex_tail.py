"""The end of a Codex rollout for a live card: turn state, last reply, your unanswered prompt, tokens.

Read backwards from the tail, like `active.last_messages` for Claude Code. Lines that cannot
matter (reasoning, message items with images, tool output) are skipped by their head, undecoded.
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone

from . import codex_parse, limits
from .messages import msg

TAIL_BYTES = 256 * 1024
TAIL_MAX = 8 * 1024 * 1024
HEAD = 480
_PAYLOAD = re.compile(rb'"payload":\s*\{"type":\s*"([A-Za-z_]+)"')
_ITEM = re.compile(rb'"item":\s*\{"type":\s*"(UserMessage|AgentMessage)"')
_EVENTS = {b"user_message", b"agent_message", b"task_started", b"task_complete", b"turn_aborted",
           b"token_count"}
# The 5-hour and weekly windows get the same keys as Claude Code's, so the page labels them alike.
WINDOW_KEYS = {300: "five_hour", 10080: "seven_day"}

_cache: dict[str, tuple] = {}           # path → (inode, size, result)


def _wanted(raw: bytes) -> bool:
    head = raw[:HEAD]
    if b'"turn_context"' in head:
        return True
    m = _PAYLOAD.search(head)
    if not m:
        return False
    kind = m.group(1)
    if kind in _EVENTS:
        return True
    if kind == b"item_completed":
        return bool(_ITEM.search(head))
    return kind == b"function_call" and b'"update_plan"' in head


def _images(p: dict) -> int:
    return sum(len(p.get(k) or []) for k in ("images", "local_images") if isinstance(p.get(k), list))


def _item_images(item: dict) -> int:
    content = item.get("content")
    return sum(1 for b in content if isinstance(b, dict) and str(b.get("type", "")).lower() != "text") \
        if isinstance(content, list) else 0


def _plan(args: str) -> list[dict] | None:
    try:
        data = json.loads(args or "{}")
    except ValueError:
        return None
    steps = data.get("plan") if isinstance(data, dict) else None
    if not isinstance(steps, list):
        return None
    return [{"subject": str(s.get("step") or "")[:200], "status": str(s.get("status") or "pending")}
            for s in steps if isinstance(s, dict)]


def _empty() -> dict:
    return {"last_at": None, "reply": None, "reply_at": None, "progress": None, "progress_at": None,
            "prompt": None, "prompt_at": None, "prompt_images": 0, "interrupted_at": None,
            "status": None, "model": None, "cwd": None, "last_prompt": None, "usage": None,
            "total_usage": None, "window": None, "rate_limits": None, "rate_limits_at": None,
            "plan": None}


def _done(out: dict) -> bool:
    # Token counts follow each reply, so they are found long before the turn start is reached.
    return all(out[k] is not None for k in ("reply", "status", "model", "last_prompt"))


class _Reader:
    """Records arrive newest first."""

    def __init__(self) -> None:
        self.out = _empty()
        self.replied = False           # a reply newer than this point is already found

    def prompt(self, text: str, ts, images: int) -> None:
        text = (text or "").strip()
        if not text:
            return
        out = self.out
        out["last_at"] = out["last_at"] or ts
        out["last_prompt"] = out["last_prompt"] or text
        if not self.replied and out["prompt"] is None:      # newer than the last reply: unanswered
            out["prompt"], out["prompt_at"], out["prompt_images"] = text, ts, images

    def reply(self, text: str | None, ts) -> None:
        text = (text or "").strip()
        if not text or self.replied:
            return
        self.replied = True
        self.out["last_at"] = self.out["last_at"] or ts
        self.out["reply"], self.out["reply_at"] = text, ts

    def record(self, rec: dict) -> None:
        out, ts = self.out, rec.get("timestamp")
        p = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
        if rec.get("type") == "turn_context":
            out["model"] = out["model"] or p.get("model")
            out["cwd"] = out["cwd"] or p.get("cwd")
            return
        kind = p.get("type")
        if kind == "user_message":
            self.prompt(p.get("message"), ts, _images(p))
        elif kind == "item_completed":
            item = p.get("item") if isinstance(p.get("item"), dict) else {}
            text = codex_parse._texts(item.get("content"), "text")
            if item.get("type") == "UserMessage":
                self.prompt(text, ts, _item_images(item))
            else:
                self.reply(text, ts)
        elif kind == "agent_message":
            self.reply(p.get("message"), ts)
        elif kind in ("task_started", "task_complete", "turn_aborted"):
            if out["status"] is None:
                out["status"] = "busy" if kind == "task_started" else "idle"
            if kind == "turn_aborted" and out["last_at"] is None and out["interrupted_at"] is None:
                out["interrupted_at"] = ts
            if kind == "task_complete":
                self.reply(p.get("last_agent_message"), ts)
        elif kind == "token_count":
            info = p.get("info") if isinstance(p.get("info"), dict) else {}
            if out["usage"] is None and isinstance(info.get("last_token_usage"), dict):
                out["usage"] = info["last_token_usage"]
                out["total_usage"] = info.get("total_token_usage")
                out["window"] = info.get("model_context_window")
            rl = p.get("rate_limits")
            # Only the account-wide `codex` bucket (unnamed in older Codex): another bucket is a
            # per-model quota, and a run stopped by a spent limit reports one with null windows.
            if out["rate_limits"] is None and isinstance(rl, dict) and rl.get("limit_id") in (None, "codex") \
                    and any(isinstance(rl.get(k), dict) for k in ("primary", "secondary")):
                out["rate_limits"], out["rate_limits_at"] = rl, ts
        elif kind == "function_call" and p.get("name") == "update_plan" and out["plan"] is None:
            out["plan"] = _plan(p.get("arguments"))


def read(path: str | None) -> dict:
    """See `_empty` for the keys. A turn started without a later end means Codex is working."""
    if not path:
        return _empty()
    try:
        st = os.stat(path)
    except OSError:
        return _empty()
    cached = _cache.get(path)
    if cached and cached[:2] == (st.st_ino, st.st_size):
        return cached[2]
    reader = _Reader()
    try:
        with open(path, "rb") as fh:
            window = TAIL_BYTES
            while True:
                reader = _Reader()
                fh.seek(max(0, st.st_size - window))
                for raw in reversed(fh.read(min(window, st.st_size)).split(b"\n")):
                    if not _wanted(raw):
                        continue
                    try:
                        rec = json.loads(raw)
                    except ValueError:
                        continue      # the window's first line is cut; the last may be mid-write
                    if isinstance(rec, dict):
                        reader.record(rec)
                    if _done(reader.out):
                        break
                if _done(reader.out) or window >= st.st_size or window >= TAIL_MAX:
                    break
                window *= 4
    except OSError:
        return _empty()
    out = reader.out
    out["status"] = out["status"] or "idle"
    _cache[path] = (st.st_ino, st.st_size, out)
    return out


def context_tokens(usage: dict | None) -> int | None:
    """The window in use: everything the last request sent plus its answer, without hidden reasoning."""
    if not isinstance(usage, dict):
        return None
    total = int(usage.get("total_tokens") or 0) or \
        int(usage.get("input_tokens") or 0) + int(usage.get("output_tokens") or 0)
    return max(0, total - int(usage.get("reasoning_output_tokens") or 0)) or None


def plan_progress(plan: list[dict] | None) -> dict | None:
    """The `update_plan` checklist in the shape of Claude Code's task list on the card."""
    if not plan:
        return None
    return {"total": len(plan), "done": sum(1 for s in plan if s["status"] == "completed"),
            "active": [s["subject"] for s in plan if s["status"] == "in_progress"],
            "items": plan[:30]}


def _window_label(minutes: int) -> str:
    if minutes and minutes % 1440 == 0:
        return msg("limits.days", n=minutes // 1440)
    return msg("limits.hours", n=round(minutes / 60)) if minutes else "?"


def limit_windows(rate_limits: dict | None, captured_at: str | None, now: float | None = None) -> dict | None:
    """Codex's `rate_limits` in the shape of `limits.read_limits`: {captured_at, age_seconds, windows}."""
    if not isinstance(rate_limits, dict):
        return None
    captured = None
    if captured_at:
        try:
            captured = datetime.fromisoformat(captured_at.replace("Z", "+00:00")).timestamp()
        except ValueError:
            captured = None
    windows = []
    for name in ("primary", "secondary"):
        w = rate_limits.get(name)
        if not isinstance(w, dict) or not isinstance(w.get("used_percent"), (int, float)):
            continue
        minutes = int(w.get("window_minutes") or 0)
        key = WINDOW_KEYS.get(minutes, name)
        resets = w.get("resets_at")
        if resets is None and isinstance(w.get("resets_in_seconds"), (int, float)) and captured:
            resets = captured + w["resets_in_seconds"]          # older Codex versions
        windows.append({"key": key, "label": msg(f"limits.{key}") if key in WINDOW_KEYS.values()
                        else _window_label(minutes),
                        "used_percentage": w["used_percent"], "resets_at": limits._iso(resets)})
    if not windows:
        return None
    return {"captured_at": datetime.fromtimestamp(captured, timezone.utc).isoformat(timespec="seconds")
            if captured else None,
            "age_seconds": round((now or time.time()) - captured) if captured else None,
            "windows": windows}
