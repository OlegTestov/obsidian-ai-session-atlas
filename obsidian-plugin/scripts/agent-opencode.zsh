# OpenCode uses the shared service. Its private route record follows the TUI after launch.
[[ "$SEED_MODE" == attach ]] && invalid_attach_seed

agent_banner() { print "Starting OpenCode terminal instance: $INSTANCE"; }
agent_find_session() { :; }
agent_exit_hint() { :; }

agent_run() {
  local root="${OBS_AGENT_ATLAS_RUNTIME:-${SCRIPT_DIR:h}}"
  [[ -d "$root/atlas" ]] || root="${SCRIPT_DIR:h:h}"
  local tab_package="$root/opencode-tab"
  [[ -d "$tab_package" ]] || tab_package="$root/obsidian-plugin/opencode-tab"
  local -a extra=("${user_args[@]}")
  local atlas_home="${OBS_AGENT_ATLAS_HOME:-${ATLAS_HOME:-}}"
  local attempt="${OBS_AGENT_OPENCODE_ATTEMPT:-}"
  ATLAS_HOME="$atlas_home" PYTHONPATH="$root" PYTHONDONTWRITEBYTECODE=1 \
    "${OBS_AGENT_ATLAS_PYTHON:-/usr/bin/python3}" -m atlas.opencode_tabs \
    "$INSTANCE" "$SEED_MODE" "$SEED_ID" "$tab_package" "${extra[@]}"
  local result=$?
  # The PTY may still hold a shell after the native client has exited.
  if [[ -n "$atlas_home" && "$attempt" =~ '^[0-9a-f]{32}$' ]]; then
    (umask 077; mkdir -p -- "$atlas_home/opencode-tabs" &&
      print -rn -- "$attempt" >| "$atlas_home/opencode-tabs/$INSTANCE.exited")
  fi
  return "$result"
}
