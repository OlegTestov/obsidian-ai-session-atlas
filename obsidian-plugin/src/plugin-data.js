// App survives module reloads. Each plugin ID owns a serialized writer and a lease: retired
// instances may finish accepted writes but cannot enqueue stale snapshots after a new load.
import { Plugin } from "obsidian";

const WRITES = Symbol.for("session-atlas.settings-writes");

function channel(plugin) {
  const owner = plugin.app || plugin;
  if (!owner[WRITES]) owner[WRITES] = new Map();
  const key = plugin.manifest ? plugin.manifest.id : "session-atlas";
  if (!owner[WRITES].has(key)) owner[WRITES].set(key, { tail: null, failed: null, revision: 0, owner: null });
  const state = owner[WRITES].get(key);
  if (!plugin.dataLease || plugin.dataLease.channel !== state) {
    if (state.owner) state.owner.retired = true;
    plugin.dataLease = { channel: state, retired: false };
    state.owner = plugin.dataLease;
  }
  return state;
}

class PluginData extends Plugin {
  saveData(data) {
    const state = channel(this);
    if (this.dataLease.retired) return Promise.resolve();
    let snapshot;
    try { snapshot = data == null ? data : JSON.parse(JSON.stringify(data)); } catch (error) { return Promise.reject(error); }
    const revision = ++state.revision;
    const saving = (state.tail ? state.tail.catch(() => {}) : Promise.resolve()).then(() => super.saveData(snapshot));
    state.tail = saving;
    saving.then(() => {
      if (revision === state.revision) state.failed = null;
      if (state.tail === saving) state.tail = null;
    }, () => {
      if (revision === state.revision) state.failed = { snapshot };
      if (state.tail === saving) state.tail = null;
    });
    return saving;
  }

  async loadData() {
    const state = channel(this);
    // A later write can join the queue while we await the first one. Failed snapshots are retried
    // by the new active instance, instead of poisoning every subsequent enable attempt.
    while (state.tail || state.failed) {
      if (state.tail) await state.tail.catch(() => {});
      else {
        const { snapshot } = state.failed;
        try {
          await this.saveData(snapshot);
        } catch (error) {
          if (this.dataLease.retired) throw new Error("AI Session Atlas: settings load superseded");
          // Storage still refuses the write: start from the newest settings, not the older disk copy.
          // The snapshot stays failed, so the next successful save clears it.
          console.error("AI Session Atlas: settings are not saved yet; using the unsaved copy", error);
          return snapshot == null ? snapshot : JSON.parse(JSON.stringify(snapshot));
        }
      }
      if (this.dataLease.retired) throw new Error("AI Session Atlas: settings load superseded");
    }
    return super.loadData();
  }
}

export { PluginData };
