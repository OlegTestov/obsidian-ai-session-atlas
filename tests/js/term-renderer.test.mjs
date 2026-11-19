// The card's terminal renderer: input messages and the private xterm paths it depends on.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT, loadSrc } from "./helpers/load-src.mjs";

const require = createRequire(import.meta.url);
const XTERM_JS = fs.readFileSync(path.join(ROOT, "node_modules", "@xterm", "xterm", "lib", "xterm.js"), "utf8");
const MAX_INPUT = 1048576;

describe("input messages", () => {
  const { inputMessage } = loadSrc("term-input");
  it("a text is one message, an empty one none", () => {
    assert.deepEqual(inputMessage("ls\r"), { type: "input", text: "ls\r" });
    assert.equal(inputMessage(""), null);
  });
  it("a large paste goes whole as one message", () => {
    const text = Array.from({ length: 150000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    assert.deepEqual(inputMessage(text), { type: "input", text });
    assert.equal(inputMessage("x".repeat(MAX_INPUT)).text.length, MAX_INPUT);
  });
  it("a paste over the limit is dropped whole, nothing partial", () => {
    assert.equal(inputMessage("x".repeat(MAX_INPUT + 1)), null);
  });
  it("the limit matches the plugin's", () => {
    assert.equal(loadSrc("mirror-session").MAX_INPUT, MAX_INPUT);
  });
});

describe("xterm internals the card renderer reaches into", () => {
  it("@xterm/xterm stays pinned to the version these paths were checked on", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.match(pkg.devDependencies["@xterm/xterm"], /^\d+\.\d+\.\d+$/);
  });
  it("the installed xterm has them: onUserInput, and the DOM renderer's row factory with its document", () => {
    const { Terminal } = require("@xterm/xterm");
    const term = new Terminal({ cols: 10, rows: 3 });
    assert.equal(typeof term._core?.coreService?.onUserInput, "function");
    for (const needle of ["_renderService", "_renderer", "_rowFactory=", "DomRendererRowFactory"]) {
      assert.ok(XTERM_JS.includes(needle), `${needle} is gone from xterm.js`);
    }
    assert.match(XTERM_JS, /_rowFactory=\w+\.createInstance\(\w+\.DomRendererRowFactory,document\)/);
  });
  it("the renderer refuses an xterm without them instead of half working", () => {
    const { xtermInternals } = loadSrc("term-internals");
    const rows = { _document: null };
    const ok = { _core: { coreService: { onUserInput() {} }, _renderService: { _renderer: { value: { _rowFactory: rows } } } } };
    assert.equal(xtermInternals(ok).rows, rows);
    for (const broken of [{}, { _core: {} }, { _core: { coreService: {}, _renderService: ok._core._renderService } },
                          { _core: { coreService: ok._core.coreService, _renderService: { _renderer: {} } } }]) {
      assert.throws(() => xtermInternals(broken), /xterm/);
    }
  });
});
