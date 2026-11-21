#!/bin/zsh
set -u

APP="${1:-}"
INSTANCE="${2:-}"
# Optional start for tabs from AI Session Atlas: what to begin with while the tab has no registry
# entry. The entry wins: after an Obsidian restart the tab returns to the session it was last in,
# not the one it was opened with.
#   resume <id> · resume-fork <id> · new <id> [first prompt] · attach <job id>
#   (a new Codex thread: new '' [first prompt] — Codex picks the id itself, also for a copy
#    made with resume-fork (`codex fork`); attach: a Claude Code background job, `claude attach`)
SEED_MODE="${3:-}"
SEED_ID="${4:-}"
SEED_PROMPT="${5:-}"
case "$SEED_MODE" in
  ""|resume|resume-fork|new|attach) ;;
  *)
    print -u2 "Unknown start mode: $SEED_MODE"
    exit 64
    ;;
esac

SCRIPT_DIR="${0:A:h}"
# Keep shell utilities available on an empty PATH without changing the agent's environment.
if [[ -z "$PATH" ]]; then
  hash date=/bin/date mkdir=/bin/mkdir mv=/bin/mv ps=/bin/ps rm=/bin/rm rmdir=/bin/rmdir \
       sleep=/bin/sleep awk=/usr/bin/awk cat=/bin/cat sed=/usr/bin/sed stat=/usr/bin/stat \
       tail=/usr/bin/tail touch=/usr/bin/touch tr=/usr/bin/tr seq=/usr/bin/seq
fi
source "$SCRIPT_DIR/agent-registry-lib.zsh"
source "$SCRIPT_DIR/agent-sessions-lib.zsh"
invalid_attach_seed() {
  print -u2 "Not a Claude Code background job id: $SEED_ID"
  exit 64
}

# Extra agent arguments: one line in a file the plugin writes from its settings (e.g. "--chrome").
# A file rather than an environment variable, so tabs opened earlier see it too.
AGENT_ARGS_DIR="${OBS_AGENT_TERMINAL_ARGS_DIR:-$HOME/Library/Application Support/session-atlas/agent-args}"

# Agent Mail: the MCP server Atlas bundles, as launch words the plugin keeps in one line per agent.
MAIL_ARGS_DIR="${OBS_AGENT_MAIL_ARGS_DIR:-$HOME/Library/Application Support/session-atlas/agent-mail-args}"

args_from() {
  local line=""
  [[ -r "$1/$2" ]] && line="$(<"$1/$2")"
  reply=()
  [[ -n "${line//[[:space:]]/}" ]] || return 0
  # Words follow shell rules (quotes work) without expansions: (z) only splits.
  reply=("${(@Q)${(z)line}}")
}

extra_args() { args_from "$AGENT_ARGS_DIR" "$1"; }

mail_args() { args_from "$MAIL_ARGS_DIR" "$1"; }

valid_instance() {
  [[ "$1" =~ '^[A-Za-z0-9_.-]{1,96}$' ]]
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

new_uuid() {
  /usr/bin/uuidgen | tr '[:upper:]' '[:lower:]'
}

if [[ "$APP" == "list" ]]; then
  [[ "$SEED_MODE" == attach ]] && invalid_attach_seed
  list_sessions
  exit 0
fi

load_agent_patterns || exit 64
if [[ -z "$APP" || -z "${ATLAS_ID_PATTERNS[$APP]-}" ]]; then
  print -u2 "Unknown agent: ${APP:-<missing>}"
  exit 64
fi
module="${ATLAS_AGENT_MODULES[$APP]-}"
if [[ -z "$module" || ! -f "$SCRIPT_DIR/$module" ]]; then
  print -u2 "Agent $APP does not support terminal launch"
  exit 64
fi
source "$SCRIPT_DIR/$module"

if [[ -z "$INSTANCE" ]]; then
  INSTANCE="${APP}-$(date +%s)-$(new_uuid)"
fi
if ! valid_instance "$INSTANCE"; then
  print -u2 "Invalid $APP terminal instance id: $INSTANCE"
  exit 64
fi

START_EPOCH="$(date +%s)"
DUPLICATE_TAB=""

launch_agent() {
  # The agent chooses how to open the mapped session and how to check ownership before it runs.
  local MAPPED_SESSION="$(agent_find_session)"
  local -a reply mail user_args
  mail_args "$APP"
  mail=("${reply[@]}")
  extra_args "$APP"
  user_args=("${reply[@]}")
  agent_run "$INSTANCE" "$START_EPOCH"
}

agent_banner
launch_agent

# The agent may exit without restoring the terminal (mouse captured so selection fails, bracketed
# paste, alternate screen). Reset to the state before it started.
printf '\e[?1000l\e[?1002l\e[?1003l\e[?1006l\e[?1004l\e[?2004l\e[?1049l\e[?25h'

# The agent prints its own hint on the alternate screen, which the reset above discards.
# Read the current mapping: /resume or a fork may have changed it since this tab started.
if [[ -z "$DUPLICATE_TAB" ]]; then
  resume_id="$(agent_find_session)"
  if valid_id "$APP" "$resume_id"; then
    printf '\n\e[90mResume this session with:\n%s\e[0m\n' "$(agent_exit_hint "$resume_id")"
  fi
fi

# Tests and automation: no shell after the agent exits. A duplicate tab is about to be closed.
[[ -n "${OBS_AGENT_TERMINAL_NO_SHELL:-}${DUPLICATE_TAB:-}" ]] && exit 0
print
print "Agent exited. This shell is kept open for manual commands."
exec zsh -l -i
