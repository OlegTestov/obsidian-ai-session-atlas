# Codex launch policy, sourced by agent-resume-terminal.zsh.
if [[ "$SEED_MODE" == attach ]]; then
  invalid_attach_seed
fi

agent_banner() { print "Starting Codex terminal instance: $INSTANCE"; }
agent_find_session() { get_resume_id codex "$INSTANCE"; }
agent_run() { run_codex "$1" "$2"; }
agent_exit_hint() { print -r -- "codex resume $1"; }

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
    valid_id codex "$session_id" || continue
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
    valid_id codex "$id" && (( ! ${seen[(Ie)$id]} )) || continue
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

run_codex() {
  local instance="$1"
  local start_epoch="$2"
  local session_id="$MAPPED_SESSION" running=""

  # No hook and none of the tab variables: Codex runs no hook here, and a Claude Code the agent
  # starts from a command must not record its session as this tab's (the vault's project hook would).
  # track_codex_thread (codex_tracked) follows the thread the tab's codex holds open instead.
  local -a flags=("${mail[@]}" "${user_args[@]}")

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
  elif [[ -z "$session_id" && "$SEED_MODE" == resume* ]] && valid_id "$APP" "$SEED_ID" \
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
