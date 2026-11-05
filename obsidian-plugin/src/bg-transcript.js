// A freshly parked job may not have written its transcript yet. Resuming that new id would open an
// empty conversation. In that case resume the parent whose last records name the job as continuation.
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
function resumeIdentity(data, root = PROJECTS) {
  if (!UUID.test(data.sessionId || "")) return null;
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return null; }
  // A job with its own durable history resumes itself, even if its parent also remains on disk.
  for (const dir of dirs) {
    const file = path.join(root, dir, `${data.sessionId}.jsonl`);
    try { if (fs.statSync(file).size > 0) return data.sessionId; } catch { /* not this project */ }
  }
  const slug = String(data.cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
  if (!dirs.includes(slug)) return null;
  const folder = path.join(root, slug);
  for (const name of fs.readdirSync(folder)) {
    const id = name.replace(/\.jsonl$/, "");
    if (!UUID.test(id) || !name.endsWith(".jsonl")) continue;
    let fd;
    try {
      fd = fs.openSync(path.join(folder, name), "r");
      const size = fs.fstatSync(fd).size;
      const tail = Buffer.alloc(Math.min(size, 65536));
      fs.readSync(fd, tail, 0, tail.length, size - tail.length);
      for (const line of tail.toString("utf8").split("\n")) {
        try {
          const row = JSON.parse(line);
          if (row.type === "continued-in" && row.continuedInSessionId === data.sessionId) return id;
        } catch { /* a partial line, or a still-writing transcript */ }
      }
    } catch { /* removed or not readable */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return null;
}
export { resumeIdentity };
