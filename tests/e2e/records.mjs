// Record builders for the fixture corpus: Claude Code transcript lines and Codex rollout lines.
// Shapes follow tests/conftest.py (the `cx_*` helpers) and docs/codex-plan.md; content is made up.

export function line(obj) {
  return JSON.stringify(obj) + "\n";
}

// --- Claude Code transcript records --------------------------------------------------------

let uuidSeq = 0;
function uuid() {
  uuidSeq += 1;
  return `00000000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
}

function claudeBase(type, ts, ctx, extra) {
  return Object.assign({ type, uuid: uuid(), timestamp: ts, cwd: ctx.cwd, sessionId: ctx.sid,
                         entrypoint: ctx.entrypoint || "cli", gitBranch: "main", version: "2.5.0" }, extra);
}

export const claude = {
  user: (ctx, ts, text) => line(claudeBase("user", ts, ctx,
    { message: { role: "user", content: [{ type: "text", text }] } })),
  compaction: (ctx, ts, text) => line(claudeBase("user", ts, ctx,
    { isCompactSummary: true,
      message: { role: "user", content: [{ type: "text",
        text: "This session is being continued from a previous conversation that ran out of context. " + text }] } })),
  reply: (ctx, ts, text, tokens = [1200, 300]) => line(claudeBase("assistant", ts, ctx,
    { message: { id: "msg_" + uuid().slice(-12), role: "assistant", model: "claude-sonnet-5",
                 content: [{ type: "text", text }],
                 usage: { input_tokens: tokens[0], output_tokens: tokens[1],
                          cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 } } })),
  // Claude Code lists the files it backs up before editing them: the catalog's "edited files".
  snapshot: (ctx, ts, paths) => line({ type: "file-history-snapshot", messageId: "msg_" + uuid().slice(-12),
    isSnapshotUpdate: true,
    snapshot: { messageId: "msg_" + uuid().slice(-12), timestamp: ts,
                trackedFileBackups: Object.fromEntries(paths.map((p, i) =>
                  [p, { backupFileName: `backup${i}@v1`, version: 1, backupTime: ts }])) } }),
  tool: (ctx, ts, name, input) => {
    const id = "toolu_" + uuid().slice(-12);
    return line(claudeBase("assistant", ts, ctx,
      { message: { id: "msg_" + uuid().slice(-12), role: "assistant", model: "claude-sonnet-5",
                   content: [{ type: "tool_use", id, name, input }],
                   usage: { input_tokens: 800, output_tokens: 120, cache_read_input_tokens: 2000,
                            cache_creation_input_tokens: 0 } } }))
      + line(claudeBase("user", ts, ctx,
        { message: { role: "user", content: [{ type: "tool_result", tool_use_id: id,
                                                content: "RAW-TOOL-OUTPUT-NEVER-INDEXED" }] } }));
  },
};

// --- Codex rollout records (compact separators, key order as Codex writes them) ---------------

function cx(type, payload, ts) {
  return JSON.stringify({ timestamp: ts, type, payload }) + "\n";
}

export const codex = {
  // codex-cli 0.160 opens the payload with the creator ids and session_id, before id.
  meta: (id, ts, cwd, opts = {}) => cx("session_meta", {
    creator_user_id: "user-PLACEHOLDER", creator_account_id: "acct-PLACEHOLDER", session_id: id,
    id, timestamp: ts, cwd, runtime_workspace_roots: [cwd], originator: opts.originator || "codex-tui",
    cli_version: "0.160.0", source: opts.source || "cli", thread_source: opts.threadSource || "user",
    ...(opts.forkedFrom ? { forked_from_id: opts.forkedFrom } : {}), model_provider: "openai",
    base_instructions: { text: "SYSTEM-INSTRUCTIONS-NEVER-INDEXED" }, history_mode: "paginated",
    context_window: 272000, git: { branch: "main", commit_hash: "abc123" } }, ts),
  context: (ts, cwd, model = "gpt-5.5") => cx("turn_context",
    { turn_id: "t1", cwd, model, effort: "high", approval_policy: "on-request" }, ts),
  started: ts => cx("event_msg", { type: "task_started", turn_id: "t1", model_context_window: 258400 }, ts),
  user: (ts, text) => cx("response_item", { type: "message", role: "user",
                                            content: [{ type: "input_text", text }] }, ts)
    + cx("event_msg", { type: "user_message", message: text, images: [] }, ts),
  agent: (ts, text) => cx("response_item", { type: "message", role: "assistant",
                                             content: [{ type: "output_text", text }] }, ts)
    + cx("event_msg", { type: "agent_message", message: text }, ts),
  complete: (ts, text) => cx("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: text }, ts),
  // A shell call as codex-cli 0.160 writes it: the call and its output, the exit code inside the output.
  exec: (ts, callId, cmd, cwd, exitCode) =>
    cx("response_item", { type: "function_call", name: "exec_command", call_id: callId,
                          arguments: JSON.stringify({ cmd, workdir: cwd }) }, ts)
    + cx("response_item", { type: "function_call_output", call_id: callId,
                            output: `Chunk ID: 1\nWall time: 0.2 seconds\nProcess exited with code ${exitCode}\n`
                              + "Output:\nRAW-TOOL-OUTPUT-NEVER-INDEXED" }, ts),
  // The event form (older versions and some tools): exit code and stderr in one record.
  execEnd: (ts, callId, cmd, cwd, exitCode, stderr = "") =>
    cx("event_msg", { type: "exec_command_end", call_id: callId, command: ["bash", "-lc", cmd], cwd,
                      exit_code: exitCode, stdout: "", stderr, aggregated_output: stderr,
                      duration: { secs: 2, nanos: 0 } }, ts),
  patch: (ts, callId, changes) => {
    const body = Object.entries(changes).map(([p, c]) =>
      `*** ${c.type === "add" ? "Add" : "Update"} File: ${p}\n${c.type === "add" ? "+" + c.content : c.unified_diff}\n`).join("");
    return cx("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: callId,
                                 input: "*** Begin Patch\n" + body + "*** End Patch\n" }, ts)
      + cx("event_msg", { type: "patch_apply_end", call_id: callId, success: true, changes,
                          stdout: "", stderr: "" }, ts);
  },
  reasoning: ts => cx("response_item", { type: "reasoning",
    summary: [{ type: "summary_text", text: "REASONING-NEVER-INDEXED" }], encrypted_content: "QUJD" }, ts),
  tokens: (ts, inp, cached, out, total, limits) => cx("event_msg", {
    type: "token_count",
    info: { last_token_usage: { input_tokens: inp, cached_input_tokens: cached, output_tokens: out,
                                reasoning_output_tokens: 0, total_tokens: inp + out },
            total_token_usage: { input_tokens: total[0], cached_input_tokens: total[1],
                                 output_tokens: total[2], reasoning_output_tokens: 0,
                                 total_tokens: total[0] + total[2] },
            model_context_window: 258400 },
    rate_limits: limits || {} }, ts),
};
