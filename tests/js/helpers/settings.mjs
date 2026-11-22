import assert from "node:assert/strict";
import Module from "node:module";
import { loadSrc } from "./load-src.mjs";
const original=Module._load;
const notices=[];
class Element {
 constructor(view=globalThis){this.children=[];this.isConnected=true;Object.defineProperty(this,"view",{value:view});}
 get ownerDocument(){return {defaultView:this.view};}
 empty(){for(const child of this.children)child.disconnect();this.children=[];}
 disconnect(){this.isConnected=false;for(const child of this.children)child.disconnect();}
 addClass(){}
 createDiv(){const el=new Element(this.view);this.children.push(el);return el;}
 createEl(tag,{text}={}){const el=this.createDiv();el.textContent=text;return el;}
 createSpan(options){return this.createEl("span",options);}
 setText(text){this.textContent=text;}
}
class Row {
 constructor(container){
  this.settingEl=container.createDiv();
  this.controlEl=this.settingEl.createDiv();
  this.handlers=formControls();
 }
 setName(name){this.settingEl.name=name;return this;}
 setDesc(desc){this.settingEl.desc=this.handlers.desc=desc;return this;}
 setHeading(){return this;}
 addButton(fn){
  const button={buttonEl:{},disabled:false,setButtonText(text){this.text=text;return this;},
   setDisabled(disabled){this.disabled=disabled;return this;},onClick(click){this.click=click;return this;}};
  (this.settingEl.buttons??=[]).push(button);fn(button);return this;
 }
 addField(type,fn){
  this.settingEl.field=this.handlers;
  this.handlers.types.push(type);
  fn(this.handlers.control);return this;
 }
 addToggle(fn){return this.addField("toggle",fn);}
 addText(fn){return this.addField("text",fn);}
 addTextArea(fn){return this.addField("area",fn);}
 addSlider(fn){return this.addField("slider",fn);}
 addDropdown(fn){return this.addField("dropdown",fn);}
}
class Tab { constructor(app,plugin){this.app=app;this.plugin=plugin;} }
Module._load=(r,p,i)=>r==="obsidian"?{PluginSettingTab:Tab, Setting:Row,Notice:class{constructor(message){notices.push(message);}}}:r==="electron"?{}:original(r,p,i);
const {AtlasSettingTab,DEFAULT_SETTINGS}=loadSrc("settings");
const {STRINGS,translate}=loadSrc("i18n");
Module._load=original;
function context({legacy=false,view}={}){
 const saved=[],effects=[], config={models:{}};
 const plugin={settings:JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),t:(key,vars)=>vars?.agent ? `${key}.${vars.agent}` : key,
  readServerConfig:()=>config,writeServerConfig:cfg=>{Object.assign(config,cfg||{});effects.push(cfg||"config");},agentEnabled:()=>true,
  saveData:async data=>saved.push(JSON.parse(JSON.stringify(data))),
  register(){},refreshAgentButtons:()=>effects.push("buttons"),writeAgentArgs:()=>effects.push("args"),writeMailArgs:()=>effects.push("mail"),
  codexHooksPath:()=>"/tmp/hooks.json",codexHookState:()=>({state:"off"}),setCodexHook:async on=>{effects.push("hook:"+on);return{ok:true};}};
 Object.assign(plugin,{
  macosVersion:async()=>"15.0",findPython:async()=>({path:"/bin/python3",version:"3.11"}),
  commandLineToolsInstalled:async()=>true,shellProbe:async()=>({claude:"/bin/claude",codex:"/bin/codex"}),
  healthInfo:async()=>({app:"session-atlas",port:8787}),atlasOrigin:()=>"http://127.0.0.1:8787",
  atlasRequest:async()=>({status:200,data:{sessions:3,indexing:false}}),
  statusLineState:()=>({state:"off"}),claudeSettingsPath:()=>"/tmp/settings.json",
 });
 const tab=new AtlasSettingTab({},plugin);
 tab.containerEl=new Element(view??{setTimeout(){},clearTimeout(){}});
 if(!legacy)tab.update=()=>effects.push("refresh");
 return {tab,plugin,saved,effects,config};
}
const flat=defs=>defs.flatMap(d=>d.items?flat(d.items):[d]);
function formControls(){
 const handlers=[];handlers.values=[];handlers.options=[];handlers.types=[];
 const inputEl=new Element();
 inputEl.addEventListener=(type,fn)=>{handlers[type]=fn;};
 let value;
 const control={inputEl,setValue(next){value=next;handlers.values.push(value);return this;},getValue:()=>value,
  setLimits(){return this;},setDynamicTooltip(){return this;},setPlaceholder(placeholder){handlers.placeholder=placeholder;return this;},
  addOption(key,label){handlers.options.push([key,label]);return this;},
  setDisabled(disabled){handlers.disabled=disabled;return this;},onChange(fn){handlers.push(fn);return this;}};
 handlers.type=async next=>{value=next;for(const fn of handlers)await fn(next);};
 handlers.value=()=>value;
 handlers.control=control;
 return handlers;
}
function controls(def){
 const row=new Row(new Element());
 const {handlers}=row;
 handlers.cleanup=def.render(row);
 assert.ok(handlers.cleanup===undefined||typeof handlers.cleanup==="function");return handlers;
}
const definitionFor=(tab,key)=>flat(tab.getSettingDefinitions()).find(def=>def.name===key);
const settled=()=>new Promise(resolve=>setImmediate(resolve));

export { context, flat, controls, definitionFor, settled, notices, Element, STRINGS, translate };
