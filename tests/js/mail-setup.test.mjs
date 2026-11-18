import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Module from "node:module";
import { test } from "node:test";
import { loadSrc } from "./helpers/load-src.mjs";

const realLoad = Module._load;
Module._load = (name, ...args) => name === "obsidian" ? { Notice: class {} } : realLoad(name, ...args);
const { mailSetupCommand } = loadSrc("mail-setup");
Module._load = realLoad;

test("the generated MCP setup commands quote the actual Python, mailbox and Codex home", () => {
  const python = "/A path/bin/python3";
  const script = "/A path/it's agent_mail.py";
  const root = "/Mail/root folder";
  const home = "/Custom/codex folder";
  const probe = `claude() { printf '%s\\n' "$@"; }
codex() { printf '%s\\n' "$CODEX_HOME" "$@"; }
`;
  const args = agent => execFileSync("/bin/sh", ["-c", probe + mailSetupCommand(agent, python, script, root, home)],
                                     { encoding: "utf8" }).trimEnd().split("\n");
  assert.deepEqual(args("claude"), ["mcp", "add", "--scope", "user", "agent-mail", "-e",
    "AGENT_MAIL_NAME=claude", "-e", "AGENT_MAIL_HOME=" + root, "--", python, script]);
  assert.deepEqual(args("codex"), [home, "mcp", "add", "agent-mail", "--env",
    "AGENT_MAIL_NAME=codex", "--env", "AGENT_MAIL_HOME=" + root, "--", python, script]);
});
