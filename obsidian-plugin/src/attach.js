// A Claude Code session running in a background job is shown in a tab by `claude attach <job id>`:
// the tab's process is the attach client, the session's own process lives under Claude's daemon.
// Input from the Active view checks the client, and the session state comes from the job's file.
import * as childProcess from "child_process";
import * as fsSync from "fs";
import * as path from "path";

const JOB_ID = /^[0-9a-f]{8}$/;
const ATTACH = /^(?:\S*\/)?claude attach ([0-9a-f]{8})$/;

/** The job id from an attach client's command line, or null. */
function attachedJobId(command) {
  const m = ATTACH.exec(String(command || "").trim());
  return m ? m[1] : null;
}

function processCommand(pid) {
  try {
    return childProcess.execFileSync("ps", ["-o", "command=", "-p", String(pid)],
                                     { encoding: "utf8", timeout: 2000 }).trim();
  } catch {
    return "";
  }
}

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The process file of the job an attach client shows, when `pid` is such a client and the job's
 * process still runs; null otherwise. `command` is injectable for tests.
 */
function attachedSessionState(pid, sessionsDir, command = processCommand) {
  const job = attachedJobId(command(pid));
  if (!job) return null;
  let names = [];
  try { names = fsSync.readdirSync(sessionsDir).filter((n) => /^\d+\.json$/.test(n)); } catch { return null; }
  for (const name of names) {
    try {
      const data = JSON.parse(fsSync.readFileSync(path.join(sessionsDir, name), "utf8"));
      if (data && data.jobId === job && JOB_ID.test(data.jobId) && data.spare !== true
          && Number.isInteger(data.pid) && running(data.pid)) return data;
    } catch {
      // a file being rewritten: the next one or the next request
    }
  }
  return null;
}

export { attachedJobId, attachedSessionState };
