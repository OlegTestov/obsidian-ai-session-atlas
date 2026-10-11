#!/bin/zsh
# Where the agents keep their sessions, for agent-resume-terminal.zsh. Lookups go by file name, never
# by reading every transcript: a Codex home holds thousands of rollouts (gigabytes), and the tab stays
# blank while the script looks.

CLAUDE_HOME_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CLAUDE_PROJECTS_DIR="${OBS_AGENT_TERMINAL_CLAUDE_PROJECTS_DIR:-$CLAUDE_HOME_DIR/projects}"
CLAUDE_SESSIONS_DIR="${OBS_AGENT_TERMINAL_CLAUDE_SESSIONS_DIR:-$CLAUDE_HOME_DIR/sessions}"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_SESSIONS_DIR="${OBS_AGENT_TERMINAL_CODEX_SESSIONS_DIR:-$CODEX_HOME_DIR/sessions}"
CODEX_ARCHIVED_DIR="$CODEX_HOME_DIR/archived_sessions"

valid_uuid() {
  [[ "$1" =~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ]]
}

# A Claude Code background job id, as `claude attach` takes it: 8 hex digits.
valid_job_id() {
  [[ "$1" =~ '^[0-9a-f]{8}$' ]]
}

# Codex names a rollout rollout-<time>-<thread id>.jsonl, in sessions/YYYY/MM/DD or archived_sessions.
codex_session_exists() {
  valid_uuid "$1" || return 1
  local -a found=("$CODEX_SESSIONS_DIR"/**/rollout-*-"$1".jsonl(N.) "$CODEX_ARCHIVED_DIR"/**/rollout-*-"$1".jsonl(N.))
  (( ${#found} > 0 ))
}

# Any project folder: a tab from AI Session Atlas can open outside the vault too.
claude_session_exists() {
  valid_uuid "$1" || return 1
  local -a found=("$CLAUDE_PROJECTS_DIR"/*/"$1".jsonl(N))
  (( ${#found} > 0 ))
}

# One field of a Claude Code process file (compact JSON, spaces tolerated).
_json_field() {
  local text="$1" key="$2"
  if [[ "$text" =~ "\"$key\"[[:space:]]*:[[:space:]]*\"([^\"]*)\"" ]]; then
    print -r -- "$match[1]"
  elif [[ "$text" =~ "\"$key\"[[:space:]]*:[[:space:]]*([0-9]+)" ]]; then
    print -r -- "$match[1]"
  fi
}

# The process still runs and is the one that wrote the file: PIDs get reused, procStart is UTC.
_claude_process_alive() {
  local pid="$1" started="$2"
  [[ "$pid" == <-> ]] && kill -0 "$pid" 2>/dev/null || return 1
  [[ -n "$started" ]] || return 0
  local now
  now="$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null)"
  [[ "${(j: :)${=now}}" == "${(j: :)${=started}}" ]]
}

# Claude Code 2.1.289+ parks a session in a background job; `claude --resume` then refuses it
# ("run claude attach <id>"). Prints the live job id for the session: the job itself, the job its
# process file names (parkedJobId) or the job its transcript continued in (continued-in).
claude_live_job() {
  local session_id="$1"
  valid_uuid "$session_id" || return 1
  local -a jobs=() continued=()
  local file text
  for file in "$CLAUDE_SESSIONS_DIR"/*.json(N); do
    text="$(<"$file")" 2>/dev/null || continue
    [[ "$(_json_field "$text" sessionId)" == "$session_id" ]] || continue
    jobs+=("$(_json_field "$text" parkedJobId)")
  done
  local -a transcript=("$CLAUDE_PROJECTS_DIR"/*/"$session_id".jsonl(N))
  if (( ${#transcript} )); then
    continued=(${(f)"$(tail -c 262144 "$transcript[1]" 2>/dev/null \
      | sed -n 's/.*"continuedInSessionId"[[:space:]]*:[[:space:]]*"\([0-9a-f-]*\)".*/\1/p')"})
  fi
  local sid job
  for file in "$CLAUDE_SESSIONS_DIR"/*.json(N); do
    text="$(<"$file")" 2>/dev/null || continue
    job="$(_json_field "$text" jobId)"
    valid_job_id "$job" || continue
    [[ "$text" == *'"spare":true'* ]] && continue
    sid="$(_json_field "$text" sessionId)"
    [[ "$sid" == "$session_id" || ${jobs[(Ie)$job]} -gt 0 || ${continued[(Ie)$sid]} -gt 0 ]] || continue
    _claude_process_alive "$(_json_field "$text" pid)" "$(_json_field "$text" procStart)" || continue
    print -r -- "$job"
    return 0
  done
  return 1
}

# The session a background job works in (its process file), for the tab's registry.
claude_job_session() {
  local job="$1" file text
  valid_job_id "$job" || return 1
  for file in "$CLAUDE_SESSIONS_DIR"/*.json(N); do
    text="$(<"$file")" 2>/dev/null || continue
    [[ "$(_json_field "$text" jobId)" == "$job" ]] || continue
    text="$(_json_field "$text" sessionId)"
    valid_uuid "$text" && { print -r -- "$text"; return 0; }
  done
  return 1
}

# A Claude Code process already in this session (not a background job: those are attached to).
# Prints its pid. A second process on one transcript would interleave two conversations.
claude_session_pid() {
  local session_id="$1" file text pid
  valid_uuid "$session_id" || return 1
  for file in "$CLAUDE_SESSIONS_DIR"/*.json(N); do
    text="$(<"$file")" 2>/dev/null || continue
    [[ "$(_json_field "$text" sessionId)" == "$session_id" ]] || continue
    [[ -n "$(_json_field "$text" jobId)" ]] && continue
    pid="$(_json_field "$text" pid)"
    _claude_process_alive "$pid" "$(_json_field "$text" procStart)" || continue
    print -r -- "$pid"
    return 0
  done
  return 1
}

# A codex process holding this thread's rollout open (Codex keeps its live thread's file open).
codex_session_pid() {
  local session_id="$1" pid
  codex_session_exists "$session_id" || return 1
  local -a found=("$CODEX_SESSIONS_DIR"/**/rollout-*-"$session_id".jsonl(N.) "$CODEX_ARCHIVED_DIR"/**/rollout-*-"$session_id".jsonl(N.))
  for pid in ${(f)"$(/usr/sbin/lsof -t -- "${found[@]}" 2>/dev/null)"}; do
    local -a argv=(${=$(ps -o command= -p "$pid" 2>/dev/null)})
    [[ "${argv[1]:t}" == codex* ]] && { print -r -- "$pid"; return 0; }
  done
  return 1
}

# The top of the nearest tab tree a process runs in (the plugin's `sh … atlas-pty`, with `script`
# under it) and that top's parent: "pid ppid". Nearest: Obsidian itself may run in another tab's agent.
tab_root_of() {
  local pid="$1" ppid cmd line top="" i
  for i in {1..32}; do
    [[ "$pid" == <-> ]] && (( pid > 1 )) || break
    line="$(ps -o ppid=,command= -p "$pid" 2>/dev/null)" || break
    read -r ppid cmd <<< "$line"
    if [[ "$cmd" == *" atlas-pty" || "$cmd" == *" atlas-pty "* ]]; then
      top="$pid $ppid"
    elif [[ -n "$top" ]]; then
      break
    fi
    pid="$ppid"
  done
  [[ -n "$top" ]] && print -r -- "$top"
}

# The process runs in a tab of an Obsidian that is gone: the top of that tab's tree now belongs to
# launchd. Or the tree is already ending and the process itself belongs to launchd. Either way
# nothing can show it or type into it any more.
orphaned_tab_process() {
  local top ppid _
  if top="$(tab_root_of "$1")"; then
    [[ "${top#* }" == 1 ]]
    return
  fi
  read -r ppid _ <<< "$(ps -o ppid= -p "$1" 2>/dev/null)"
  [[ "$ppid" == 1 ]]
}

# A tab tree top of a running Obsidian: alive, not handed to launchd, still the plugin's `sh … atlas-pty`.
_live_tab_root() {
  local line ppid cmd
  [[ "$1" == <-> ]] || return 1
  line="$(ps -o ppid=,command= -p "$1" 2>/dev/null)" || return 1
  read -r ppid cmd <<< "$line"
  [[ "$ppid" != 1 && ( "$cmd" == *" atlas-pty" || "$cmd" == *" atlas-pty "* ) ]]
}

# Another tab of a running Obsidian already shows this background job. Tabs restored together start
# within the same second, so the first one claims the job (an atomic mkdir holding its tree's top);
# a `claude attach <job>` in another tab counts too (a tab of an older version takes no claim).
job_open_in_another_tab() {
  local job="$1" pid top mine claim owner age
  local -a viewers=()
  mine="$(tab_root_of $$)"
  mine="${mine%% *}"
  for pid in ${(f)"$(/usr/bin/pgrep -f "(^|/)claude attach $job\$" 2>/dev/null)"}; do
    top="$(tab_root_of "$pid")" || continue
    [[ "${top#* }" != 1 && "${top%% *}" != "$mine" ]] && viewers+=("${top%% *}")
  done
  (( ${#viewers} )) && return 0
  [[ -n "$mine" && -n "${STATE_DIR:-}" ]] || return 1
  claim="$STATE_DIR/view-$job"
  if ! mkdir "$claim" 2>/dev/null; then
    owner="$(<"$claim/root")" 2>/dev/null
    age=$(( $(date +%s) - $(stat -f %m "$claim" 2>/dev/null || print 0) ))
    # Still starting (no attach under it yet): the claim holds for half a minute.
    # An empty claim was made a moment ago and is being written.
    [[ "$owner" != "$mine" ]] && (( age < 30 )) && { [[ -z "$owner" ]] || _live_tab_root "$owner"; } && return 0
    rm -rf "$claim"
    mkdir "$claim" 2>/dev/null || return 0      # another tab claimed it this very moment
  fi
  print -r -- "$mine" > "$claim/root"
  return 1
}

# Ends the process and waits until it is gone. Claude Code saves its session and stops its MCP
# servers on SIGTERM, which takes well over ten seconds on a busy machine. OBS_AGENT_END_WAIT: seconds.
end_process() {
  local pid="$1" limit="${OBS_AGENT_END_WAIT:-60}" i
  kill -TERM "$pid" 2>/dev/null
  for i in $(seq 1 $(( limit * 5 ))); do
    kill -0 "$pid" 2>/dev/null || return 0
    (( i == 10 )) && print "Waiting for it to finish saving…"
    sleep 0.2
  done
  kill -KILL "$pid" 2>/dev/null
  for i in {1..25}; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  print "The other process (pid $pid) did not end; not starting a second one."
  return 1
}

# The session already runs in another process: never start a second one silently. A process left by
# an Obsidian that has closed is ended without asking; any other one only on yes. Returns 0 when the
# tab may go on, 1 when it must not. OBS_AGENT_RUNNING_ANSWER answers for tests (y or n).
take_over_running() {
  local agent="$1" session_id="$2" pid="$3" answer="${OBS_AGENT_RUNNING_ANSWER:-}"
  # A shared Codex server owns multiple threads. Stopping it would interrupt all of them.
  if [[ "$agent" == Codex && "$(ps -o command= -p "$pid" 2>/dev/null)" == *' app-server '* ]]; then
    print "This session is held by a shared Codex server; not stopping it to move one thread."
    print "Close the original session first, then reopen it here."
    return 1
  fi
  if orphaned_tab_process "$pid"; then
    print "This $agent session was still running in a tab of an Obsidian that has closed (pid $pid)."
    print "Ending it there and continuing here."
    end_process "$pid"
    return
  fi
  print "This $agent session is already running in another process (pid $pid)."
  print "Two processes on one conversation would mix their replies, so this tab does not start it."
  if [[ -z "$answer" ]]; then
    if [[ -t 0 ]]; then
      read -r "answer?End it there and continue here? [y/N] "
    else
      answer=n
    fi
  fi
  [[ "$answer" == [yY]* ]] || { print "Left running there. Close this tab, or use Move in AI Session Atlas → Active."; return 1; }
  end_process "$pid"
}
