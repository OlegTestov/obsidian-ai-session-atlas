"""AI features through Codex: one `codex exec` per request, as isolated as `claude -p` in runner.py.

`--ephemeral` keeps the run out of the Codex session list (and out of the catalog), `--ignore-user-config`
skips config.toml — its MCP servers, hooks and profiles — while Codex's own login still applies,
`--ignore-rules` skips exec-policy rules, `--disable hooks` keeps hooks.json out, Codex's own tools are
off (NO_TOOLS), and a read-only sandbox in an empty folder of our own. The prompt goes on stdin; the
last message comes back through `-o`.
Extra `-c key=value` overrides (a provider, a model) come from `codex_exec_config` in config.json.
"""
from __future__ import annotations

import json
import os
import tempfile

from . import codex_app, config
from .messages import msg

DEFAULT_MODEL = "default"          # Codex picks its own default model
EFFORTS = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "high"}
DEFAULT_EFFORT = {"classification": "low", "catalog_summary": "low", "handoff": "medium"}


class TooLong(RuntimeError):
    """The input did not fit the model's window: the caller retries with less (runner.PromptTooLong)."""


# Codex's own tools are off: a transcript is untrusted text and must not make the model run a command, read
# a file, search the web or start an agent; nor is it told about your skills. Left on in 0.167:
# request_user_input, refused in exec mode.
# An unknown name makes codex exit with "Unknown feature flag": it fails closed, never runs with tools.
NO_TOOLS = ("shell_tool", "unified_exec", "multi_agent", "goals", "view_image", "apps", "plugins",
            "image_generation", "browser_use", "computer_use")

# Codex 0.167: "Codex ran out of room in the model's context window…"; the API's own code as a fallback.
TOO_LONG = ("context window", "context_length_exceeded", "maximum context length")


def model_for(artifact_kind: str) -> tuple[str, str]:
    """`codex_model` in config.json: [model, effort]; an empty model means Codex's default."""
    value = config.get("codex_model")
    model, effort = DEFAULT_MODEL, DEFAULT_EFFORT.get(artifact_kind, "medium")
    if isinstance(value, (list, tuple)) and len(value) == 2:
        model = str(value[0] or "").strip() or DEFAULT_MODEL
        effort = str(value[1] or "").strip() or effort
    return model, effort


def model_label(model: str) -> str:
    return msg("runner.codex_default_model") if model == DEFAULT_MODEL else model


def argv(binary: str, cwd: str, out: str, model: str, effort: str, schema: str | None) -> list[str]:
    args = [binary, "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--disable", "hooks",
            *[a for f in NO_TOOLS for a in ("--disable", f)], "-c", 'web_search="disabled"',
            "-c", "skills.include_instructions=false",       # no skill list from ~/.agents or CODEX_HOME
            "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", "-C", cwd, "-o", out,
            "-c", f"model_reasoning_effort={EFFORTS.get(effort, 'medium')}"]
    if model != DEFAULT_MODEL:
        args += ["-m", model]
    if schema:
        args += ["--output-schema", schema]
    for item in config.get("codex_exec_config") or []:
        if isinstance(item, str) and "=" in item:
            args += ["-c", item]
    return [*args, "-"]                      # "-": the prompt comes on stdin, never on the command line


def run(prompt: str, cwd: str, model: str, effort: str, timeout: int, schema: dict | None = None) -> str:
    """The model's last message; raises RuntimeError with Codex's own reason on failure."""
    binary = codex_app.find_codex()
    if not binary:
        raise RuntimeError(msg("runner.no_codex"))
    with tempfile.TemporaryDirectory(prefix="atlas-codex-") as tmp:
        out = os.path.join(tmp, "last.txt")
        schema_path = None
        if schema:
            schema_path = os.path.join(tmp, "schema.json")
            with open(schema_path, "w", encoding="utf-8") as fh:
                json.dump(schema, fh)
        proc = codex_app.run_group(argv(binary, cwd, out, model, effort, schema_path), timeout, cwd,
                                   input=prompt)
        try:
            with open(out, encoding="utf-8") as fh:
                text = fh.read().strip()
        except OSError:
            text = ""
    if proc.returncode != 0 or not text:
        lines = [x for x in (proc.stderr or "").strip().splitlines() if x.strip()]
        detail = " ".join(lines[-3:]) or (proc.stdout or "").strip() or msg("runner.codex_error")
        if any(marker in detail.lower() for marker in TOO_LONG):
            raise TooLong(detail[:300])
        raise RuntimeError(detail[:500])
    return text


SUMMARY_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["did", "result", "open", "work_outcome"],
    "properties": {"did": {"type": "string"}, "result": {"type": "string"},
                   "open": {"type": ["string", "null"]},
                   "work_outcome": {"type": "string", "enum": ["done", "blocked", "in_progress", "unknown"]}},
}

# The prompt asks for an array; a schema's root must be an object, and parse_batch finds the array inside.
CLASSIFY_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["sessions"],
    "properties": {"sessions": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["n", "domain", "topic", "summary", "confidence"],
        "properties": {"n": {"type": "integer"}, "domain": {"type": ["string", "null"]},
                       "topic": {"type": "string"}, "summary": {"type": "string"},
                       "confidence": {"type": "number"}}}}},
}
