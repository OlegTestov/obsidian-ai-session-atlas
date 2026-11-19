// The two private xterm 6 paths the card renderer needs; an xterm without them must fail loudly, not half work.
function xtermInternals(term) {
  const core = term?._core;
  const rows = core?._renderService?._renderer?.value?._rowFactory;
  const onUserInput = core?.coreService?.onUserInput;
  if (!rows || typeof onUserInput !== "function") throw new Error("this xterm no longer has the internals the card terminal needs");
  return { rows, onUserInput: handler => onUserInput.call(core.coreService, handler) };
}

export { xtermInternals };
