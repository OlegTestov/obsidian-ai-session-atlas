# A test-only launcher with no agent-specific code in the skeleton.
agent_banner() { print "Starting Fake terminal instance: $INSTANCE"; }
agent_find_session() { get_resume_id fake "$INSTANCE"; }
agent_run() {
  local id="${MAPPED_SESSION:-$SEED_ID}"
  valid_id fake "$id" || return 64
  print -r -- "${(pj:\x1f:)mail}" "${(pj:\x1f:)user_args}"
  upsert_resume_id fake "$1" "$id"
}
agent_exit_hint() { print -r -- "fake resume $1"; }
