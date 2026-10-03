#!/bin/zsh
set -u

APP="${1:-}"
INSTANCE="${2:-}"
# Optional start for tabs from Session Atlas: what to begin with while the tab has no registry
# entry. The entry wins: after an Obsidian restart the tab returns to the session it was last in,
# not the one it was opened with.
#   resume <id> · resume-fork <id> · new <id> [first prompt]
SEED_MODE="${3:-}"
SEED_ID="${4:-}"
SEED_PROMPT="${5:-}"
case "$APP" in
  claude|codex|list) ;;
  *)
    print -u2 "Usage: $0 claude|codex|list <terminal-instance> [resume|resume-fork|new <session-id> [prompt]]"
    exit 64
    ;;
esac
case "$SEED_MODE" in
  ""|resume|resume-fork|new) ;;
  *)
    print -u2 "Unknown start mode: $SEED_MODE"
    exit 64
    ;;
esac

SCRIPT_DIR="${0:A:h}"
source "$SCRIPT_DIR/agent-registry-lib.zsh"

CODEX_SESSIONS_DIR="${OBS_AGENT_TERMINAL_CODEX_SESSIONS_DIR:-$HOME/.codex/sessions}"
# Extra agent arguments: one line in a file the plugin writes from its settings (e.g. "--chrome").
# A file rather than an environment variable, so tabs opened earlier see it too.
AGENT_ARGS_DIR="${OBS_AGENT_TERMINAL_ARGS_DIR:-$HOME/Library/Application Support/session-atlas/agent-args}"

extra_args() {
  local line=""
  [[ -r "$AGENT_ARGS_DIR/$1" ]] && line="$(<"$AGENT_ARGS_DIR/$1")"
  reply=()
  [[ -n "${line//[[:space:]]/}" ]] || return 0
  # Words follow shell rules (quotes work) without expansions: (z) only splits.
  reply=("${(@Q)${(z)line}}")
}
CLAUDE_PROJECTS_DIR="${OBS_AGENT_TERMINAL_CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"

valid_instance() {
  [[ "$1" =~ '^[A-Za-z0-9_.-]{1,96}$' ]]
}

valid_uuid() {
  [[ "$1" =~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ]]
}

list_sessions() {
  if [[ ! -s "$REGISTRY" ]]; then
    print "No managed Obsidian agent resume mappings."
    return 0
  fi

  awk -F '\t' -v vault="$VAULT_ROOT" '
    $4 == vault {
      printf "%-6s instance=%s session=%s updated=%s\n", $1, $2, $3, $5
    }
  ' "$REGISTRY"
}

claude_project_slug() {
  print -r -- "$VAULT_ROOT" | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g'
}

new_uuid() {
  /usr/bin/uuidgen | tr '[:upper:]' '[:lower:]'
}

codex_session_id_from_file() {
  local file="$1"
  local first_line=""
  IFS= read -r first_line < "$file" 2>/dev/null || return 1
  [[ "$first_line" == *'"type":"session_meta"'* ]] || return 1
  [[ "$first_line" == *"\"cwd\":\"$VAULT_ROOT\""* ]] || return 1
  print -r -- "$first_line" | sed -n 's/.*"payload":{"id":"\([^"]*\)".*/\1/p'
}

codex_session_exists() {
  local wanted="$1"
  local file session_id

  [[ -d "$CODEX_SESSIONS_DIR" ]] || return 1
  while IFS= read -r file; do
    session_id="$(codex_session_id_from_file "$file" 2>/dev/null || true)"
    [[ "$session_id" == "$wanted" ]] && return 0
  done < <(find "$CODEX_SESSIONS_DIR" -type f -name '*.jsonl' 2>/dev/null)

  return 1
}

latest_new_codex_session_id() {
  local start_epoch="$1"
  local best_created=0
  local best_id=""
  local file created session_id

  [[ -d "$CODEX_SESSIONS_DIR" ]] || return 1
  while IFS= read -r file; do
    created="$(stat -f %B "$file" 2>/dev/null || print 0)"
    [[ "$created" == <-> ]] || created=0
    (( created > 0 )) || created="$(stat -f %m "$file" 2>/dev/null || print 0)"
    (( created >= start_epoch )) || continue
    (( created >= best_created )) || continue
    session_id="$(codex_session_id_from_file "$file")"
    [[ -n "$session_id" ]] || continue
    session_id_is_claimed codex "$session_id" && continue
    best_created="$created"
    best_id="$session_id"
  done < <(find "$CODEX_SESSIONS_DIR" -type f -name '*.jsonl' 2>/dev/null)

  [[ -n "$best_id" ]] || return 1
  print "$best_id"
}

watch_codex_session_id() {
  local instance="$1"
  local start_epoch="$2"
  local session_id=""
  local i

  for i in $(seq 1 120); do
    session_id="$(latest_new_codex_session_id "$start_epoch" 2>/dev/null || true)"
    if [[ -n "$session_id" ]]; then
      upsert_resume_id codex "$instance" "$session_id"
      return 0
    fi
    sleep 0.5
  done
}

# Any project folder: a tab from Session Atlas can open outside the vault too.
claude_session_exists() {
  local session_id="$1"
  valid_uuid "$session_id" || return 1
  local -a found=("$CLAUDE_PROJECTS_DIR"/*/"$session_id".jsonl(N))
  (( ${#found} > 0 ))
}

# The hook that records the tab's current session in the registry goes through --settings: only the
# vault has project settings, while the tab may run in any folder. Hooks from --settings add to the
# project ones instead of replacing them (checked on the CLI).
hook_settings() {
  local hook="$SCRIPT_DIR/agent-session-hook.zsh"
  local cmd="${(qqq)hook}"
  cmd="${cmd//\\/\\\\}"
  cmd="${cmd//\"/\\\"}"
  local entry="[{\"hooks\":[{\"type\":\"command\",\"command\":\"$cmd\",\"timeout\":5}]}]"
  print -r -- "{\"hooks\":{\"SessionStart\":$entry,\"UserPromptSubmit\":$entry}}"
}

run_claude() {
  local instance="$1"
  local session_id
  session_id="$(get_resume_id claude "$instance")"

  # Exported so the SessionStart/UserPromptSubmit hook (agent-session-hook.zsh)
  # can write the session Claude is ACTUALLY in back into the registry for this tab.
  export OBS_AGENT_KIND="claude"
  export OBS_AGENT_INSTANCE="$instance"
  export OBS_AGENT_TERMINAL_STATE_DIR="$STATE_DIR"
  export OBS_AGENT_TERMINAL_VAULT_ROOT="$VAULT_ROOT"

  local -a reply
  extra_args claude
  local -a flags=("${reply[@]}" --settings "$(hook_settings)")

  if [[ -n "$session_id" ]] && claude_session_exists "$session_id"; then
    print "Resuming Claude Code session: $session_id"
    claude "${flags[@]}" --resume "$session_id"
  elif [[ -z "$session_id" && "$SEED_MODE" == resume* ]] && claude_session_exists "$SEED_ID"; then
    upsert_resume_id claude "$instance" "$SEED_ID"
    if [[ "$SEED_MODE" == resume-fork ]]; then
      # The fork's id is unknown in advance: the hook records it when the session starts.
      print "Forking Claude Code session: $SEED_ID"
      claude "${flags[@]}" --resume "$SEED_ID" --fork-session
    else
      print "Resuming Claude Code session: $SEED_ID"
      claude "${flags[@]}" --resume "$SEED_ID"
    fi
  elif [[ -z "$session_id" && "$SEED_MODE" == new ]] && valid_uuid "$SEED_ID" \
      && ! claude_session_exists "$SEED_ID"; then
    upsert_resume_id claude "$instance" "$SEED_ID"
    print "Starting Claude Code session: $SEED_ID"
    if [[ -n "$SEED_PROMPT" ]]; then
      claude "${flags[@]}" --session-id "$SEED_ID" "$SEED_PROMPT"
    else
      claude "${flags[@]}" --session-id "$SEED_ID"
    fi
  else
    if [[ -n "$session_id" ]]; then
      print "⚠ Mapped session $session_id has no saved transcript on disk — starting a fresh session."
    fi
    session_id="$(new_uuid)"
    upsert_resume_id claude "$instance" "$session_id"
    print "Starting Claude Code session: $session_id"
    claude "${flags[@]}" --session-id "$session_id"
  fi
}

run_codex() {
  local instance="$1"
  local start_epoch="$2"
  local session_id
  session_id="$(get_resume_id codex "$instance")"

  # Exported so the Codex SessionStart/UserPromptSubmit hook (agent-session-hook.zsh)
  # records the session Codex is ACTUALLY in — including one resumed inside the tab,
  # which the file-discovery fallback below cannot catch.
  export OBS_AGENT_KIND="codex"
  export OBS_AGENT_INSTANCE="$instance"
  export OBS_AGENT_TERMINAL_STATE_DIR="$STATE_DIR"
  export OBS_AGENT_TERMINAL_VAULT_ROOT="$VAULT_ROOT"

  local -a reply
  extra_args codex
  local -a flags=("${reply[@]}")

  if [[ -n "$session_id" ]] && codex_session_exists "$session_id"; then
    print "Resuming Codex session: $session_id"
    codex "${flags[@]}" resume "$session_id"
  else
    watch_codex_session_id "$instance" "$start_epoch" &!
    codex "${flags[@]}"
    session_id="$(latest_new_codex_session_id "$start_epoch" 2>/dev/null || true)"
    if [[ -n "$session_id" ]]; then
      upsert_resume_id codex "$instance" "$session_id"
    fi
  fi
}

if [[ "$APP" == "list" ]]; then
  list_sessions
  exit 0
fi

if [[ -z "$INSTANCE" ]]; then
  INSTANCE="${APP}-$(date +%s)-$(new_uuid)"
fi
if ! valid_instance "$INSTANCE"; then
  print -u2 "Invalid $APP terminal instance id: $INSTANCE"
  exit 64
fi

START_EPOCH="$(date +%s)"

case "$APP" in
  claude) print "Starting Claude Code terminal instance: $INSTANCE" ;;
  codex) print "Starting Codex terminal instance: $INSTANCE" ;;
esac

case "$APP" in
  claude) run_claude "$INSTANCE" ;;
  codex) run_codex "$INSTANCE" "$START_EPOCH" ;;
esac

# The agent may exit without restoring the terminal (mouse captured so selection fails, bracketed
# paste, alternate screen). Reset to the state before it started.
printf '\e[?1000l\e[?1002l\e[?1003l\e[?1006l\e[?1004l\e[?2004l\e[?1049l\e[?25h'

# Tests and automation: no shell after the agent exits.
[[ -n "${OBS_AGENT_TERMINAL_NO_SHELL:-}" ]] && exit 0
print
print "Agent exited. This shell is kept open for manual commands."
exec zsh -l -i
