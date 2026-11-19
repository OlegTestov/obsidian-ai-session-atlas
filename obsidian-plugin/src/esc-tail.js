// The part of the terminal output that is a half-received escape sequence. The parser holds it,
// a snapshot leaves it out, so a mirror that starts there needs it first.
const MAX_TAIL = 512;

/**
 * The trailing escape sequence of `text` that is not finished yet, or "".
 * Only a "pure" one is carried: xterm runs a C0 control inside an escape or CSI sequence at once, so
 * replaying such a tail would repeat its effect. Inside an OSC/DCS string a C0 byte is data (BEL ends
 * an OSC only; a DCS ends on ST). CAN and SUB cancel any sequence. 8-bit C1 introducers (0x9b, 0x9d,
 * 0x90) are ignored: they are UTF-8 continuation bytes in the text that reaches here.
 */
function unfinishedEscape(text) {
  if (text.indexOf("\x1b") < 0) return "";
  let state = "ground", start = 0, osc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (state === "strEsc") {
      if (ch === 0x5c) { state = "ground"; continue; }
      state = "esc"; start = i - 1;           // the ESC began a new sequence, not a terminator
    }
    if (ch === 0x1b) {
      if (state === "str") state = "strEsc";           // maybe the terminator ESC \
      else { state = "esc"; start = i; }
      continue;
    }
    if (ch === 0x18 || ch === 0x1a) { state = "ground"; continue; }
    if (state === "str") {
      if (ch === 0x07 && osc) state = "ground";
    } else if (state === "esc") {
      if (ch === 0x5b) state = "csi";
      else if (ch === 0x5d || ch === 0x50 || ch === 0x58 || ch === 0x5e || ch === 0x5f) { state = "str"; osc = ch === 0x5d; }
      else if (!(ch >= 0x20 && ch <= 0x2f)) state = "ground";   // a final byte, or a C0 control that runs at once
    } else if (state === "csi") {
      if (ch < 0x20 || ch > 0x3f) state = "ground";             // a final byte, a C0 control or a byte not valid here
    }
  }
  if (state === "ground") return "";
  const tail = text.slice(start);
  return tail.length > MAX_TAIL ? "" : tail;
}

/** The unfinished sequence after the output so far, given the previous one and the next chunk. */
function nextTail(previous, chunk) {
  return unfinishedEscape(previous + chunk);
}

export { unfinishedEscape, nextTail, MAX_TAIL };
