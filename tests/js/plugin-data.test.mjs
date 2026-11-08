import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { loadSrc } from "./helpers/load-src.mjs";
const realLoad = Module._load;
const events = [];
class Base {
  async saveData(data) { await this.app.write(data); }
  async loadData() { events.push("read"); return this.app.disk; }
}
Module._load = (r,p,i) => r === "obsidian" ? { Plugin: Base } : realLoad(r,p,i);
const { PluginData } = loadSrc("plugin-data");
Module._load = realLoad;
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function instance(app) { return Object.assign(new PluginData(), { app, manifest: { id: "session-atlas" } }); }

describe("settings writes across plugin reloads", () => {
  it("a retired asynchronous poll cannot overwrite a new instance's settings", async () => {
    const gate=deferred();
    const app={disk:null,async write(v){this.disk=v;}};
    const old=instance(app);await old.saveData({name:"Backend"});
    const polling=(async()=>{await gate.promise;await old.saveData({name:"Backend",openSessions:[]});})();
    const next=instance(app);await next.loadData();await next.saveData({name:"Infra"});
    gate.resolve();await polling;
    assert.deepEqual(app.disk,{name:"Infra"});
  });
  it("a new enable retries a failed snapshot once storage is writable again", async () => {
    let broken=true;
    const app={disk:{name:"Backend"},async write(v){if(broken)throw new Error("disk error");this.disk=v;}};
    await assert.rejects(instance(app).saveData({name:"Infra"}),/disk error/);
    const quiet=console.error;console.error=()=>{};
    try {
      // Storage still broken: the plugin loads with the newest settings instead of failing to load.
      const loaded=await instance(app).loadData();
      assert.deepEqual(loaded,{name:"Infra"});
      assert.deepEqual(app.disk,{name:"Backend"});
    } finally { console.error=quiet; }
    broken=false;
    assert.deepEqual(await instance(app).loadData(),{name:"Infra"});
    assert.deepEqual(app.disk,{name:"Infra"});
  });
  it("data that cannot be serialised rejects instead of throwing", async () => {
    const app={disk:null,async write(v){this.disk=v;}};
    const cyclic={};cyclic.self=cyclic;
    let result;
    assert.doesNotThrow(()=>{result=instance(app).saveData(cyclic);});
    await assert.rejects(result,TypeError);
  });
  it("a reloaded instance reads only after the previous disk write finishes", async () => {
    events.length = 0;
    const gate = deferred();
    const app = { disk: { tabGroups: "old" }, async write(value) { await gate.promise; this.disk=value; } };
    const old = instance(app), next = instance(app);
    const writing = old.saveData({ tabGroups: "new" });
    let read = false;
    const loading = next.loadData().then(value => { read=true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(read,false);
    gate.resolve();
    await writing;
    assert.deepEqual(await loading,{tabGroups:"new"});
  });
  it("the barrier survives reloading the plugin module itself", async () => {
    const gate = deferred();
    const app = { disk: null, async write(data) { await gate.promise; this.disk = data; } };
    const saving = instance(app).saveData({ tabGroups: "kept" });
    const file = Object.keys(Module._cache).find(k => k.endsWith("/plugin-data.js"));
    delete Module._cache[file];
    Module._load = (r,p,i) => r === "obsidian" ? { Plugin: Base } : realLoad(r,p,i);
    const Next = loadSrc("plugin-data").PluginData;
    Module._load = realLoad;
    let read = false;
    const next = Object.assign(new Next(), { app, manifest: { id: "session-atlas" } });
    const loading = next.loadData().then(data => { read = true; return data; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(read, false);
    gate.resolve(); await saving;
    assert.deepEqual(await loading, { tabGroups: "kept" });
  });
  it("loading waits for writes queued while it was already waiting", async () => {
    const a=deferred(), b=deferred();
    const app={disk:null, async write(v){ await (v.n===1?a:b).promise; this.disk=v; }};
    const p=instance(app), one=p.saveData({n:1});
    let read=false;
    const next=instance(app);
    const loading=next.loadData().then(v=>{read=true;return v;});
    const two=next.saveData({n:2});
    a.resolve();await one;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(read,false);
    b.resolve();await two;assert.deepEqual(await loading,{n:2});
  });
  it("serializes writes and snapshots the value when queued", async () => {
    const gate=deferred(), started=[];
    const app={ disk:null, async write(value) { started.push(value.n); if(value.n===1) await gate.promise; this.disk=value; } };
    const p=instance(app), a={n:1}, b={n:2};
    const first=p.saveData(a), second=p.saveData(b);
    a.n=10; b.n=20;
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(started,[1]);
    gate.resolve(); await Promise.all([first,second]);
    assert.deepEqual(app.disk,{n:2});
  });
  it("vaults and other plugins do not block each other", async () => {
    const gate=deferred();
    const a={disk:null,async write(v){ await gate.promise; this.disk=v; }};
    const b={disk:{ok:true},async write(v){this.disk=v;}};
    const pending=instance(a).saveData({n:1});
    assert.deepEqual(await instance(b).loadData(),{ok:true});
    const other=instance(a); other.manifest.id="other-plugin";
    assert.equal(await other.loadData(),null);
    gate.resolve(); await pending;
  });
  it("a failed write is visible to the caller and does not stop a later save", async () => {
    const app={disk:{old:true},async write(v){ if(v.fail) throw new Error("disk error");this.disk=v;}};
    const p=instance(app);
    await assert.rejects(p.saveData({fail:true}),/disk error/);
    await p.saveData({recovered:true});
    assert.deepEqual(await instance(app).loadData(),{recovered:true});
  });
});
