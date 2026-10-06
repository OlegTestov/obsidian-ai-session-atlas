// A CLI client with no open rollout; its shared daemon owns several files.
import { spawn } from "node:child_process";
import { api, expect, ids, run, test } from "./fixtures.mjs";

test("a resumed daemon client appears once; other daemon-held threads are not guessed", async ({ page, open }) => {
  const daemon = spawn("/bin/bash", ["-c",
    'exec -a "codex app-server --listen unix:// --managed-daemon" sleep 60 < "$1" 3< "$2"',
    "daemon", run.corpus.files.codexLedger, run.corpus.files.codexFork],
    { detached: true, stdio: "ignore" });
  const client = spawn("/bin/bash", ["-c", 'exec -a "$1" sleep 60',
    "client", `codex resume ${ids.codexLedger}`], { detached: true, stdio: "ignore" });
  try {
    await expect.poll(async () => (await api("/api/active")).sessions
      .filter(s => s.session_id === ids.codexLedger).length, { timeout: 15000 }).toBe(1);
    await open("active");
    await expect(page.locator(`#active-grid .acard[data-id="${ids.codexLedger}"]`)).toBeVisible();
    const active = (await api("/api/active")).sessions;
    expect(active.find(s => s.session_id === ids.codexLedger).pid).toBe(client.pid);
    expect(active.some(s => s.pid === daemon.pid || s.session_id === ids.codexFork)).toBe(false);
  } finally {
    for (const p of [client, daemon]) {
      try { process.kill(-p.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    await expect.poll(async () => (await api("/api/active")).sessions
      .some(s => s.session_id === ids.codexLedger), { timeout: 15000 }).toBe(false);
  }
});
