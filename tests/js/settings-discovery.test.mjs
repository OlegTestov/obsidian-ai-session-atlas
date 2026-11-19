import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { loadSrc } from "./helpers/load-src.mjs";
const original=Module._load;
class Tab { constructor(app,plugin){this.app=app;this.plugin=plugin;} }
Module._load=(r,p,i)=>r==="obsidian"?{PluginSettingTab:Tab, Setting:class{},Notice:class{}}:r==="electron"?{}:original(r,p,i);
const {AtlasSettingTab,DEFAULT_SETTINGS}=loadSrc("settings");
Module._load=original;
function context(){
 const saved=[],effects=[], config={models:{}};
 const plugin={settings:JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),t:k=>k,
  readServerConfig:()=>config,writeServerConfig:cfg=>{Object.assign(config,cfg||{});effects.push(cfg||"config");},agentEnabled:()=>true,
  saveData:async data=>saved.push(JSON.parse(JSON.stringify(data))),
  register(){},refreshAgentButtons:()=>effects.push("buttons"),writeAgentArgs:()=>effects.push("args"),writeMailArgs:()=>effects.push("mail"),
  codexHooksPath:()=>"/tmp/hooks.json",codexHookState:()=>({state:"off"}),setCodexHook:async on=>{effects.push("hook:"+on);return{ok:true};}};
 const tab=new AtlasSettingTab({},plugin);
 tab.update=()=>effects.push("refresh");
 return {tab,plugin,saved,effects,config};
}
const flat=defs=>defs.flatMap(d=>d.items?flat(d.items):[d]);
function controls(def){
 const handlers=[];handlers.values=[];
 const control={setValue(value){handlers.values.push(value);return this;},setLimits(){return this;},setDynamicTooltip(){return this;},
  setPlaceholder(){return this;},addOption(){return this;},setDisabled(){return this;},onChange(fn){handlers.push(fn);return this;}};
 const row={addToggle(fn){fn(control);return this;},addText(fn){fn(control);return this;},
  addSlider(fn){fn(control);return this;},addDropdown(fn){fn(control);return this;}};
 assert.equal(def.render(row),undefined,"native render cleanup must be a function or undefined");return handlers;
}
describe("settings discovery",()=>{
 it("cached server definitions read current values whenever settings reopen",async()=>{
  const {tab,config}=context();const def=flat(tab.getSettingDefinitions()).find(d=>d.name==="ai.enabled");
  const first=controls(def);assert.equal(first.values[0],true);          // no setting yet: on
  await first[0](false);assert.equal(config.llm_enabled,false);
  assert.equal(controls(def).values[0],false);
 });
 it("refresh falls back to display on hosts without the settings-search API",()=>{
  const {tab}=context();tab.update=undefined;let displayed=0;tab.display=()=>displayed++;
  tab.refresh();assert.equal(displayed,1);
 });
 it("provides localized searchable definitions for plugin and server settings",()=>{
  const {tab}=context();const defs=flat(tab.getSettingDefinitions());
  for(const key of ["settings.language","settings.agent.claude","settings.agent.codex","settings.fontSize",
   "settings.notify","updates.setting","cfg.roots","cfg.sensitive","ai.enabled",
   "ai.model.classification","ai.agent","ai.codexModel","codexHook","adv.python","adv.shell"]){
   assert.ok(defs.some(d=>d.name===key),key);
  }
  assert.ok(!defs.some(d=>d.name==="ai.language"),"one language: the plugin's");
  assert.ok(defs.every(d=>typeof d.name==="string"&&typeof d.render==="function"));
 });
 it("declarative agent controls preserve persistence and runtime side effects",async()=>{
  const {tab,plugin,saved,effects}=context();
  const def=flat(tab.getSettingDefinitions()).find(d=>d.name==="settings.agent.codex");
  const handlers=controls(def);
  await handlers[0](false);await handlers[1]("--example");
  assert.equal(plugin.settings.agents.codex,false);
  assert.equal(plugin.settings.agentArgs.codex,"--example");
  assert.equal(saved.length,2);assert.deepEqual(effects,["buttons","args"]);
 });
 it("the AI agent choice starts at auto and saves to config.json",async()=>{
  const {tab,config}=context();const def=flat(tab.getSettingDefinitions()).find(d=>d.name==="ai.agent");
  const h=controls(def);assert.equal(h.values[0],"auto");
  await h[0]("codex");assert.equal(config.ai_agent,"codex");
  assert.equal(controls(def).values[0],"codex");
 });
 it("the Codex hook toggle shows the file's state and turns the hook on and off",async()=>{
  const {tab,plugin,effects}=context();const def=flat(tab.getSettingDefinitions()).find(d=>d.name==="codexHook");
  const h=controls(def);assert.equal(h.values[0],false);
  await h[0](true);await h[0](false);
  assert.deepEqual(effects.filter(e=>String(e).startsWith("hook:")),["hook:true","hook:false"]);
  plugin.codexHookState=()=>({state:"ours"});assert.equal(controls(def).values[0],true);
 });
 it("changing the language refreshes native settings search definitions",async()=>{
  const {tab,plugin,effects}=context();
  const def=flat(tab.getSettingDefinitions()).find(d=>d.name==="settings.language");
  await controls(def)[0]("ru");assert.equal(plugin.settings.language,"ru");
  assert.deepEqual(effects,["config","refresh"]);               // config.json takes the new language too
 });
 it("the mail folder is saved on blur only, and only when it is a usable absolute path",async()=>{
  const {tab,plugin,saved}=context();const def=flat(tab.getSettingDefinitions()).find(d=>d.name==="mail.root");
  let value="",blur=null;const shown=[],changes=[];
  const control={setPlaceholder(){return this;},setValue(v){shown.push(v);value=v;return this;},getValue:()=>value,
   onChange(fn){changes.push(fn);return this;},inputEl:{addEventListener:(type,fn)=>{if(type==="blur")blur=fn;}}};
  def.render({addText(fn){fn(control);return this;}});
  for(const fn of changes)await fn("/Users/me/par");            // typing a partial path
  value="/Users/me/par";assert.deepEqual(saved,[]);assert.equal(plugin.settings.agentMailRoot,"");
  for(const bad of ["relative/box","~/","/","~"]){value=bad;await blur();}
  assert.deepEqual(saved,[]);assert.equal(plugin.settings.agentMailRoot,"");
  assert.deepEqual(shown.slice(-4),["","","",""]);
  value="/Users/me/mailbox";await blur();
  assert.equal(plugin.settings.agentMailRoot,"/Users/me/mailbox");assert.equal(saved.length,1);
  value="";await blur();assert.equal(plugin.settings.agentMailRoot,"");
 });
 it("the mail launch flags are rewritten when the mail folder or the wake switch changes",async()=>{
  const {tab,effects}=context();const defs=flat(tab.getSettingDefinitions());
  assert.equal(defs.some(d=>/^mail\.setup/.test(d.name)),false);   // no manual connect row
  await controls(defs.find(d=>d.name==="mail.wake"))[0](false);
  assert.deepEqual(effects,["mail"]);
  let value="/Users/me/mailbox",blur=null;
  defs.find(d=>d.name==="mail.root").render({addText(fn){fn({setPlaceholder(){return this;},setValue(){return this;},
   getValue:()=>value,inputEl:{addEventListener:(t,f)=>{if(t==="blur")blur=f;}}});return this;}});
  await blur();assert.deepEqual(effects,["mail","mail"]);
  await controls(defs.find(d=>d.name==="adv.python"))[0]("/opt/python3");
  assert.deepEqual(effects,["mail","mail","mail"]);
  await controls(defs.find(d=>d.name==="adv.shell"))[0]("/bin/zsh");
  assert.deepEqual(effects,["mail","mail","mail"]);
 });
});
