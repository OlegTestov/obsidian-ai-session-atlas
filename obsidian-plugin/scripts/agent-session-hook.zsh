#!/bin/zsh
# Claude Code hook (SessionStart + UserPromptSubmit) for the Obsidian agent terminal.
#
# Why this exists:
#   The launcher records in resume.tsv the session id IT started (claude --session-id).
#   But if you resume a DIFFERENT past conversation inside the tab, the launcher never
#   learns about it, so on the next Obsidian restart it tries to resume the wrong
#   (often empty) session and silently starts fresh.
#
#   This hook fixes that: on every session start AND on every prompt you send, it writes
#   the session id Claude is ACTUALLY in into resume.tsv, keyed by the tab's instance.
#   Whatever conversation you end up working in is what gets resumed next time.
#
# Safety: a strict no-op for anything not launched by the Obsidian agent terminal
#   (OBS_AGENT_INSTANCE unset) — nightly headless runs, sub-agents, other projects.
#   Prints nothing to stdout and always exits 0, so it never blocks a prompt.

emulate -L zsh

# Only act for tabs launched by the Obsidian agent terminal launcher.
[[ -n "${OBS_AGENT_INSTANCE:-}" && -n "${OBS_AGENT_KIND:-}" ]] || exit 0

payload="$(cat)"

# Ignore sub-agent (Task tool) sessions: their payload carries "agent_id".
# Never let a sub-agent's session id overwrite the tab's main session.
case "$payload" in
  *'"agent_id"'*) exit 0 ;;
esac

# session_id is a UUID — extract and validate strictly.
session_id="$(print -r -- "$payload" \
  | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F-]*\)".*/\1/p' \
  | head -1)"
[[ "$session_id" =~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' ]] || exit 0

script_dir="${0:A:h}"
(
  source "$script_dir/agent-registry-lib.zsh"
  upsert_resume_id "$OBS_AGENT_KIND" "$OBS_AGENT_INSTANCE" "$session_id"
) >/dev/null 2>&1 || true

exit 0
