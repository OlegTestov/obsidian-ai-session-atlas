// Same ordering as xterm's WriteBuffer: chunks parsed in a later task, callback right after its own chunk.
export function fakeTerm() {
  const queue = [];
  let scheduled = false;
  const term = { screen: "", cols: 80, rows: 24, options: { scrollback: 100 },
    loadAddon(a) { a.activate(term); },
    write(text, cb) {
      queue.push([text, cb]);
      if (!scheduled) { scheduled = true; setTimeout(() => { scheduled = false;
        while (queue.length) { const [t, c] = queue.shift(); term.screen += t; c?.(); } }); }
    } };
  return term;
}
