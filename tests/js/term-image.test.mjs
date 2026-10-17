import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSrc } from './helpers/load-src.mjs';
const paste = loadSrc('term-paste');

test('image paste is claimed synchronously, saved once, and pasted without submitting', async () => {
  const blob = new Blob(['image'], { type: 'image/png' });
  const writes = []; let prevented = false; let stopped = false;
  const event = { clipboardData: { items: [{ type: 'image/png', getAsFile: () => blob }] },
    preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } };
  const pending = paste.pasteImageEvent(event, { paste: p => writes.push(p) }, async () => '/a folder/image.png');
  assert.ok(prevented); assert.ok(stopped);
  assert.equal(await pending, true);
  assert.deepEqual(writes, ['"/a folder/image.png" ']);
});
test('text and file-path paste keep xterm handling', () => {
  assert.equal(paste.pasteImageEvent({clipboardData:{items:[{type:'text/plain'}]}}, {}, () => assert.fail()), null);
});
test('failed image persistence never types a nonexistent path', async () => {
  await assert.rejects(paste.pasteImageEvent({clipboardData:{items:[{type:'image/png',getAsFile:()=>new Blob(['x'])}]},preventDefault(){},stopImmediatePropagation(){}}, {paste:()=>assert.fail()}, async()=>{throw Error('disk full');}), /disk full/);
});
test('clipboard image storage uses unique private PNG files and rejects oversized or invalid images', async () => {
  const { saveClipboardImage } = loadSrc('term-image');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-clipboard-'));
  try {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=', 'base64');
    const image = new Blob([bytes], {type:'image/png'});
    const a = await saveClipboardImage(dir,image); const b = await saveClipboardImage(dir,image);
    assert.notEqual(a,b); assert.deepEqual(fs.readFileSync(a),bytes);
    assert.equal(fs.statSync(a).mode & 0o777,0o600);
    await assert.rejects(saveClipboardImage(dir,new Blob(['not png'],{type:'image/png'})));
    await assert.rejects(saveClipboardImage(dir,{size:21*1024*1024}));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
