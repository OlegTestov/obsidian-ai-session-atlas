import { Plugin } from "@opencode/plugin/tui";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
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
    let timer;
    const stopHeartbeat = () => {
      if (timer !== undefined) globalThis.clearInterval(timer);
      timer = undefined;
    };
    const publish = () => {
      const route = context.ui.router.current();
      const current = route.type === "session" && SESSION_ID.test(route.sessionID) ? route.sessionID : null;
      if (!verified) {
        if (current !== last) return;
        verified = true;
      }
      if (current) last = current;
      const signature = JSON.stringify([route.type, current, last]);
      if (previous === signature && Date.now() - published < 1000) return;
      try {
        const tmp = file + ".tmp";
        writeFileSync(tmp, JSON.stringify({ nonce, pid, route: route.type, current, last, at: Date.now() }),
                      { mode: 0o600 });
        renameSync(tmp, file);
        previous = signature;
        published = Date.now();
        if (timer === undefined) timer = globalThis.setInterval(publish, 500);
      } catch {
        previous = "";
        try { unlinkSync(file); } catch (error) {
          if (error.code !== "ENOENT") stopHeartbeat();
        }
      }
    };
    timer = globalThis.setInterval(publish, 500);
    publish();
    const slot = context.ui.slot({ append: "app", render() {
      createEffect(publish);
      return null;
    } });
    return () => { stopHeartbeat(); slot.dispose?.(); };
  },
});
