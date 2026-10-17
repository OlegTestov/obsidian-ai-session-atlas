import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Same uploads folder as catalog attachments; files remain available to resumed sessions. */
async function saveClipboardImage(dataDir, image) {
  if (!image.size || image.size > MAX_IMAGE_BYTES) throw new Error("Image must be between 1 byte and 20 MB");
  const bytes = Buffer.from(await image.arrayBuffer());
  let ext;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ext = "png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ext = "jpg";
  else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") ext = "webp";
  else throw new Error("Unsupported clipboard image format");
  const dir = path.join(dataDir, "uploads");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${randomUUID()}.${ext}`);
  await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
  return file;
}

export { saveClipboardImage };
