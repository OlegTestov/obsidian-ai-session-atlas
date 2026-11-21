# Claude Code launch policy, sourced by agent-resume-terminal.zsh.
if [[ "$SEED_MODE" == attach ]] && ! valid_job_id "$SEED_ID"; then
  invalid_attach_seed
fi

agent_banner() { print "Starting Claude Code terminal instance: $INSTANCE"; }
agent_find_session() { get_resume_id claude "$INSTANCE"; }
agent_run() { run_claude "$1"; }

agent_exit_hint() {
  local resume_job
  if resume_job="$(claude_live_job "$1")"; then
    print -r -- "claude attach $resume_job"
  else
    print -r -- "claude --resume $1"
  fi
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
  local session_id="$MAPPED_SESSION" job="" running=""

  # Exported so the SessionStart/UserPromptSubmit hook (agent-session-hook.zsh)
  # can write the session Claude is ACTUALLY in back into the registry for this tab.
  export OBS_AGENT_KIND="claude"
  export OBS_AGENT_INSTANCE="$instance"
  export OBS_AGENT_TERMINAL_STATE_DIR="$STATE_DIR"
  export OBS_AGENT_TERMINAL_VAULT_ROOT="$VAULT_ROOT"
  # Background jobs the agent starts (a daemon outside the tab) inherit these variables: the hook
  # records a session only for a process that descends from this script.
  export OBS_AGENT_TAB_PID="$$"

  local -a flags=("${mail[@]}" "${user_args[@]}" --settings "$(hook_settings)")

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
  elif [[ -z "$session_id" && "$SEED_MODE" == new ]] && valid_id "$APP" "$SEED_ID" \
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
