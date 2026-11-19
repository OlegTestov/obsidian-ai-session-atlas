// The unfinished escape sequence at the end of terminal output, which a snapshot cannot carry.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers/load-src.mjs";

const { unfinishedEscape, nextTail } = loadSrc("esc-tail");

describe("unfinishedEscape", () => {
  it("is empty for plain text and complete sequences", () => {
    for (const text of ["", "abc", "a\x1b[31mb", "\x1b[2J", "\x1b]0;title\x07x", "\x1b]0;t\x1b\\x", "\x1b(Bx", "\x1b7"]) {
      assert.equal(unfinishedEscape(text), "", JSON.stringify(text));
    }
  });
  it("keeps a lone ESC and a CSI without its final byte", () => {
    assert.equal(unfinishedEscape("A\x1b"), "\x1b");
    assert.equal(unfinishedEscape("A\x1b["), "\x1b[");
    assert.equal(unfinishedEscape("A\x1b[3"), "\x1b[3");
    assert.equal(unfinishedEscape("ok\x1b[1;3"), "\x1b[1;3");
    assert.equal(unfinishedEscape("\x1b[31mA\x1b[?25"), "\x1b[?25");
    assert.equal(unfinishedEscape("\x1b("), "\x1b(");
  });
  it("keeps an OSC or DCS without BEL or ST, including a pending ESC of the terminator", () => {
    assert.equal(unfinishedEscape("x\x1b]0;tit"), "\x1b]0;tit");
    assert.equal(unfinishedEscape("x\x1b]0;tit\x1b"), "\x1b]0;tit\x1b");
    assert.equal(unfinishedEscape("x\x1bPq#0"), "\x1bPq#0");
  });
  it("does not carry a CSI with a C0 control inside: xterm runs the control at once", () => {
    assert.equal(unfinishedEscape("A\x1b[3\n"), "");
    assert.equal(unfinishedEscape("A\x1b[3\n1"), "");
    assert.equal(unfinishedEscape("\x1b[1\r;"), "");
    assert.equal(unfinishedEscape("\x1b(\n"), "");
    assert.equal(unfinishedEscape("a\x1b[3\x18"), "");        // CAN cancels it
  });
  it("a DCS ends only on ST: BEL inside stays unfinished, an OSC ends on BEL", () => {
    assert.equal(unfinishedEscape("x\x1bPab\x07cd"), "\x1bPab\x07cd");
    assert.equal(unfinishedEscape("x\x1bPab\x1b\\cd"), "");
    assert.equal(unfinishedEscape("x\x1b]0;ab\x07cd"), "");
  });
  it("a pure split SGR is still carried", () => {
    assert.equal(unfinishedEscape("a\x1b[3"), "\x1b[3");
    assert.equal(nextTail("\x1b[3", "1m"), "");
  });
  it("drops what is longer than 512 characters", () => {
    assert.equal(unfinishedEscape("\x1b]0;" + "a".repeat(600)), "");
    assert.equal(unfinishedEscape("\x1b]0;" + "a".repeat(100)).length, 104);
  });
  it("nextTail joins the old tail to the next chunk: a split colour sequence completes", () => {
    let tail = nextTail("", "A\x1b[3");
    assert.equal(tail, "\x1b[3");
    tail = nextTail(tail, "1mB");
    assert.equal(tail, "");
    assert.equal(nextTail("\x1b", "[31m"), "");
    assert.equal(nextTail("\x1b[3", "1;4"), "\x1b[31;4");
  });
});
