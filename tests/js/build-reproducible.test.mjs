import { after, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const TMP=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"atlas-repro-")));
after(()=>fs.rmSync(TMP,{recursive:true,force:true}));
function copy(name){
 const dir=path.join(TMP,name);fs.mkdirSync(dir);
 for(const f of ["atlas","web","obsidian-plugin","manifest.json","esbuild.config.mjs"]){
  fs.cpSync(path.join(ROOT,f),path.join(dir,f),{recursive:true,filter:p=>!p.includes("__pycache__")});
 }
 return dir;
}
const hash=p=>createHash("sha256").update(fs.readFileSync(p)).digest("hex");
it("release assets match across directories, working directories and symlinked dependencies",()=>{
 const a=copy("real"),b=copy("symlink");
 const modules=path.join(a,"node_modules");fs.mkdirSync(modules);
 fs.symlinkSync(fs.realpathSync(path.join(ROOT,"node_modules/esbuild")),path.join(modules,"esbuild"));
 fs.cpSync(fs.realpathSync(path.join(ROOT,"node_modules/@xterm")),path.join(modules,"@xterm"),{recursive:true});
 fs.symlinkSync(modules,path.join(b,"node_modules"));
 for(const dir of [a,b]){
  const r=spawnSync(process.execPath,[path.join(dir,"esbuild.config.mjs"),"--outdir",path.join(dir,"out")],
   {cwd:TMP,encoding:"utf8",timeout:30000});
  assert.equal(r.status,0,r.stderr);
 }
 for(const name of ["main.js","manifest.json","styles.css"]){
  assert.equal(hash(path.join(a,"out",name)),hash(path.join(b,"out",name)),name);
 }
});
