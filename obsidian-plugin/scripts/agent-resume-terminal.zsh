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
case "$APP" in
  claude|codex|list) ;;
  *)
    print -u2 "Usage: $0 claude|codex|list <terminal-instance> [resume|resume-fork|new <session-id> [prompt] | attach <job-id>]"
    exit 64
    ;;
esac
case "$SEED_MODE" in
  ""|resume|resume-fork|new|attach) ;;
  *)
    print -u2 "Unknown start mode: $SEED_MODE"
    exit 64
    ;;
esac

SCRIPT_DIR="${0:A:h}"
source "$SCRIPT_DIR/agent-registry-lib.zsh"
source "$SCRIPT_DIR/agent-sessions-lib.zsh"
if [[ "$SEED_MODE" == attach ]] && { [[ "$APP" != claude ]] || ! valid_job_id "$SEED_ID"; }; then
  print -u2 "Not a Claude Code background job id: $SEED_ID"
  exit 64
fi

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

# The first line of a rollout Codex wrote (compact JSON) names the folder it runs in.
codex_rollout_in_cwd() {
  local first_line=""
  IFS= read -r first_line < "$1" 2>/dev/null || return 1
  first_line="${first_line//\": \"/\":\"}"
  [[ "$first_line" == *"\"cwd\":\"$VAULT_ROOT\""* || "$first_line" == *"\"cwd\":\"${VAULT_ROOT:A}\""* ]]
}

# A thread this tab's Codex started: its rollout appeared after the start, in this folder, and no
# other tab claimed it. Only rollouts written since the start are looked at, the id is in the name.
latest_new_codex_session_id() {
  local start_epoch="$1"
  local best_created=0 best_id="" created session_id file
  [[ -d "$CODEX_SESSIONS_DIR" ]] || return 1
  local -a files=("$CODEX_SESSIONS_DIR"/**/rollout-*.jsonl(N.ms-$(( $(date +%s) - start_epoch + 2 ))))
  for file in "${files[@]}"; do
    session_id="${${file:t:r}: -36}"
    valid_uuid "$session_id" || continue
    created="$(stat -f %B "$file" 2>/dev/null || print 0)"
    [[ "$created" == <-> ]] || created=0
    (( created > 0 )) || created="$(stat -f %m "$file" 2>/dev/null || print 0)"
    (( created >= start_epoch && created >= best_created )) || continue
    codex_rollout_in_cwd "$file" || continue
    session_id_is_claimed codex "$session_id" && continue
    best_created="$created"
    best_id="$session_id"
  done

  [[ -n "$best_id" ]] || return 1
  print "$best_id"
}

# The interactive codex of this tab: the script's own child, or the native binary under npm's node
# wrapper. A `codex exec` the agent runs from a command sits under a shell, further down: not ours.
tab_codex_pids() {
  local pid child
  local -a argv
  for pid in ${(f)"$(/usr/bin/pgrep -P $$ 2>/dev/null)"}; do
    argv=(${=$(ps -o command= -p "$pid" 2>/dev/null)})
    if [[ "${argv[1]:t}" == codex* ]]; then
      print -r -- "$pid"
    elif [[ "${argv[1]:t}" == node && "${argv[2]:t}" == codex* ]]; then
      for child in ${(f)"$(/usr/bin/pgrep -P "$pid" 2>/dev/null)"}; do
        argv=(${=$(ps -o command= -p "$child" 2>/dev/null)})
        [[ "${argv[1]:t}" == codex* ]] && print -r -- "$child"
      done
    fi
  done
}

# A thread the human works in: subagent and review threads (source.subagent) run inside the same
# process and keep their rollouts open too.
codex_user_rollout() {
  local head=""
  head="$(/usr/bin/head -c 65536 "$1" 2>/dev/null | /usr/bin/head -n 1)"
  head="${head//\": /\":}"
  [[ "$head" != *'"thread_source":"subagent"'* && "$head" != *'"source":{"subagent"'* ]]
}

# "<thread id> <mtime> <path>" for every user rollout the processes hold open.
open_codex_threads() {
  (( $# )) || return 0
  local line file id
  local -a seen=()
  for line in ${(f)"$(/usr/sbin/lsof -w -a -p "${(j:,:)@}" -Fn 2>/dev/null)"}; do
    [[ "$line" == n*/rollout-*.jsonl ]] || continue
    file="${line#n}"
    id="${${file:t:r}: -36}"
    valid_uuid "$id" && (( ! ${seen[(Ie)$id]} )) || continue
    seen+=("$id")
    codex_user_rollout "$file" || continue
    print -r -- "$id $(stat -f %Fm "$file" 2>/dev/null || print 0) $file"
  done
}

# Codex gets no hook here (its hooks need trust first), so the tab follows the thread its codex holds
# open: /new, /resume and /fork switch threads inside one process, and after an Obsidian restart the
# tab must come back on the last one. Codex keeps every rollout it opened open, so a rollout opened
# since the last look is the switch; otherwise the one written last is current, as Active picks it.
track_codex_thread() {
  local instance="$1" every="${OBS_AGENT_CODEX_TRACK_EVERY:-2}"
  local current="" since=0 recorded line id mtime best best_m stop=0 nap=""
  local -a pids rows known=()
  # Stopped by codex_tracked with TERM: the trap only asks to stop, so a record in progress finishes and
  # lets go of the registry lock (killed inside it, the next record would wait out the lock timeout).
  trap 'stop=1; [[ -n "$nap" ]] && kill "$nap" 2>/dev/null' TERM
  recorded="$(get_resume_id codex "$instance")"
  while (( ! stop )) && kill -0 $$ 2>/dev/null; do
    sleep "$every" & nap=$!
    wait "$nap" 2>/dev/null
    nap=""
    (( stop )) && break
    pids=(${(f)"$(tab_codex_pids)"})
    (( ${#pids} )) || continue
    rows=(${(f)"$(open_codex_threads "${pids[@]}")"})
    (( ${#rows} )) || continue
    best="" best_m=0
    for line in "${rows[@]}"; do                   # newly opened: the newest of them
      id="${line%% *}" mtime="${${line#* }%% *}"
      (( ${known[(Ie)$id]} )) && continue
      known+=("$id")
      (( mtime >= best_m )) && best="$id" best_m="$mtime"
    done
    if [[ -n "$best" ]]; then
      current="$best" since="$(date +%s)"
    else
      for line in "${rows[@]}"; do                 # written to after the switch
        id="${line%% *}" mtime="${${line#* }%% *}"
        (( mtime > best_m )) && best="$id" best_m="$mtime"
      done
      [[ -n "$best" && "$best" != "$current" ]] && (( best_m > since )) && current="$best" since="$best_m"
    fi
    if [[ -n "$current" && "$current" != "$recorded" ]]; then
      upsert_resume_id codex "$instance" "$current" && recorded="$current"
    fi
  done
}

# Runs codex in the foreground while track_codex_thread follows its thread.
codex_tracked() {
  local instance="$1" tracker rc i
  shift
  track_codex_thread "$instance" &!
  tracker=$!
  codex "$@"
  rc=$?
  kill "$tracker" 2>/dev/null
  for i in {1..100}; do kill -0 "$tracker" 2>/dev/null || break; sleep 0.05; done
  return $rc
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

# A session that runs in a background job opens with `claude attach` (`--resume` refuses it). The
# registry keeps the job's session: after a restart the tab attaches again while the job runs and
# resumes its transcript once the job is gone. Attach takes no flags and runs no hooks.
attach_claude_job() {
  local instance="$1" job="$2" job_session
  # After a restart both the tab of a parked session and a tab opened on its job lead here: one view
  # is enough. The plugin closes this tab when told so (OSC 7770 with the tab's id).
  if job_open_in_another_tab "$job"; then
    print "This conversation is already open in another tab (Claude Code background session $job)."
    printf '\e]7770;close;%s\a' "$instance"
    DUPLICATE_TAB=1
    return 0
  fi
  job_session="$(claude_job_session "$job")" && upsert_resume_id claude "$instance" "$job_session"
  print "Attaching to Claude Code background session: $job"
  claude attach "$job"
}

run_claude() {
  local instance="$1"
  local session_id job="" running=""
  session_id="$(get_resume_id claude "$instance")"

  # Exported so the SessionStart/UserPromptSubmit hook (agent-session-hook.zsh)
  # can write the session Claude is ACTUALLY in back into the registry for this tab.
  export OBS_AGENT_KIND="claude"
  export OBS_AGENT_INSTANCE="$instance"
  export OBS_AGENT_TERMINAL_STATE_DIR="$STATE_DIR"
  export OBS_AGENT_TERMINAL_VAULT_ROOT="$VAULT_ROOT"
  # Background jobs the agent starts (a daemon outside the tab) inherit these variables: the hook
  # records a session only for a process that descends from this script.
  export OBS_AGENT_TAB_PID="$$"

  local -a reply
  extra_args claude
  local -a flags=("${reply[@]}" --settings "$(hook_settings)")

  if [[ -n "$session_id" ]] && job="$(claude_live_job "$session_id")"; then
    attach_claude_job "$instance" "$job"
  elif [[ -n "$session_id" ]] && claude_session_exists "$session_id"; then
    if running="$(claude_session_pid "$session_id")" && ! take_over_running "Claude Code" "$session_id" "$running"; then
      return 0
    fi
    print "Resuming Claude Code session: $session_id"
    claude "${flags[@]}" --resume "$session_id"
  elif [[ -z "$session_id" && "$SEED_MODE" == attach ]] && valid_job_id "$SEED_ID"; then
    # The job may have ended since the click: then its transcript is resumed.
    local job_session=""
    job_session="$(claude_job_session "$SEED_ID")"
    if [[ -n "$job_session" ]] && ! claude_live_job "$job_session" >/dev/null \
        && claude_session_exists "$job_session"; then
      upsert_resume_id claude "$instance" "$job_session"
      print "Resuming Claude Code session: $job_session"
      claude "${flags[@]}" --resume "$job_session"
    else
      attach_claude_job "$instance" "$SEED_ID"
    fi
  elif [[ -z "$session_id" && "$SEED_MODE" == resume ]] && job="$(claude_live_job "$SEED_ID")"; then
    attach_claude_job "$instance" "$job"
  elif [[ -z "$session_id" && "$SEED_MODE" == resume* ]] && claude_session_exists "$SEED_ID"; then
    upsert_resume_id claude "$instance" "$SEED_ID"
    if [[ "$SEED_MODE" == resume-fork ]]; then
      # The fork's id is unknown in advance: the hook records it when the session starts.
      print "Forking Claude Code session: $SEED_ID"
      claude "${flags[@]}" --resume "$SEED_ID" --fork-session
    else
      if running="$(claude_session_pid "$SEED_ID")" && ! take_over_running "Claude Code" "$SEED_ID" "$running"; then
        return 0
      fi
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
  local session_id running=""
  session_id="$(get_resume_id codex "$instance")"

  # No hook and none of the tab variables: Codex runs no hook here, and a Claude Code the agent
  # starts from a command must not record its session as this tab's (the vault's project hook would).
  # track_codex_thread (codex_tracked) follows the thread the tab's codex holds open instead.
  local -a reply
  extra_args codex
  local -a flags=("${reply[@]}")

  # New Codex CLIs share an app-server that owns every rollout. Keep our tabs independently
  # observable and controllable; older CLIs without this flag keep their ordinary launch.
  if codex --help 2>/dev/null | /usr/bin/grep -q -- '--no-daemon'; then
    [[ "${flags[(Ie)--no-daemon]}" == 0 ]] && flags=(--no-daemon "${flags[@]}")
  fi

  local fork_of=""
  if [[ -n "$session_id" ]] && codex_session_exists "$session_id"; then
    if running="$(codex_session_pid "$session_id")" && ! take_over_running Codex "$session_id" "$running"; then
      return 0
    fi
    print "Resuming Codex session: $session_id"
    codex_tracked "$instance" "${flags[@]}" resume "$session_id"
  elif [[ -z "$session_id" && "$SEED_MODE" == resume* ]] && valid_uuid "$SEED_ID" \
      && codex_session_exists "$SEED_ID"; then
    # From AI Session Atlas: recorded first, so a restart brings it back. A copy gets its own id
    # when it starts; until the tracker sees it, a restart resumes the source, as for Claude Code.
    upsert_resume_id codex "$instance" "$SEED_ID"
    if [[ "$SEED_MODE" == resume-fork ]]; then
      fork_of="$SEED_ID"
      print "Forking Codex session: $SEED_ID"
      codex_tracked "$instance" "${flags[@]}" fork "$SEED_ID"
    else
      if running="$(codex_session_pid "$SEED_ID")" && ! take_over_running Codex "$SEED_ID" "$running"; then
        return 0
      fi
      print "Resuming Codex session: $SEED_ID"
      codex_tracked "$instance" "${flags[@]}" resume "$SEED_ID"
    fi
  else
    # A new thread from AI Session Atlas starts with its first prompt (only on the first open: after
    # a restart the tab resumes the thread the tracker recorded). Codex picks the thread id itself.
    local -a first=()
    if [[ -z "$session_id" && "$SEED_MODE" == new && -n "${SEED_PROMPT//[[:space:]]/}" ]]; then
      # A leading "-" would make the prompt a flag.
      [[ "$SEED_PROMPT" == -* ]] && first=(" $SEED_PROMPT") || first=("$SEED_PROMPT")
      # Marks the prompt as sent: if no thread gets recorded, a restart must not send it again.
      upsert_resume_id codex "$instance" "prompt-sent"
    fi
    codex_tracked "$instance" "${flags[@]}" "${first[@]}"
  fi
  # Codex quit before the tracker looked: the thread it started is the newest rollout in this folder.
  session_id="$(get_resume_id codex "$instance")"
  if ! codex_session_exists "$session_id" || [[ -n "$fork_of" && "$session_id" == "$fork_of" ]]; then
    session_id="$(latest_new_codex_session_id "$start_epoch" 2>/dev/null || true)"
    [[ -n "$session_id" ]] && upsert_resume_id codex "$instance" "$session_id"
  fi
  return 0
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
DUPLICATE_TAB=""

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

# The agent prints its own hint on the alternate screen, which the reset above discards.
# Read the current mapping: /resume or a fork may have changed it since this tab started.
if [[ -z "$DUPLICATE_TAB" ]]; then
  resume_id="$(get_resume_id "$APP" "$INSTANCE")"
  if valid_uuid "$resume_id"; then
    resume_command=""
    if [[ "$APP" == claude ]]; then
      if resume_job="$(claude_live_job "$resume_id")"; then
        resume_command="claude attach $resume_job"
      else
        resume_command="claude --resume $resume_id"
      fi
    else
      resume_command="codex resume $resume_id"
    fi
    printf '\n\e[90mResume this session with:\n%s\e[0m\n' "$resume_command"
  fi
fi

# Tests and automation: no shell after the agent exits. A duplicate tab is about to be closed.
[[ -n "${OBS_AGENT_TERMINAL_NO_SHELL:-}${DUPLICATE_TAB:-}" ]] && exit 0
print
print "Agent exited. This shell is kept open for manual commands."
exec zsh -l -i
