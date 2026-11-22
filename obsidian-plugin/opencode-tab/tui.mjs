import { Plugin } from "@opencode/plugin/tui";
import { renameSync, writeFileSync } from "node:fs";
import { createEffect } from "solid-js";

const SESSION_ID = /^ses_[0-9A-Za-z]{26}$/;

export default Plugin.define({
  id: "session-atlas.route",
  setup(context) {
    const { file, nonce, pid } = context.options;
    if (typeof file !== "string" || typeof nonce !== "string" || !Number.isInteger(pid)) return;
    let last = context.options.last;
    let verified = !last;
    let previous = "";
    let published = 0;
    const publish = () => {
      const route = context.ui.router.current();
      const current = route.type === "session" && SESSION_ID.test(route.sessionID) ? route.sessionID : null;
      if (!verified) {
        if (current !== last) return;
        verified = true;
      }
      if (current) last = current;
      const signature = JSON.stringify([route.type, current, last]);
      if (previous === signature && Date.now() - published < 2000) return;
      try {
        const tmp = file + ".tmp";
        writeFileSync(tmp, JSON.stringify({ nonce, pid, route: route.type, current, last, at: Date.now() }),
                      { mode: 0o600 });
        renameSync(tmp, file);
        previous = signature;
        published = Date.now();
      } catch { /* tab launch and navigation continue when the Atlas record cannot be updated */ }
    };
    publish();
    const slot = context.ui.slot({ append: "app", render() {
      createEffect(publish);
      return null;
    } });
    const timer = globalThis.setInterval(publish, 500);
    return () => { globalThis.clearInterval(timer); slot.dispose?.(); };
  },
});
