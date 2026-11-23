// One card's mirror of a tab's PTY: buffer live chunks, send the snapshot, flush, go live. Pure: no Obsidian.
const MAX_INPUT = 1048576;     // one input message, a paste included: the card drops a larger one whole
const MAX_QUEUED = 1048576;    // input waiting for a verification
const VERIFY_FRESH_MS = 1000;
const VERIFY_TIMEOUT_MS = 3000;

class MirrorSession {
  // deps: term, serialize(term) -> start fields, post(msg), subscribers (the tab's Set), connected() (the card is still there), alive() (and the PTY is the same and running), front(),
  // writeInput(text), fit(cols, rows), onEnd(), tail() (optional: the half-received escape sequence of the output so far), verify() (async: the target is still the same tab, agent and session), now() (optional clock),
  // bound(input) (optional: synchronous route ownership), pending(on) (optional: input is waiting for a verification), verifyTimeoutMs (optional)
  constructor(deps) {
    Object.assign(this, deps);
    this.now = deps.now || Date.now;
    this.verifiedAt = this.now();
    this.verifying = false;
    this.queue = [];
    this.queued = 0;
    this.live = false;
    this.ended = false;
    this.buffer = [];
    this.push = message => this.accept(message);
  }

  /** Subscribe at once, so bytes arriving before the snapshot callback are kept; ready(true|false) after it. */
  start(ready) {
    this.subscribers.add(this.push);
    // The parser holds a half-received sequence that the snapshot leaves out; it goes first in the live stream.
    const tail = this.tail ? this.tail() : "";
    // Queue behind pending terminal writes so the snapshot and the buffered bytes meet at the same point.
    this.term.write("", () => {
      if (!this.checkBinding() || !this.alive()) { this.end(); return ready(false); }
      let snapshot;
      try { snapshot = this.serialize(this.term); }
      catch { this.end(); return ready(false); }    // in a write callback no promise catches this
      this.post({ type: "start", ...snapshot });
      this.live = true;
      if (tail) this.post({ type: "data", text: tail });
      const held = this.buffer;
      this.buffer = [];
      held.forEach(message => this.accept(message));
      ready(!this.ended);
    });
  }

  checkBinding(input = false) {
    if (this.ended) return false;
    if (this.bound && !this.bound(input)) { this.fail(input); return false; }
    return true;
  }

  accept(message) {
    if (!this.checkBinding()) return;
    if (!this.live) { this.buffer.push(message); return; }
    if (this.connected()) this.post(message);
    if (!this.connected() || message.type === "exit") this.end();
  }

  /** A message from the card. Input needs Atlas in front; a size change does not. */
  command(command) {
    if (command?.type === "close" || !this.alive()) return this.end();
    if (command?.type === "input" && typeof command.text === "string" && command.text.length > 0
        && command.text.length <= MAX_INPUT && this.front()) this.write(command.text);
    if (command?.type === "size" && Number.isInteger(command.cols) && Number.isInteger(command.rows)
        && command.cols >= 2 && command.cols <= 400 && command.rows >= 2 && command.rows <= 200
        && this.checkBinding()) {
      this.fit(command.cols, command.rows);
    }
  }

  /** Writes at once while the last verification is fresh; otherwise queues, verifies once, then writes in order. */
  write(text) {
    if (!this.checkBinding(true)) return;
    if (!this.verifying && this.now() - this.verifiedAt < VERIFY_FRESH_MS) return this.writeInput(text);
    if (this.queued + text.length > MAX_QUEUED) return;
    if (!this.queue.length && this.pending) this.pending(true);
    this.queue.push(text);
    this.queued += text.length;
    if (this.verifying) return;
    this.verifying = true;
    // A check that never answers must not hold input (or the card) forever; its late answer finds the session ended.
    const timer = setTimeout(() => { this.verifying = false; this.fail(); }, this.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS);
    Promise.resolve().then(() => this.verify()).catch(() => false).then(ok => {
      clearTimeout(timer);
      this.verifying = false;
      if (this.ended) return;
      if (!ok || !this.alive()) return this.fail();
      if (!this.front()) return this.dropQueue();     // Atlas lost the front while the check ran
      this.verifiedAt = this.now();
      const held = this.queue;
      this.dropQueue();
      for (const item of held) {
        if (!this.checkBinding(true)) break;
        this.writeInput(item);
      }
    });
  }

  dropQueue() {
    const was = this.queue.length > 0;
    this.queue = [];
    this.queued = 0;
    if (was && this.pending) this.pending(false);
  }

  fail(unavailable = false) {
    this.dropQueue();
    this.post(unavailable ? { type: "exit", unavailable } : { type: "exit" });
    this.end();
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.dropQueue();
    this.subscribers.delete(this.push);
    this.onEnd();
  }
}

export { MirrorSession, MAX_INPUT };
