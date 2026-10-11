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

# Only the tab's own agent: Claude Code's background jobs run under a daemon outside the tab but
# inherit its variables, and their sessions would take the tab over after a restart.
_ancestor_of_hook() {
  local pid=$PPID ppid _ i
  for i in {1..32}; do
    [[ "$pid" == "$1" ]] && return 0
    (( pid > 1 )) || return 1
    read -r ppid _ <<< "$(ps -o ppid= -p "$pid" 2>/dev/null)"
    [[ "$ppid" == <-> ]] || return 1
    pid=$ppid
  done
  return 1
}
_background_job() {
  local dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions" pid=$PPID ppid _ i text
  for i in {1..6}; do
    if [[ -r "$dir/$pid.json" ]]; then
      text="$(<"$dir/$pid.json")"
      [[ "$text" == *'"kind":"bg"'* || "$text" == *'"kind": "bg"'* ]] && return 0
      return 1
    fi
    read -r ppid _ <<< "$(ps -o ppid= -p "$pid" 2>/dev/null)"
    [[ "$ppid" == <-> ]] && (( ppid > 1 )) || return 1
    pid=$ppid
  done
  return 1
}
if [[ -n "${OBS_AGENT_TAB_PID:-}" ]]; then
  _ancestor_of_hook "$OBS_AGENT_TAB_PID" || exit 0
fi
_background_job && exit 0

script_dir="${0:A:h}"
(
  source "$script_dir/agent-registry-lib.zsh"
  upsert_resume_id "$OBS_AGENT_KIND" "$OBS_AGENT_INSTANCE" "$session_id"
) >/dev/null 2>&1 || true

exit 0
