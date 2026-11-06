// A freshly parked job may not have written its transcript yet: resuming its id would open an empty
// conversation. Then the parent is resumed, the transcript whose last records name the job as its
// continuation (`continued-in`).
import * as fs from "fs";
import * as path from "path";
import { PROJECTS_DIR, SESSION_ID } from "./constants";

const TAIL_BYTES = 65536;

/** Claude Code's project folder name for a working directory. */
const projectSlug = (cwd) => String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");

function hasHistory(root, dirs, id) {
  return dirs.some((dir) => {
    try { return fs.statSync(path.join(root, dir, `${id}.jsonl`)).size > 0; } catch { return false; }
  });
}

function namesContinuation(file, id) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, TAIL_BYTES));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return tail.toString("utf8").split("\n").some((line) => {
      try {
        const row = JSON.parse(line);
        return row.type === "continued-in" && row.continuedInSessionId === id;
      } catch { return false; }                          // a cut first line, or one still being written
    });
  } catch {
    return false;                                        // removed or not readable
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The session id to resume for a job's process file: its own, or its parent's; null when neither. */
function resumeIdentity(data, root = PROJECTS_DIR) {
  const id = data && data.sessionId;
  if (!SESSION_ID.test(id || "")) return null;
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return null; }
  if (hasHistory(root, dirs, id)) return id;            // its own history wins over the parent's
  const folder = path.join(root, projectSlug(data.cwd));
  let names;
  try { names = fs.readdirSync(folder).filter((n) => n.endsWith(".jsonl") && SESSION_ID.test(n.slice(0, -6))); }
  catch { return null; }
  // The parent was written to when the job started: newest first, so the search stops early.
  const files = names.map((name) => {
    const file = path.join(folder, name);
    try { return { file, name, at: fs.statSync(file).mtimeMs }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.at - a.at);
  const parent = files.find((f) => namesContinuation(f.file, id));
  return parent ? parent.name.slice(0, -6) : null;
}

export { resumeIdentity };
