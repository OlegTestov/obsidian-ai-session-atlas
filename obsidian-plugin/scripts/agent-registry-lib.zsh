#!/bin/zsh
# Shared registry + lock helpers for the Obsidian agent-terminal resume system.
# Sourced by:
#   - agent-resume-terminal.zsh  (the launcher)
#   - agent-session-hook.zsh      (the Claude Code SessionStart/UserPromptSubmit hook)
# Single source of truth so both writers use the SAME lock protocol on resume.tsv.

STATE_DIR="${OBS_AGENT_TERMINAL_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/obsidian-agent-terminals}"
REGISTRY="$STATE_DIR/resume.tsv"
LOCK_DIR="$STATE_DIR/resume.lock"
LOCK_STALE_AFTER="${OBS_AGENT_TERMINAL_LOCK_STALE_AFTER:-30}"
VAULT_ROOT="${OBS_AGENT_TERMINAL_VAULT_ROOT:-$PWD}"

mkdir -p "$STATE_DIR"
touch "$REGISTRY"

break_stale_lock() {
  [[ -d "$LOCK_DIR" ]] || return 1

  local owner_pid=""
  if [[ -f "$LOCK_DIR/pid" ]]; then
    owner_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [[ "$owner_pid" == <-> ]] && kill -0 "$owner_pid" 2>/dev/null; then
      return 1
    fi
  fi

  local modified now age
  modified="$(stat -f %m "$LOCK_DIR" 2>/dev/null || print 0)"
  now="$(date +%s)"
  age=$((now - modified))
  (( age >= LOCK_STALE_AFTER )) || return 1

  rm -f "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null
}

lock() {
  local waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if break_stale_lock; then
      continue
    fi
    sleep 0.05
    waited=$((waited + 1))
    if (( waited > 400 )); then
      print -u2 "Timed out waiting for $LOCK_DIR"
      return 75
    fi
  done
  print "$$" > "$LOCK_DIR/pid"
}

unlock() {
  rm -f "$LOCK_DIR/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

get_resume_id() {
  local kind="$1"
  local instance="$2"
  awk -F '\t' -v kind="$kind" -v instance="$instance" -v vault="$VAULT_ROOT" '
    $1 == kind && $2 == instance && $4 == vault { id = $3 }
    END { if (id != "") print id }
  ' "$REGISTRY"
}

session_id_is_claimed() {
  local kind="$1"
  local session_id="$2"
  awk -F '\t' -v kind="$kind" -v session_id="$session_id" -v vault="$VAULT_ROOT" '
    $1 == kind && $3 == session_id && $4 == vault { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$REGISTRY"
}

upsert_resume_id() {
  local kind="$1"
  local instance="$2"
  local session_id="$3"
  [[ -n "$session_id" ]] || return 0

  lock || return $?
  local tmp="$REGISTRY.tmp.$$"
  awk -F '\t' -v kind="$kind" -v instance="$instance" -v vault="$VAULT_ROOT" '
    !($1 == kind && $2 == instance && $4 == vault) { print }
  ' OFS='\t' "$REGISTRY" > "$tmp"
  print -r -- "$kind"$'\t'"$instance"$'\t'"$session_id"$'\t'"$VAULT_ROOT"$'\t'"$(date +%s)" >> "$tmp"
  mv "$tmp" "$REGISTRY"
  unlock
}
