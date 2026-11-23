import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { test } from "node:test";
import vm from "node:vm";
import { loadSrc } from "./helpers/load-src.mjs";
import { JS, loadPage, pageOrder } from "./helpers/page.mjs";

const agents = ["claude", "codex", "opencode"];
const names = ["Claude Code", "Codex", "OpenCode"];
const svgNS = "http://www.w3.org/2000/svg";

class Element {
  children = [];
  attributes = new Map();
  events = new Map();
  style = {};
  className = "";

  constructor(tag, namespace) { Object.assign(this, { tag, namespace }); }
  get textContent() { return this.children.map(child => child.textContent ?? child).join(""); }
  set textContent(text) { this.replaceChildren(text); }
  get classList() {
    const classes = new Set(this.className.split(/\s+/).filter(Boolean));
    return {
      contains: name => classes.has(name),
      toggle: (name, on) => {
        if (on) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(" ");
      },
    };
  }

  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  addEventListener(type, callback) { this.events.set(type, callback); }
  findAll(predicate) {
    return [this, ...this.children.filter(child => child instanceof Element)
      .flatMap(child => child.findAll(predicate))].filter(predicate);
  }
}

function catalog({ selected, available = true } = {}) {
  const order = pageOrder();
  const page = loadPage(order.slice(0, order.indexOf("stats.js") + 1), {
    storage: selected && { "atlas.agents": JSON.stringify({ stats: { selected }, search: { selected } }) },
    setup: ctx => { ctx.ATLAS_OPENCODE_AVAILABLE = available; },
  });
  const sections = new Map();
  page.document = {
    createElement: tag => new Element(tag),
    createElementNS: (namespace, tag) => new Element(tag, namespace),
    createDocumentFragment: () => new Element("fragment"),
    createTextNode: text => text,
    querySelector: selector => {
      if (!sections.has(selector)) sections.set(selector, new Element("div"));
      return sections.get(selector);
    },
  };
  return page;
}

function icons(element) {
  return element.findAll(node => node.tag === "svg").map(icon => {
    assert.equal(icon.namespace, svgNS);
    assert.equal(icon.getAttribute("aria-hidden"), "true");
    assert.equal(icon.getAttribute("fill"), "currentColor");
    return icon;
  });
}

function iconKinds(element) { return icons(element).map(icon => icon.getAttribute("data-agent")); }
function byClass(element, name) { return element.findAll(node => node.classList.contains(name)); }

for (const [selection, available, expected, text, filtered] of [
  [["codex"], true, ["codex"], "Codex● ▾", true],
  [["opencode", "claude"], true, ["claude", "opencode"], "● ▾", true],
  [agents, true, agents, " ▾", false],
  [agents, false, ["claude", "codex"], " ▾", false],
]) {
  test(`Statistics button renders ${expected.join(", ")} with OpenCode ${available ? "visible" : "hidden"}`, () => {
    const page = catalog({ selected: selection, available });
    page.renderStatsBar();
    const [btn] = byClass(page.document.querySelector("#stats-bar"), "ms-btn");
    assert.deepEqual(iconKinds(btn), expected);
    assert.equal(btn.textContent, text);
    const title = `Agent: ${expected.map(kind => names[agents.indexOf(kind)]).join(", ")}`;
    assert.equal(btn.title, title);
    assert.equal(btn.getAttribute("aria-label"), title);
    assert.equal(btn.classList.contains("on"), filtered);
  });
}

test("unnamed buttons keep their text and the agent list has plain names, icons and counts", () => {
  const page = catalog({ selected: ["opencode"] });
  const [btn, pop] = page.agentFilter("search", () => {}, { counts: () => ({ claude: 2, codex: 4 }) }).children;
  assert.equal(btn.textContent, "Agent● ▾");
  assert.deepEqual(iconKinds(btn), []);
  assert.equal(btn.title, "Agent: OpenCode");

  // Fill after availability changes, as the live page does while the popover is open.
  pop.classList.toggle("hidden", false);
  page.setOpenCodeAvailable(false);
  assert.equal(btn.textContent, "Agent ▾");
  assert.deepEqual(iconKinds(pop), ["claude", "codex"]);
  page.setOpenCodeAvailable(true);
  const rows = pop.findAll(node => node.tag === "label");
  assert.deepEqual(rows.map(iconKinds), agents.map(kind => [kind]));
  assert.deepEqual(rows.map(row => row.textContent), ["Claude Code2", "Codex4", "OpenCode0"]);
  assert.deepEqual(byClass(pop, "agent-badge"), []);
  assert.deepEqual(rows.map(row => [row.children[0].checked, row.children[0].disabled]),
    [[false, false], [false, false], [true, true]]);
});

test("Statistics rows show plain agent names and preserve the unpriced cost", () => {
  const page = catalog();
  vm.runInContext(`
    renderTiles = () => el("div");
    renderChart = () => el("div");
    statsData = {
      by_agent: [
        { name: "claude", cost: 3, tokens: 1000, active_s: 60 },
        { key: "codex", cost: 2, tokens: 900, active_s: 40 },
        { name: "opencode", cost: null, tokens: 800, active_s: 20 },
      ],
      domains: [], models: [], topics: [], projects: [], sessions: [], tools: [], skills: [], agents: [], week: [],
    };
    renderStats();
  `, page);
  const [panel] = byClass(page.document.querySelector("#stats-body"), "spanel");
  assert.deepEqual(byClass(panel, "bn").map(node => node.textContent), names);
  assert.deepEqual(iconKinds(panel), agents);
  assert.deepEqual(byClass(panel, "agent-badge"), []);
  const openCode = byClass(panel, "brow").at(-1);
  assert.equal(byClass(openCode, "bv")[0].textContent, "—");
  assert.match(openCode.title, /^OpenCode: — · 800 tokens · /);
});

test("the page and Obsidian ribbon use the same source for every agent mark", () => {
  const registered = new Map();
  const load = Module._load;
  Module._load = (id, ...args) => id === "obsidian"
    ? { addIcon: (id, svg) => registered.set(id, svg) } : load(id, ...args);
  try {
    loadSrc("agent-icons").registerAgentIcons();
  } finally {
    Module._load = load;
  }
  const page = catalog();
  page.renderStatsBar();
  const [button] = byClass(page.document.querySelector("#stats-bar"), "ms-btn");
  assert.deepEqual([...registered.keys()], agents.map(kind => `atlas-${kind}`));
  assert.deepEqual(iconKinds(button), agents);
  const source = readFileSync(`${JS}/agent-marks.js`, "utf8");
  const pageRender = readFileSync(`${JS}/agent-filter.js`, "utf8");
  const pluginRender = readFileSync(new URL("../../obsidian-plugin/src/agent-icons.js", import.meta.url), "utf8");
  const style = readFileSync(`${JS}/atlas.css`, "utf8");
  for (const icon of icons(button)) {
    const paths = icon.children.map(node => node.getAttribute("d"));
    const ribbon = registered.get(`atlas-${icon.getAttribute("data-agent")}`);
    assert.deepEqual([...ribbon.matchAll(/\bd="([^"]+)"/g)].map(match => match[1]), paths);
    for (const d of paths) {
      assert.equal(source.split(d).length, 2);
      assert.equal(pageRender.includes(d), false);
      assert.equal(pluginRender.includes(d), false);
      assert.equal(style.includes(encodeURIComponent(d)), false);
    }
  }
});
