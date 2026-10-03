// The release build: main.js built by esbuild.config.mjs into a temp folder must start its embedded
// server, behave like the sources on the bridge checks, and work on a clean macOS account.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "../../esbuild.config.mjs";
import { defineRuntimeTests } from "./helpers/runtime-suite.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-bundle-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const BUNDLE = path.join(await build(path.join(TMP, "build")), "main.js");

/** Runs a test file in a child node with its own environment; returns the TAP summary. */
function runChild(args, env) {
  const r = childProcess.spawnSync(process.execPath, ["--test-reporter=tap", ...args],
                                   { env, encoding: "utf8", timeout: 180000 });
  const count = (name) => Number((new RegExp(`^# ${name} (\\d+)$`, "m").exec(r.stdout) || [])[1] || 0);
  return { status: r.status, pass: count("pass"), fail: count("fail"), output: r.stdout + r.stderr };
}

/** The parent's environment without the test runner's own markers. */
function childEnv(extra) {
  const env = Object.assign({}, process.env, extra);
  delete env.NODE_TEST_CONTEXT;
  return env;
}

defineRuntimeTests(BUNDLE);

describe("bundle behaves like the sources", () => {
  it("passes every plugin bridge check", () => {
    const r = runChild(["--test", path.join(HERE, "plugin.test.mjs")], childEnv({ ATLAS_PLUGIN_BUNDLE: BUNDLE }));
    assert.equal(r.status, 0, r.output);
    assert.equal(r.fail, 0, r.output);
    assert.ok(r.pass >= 182, `only ${r.pass} checks ran\n${r.output}`);
  });
});

const CLT = fs.existsSync("/usr/bin/python3")
  && childProcess.spawnSync("/usr/bin/xcode-select", ["-p"]).status === 0;

describe("bundle on a clean account", () => {
  // Like a colleague's machine: empty home without a profile, system PATH, no Homebrew, no settings.
  it("starts the server with python3 from Command Line Tools",
     { skip: CLT ? false : "needs /usr/bin/python3 and Command Line Tools" }, () => {
       const home = path.join(TMP, "clean-home");
       const tmpdir = path.join(TMP, "clean-tmp");
       fs.mkdirSync(home);
       fs.mkdirSync(tmpdir);
       const env = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh",
                     USER: process.env.USER || "user", LANG: "en_US.UTF-8", TMPDIR: tmpdir,
                     ATLAS_EXPECT_PYTHON: "/usr/bin/python3", ATLAS_RUNTIME_BUNDLE: BUNDLE };
       const r = runChild([path.join(HERE, "helpers", "runtime-suite.mjs")], env);
       assert.equal(r.status, 0, r.output);
       assert.equal(r.fail, 0, r.output);
       assert.equal(r.pass, 17, r.output);
     });
});
