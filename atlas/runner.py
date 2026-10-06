"""What leaves the machine and through what. Fail-closed: nothing leaves without explicit permission."""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
from datetime import datetime, timezone

from . import agents, config, db, prompts
from .messages import msg

EXTRACTOR_VERSION = 1

# Only an explicitly listed backend counts as local. litellm alone does not mean local:
# it routes on to an external provider.
LOCAL_BACKENDS = {"ollama", "lmstudio", "llamacpp"}
EXTERNAL_BACKEND = "claude-cli"

DEFAULT_MODEL = "sonnet"
DEFAULT_EFFORT = "medium"

# Models with a 1M window without the `[1m]` suffix, measured by contextWindow in `claude -p` output:
# `claude-opus-5-5` reports 1 000 000, same as `[1m]`.
NATIVE_1M = {"claude-opus-5-5"}
WINDOW_1M = 1_000_000
WINDOW_DEFAULT = 200_000


def has_1m_window(model: str) -> bool:
    return model.endswith("[1m]") or model in NATIVE_1M


def _models() -> dict:
    """Model and effort for the task, from settings. Classification runs in batches, so it uses low;
    description and handoff run one at a time, on a button press."""
    out = {}
    for kind, value in (config.get("models") or {}).items():
        if isinstance(value, (list, tuple)) and len(value) == 2 and all(isinstance(v, str) and v for v in value):
            out[kind] = (value[0], value[1])
    return out

# Send budget in characters (≈ divide by 4 for tokens). A handoff takes almost the whole window;
# a short description does not need that much.
# Measured on a real session: 2 798 964 characters gave 1 315 799 tokens, i.e. ~2.1 characters
# per token. Dividing by 4, as for English, is wrong: Cyrillic costs twice as much.
CHARS_PER_TOKEN = 2.1

# Budget in tokens, with headroom for the prompt template and the answer (window limit is 1M).
TOKEN_BUDGET = {
    "handoff": 750_000,
    "catalog_summary": 50_000,
}
DEFAULT_TOKEN_BUDGET = 20_000


def budget_chars(artifact_kind: str, scale: float = 1.0) -> int:
    tokens = TOKEN_BUDGET.get(artifact_kind, DEFAULT_TOKEN_BUDGET)
    # Budgets assume a 1M window; a model with a standard window gets the same share of its own.
    window = WINDOW_1M if has_1m_window(model_for(artifact_kind)[0]) else WINDOW_DEFAULT
    return int(tokens * window / WINDOW_1M * CHARS_PER_TOKEN * scale)

# A preview cannot show 3 MB whole: return the head and tail, put the full text in a file.
PREVIEW_HEAD = 6_000
PREVIEW_TAIL = 2_000


def model_for(artifact_kind: str) -> tuple[str, str]:
    """With force_1m set, models without a native 1M window get the [1m] suffix. Not every plan
    has it, so it is off by default."""
    model, effort = _models().get(artifact_kind, (DEFAULT_MODEL, DEFAULT_EFFORT))
    if config.get("force_1m") and not has_1m_window(model):
        model += "[1m]"
    return model, effort

ASSISTANT_SAMPLE = 60


class EgressDenied(RuntimeError):
    pass


class LlmDisabled(EgressDenied):
    """AI features are off in settings: no request goes to the model."""


def llm_enabled() -> bool:
    return config.get("llm_enabled") is True


def require_llm() -> None:
    if not llm_enabled():
        raise LlmDisabled(msg("server.llm_off"))


class PromptTooLong(RuntimeError):
    """The window did not fit after all: the character-based estimate depends on language and content."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# launchd does not inherit the user's PATH: without this, a server under launchd cannot find
# claude in ~/.local/bin, and classification fails with "claude not found in PATH" on every batch.
CLAUDE_CANDIDATES = (
    "~/.local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
)


def find_claude() -> str:
    configured = config.get("claude_bin")
    if configured and os.access(os.path.expanduser(configured), os.X_OK):
        return os.path.expanduser(configured)
    found = shutil.which("claude")
    if found:
        return found
    for candidate in CLAUDE_CANDIDATES:
        path = os.path.expanduser(candidate)
        if os.access(path, os.X_OK):
            return path
    raise RuntimeError(msg("runner.no_claude", paths=", ".join(CLAUDE_CANDIDATES)))


def runner_cwd() -> str:
    """Separate folder: the compressor's transcript lands under its own slug and the indexer skips it."""
    path = os.path.join(db.atlas_home(), "runner")
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def _sample(items: list[str], limit: int) -> list[str]:
    """Evenly across the whole session, not head and tail: the decision usually sits in the middle."""
    if len(items) <= limit:
        return items
    step = len(items) / limit
    return [items[int(i * step)] for i in range(limit)]


def _tail_within(items: list[str], budget: int) -> list[str]:
    """Take from the end while it fits: "the last part of the session" is the tail, not the start."""
    out, used = [], 0
    for text in reversed(items):
        cost = len(text) + 2
        if used + cost > budget:
            break
        out.append(text)
        used += cost
    out.reverse()
    return out


def build_payload(conn: sqlite3.Connection, session_id: str,
                  artifact_kind: str = "handoff", scale: float = 1.0) -> dict:
    """Exactly the text that will leave the machine.

    Priority order: compaction summaries and user prompts go in whole, since they carry
    the goal and decisions and weigh little. The rest of the budget is filled with assistant
    replies, starting from the end.
    """
    row = conn.execute(
        "SELECT source_path, title, started_at, last_activity_at, cwd_last, branch_last, "
        "human_turns, content_hash, agent FROM sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    if row is None:
        raise LookupError(msg("runner.no_session", sid=session_id))

    budget = budget_chars(artifact_kind, scale)
    facts = agents.parse_session(row["source_path"], session_id, row["agent"])
    files = [r["resolved_path"] for r in conn.execute(
        "SELECT resolved_path FROM session_files WHERE session_id=?", (session_id,))]
    links = [f"{r['kind']}: {r['url']}" for r in conn.execute(
        "SELECT kind, url FROM session_links WHERE session_id=?", (session_id,))]
    tickets = [r["ticket"] for r in conn.execute(
        "SELECT ticket FROM session_tickets WHERE session_id=?", (session_id,))]

    # Labels use the page language: the preview shows exactly the text that will leave the machine.
    header = "\n".join([
        msg("fact.session", sid=session_id),
        msg("fact.title", value=row["title"]),
        msg("fact.period", start=row["started_at"], end=row["last_activity_at"]),
        msg("fact.folder", cwd=row["cwd_last"], branch=row["branch_last"]),
        msg("fact.turns", value=row["human_turns"]),
        msg("fact.tickets", value=", ".join(tickets) or "—"),
        msg("fact.files_n", n=len(files), value=", ".join(files[:80]) or "—"),
        msg("fact.links", value=", ".join(links) or "—"),
    ])

    sections, used = [((msg("payload.header"), 1, len(header)))], len(header)
    blocks = [header]

    def take(title: str, items: list[str], joiner: str = "\n\n") -> None:
        nonlocal used
        if not items:
            return
        kept = _tail_within(items, max(0, budget - used))
        if not kept:
            return
        text = f"\n## {title}\n" + joiner.join(kept)
        blocks.append(text)
        used += len(text)
        sections.append((title, len(kept), len(text)))

    t_summaries, t_prompts = msg("payload.summaries"), msg("payload.prompts")
    t_answers, t_commands = msg("payload.answers"), msg("payload.commands")
    take(t_summaries, facts.summaries)
    take(t_prompts, facts.user_text)
    take(t_answers, facts.assistant_text)
    take(t_commands, facts.commands, joiner="\n")

    text = "\n".join(blocks)
    dropped = {
        "summaries": len(facts.summaries),
        "prompts": len(facts.user_text),
        "answers": len(facts.assistant_text),
        "commands": len(facts.commands),
    }
    kept = {title: count for title, count, _ in sections}
    # "Truncated" means lost pieces, not hitting the budget: commands may not fit
    # even when the total is slightly under the cap.
    truncated = (kept.get(t_summaries, 0) < dropped["summaries"]
                 or kept.get(t_prompts, 0) < dropped["prompts"]
                 or kept.get(t_answers, 0) < dropped["answers"]
                 or kept.get(t_commands, 0) < dropped["commands"])
    return {
        "session_id": session_id,
        "content_hash": row["content_hash"],
        "text": text,
        "chars": len(text),
        "budget": budget,
        "estimated_tokens": int(len(text) / CHARS_PER_TOKEN),
        "truncated": truncated,
        "sections": [{"title": t, "items": c, "chars": n} for t, c, n in sections],
        "totals": dropped,
        "kept": kept,
    }


def sensitivity_of(conn: sqlite3.Connection, session_id: str) -> str:
    override = conn.execute(
        "SELECT sensitivity FROM user_overrides WHERE session_id=?", (session_id,)
    ).fetchone()
    if override and override["sensitivity"]:
        return override["sensitivity"]
    row = conn.execute(
        "SELECT sensitivity_rule FROM sessions WHERE session_id=?", (session_id,)
    ).fetchone()
    return (row["sensitivity_rule"] if row else None) or "unclassified"


def grant_egress(conn: sqlite3.Connection, session_id: str, content_hash: str,
                 artifact_kind: str, backend: str, model: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO egress_grants (session_id, content_hash, artifact_kind, "
        "backend, model, granted_at) VALUES (?,?,?,?,?,?)",
        (session_id, content_hash, artifact_kind, backend, model, _now()),
    )
    conn.commit()


def check_egress(conn: sqlite3.Connection, session_id: str, content_hash: str,
                 artifact_kind: str, backend: str, model: str) -> None:
    """The grant is tied to the content state: any append invalidates it."""
    if backend in LOCAL_BACKENDS:
        return
    sensitivity = sensitivity_of(conn, session_id)
    grant = conn.execute(
        "SELECT granted_at FROM egress_grants WHERE session_id=? AND content_hash=? "
        "AND artifact_kind=? AND backend=? AND model=?",
        (session_id, content_hash, artifact_kind, backend, model),
    ).fetchone()
    if grant:
        return
    raise EgressDenied(msg("runner.egress_denied", sensitivity=sensitivity,
                           backend=backend, model=model))


# Above this size, check the flags first with a cheap call: otherwise an error in them
# shows up only after megabytes are sent.
PREFLIGHT_ABOVE = 200_000


def _argv(binary: str, model: str, effort: str) -> list[str]:
    return [
        binary, "-p",
        "--model", model,
        "--effort", effort,
        "--setting-sources", "",
        "--strict-mcp-config", "--mcp-config", json.dumps({"mcpServers": {}}),
        "--allowed-tools", "",
        "--disallowed-tools", "Bash,Read,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task",
        "--output-format", "text",
    ]


def preflight(model: str = "claude-haiku-4-5-20251001", effort: str = "low") -> None:
    """A tiny run with the same flags: catches a broken invocation before the expensive send."""
    binary = find_claude()
    env = dict(os.environ)
    env.pop("CLAUDE_EFFORT", None)
    env.pop("ANTHROPIC_API_KEY", None)
    proc = subprocess.run(_argv(binary, model, effort), input=msg("runner.preflight_prompt", prompts.lang()),
                          capture_output=True, text=True, timeout=120,
                          cwd=runner_cwd(), env=env)
    if proc.returncode != 0:
        raise RuntimeError(msg("runner.preflight_failed",
                               detail=(proc.stderr or "").strip()[:300]))


def run_isolated(prompt: str, model: str = DEFAULT_MODEL, effort: str = DEFAULT_EFFORT,
                 timeout: int = 900) -> str:
    """`claude -p` without settings, hooks, plugins, MCP and tools: otherwise the compressor loads
    your environment and creates transcripts of its own."""
    require_llm()                  # last line of defense: every model call passes through here
    binary = find_claude()
    if len(prompt) > PREFLIGHT_ABOVE:
        preflight(effort=effort)
    argv = _argv(binary, model, effort)
    env = dict(os.environ)
    env.pop("CLAUDE_EFFORT", None)      # the level is set by a flag; the environment variable would interfere
    env.pop("ANTHROPIC_API_KEY", None)
    proc = subprocess.run(argv, input=prompt, capture_output=True, text=True,
                          timeout=timeout, cwd=runner_cwd(), env=env)
    if proc.returncode != 0:
        # The reason comes in stdout: with an empty stderr, a bare "returned an error" is useless.
        detail = ((proc.stderr or "").strip() or (proc.stdout or "").strip()
                  or msg("runner.cli_error"))
        if "Prompt is too long" in detail:
            raise PromptTooLong(detail[:300])
        raise RuntimeError(detail[:500])
    return proc.stdout.strip()


def preview_payload(conn: sqlite3.Connection, session_id: str, artifact_kind: str) -> dict:
    """3 MB cannot be shown: return the head and tail, write the full text to a file for checking."""
    payload = build_payload(conn, session_id, artifact_kind)
    text = payload["text"]
    if len(text) > PREVIEW_HEAD + PREVIEW_TAIL:
        shown = (text[:PREVIEW_HEAD]
                 + msg("payload.skipped", n=f"{len(text) - PREVIEW_HEAD - PREVIEW_TAIL:,}")
                 + text[-PREVIEW_TAIL:])
    else:
        shown = text
    folder = os.path.join(db.atlas_home(), "payloads")
    os.makedirs(folder, mode=0o700, exist_ok=True)
    path = os.path.join(folder, f"{session_id}.{artifact_kind}.txt")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(path, 0o600)
    return {**payload, "text": shown, "full_path": path}
