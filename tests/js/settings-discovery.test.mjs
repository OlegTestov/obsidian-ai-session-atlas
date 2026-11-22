import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { context, flat, controls, Element, STRINGS, translate } from "./helpers/settings.mjs";

describe("settings discovery",()=>{
 it("cached server definitions read current values whenever settings reopen",async()=>{
  const {tab,config}=context();const def=flat(tab.getSettingDefinitions()).find(d=>d.name==="ai.enabled");
  const first=controls(def);assert.equal(first.values[0],true);          // no setting yet: on
  await first[0](false);assert.equal(config.llm_enabled,false);
  assert.equal(controls(def).values[0],false);
 });
 it("refresh falls back to display on hosts without the settings-search API",async()=>{
  const {tab}=context({legacy:true});tab.display();
  let displayed=0;tab.display=()=>displayed++;
  await tab.refresh();assert.equal(displayed,1);
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
  const defs=flat(tab.getSettingDefinitions());
  await controls(defs.find(d=>d.name==="settings.agent.codex"))[0](false);
  const args=controls(defs.find(d=>d.name==="settings.args.codex"));
  await args.type("--example");
  assert.deepEqual(effects,["buttons"]);
  await args.blur();await args.blur();
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
  const picker=controls(def);
  assert.equal(picker.values[0],"auto");
  await picker[0]("ru");assert.equal(plugin.settings.language,"ru");
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
  const change=async (key,value)=>{
   const field=controls(defs.find(d=>d.name===key));
   await field.type(value);await field.blur();
  };
  await change("mail.root","/Users/me/mailbox");assert.deepEqual(effects,["mail","mail"]);
  await change("adv.python","/opt/python3");
  assert.deepEqual(effects,["mail","mail","mail"]);
  await change("adv.shell","/bin/zsh");
  assert.deepEqual(effects,["mail","mail","mail"]);
 });
});

describe("settings regressions",()=>{
 it("F1 displays effective categories and leaving them untouched preserves an absent key",async()=>{
  const {tab,config,effects}=context();
  const def=flat(tab.getSettingDefinitions()).find(d=>d.name==="cfg.domains");
  const categories=controls(def);
  assert.match(categories.values[0],/^work — .+\nprojects — .+\npersonal — .+$/);
  await categories.blur();
  assert.equal(Object.hasOwn(config,"domains"),false);
  assert.deepEqual(effects,[]);
  await categories.type("");await categories.blur();
  assert.deepEqual(config.domains,[]);
  assert.equal(controls(def).values[0],"","an explicitly empty list stays empty");
  await categories.blur();assert.equal(effects.length,1);
 });

 it("F2 skips untouched fields and saves edits only once on blur",async()=>{
  const {tab,config,plugin,saved,effects}=context();
  const defs=flat(tab.getSettingDefinitions());
  for(const key of ["cfg.vaults","cfg.roots","cfg.domains","cfg.rules","cfg.sensitive","cfg.tickets",
   "ai.model.classification","ai.model.catalog_summary","ai.model.handoff","ai.codexModel","codexHook.home","mail.root"]){
   const field=controls(defs.find(d=>d.name===key));
   await field.blur();
   assert.deepEqual(effects,[],key);
  }
  assert.deepEqual(config,{models:{}});
  for(const [label,key,value] of [["mail.script","agentMailScript","/tmp/mail.py"],
   ["adv.python","pythonPath","/opt/python3"],["adv.shell","shellPath","/bin/zsh"]]){
   const field=controls(defs.find(d=>d.name===label));
   const count=saved.length;
   await field.type(value);
   assert.equal(saved.length,count,`${label} must wait for blur`);
   await field.blur();assert.equal(plugin.settings[key],value);
   await field.blur();assert.equal(saved.length,count+1,`${label} must save exactly once`);
  }
 });

 it("F3 disables both notification controls and preserves their values",async()=>{
  const {tab,plugin,saved}=context();
  Object.assign(plugin.settings,{systemNotify:true,noticeHold:"sticky"});
  const defs=flat(tab.getSettingDefinitions());
  const field=key=>controls(defs.find(d=>d.name===key));
  await field("settings.notify")[0](false);
  for(const [key,value] of [["settings.systemNotify",true],["settings.noticeHold","sticky"]]){
   const control=field(key);
   assert.equal(control.disabled,true);
   assert.equal(control.values[0],value);
   assert.equal(control.desc,"settings.notify.disabled");
  }
  assert.equal(saved.at(-1).systemNotify,true);assert.equal(saved.at(-1).noticeHold,"sticky");
  await field("settings.notify")[0](true);
  assert.equal(field("settings.systemNotify").disabled,false);
  assert.equal(field("settings.noticeHold").disabled,false);
 });

 it("F4 puts the invalid AI agent warning by its dropdown alone",async()=>{
  const {tab,plugin,config}=context();
  config.ai_agent="invalid";
  plugin.atlasRequest=async()=>({status:200,data:{sessions:3,indexing:false,ai_agent_error:"invalid AI agent from server"}});
  const defs=flat(tab.getSettingDefinitions());
  const status=new Element();
  const cleanup=defs.find(d=>d.name==="setup.index").render({settingEl:status});
  await new Promise(resolve=>setImmediate(resolve));
  cleanup();
  assert.match(JSON.stringify(status),/setup.indexed/);
  assert.doesNotMatch(JSON.stringify(status),/invalid AI agent from server/);
  const picker=controls(defs.find(d=>d.name==="ai.agent"));
  assert.deepEqual(picker.options.at(-1),["","ai.agent.invalid"]);
  assert.equal(picker.values[0],"");
  await picker[0]("codex");
  assert.equal(config.ai_agent,"codex");
 });
});

// The settings keys and controls shipped in 2.15.1, matched to their current definitions.
const MASTER_CONTROLS={
 language:["settings.language","dropdown"],showWhatsNew:["updates.setting","toggle"],explorerClicks:["settings.explorer","toggle"],
 "agents.claude":["settings.agent.claude","toggle"],"agents.codex":["settings.agent.codex","toggle"],
 loadAgentTabs:["settings.loadAgentTabs","toggle"],terminalFontSize:["settings.fontSize","slider"],
 notify:["settings.notify","toggle"],systemNotify:["settings.systemNotify","toggle"],noticeHold:["settings.noticeHold","dropdown"],
 wakeOnMail:["mail.wake","toggle"],llm_enabled:["ai.enabled","toggle"],ai_agent:["ai.agent","dropdown"],
 sensitive:["cfg.sensitive","area"],vaults:["cfg.vaults","area"],workspace_roots:["cfg.roots","area"],domains:["cfg.domains","area"],
 vault_domain_rules:["cfg.rules","area"],ticket_prefixes:["cfg.tickets","text"],statusLine:["setup.limits","toggle"],
 "hooks.PermissionRequest":["codexHook","toggle"],codexHome:["codexHook.home","text"],
 "agentArgs.claude":["settings.args.claude","text"],"agentArgs.codex":["settings.args.codex","text"],shellPath:["adv.shell","text"],
 "models.classification":["ai.model.classification","text"],"models.catalog_summary":["ai.model.catalog_summary","text"],
 "models.handoff":["ai.model.handoff","text"],force_1m:["ai.force1m","toggle"],codex_model:["ai.codexModel","text"],
 agentMailRoot:["mail.root","text"],agentMailScript:["mail.script","text"],pythonPath:["adv.python","text"],
};

it("settings layout keeps all master controls in the specified section and row order",()=>{
 const {tab}=context();
 const defs=tab.getSettingDefinitions();
 assert.deepEqual(defs.map(def=>[def.heading||def.name,def.items?.map(row=>row.name)]),[
  ["setup.heading",["setup.index"]],
  ["settings.generalHeading",["settings.language","updates.setting","settings.explorer"]],
  ["settings.agentsHeading",["settings.agent.claude","settings.agent.codex","settings.loadAgentTabs","settings.fontSize","mail.wake"]],
  ["cfg.heading",["cfg.vaults","cfg.roots","cfg.domains","cfg.rules","cfg.tickets"]],
  ["ai.heading",["ai.enabled","ai.agent","cfg.sensitive","ai.classification"]],
  ["settings.notificationsHeading",["settings.notify","settings.systemNotify","settings.noticeHold"]],
  ["adv.integrations",["adv.defaults","setup.limits","codexHook","codexHook.home"]],
  ["adv.launch",["settings.args.claude","settings.args.codex","adv.shell"]],
  ["adv.models",["ai.model.classification","ai.model.catalog_summary","ai.model.handoff","ai.force1m","ai.codexModel"]],
  ["adv.mail",["mail.root","mail.script"]],
  ["adv.diagnostics",["setup.macos","setup.python","adv.python","setup.agentPath.Claude Code","setup.agentPath.Codex","setup.address"]],
 ]);
 const rows=flat(defs);
 for(const [key,[name,type]] of Object.entries(MASTER_CONTROLS)){
  const row=rows.find(def=>def.name===name);
  assert.ok(row,key);
  assert.deepEqual(controls(row).types,[type],key);
 }
});

it("settings headings, rows, and state strings are bilingual and descriptions stay within 120 characters",()=>{
 const {tab,plugin}=context();
 const settingsKey=/^(?:setup|settings|mail|ai|cfg|adv|codexHook)(?:\.|$)|^updates\.setting/;
 for(const lang of ["en","ru"]){
  plugin.t=(key,vars)=>{
   assert.ok(Object.hasOwn(STRINGS[lang],key),`${lang}: ${key}`);
   return translate(lang,key,vars);
  };
  const defs=tab.getSettingDefinitions();
  for(const {name,desc,heading} of [...defs,...flat(defs)]){
   for(const text of [name,desc,heading].filter(Boolean)) assert.equal(text,text.trim());
   assert.ok((desc?.length||0)<=120,`${lang}: ${name} (${desc?.length})`);
  }
  for(const key of Object.keys(STRINGS.en).filter(key=>settingsKey.test(key))){
   const text=plugin.t(key);
   assert.equal(text,text.trim(),`${lang}: ${key}`);
   if(key.endsWith(".desc")) assert.ok(text.length<=120,`${lang}: ${key} (${text.length})`);
  }
 }
});
