// The plugin runs in Obsidian's renderer, where window, document and getComputedStyle are globals.
// Node tests install stand-ins on Node's global object.

export function setGlobal(name, value) {
  globalThis[name] = value;
}

export function getGlobal(name) {
  return globalThis[name];
}
