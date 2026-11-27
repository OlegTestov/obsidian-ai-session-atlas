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
  local best_created=0 best_id="" created session_id file REPLY
  [[ -d "$CODEX_SESSIONS_DIR" ]] || return 1
  local -a files=("$CODEX_SESSIONS_DIR"/**/rollout-*.jsonl(N.ms-$(( $(date +%s) - start_epoch + 2 ))))
  for file in "${files[@]}"; do
    codex_rollout_thread_id "$file" || continue
    session_id="$REPLY"
    codex_user_rollout "$file" || continue
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
  local line pid child
  local -a argv
  for line in ${(f)"$(/usr/bin/pgrep -fl -P $$ 2>/dev/null)"}; do
    pid="${line%% *}"
    argv=(${=${line#* }})
    if [[ "${argv[1]:t}" == codex* ]]; then
      print -r -- "$pid"
    elif [[ "${argv[1]:t}" == node && "${argv[2]:t}" == codex* ]]; then
      for line in ${(f)"$(/usr/bin/pgrep -fl -P "$pid" 2>/dev/null)"}; do
        child="${line%% *}"
        argv=(${=${line#* }})
        [[ "${argv[1]:t}" == codex* ]] && print -r -- "$child"
      done
    fi
  done
}

# A thread the human works in: subagent and review threads (source.subagent) run inside the same
# process and keep their rollouts open too.
codex_user_rollout() {
  local head=""
  zmodload zsh/system || return 1
  sysread -s 65536 head < "$1" 2>/dev/null
  head="${head%%$'\n'*}"
  head="${head//": /":}"
  [[ "$head" != *'"thread_source":"subagent"'* && "$head" != *'"source":{"subagent"'* ]]
}

# "<thread id> <mtime> <writable> <descriptor> <path>" for the human rollouts held by this tab.
open_codex_threads() {
  (( $# )) || return 0
  local line file REPLY access=0 fd=0
  local -A held ids descriptors
  local -a files
  # The descriptor report already carries vnode paths. Skip lsof's blocking filesystem lookups.
  for line in ${(f)"$(/usr/sbin/lsof -b -w -n -P -F pfna -p "${(j:,:)@}" 2>/dev/null)"}; do
    case "$line" in
      f<->) access=0 fd="${line#f}" ;;
      [pf]*) access=0 fd=0 ;;
      a[wu]) access=1 ;;
      n*/rollout-*.jsonl)
        file="${line#n}"
        if [[ -z "${held[$file]-}" ]]; then
          codex_rollout_thread_id "$file" && codex_user_rollout "$file" || continue
          files+=("$file")
          ids[$file]="$REPLY"
        fi
        if [[ -z "${held[$file]-}" ]] || (( access > ${held[$file]} ||
              (access == ${held[$file]} && fd < ${descriptors[$file]}) )); then
          held[$file]="$access"
          descriptors[$file]="$fd"
        fi
        ;;
    esac
  done
  (( ${#files} )) || return 0
  # Batch stat for every descriptor, even after an in-TUI switch left several files open.
  for line in ${(f)"$(/usr/bin/stat -f '%Fm %N' "${files[@]}" 2>/dev/null)"}; do
    file="${line#* }"
    print -r -- "${ids[$file]} ${line%% *} ${held[$file]} ${descriptors[$file]} $file"
  done
}

# After a write, the latest writable human rollout owns the tab. A newly opened, older rollout
# also records /resume before the first prompt. Its open descriptor is the only signal at that point.
track_codex_thread() {
  local instance="$1" every="${OBS_AGENT_CODEX_TRACK_EVERY:-2}"
  local current="" recorded resume_hint line id mtime file best new best_file stop=0 nap="" access fd
  local startup_resume_fd=0 later_opened later_fd newest_file
  local -a pids rows alive
  local -A observed seen writers latest_writers
  local -F 9 start_poll rest
  zmodload zsh/datetime
  trap 'stop=1; [[ -n "$nap" ]] && kill "$nap" 2>/dev/null' TERM
  recorded="$(get_resume_id codex "$instance")"
  resume_hint="$recorded"
  while (( ! stop )) && kill -0 $$ 2>/dev/null; do
    start_poll="$EPOCHREALTIME"
    alive=()
    for id in "${pids[@]}"; do
      kill -0 "$id" 2>/dev/null && alive+=("$id")
    done
    pids=("${alive[@]}")
    (( ${#pids} )) || pids=(${(f)"$(tab_codex_pids)"})
    if (( ${#pids} )); then
      rows=(${(f)"$(open_codex_threads "${pids[@]}")"})
      local best_access=-1 changed=0 present=0
      local -F 9 best_m=-1 new_m=-1
      best="" best_file="" new="" seen=() writers=() later_opened="" later_fd=0 startup_resume_fd=0
      for line in "${rows[@]}"; do
        id="${line%% *}" line="${line#* }"
        mtime="${line%% *}" line="${line#* }"
        access="${line%% *}" line="${line#* }"
        fd="${line%% *}" file="${line#* }"
        seen[$file]="$mtime"
        (( access )) && writers[$file]="$id"
        if (( access > best_access )); then
          best="" new="" best_m=-1 new_m=-1 changed=0 present=0 best_access="$access"
        fi
        (( access == best_access )) || continue
        [[ "$id" == "$current" ]] && present=1
        if (( ! access )) && [[ -n "$resume_hint" && "$best" == "$resume_hint" && "$id" != "$resume_hint" ]]; then
          :
        elif { (( ! access )) && [[ "$id" == "$resume_hint" && "$best" != "$resume_hint" ]]; } ||
            (( mtime > best_m )) || { (( mtime == best_m )) &&
            { [[ "$id" == "$resume_hint" && "$best" != "$resume_hint" ]] ||
              [[ "$best" != "$resume_hint" && "$file" > "$best_file" ]]; }; }; then
          best="$id" best_m="$mtime" best_file="$file"
        fi
        if [[ -z "$current" ]] && (( access )); then
          if [[ "$id" == "$resume_hint" ]] && (( mtime >= START_EPOCH )); then
            startup_resume_fd="$fd"
          elif [[ "$id" != "$resume_hint" ]] && (( mtime < START_EPOCH && fd > later_fd )); then
            later_opened="$id" later_fd="$fd"
          fi
        fi
        if [[ -z "${observed[$file]-}" ]]; then
          if (( mtime > new_m )); then new="$id" new_m="$mtime"; fi
        elif [[ "${observed[$file]}" != "$mtime" ]]; then
          changed=1
        fi
      done
      if [[ -n "$best" ]]; then
        if [[ -z "$current" ]]; then
          current="$best"
          # If the first poll missed startup, a later fd to pre-existing history still shows
          # a promptless /resume. Require the original thread to have written during startup.
          if [[ "$best" == "$resume_hint" ]] && (( startup_resume_fd && later_fd > startup_resume_fd )); then
            current="$later_opened"
          fi
        elif (( ! present )); then
          current="$best"
        elif (( best_access && new_m < START_EPOCH && best_m >= START_EPOCH )) &&
            [[ -n "$new" && "$new" != "$best" ]]; then
          current="$new"
        elif (( changed )) || [[ -n "$new" ]]; then
          current="$best"
        fi
        observed=("${(@kv)seen}")
        latest_writers=("${(@kv)writers}")
        if [[ "$current" != "$recorded" ]]; then
          upsert_resume_id codex "$instance" "$current" && recorded="$current"
        fi
      fi
    fi
    rest=$(( every - (EPOCHREALTIME - start_poll) ))
    if (( rest > 0 && ! stop )); then
      sleep "$rest" & nap=$!
      wait "$nap" 2>/dev/null
      nap=""
    fi
  done
  # A final write can land after the last lsof poll. These files are already known writers,
  # even if the process closed their descriptors before the tracker was scheduled again.
  if (( stop && ${#latest_writers} )); then
    local -F 9 newest_m=-1
    changed=0 newest_file=""
    for line in ${(f)"$(/usr/bin/stat -f '%Fm %N' "${(@k)latest_writers}" 2>/dev/null)"}; do
      mtime="${line%% *}" file="${line#* }"
      [[ "${observed[$file]}" != "$mtime" ]] && changed=1
      if (( mtime > newest_m )) || { (( mtime == newest_m )) && [[ "$file" > "$newest_file" ]]; }; then
        newest_file="$file" newest_m="$mtime"
      fi
    done
    if (( changed )) && [[ -n "$newest_file" && "${latest_writers[$newest_file]}" != "$recorded" ]]; then
      upsert_resume_id codex "$instance" "${latest_writers[$newest_file]}"
    fi
  fi
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
  local -a reply

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
  if [[ -n "$session_id" ]] && codex_session_files "$session_id"; then
    if running="$(codex_files_pid "${reply[@]}")" && ! take_over_running Codex "$session_id" "$running"; then
      return 0
    fi
    print "Resuming Codex session: $session_id"
    codex_tracked "$instance" "${flags[@]}" resume "$session_id"
  elif [[ -z "$session_id" && "$SEED_MODE" == resume* ]] && valid_id "$APP" "$SEED_ID" \
      && codex_session_files "$SEED_ID"; then
    # From AI Session Atlas: recorded first, so a restart brings it back. A copy gets its own id
    # when it starts; until the tracker sees it, a restart resumes the source, as for Claude Code.
    upsert_resume_id codex "$instance" "$SEED_ID"
    if [[ "$SEED_MODE" == resume-fork ]]; then
      fork_of="$SEED_ID"
      print "Forking Codex session: $SEED_ID"
      codex_tracked "$instance" "${flags[@]}" fork "$SEED_ID"
    else
      if running="$(codex_files_pid "${reply[@]}")" && ! take_over_running Codex "$SEED_ID" "$running"; then
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
