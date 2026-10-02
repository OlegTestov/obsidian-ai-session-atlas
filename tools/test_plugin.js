/**
 * Проверка моста плагина Obsidian без самого Obsidian.
 *
 * Важна ровно одна вещь: команды выполняются только по сообщениям от каталога.
 * На странице каталога лежит текст чужих сессий, и чужой origin не должен уметь
 * ничего запустить.
 *
 *   node tools/test_plugin.js
 */
// Промис, который не разрешится никогда, опустошает цикл событий — и node выходит с кодом 0,
// не дойдя до итога. Такой выход — провал.
let finished = false;
process.on("exit", () => {
  if (!finished) {
    console.log("FAIL тест не дошёл до конца: ожидание повисло");
    process.exitCode = 1;
  }
});
const Module = require("module");
const assert = require("assert");
const path = require("path");

// Исходник в репозитории, а не копия в vault: проверяем то, что правим. Аргументом можно
// передать собранный main.js — pytest так проверяет, что склейка ведёт себя как исходник.
const SRC = path.join(__dirname, "..", "obsidian-plugin", "src");
const PLUGIN = process.argv[2] ? path.resolve(process.argv[2]) : path.join(SRC, "main.js");

// Заглушки того, что плагин берёт из окружения Obsidian.
const views = {};
const intervals = [];
class FakeBase {
  constructor() {}
  registerView(type, factory) { views[type] = factory; }
  addRibbonIcon(icon, title) { (this.ribbons = this.ribbons || []).push({ icon, title }); }
  addCommand(c) { (this.commands = this.commands || []).push(c); }
  addSettingTab(tab) { this.settingTab = tab; }
  registerEvent() {}
  register() {}
  registerInterval(id) { intervals.push(id); return id; }
  registerDomEvent(target, type, fn, options) {
    (this.domEvents = this.domEvents || []).push({ target, type, fn, options });
  }
  async loadData() { return this.stored || null; }
  async saveData(data) { this.stored = data; }
}
const modals = [];
let lastNotice = null;
const notices = [];
// Язык Obsidian: он хранит его в localStorage; у английского ключа нет.
let obsidianLanguage = "ru";
global.window = { setTimeout, clearTimeout, setInterval: () => 0,
                  addEventListener() {}, removeEventListener() {},
                  localStorage: { getItem: (k) => (k === "language" ? obsidianLanguage : null) } };
let focusedWindow = true;
global.document = { addEventListener() {}, hasFocus: () => focusedWindow };
const systemNotes = [];
class FakeNotification {
  constructor(title, options) { this.title = title; this.body = options.body; systemNotes.push(this); }
}
FakeNotification.permission = "granted";
global.window.Notification = FakeNotification;
let windowFocusCalls = 0;
global.window.focus = () => { windowFocusCalls++; };
const stubs = {
  obsidian: {
    Plugin: FakeBase,
    ItemView: class { constructor(leaf) { this.leaf = leaf; } },
    Modal: class {
      constructor(app) {
        this.app = app;
        const el = { empty() {}, setText() {}, createEl: () => el, createDiv: () => el,
                     addEventListener() {} };
        this.titleEl = el;
        this.contentEl = el;
      }
      open() { modals.push(this); }
      close() { this.onClose(); }
    },
    Notice: class {
      constructor(msg) {
        this.msg = msg;
        notices.push(msg);
        this.noticeEl = { listeners: [], addEventListener(type, fn) { this.listeners.push(fn); } };
        lastNotice = this;
      }
    },
    PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; } },
    addIcon: () => {},
    TFile: class { constructor(path) { this.path = path; } },
    Setting: class {},
  },
};
const realLoad = Module._load;
Module._load = (request, parent, isMain) =>
  stubs[request] ? stubs[request] : realLoad(request, parent, isMain);

const SessionAtlasPlugin = require(PLUGIN);
// Чистые помощники слияния — из исходников и тоже под заглушками (сборка отдаёт только класс).
const agents = require(path.join(SRC, "agents.js"));
const i18n = require(path.join(SRC, "i18n.js"));
const { AgentTerminalView, specialKey, canFit, applyTheme } = require(path.join(SRC, "term-view.js"));
Module._load = realLoad;
// Ни один экземпляр плагина в тестах не пишет в настоящую папку данных.
const TEST_DATA = require("fs").mkdtempSync(path.join(require("os").tmpdir(), "atlas-plugin-test-"));
SessionAtlasPlugin.prototype.dataDirOverride = TEST_DATA;
process.on("exit", () => require("fs").rmSync(TEST_DATA, { recursive: true, force: true }));

const plugin = new SessionAtlasPlugin();
const opened = [];
plugin.openCommandInTerminal = (command, cwd, label) => opened.push({ command, cwd, label });

const good = {
  origin: "http://127.0.0.1:8787",
  data: { source: "session-atlas", type: "resume", command: "cd '/x' && claude --resume 1",
          cwd: "/x", title: "Тест" },
};

const cases = [
  ["чужой origin", { ...good, origin: "https://evil.example" }, false],
  ["origin с тем же портом, но https", { ...good, origin: "https://127.0.0.1:8787" }, false],
  ["без source", { ...good, data: { ...good.data, source: undefined } }, false],
  ["чужой source", { ...good, data: { ...good.data, source: "other" } }, false],
  ["неизвестный type", { ...good, data: { ...good.data, type: "exec" } }, false],
  ["пустая команда", { ...good, data: { ...good.data, command: "" } }, false],
  ["команда не строка", { ...good, data: { ...good.data, command: { toString: () => "rm" } } }, false],
  ["пустое сообщение", { origin: good.origin, data: null }, false],
  ["свой resume", good, true],
  ["свой new-session", { ...good, data: { ...good.data, type: "new-session" } }, true],
];

let failures = 0;
for (const [name, event, shouldRun] of cases) {
  const before = opened.length;
  plugin.handleMessage(event);
  const ran = opened.length > before;
  const ok = ran === shouldRun;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}: ${ran ? "выполнено" : "отклонено"}`);
}

assert.strictEqual(opened[0].command, good.data.command, "команда передана без изменений");
assert.strictEqual(opened[0].cwd, "/x", "рабочая папка передана");



// Health-проба не должна идти через fetch: из Obsidian это кросс-оригин со схемы app://,
// сервер такие отклоняет по Origin (проверено: 403 «чужой Origin»).
// В сборке — ещё и встроенная страница (модуль payload), ей fetch можно: проверяем код плагина.
const source = process.argv[2]
  ? require("fs").readFileSync(PLUGIN, "utf8").split("\n").filter((l) => !l.startsWith('__modules["payload"]')).join("\n")
  : require("fs").readdirSync(SRC).filter((f) => f.endsWith(".js"))
    .map((f) => require("fs").readFileSync(path.join(SRC, f), "utf8")).join("\n");
assert.ok(!/fetch\(/.test(source), "health-проба обязана идти через node http, не fetch");
assert.ok(/require\("http"\)/.test(source), "плагин должен использовать node http");
console.log("  ok   health-проба идёт мимо fetch");

// Строчный iframe давал внешнюю полосу прокрутки на 4 px (замерено: 304 против 300).
assert.ok(/frame\.style\.display = "block"/.test(source), "iframe каталога — блочный");
assert.ok(/container\.style\.overflow = "hidden"/.test(source), "контейнер без своей прокрутки");
console.log("  ok   у вкладки нет лишней полосы прокрутки");

// Две асинхронные отрисовки рисовали по блоку ошибки каждая.
assert.ok(/this\.rendering/.test(source), "отрисовка обязана быть защищена от наложения");
console.log("  ok   отрисовка защищена от наложения");

// --- вкладка «Активные»: список вкладок терминала, переход и закрытие с подтверждением ---

const terminalLeaf = (pid, title) => ({
  view: {
    emulator: { pseudoterminal: Promise.resolve({ shell: Promise.resolve({ pid, stdin: { write() {} } }) }) },
    getDisplayText: () => title,
  },
  detached: false,
  detach() { this.detached = true; },
});
const hungLeaf = { view: { emulator: { pseudoterminal: new Promise(() => {}) },
                           getDisplayText: () => "висит" }, detach() {} };
const leafA = terminalLeaf(5001, "Claude A");
const leafB = terminalLeaf(5002, "Claude B");
const otherLeaf = { view: { getDisplayText: () => "Заметка" }, detach() {} };
let leaves = [leafA, hungLeaf, leafB];
const workspace = { active: null, revealed: null };
plugin.app = {
  plugins: { enabledPlugins: new Set(["terminal"]) },
  workspace: {
    getLeavesOfType: (type) => (type === "terminal:terminal" ? leaves
      : type === "session-atlas-terminal" ? [] : [otherLeaf]),
    setActiveLeaf: (leaf) => { workspace.active = leaf; },
    revealLeaf: (leaf) => { workspace.revealed = leaf; },
  },
};
plugin.pendingCloseConfirms = new WeakSet();

const replies = [];
const frame = { postMessage: (msg, origin) => replies.push({ msg, origin }) };
const msg = (data, origin = good.origin) =>
  ({ origin, source: frame, data: { source: "session-atlas", ...data } });
const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, ok) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
};

(async () => {
  plugin.handleMessage(msg({ type: "list-tabs" }));
  await settle(1200);   // зависшая вкладка отваливается по таймауту, а не вешает ответ
  const tabs = replies.length ? replies[0].msg.tabs : [];
  check("список вкладок: только терминалы с живым PTY",
        JSON.stringify(tabs.map((t) => t.ptyPid)) === "[5001,5002]");
  check("ответ уходит только на origin каталога", replies[0] && replies[0].origin === good.origin);
  check("ответ помечен источником хоста", replies[0] && replies[0].msg.source === "session-atlas-host");
  check("связь с терминалом: есть", replies[0] && replies[0].msg.health
        && replies[0].msg.health.ok === true && replies[0].msg.health.reason === null);
  leaves = [leafA, leafB];

  // Связь рвётся по понятной причине — её и видно на странице.
  const healthOf = async () => (await plugin.terminalReport()).health;
  plugin.app.plugins.enabledPlugins.delete("terminal");
  let h = await healthOf();
  check("связь: плагин Terminal не нужен", h.ok, h);
  plugin.app.plugins.enabledPlugins.add("terminal");
  leaves = [hungLeaf];
  h = await healthOf();
  check("связь: вкладки есть, процесса нет", !h.ok && /не отдают процесс/.test(h.reason));
  const mute = { view: { emulator: { pseudoterminal: Promise.resolve({ shell: Promise.resolve({ pid: 5003 }) }) },
                         getDisplayText: () => "без ввода" } };
  leaves = [mute];
  h = await healthOf();
  check("связь: терминал без ввода", !h.ok && /не принимает ввод/.test(h.reason));
  leaves = [];
  h = await healthOf();
  check("связь: вкладок нет — связь есть", h.ok && /вкладок терминала нет/.test(h.reason));
  // Причина — на языке плагина: страница показывает её как есть, на том же языке.
  obsidianLanguage = "en";
  h = await healthOf();
  check("связь: причина по-английски при английском Obsidian", h.ok && h.reason === "no terminal tabs");
  obsidianLanguage = "ru";
  leaves = [leafA, leafB];

  plugin.handleMessage(msg({ type: "list-tabs" }, "https://evil.example"));
  await settle();
  check("чужой origin списка вкладок не получает", replies.length === 1);

  plugin.handleMessage(msg({ type: "focus-tab", ptyPid: 5002 }));
  await settle();
  check("«Перейти» открывает свою вкладку", workspace.active === leafB && workspace.revealed === leafB);

  workspace.active = null;
  plugin.handleMessage(msg({ type: "focus-tab", ptyPid: "5002" }));
  plugin.handleMessage(msg({ type: "focus-tab", ptyPid: 1 }));
  await settle();
  check("PID не числом или системный — игнор", workspace.active === null);

  plugin.handleMessage(msg({ type: "close-tab", ptyPid: 5001, title: "Сессия A" }));
  await settle();
  check("«Закрыть» сначала спрашивает", modals.length === 1 && !leafA.detached);
  plugin.handleMessage(msg({ type: "close-tab", ptyPid: 5001, title: "Сессия A" }));
  await settle();
  check("повторное нажатие не плодит окна", modals.length === 1);
  check("в окне название сессии", /Сессия A/.test(modals[0].text));
  modals[0].close();                      // «Оставить»
  check("«Оставить» вкладку не закрывает", !leafA.detached);

  plugin.handleMessage(msg({ type: "close-tab", ptyPid: 5001, title: "Сессия A" }));
  await settle();
  check("после отказа окно открывается снова", modals.length === 2);
  modals[1].confirmed = true;
  modals[1].close();                      // «Закрыть»
  check("подтверждение закрывает именно эту вкладку", leafA.detached && !leafB.detached);

  plugin.handleMessage(msg({ type: "close-tab", ptyPid: 4242, title: "чужой" }));
  await settle();
  check("PID без своей вкладки — ни окна, ни закрытия", modals.length === 2
        && notices.some((n) => /уже закрыта/.test(n)));

  plugin.handleMessage(msg({ type: "close-tab", ptyPid: 5002 }, "https://evil.example"));
  await settle();
  check("чужой origin закрыть не может", modals.length === 2 && !leafB.detached);

  // --- быстрый ответ: текст печатается во вкладку, как будто набран руками ---

  const typed = [];
  const typingLeaf = {
    view: {
      emulator: { pseudoterminal: Promise.resolve({ shell: Promise.resolve({
        pid: 6001, stdin: { write: (chunk) => typed.push(chunk) } }) }) },
      getDisplayText: () => "Claude C",
    },
    detach() {},
  };
  let onType = null;                 // экран вкладки меняется в ответ на нажатия — как у живого CLI
  // Вкладка с открытым диалогом тоже принимает ввод: отказ должен идти от статуса, а не от неё.
  const dialogLeaf = {
    view: {
      emulator: { pseudoterminal: Promise.resolve({ shell: Promise.resolve({
        pid: 6002, stdin: { write: (chunk) => { typed.push(chunk); if (onType) onType(chunk); } } }) }) },
      getDisplayText: () => "Claude D",
    },
    detach() {},
  };
  leaves = [typingLeaf, dialogLeaf, leafB];
  const parents = { 7001: 7000, 7000: 6001, 6001: 900, 8001: 6002, 6002: 900, 9001: 5002 };
  plugin.parentPid = (pid) => parents[pid] || 0;
  const states = { 7001: { sessionId: "sess-c", status: "idle" },
                   8001: { sessionId: "sess-b", status: "waiting", waitingFor: "input needed" },
                   9001: { sessionId: "sess-e", status: "idle" } };
  plugin.readSessionState = (pid) => states[pid] || null;
  const sendMsg = (extra, origin) => msg(Object.assign({ type: "send-text", ptyPid: 6001,
    claudePid: 7001, sessionId: "sess-c", text: "проверь тесты", nonce: "n" }, extra), origin);
  const lastReply = () => replies[replies.length - 1].msg;
  const sendCase = async (name, extra, expectOk, expectTyped, origin) => {
    typed.length = 0;
    const before = replies.length;
    plugin.handleMessage(sendMsg(extra, origin));
    await settle(650);                    // Enter уходит через паузу после вставки
    const replied = replies.length > before;
    const ok = origin ? !replied && typed.length === 0
      : replied && lastReply().ok === expectOk
        && JSON.stringify(typed) === JSON.stringify(expectTyped);
    check(name + (replied ? ` (${lastReply().ok ? "ok" : lastReply().reason})` : ""), ok);
  };

  await sendCase("однострочный ответ: текст и Enter", {}, true, ["проверь тесты", "\r"]);
  await sendCase("многострочный — вставкой, потом Enter", { text: "раз\nдва" }, true,
                 ["\x1b[200~раз\nдва\x1b[201~", "\r"]);
  await sendCase("управляющие символы вырезаются", { text: "\x03стоп\x1b[2J" }, true,
                 ["стоп[2J", "\r"]);
  await sendCase("диалог открыт (waiting) — отказ", { ptyPid: 6002, claudePid: 8001,
                 sessionId: "sess-b" }, false, []);
  await sendCase("процесс не из этой вкладки — отказ", { claudePid: 9001, sessionId: "sess-e" },
                 false, []);
  await sendCase("другая сессия в файле процесса — отказ", { sessionId: "чужая" }, false, []);
  await sendCase("пустое сообщение — отказ", { text: "   " }, false, []);
  await sendCase("слишком длинное — отказ", { text: "я".repeat(20001) }, false, []);
  await sendCase("вкладки нет — отказ", { ptyPid: 4242 }, false, []);
  await sendCase("PID строкой — отказ", { claudePid: "7001" }, false, []);
  await sendCase("чужой origin — ни ответа, ни ввода", {}, null, [], "https://evil.example");
  check("ответ несёт nonce запроса", lastReply().nonce === "n");

  // Картинки: только из папки загрузок каталога и только существующие файлы.
  const fs = require("fs");
  const os = require("os");
  const uploads = path.join(os.homedir(), "Library/Application Support/session-atlas/uploads");
  fs.mkdirSync(uploads, { recursive: true });
  const pic = path.join(uploads, "test-plugin-bridge.png");
  fs.writeFileSync(pic, "png");
  const outside = path.join(os.tmpdir(), "outside.png");
  fs.writeFileSync(outside, "png");
  try {
    await sendCase("картинка: путь отдельной вставкой, потом текст",
                   { images: [pic], text: "что тут?" }, true,
                   ["\x1b[200~" + pic + "\x1b[201~ ", "что тут?", "\r"]);
    await sendCase("только картинка без текста", { images: [pic], text: "" }, true,
                   ["\x1b[200~" + pic + "\x1b[201~ ", "\r"]);
    await sendCase("картинка вне папки загрузок — отказ", { images: [outside] }, false, []);
    await sendCase("выход из папки через .. — отказ",
                   { images: [path.join(uploads, "..", "..", "outside.png")] }, false, []);
    await sendCase("несуществующая картинка — отказ", { images: [path.join(uploads, "нет.png")] },
                   false, []);
    await sendCase("не картинка по расширению — отказ", { images: [pic.replace(".png", ".sh")] },
                   false, []);
    await sendCase("больше пяти картинок — отказ", { images: Array(6).fill(pic) }, false, []);
  } finally {
    fs.rmSync(pic, { force: true });
    fs.rmSync(outside, { force: true });
  }

  // --- ответ на диалог из карточки: экран вкладки — настоящие снимки живого Claude Code ---

  const screens = require(path.join(__dirname, "fixtures", "dialog_screens.json"));
  let screen = screens.bash;
  dialogLeaf.view.emulator.terminal = {
    get rows() { return screen.length; },
    buffer: { active: { baseY: 0, getLine: (i) => ({ translateToString: () => screen[i] }) } },
  };
  const dialogMsg = (type, extra, origin) => msg(Object.assign({ type, ptyPid: 6002,
    claudePid: 8001, sessionId: "sess-b", nonce: "d" }, extra), origin);
  const ask = async (extra) => {
    const before = replies.length;
    plugin.handleMessage(dialogMsg("read-dialog", extra));
    await settle();
    return replies.length > before ? lastReply() : null;
  };
  const press = async (name, extra, expectOk, expectTyped, origin) => {
    typed.length = 0;
    const before = replies.length;
    plugin.handleMessage(dialogMsg("answer-dialog", extra, origin));
    await settle();
    const replied = replies.length > before;
    const ok = origin ? !replied && typed.length === 0
      : replied && lastReply().type === "answered" && lastReply().ok === expectOk
        && JSON.stringify(typed) === JSON.stringify(expectTyped);
    check(name + (replied ? ` (${lastReply().ok ? "ok" : lastReply().reason})` : ""), ok);
  };

  let seen = await ask();
  check("диалог Bash: заголовок, команда, три варианта", seen && seen.type === "dialog"
        && seen.dialog.title === "Bash command" && seen.dialog.details[0] === "touch /tmp/claude-501/probeA"
        && seen.dialog.options.map((o) => o.text).join("|")
          === "Yes|Yes, and always allow access to /tmp/claude-501 from this project|No");
  await press("«Да» — одна цифра, без Enter", { option: 1, text: "Yes" }, true, ["1"]);
  await press("«Нет» — цифра 3", { option: 3, text: "No" }, true, ["3"]);
  await press("подпись не совпала — отказ", { option: 1, text: "Yes, and always" }, false, []);
  await press("номер вне экрана — отказ", { option: 4, text: "No" }, false, []);
  await press("номер строкой — отказ", { option: "1", text: "Yes" }, false, []);
  await press("чужой origin — ни ответа, ни нажатия", { option: 1, text: "Yes" }, null, [],
              "https://evil.example");
  await press("чужой id сессии — отказ", { option: 1, text: "Yes", sessionId: "чужая" }, false, []);
  screen = screens.edit;
  await press("экран правки: «Нет» — тоже цифра 3", { option: 3, text: "No" }, true, ["3"]);
  await press("вариант 2 правки — полная подпись с переносом",
              { option: 2, text: "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)" },
              true, ["2"]);
  await press("вариант 2 Bash на экране правки — отказ",
              { option: 2, text: "Yes, and always allow access to /tmp/claude-501 from this project" }, false, []);
  screen = screens.question;
  seen = await ask();
  check("вопрос: варианты без «Type something» и «Chat about this»", seen.dialog.kind === "question"
        && seen.dialog.title === "Colour" && seen.dialog.question === "Which colour do you prefer?"
        && seen.dialog.options.map((o) => o.text).join("|") === "Red|Blue"
        && seen.dialog.options[1].detail === "Cool, calm, serene");
  await press("вопрос: «Blue» — цифра 2", { option: 2, text: "Blue" }, true, ["2"]);
  screen = screens.multi;
  seen = await ask();
  check("несколько вопросов — только во вкладке", seen.dialog && seen.dialog.answerable === false
        && seen.dialog.title === "Colour · Fruits");
  await press("несколько вопросов — нажатие отказано", { option: 1, text: "Red" }, false, []);

  // Выход из режима плана — настоящие экраны: диалог, курсор в поле замечаний, набранный текст.
  screen = screens.plan;
  seen = await ask();
  check("план: одобрение — кнопками, поле замечаний — отдельно, путь к плану", seen.dialog.kind === "plan"
        && seen.dialog.options.map((o) => o.text).join("|") === "Yes, auto-accept edits|Yes, manually approve edits"
        && seen.dialog.feedback.n === 3 && seen.dialog.feedback.typed === "" && !seen.dialog.feedback.selected
        && /^~\/\.claude\/plans\/plan-how-to-create-[\w-]+\.md$/.test(seen.dialog.planPath), seen.dialog);
  await press("план: «выполнять» — цифра 1", { option: 1, text: "Yes, auto-accept edits" }, true, ["1"]);
  const note = "Используй printf вместо echo, а файл положи в /tmp/claude-501/probe2 — и добавь проверку, "
    + "что он создан, командой test -f; это длинное замечание";
  const feedbackCase = async (name, reactions, expectOk, expectTyped, extra) => {
    screen = screens.plan;
    onType = (chunk) => { if (reactions[chunk] !== undefined) screen = reactions[chunk]; };
    typed.length = 0;
    const before = replies.length;
    plugin.handleMessage(dialogMsg("answer-dialog", Object.assign({ option: 3, text: "Tell Claude what to change",
                                                                     feedback: note }, extra)));
    await settle(expectOk ? 400 : 3500);
    onType = null;
    const r = replies.length > before ? lastReply() : null;
    check(name + (r ? ` (${r.ok ? "ok" : r.reason})` : ""), r && r.ok === expectOk
          && JSON.stringify(typed) === JSON.stringify(expectTyped), typed);
  };
  await feedbackCase("план: замечания — цифра, текст, сверка экрана, Enter",
                     { 3: screens.plan_selected, [note]: screens.plan_typed }, true, ["3", note, "\r"]);
  await feedbackCase("план: поле не открылось — текст не набирается", {}, false, ["3"]);
  await feedbackCase("план: на экране другой текст — Enter не нажат", { 3: screens.plan_selected }, false, ["3", note]);
  await feedbackCase("план: замечания к чужому номеру — отказ", {}, false, [], { option: 1 });
  await feedbackCase("план: переносы строк — одной строкой", { 3: screens.plan_selected,
                     [note]: screens.plan_typed }, true, ["3", note, "\r"],
                     { feedback: note.replace(", а файл", ",\nа файл") });
  // Нумерованный список в ответе Claude под линией — не диалог, пока нет подвала «Esc to cancel».
  screen = screens.question.filter((l) => !/Esc to cancel/.test(l)).concat(["❯ ", "? for shortcuts"]);
  seen = await ask();
  check("список без подвала диалога — не диалог", seen.dialog === null);
  screen = ["❯ ", "? for shortcuts"];
  seen = await ask();
  check("на экране нет диалога — честная причина", seen.dialog === null && /не разобран/.test(seen.reason));
  states[8001].status = "idle";
  screen = screens.bash;
  seen = await ask();
  check("сессия не ждёт — диалога нет", seen.dialog === null && /диалога нет/.test(seen.reason));
  obsidianLanguage = "en";
  seen = await ask();
  check("сессия не ждёт — причина по-английски", seen.dialog === null && seen.reason === "no dialog");
  obsidianLanguage = "ru";
  await press("сессия не ждёт — нажатие отказано", { option: 1, text: "Yes" }, false, []);
  states[8001].status = "waiting";

  // --- быстрые команды: ответ, который Claude Code показывает на экране, а не в транскрипте ---

  const cmdScreens = require(path.join(__dirname, "fixtures", "command_screens.json"));
  let typingScreen = cmdScreens.context;
  typingLeaf.view.emulator.terminal = {
    get rows() { return typingScreen.length; },
    buffer: { active: { baseY: 0, getLine: (i) => ({ translateToString: () => typingScreen[i] }) } },
  };
  const commandCase = async (name, text, screen, check_) => {
    typingScreen = screen;
    const before = replies.length;
    plugin.handleMessage(sendMsg({ text, nonce: "c-" + name }));
    await settle(2100);                   // Enter + время на ответ команды
    const out = replies.slice(before).find((r) => r.msg.type === "command-output");
    check(name, !!out && out.origin === good.origin && out.msg.nonce === "c-" + name && check_(out.msg));
  };
  await commandCase("/context — отчёт с экрана", "/context", cmdScreens.context,
                    (m) => !m.panel && /Memory files/.test(m.text) && !/❯/.test(m.text));
  await commandCase("/usage — панель", "/usage", cmdScreens.usage, (m) => m.panel && /Total cost/.test(m.text));
  await commandCase("/effort low — ответ без значка ⎿", "/effort low", cmdScreens["effort-low"],
                    (m) => /^Set effort level to low/.test(m.text));
  await commandCase("/goal — панель «No goal set»", "/goal", cmdScreens.goal,
                    (m) => m.panel && /No goal set/.test(m.text));
  typed.length = 0;
  const beforePlain = replies.length;
  plugin.handleMessage(sendMsg({ text: "обычный запрос", nonce: "plain" }));
  await settle(2100);
  check("обычное сообщение экран не читает", !replies.slice(beforePlain).some((r) => r.msg.type === "command-output"));
  const beforeCompact = replies.length;
  plugin.handleMessage(sendMsg({ text: "/compact", nonce: "cmp" }));
  await settle(2100);
  check("/compact — ответ в транскрипте, экран не читаем", !replies.slice(beforeCompact).some((r) => r.msg.type === "command-output"));

  // Панель, открытая во вкладке, — текстом в карточку, закрыть её можно Esc.
  screen = cmdScreens.effort;
  seen = await ask();
  check("панель /effort — текстом, без кнопок вариантов", seen.dialog && seen.dialog.kind === "panel"
        && /Faster/.test(seen.dialog.panel) && seen.dialog.answerable === false);
  screen = screens.bash;

  // --- «Стоп»: ровно одно Esc, только работающей или ждущей в диалоге сессии ---

  const stop = async (name, extra, expectOk, expectTyped, origin) => {
    typed.length = 0;
    const before = replies.length;
    plugin.handleMessage(msg(Object.assign({ type: "interrupt", ptyPid: 6001, claudePid: 7001,
      sessionId: "sess-c", nonce: "s" }, extra), origin));
    await settle();
    const replied = replies.length > before;
    const ok = origin ? !replied && typed.length === 0
      : replied && lastReply().type === "stopped" && lastReply().ok === expectOk
        && JSON.stringify(typed) === JSON.stringify(expectTyped);
    check(name + (replied ? ` (${lastReply().ok ? "ok" : lastReply().reason})` : ""), ok);
  };
  states[7001].status = "busy";
  await stop("работает — одно Esc", {}, true, ["\x1b"]);
  states[7001].status = "shell";
  await stop("выполняет команду — одно Esc", {}, true, ["\x1b"]);
  states[7001].status = "idle";
  await stop("в покое — отказ (второе Esc открыло бы откат)", {}, false, []);
  await stop("диалог — Esc закрывает его", { ptyPid: 6002, claudePid: 8001, sessionId: "sess-b" },
             true, ["\x1b"]);
  states[7001].status = "busy";
  await stop("чужой id сессии — отказ", { sessionId: "чужая" }, false, []);
  await stop("процесс не из этой вкладки — отказ", { claudePid: 9001, sessionId: "sess-e" }, false, []);
  await stop("чужой origin — ни ответа, ни Esc", {}, null, [], "https://evil.example");
  states[7001].status = "idle";

  // --- уведомления: сессия закончила ход и ждёт тебя ---

  const ses = (id, activity, extra) => Object.assign({ session_id: id, title: "Сессия " + id,
    activity, ancestors: [] }, extra);
  let served = null;
  leaves = [leafA, leafB];
  plugin.fetchActive = async () => served;
  plugin.settings = { notify: true };
  plugin.lastActivity = null;
  const headers = [];
  const atlasLeaf = { updateHeader() { headers.push(plugin.waitingCount); } };
  const baseLeaves = plugin.app.workspace.getLeavesOfType;
  plugin.app.workspace.getLeavesOfType = (type) =>
    (type === "session-atlas" ? [atlasLeaf] : baseLeaves(type));
  const poll = async (sessions) => { served = { sessions }; notices.length = 0; await plugin.pollActive(); };

  await poll([ses("a", "busy"), ses("b", "idle"), ses("c", "background")]);
  check("первый опрос молчит, счётчик — ждущие", notices.length === 0 && plugin.waitingCount === 1);
  check("счётчик уходит в заголовок вкладки каталога", headers[headers.length - 1] === 1);
  await poll([ses("a", "idle", { ancestors: [4000, 5001] }), ses("b", "idle"), ses("c", "busy")]);
  check("работала → ждёт: уведомление", notices.length === 1 && /Сессия a/.test(notices[0])
        && /перейти/.test(notices[0]));
  check("счётчик пересчитан", plugin.waitingCount === 2);
  workspace.active = null;
  lastNotice.noticeEl.listeners.forEach((fn) => fn());
  await settle();
  check("клик по уведомлению открывает вкладку сессии", workspace.active === leafA);
  await poll([ses("a", "idle"), ses("b", "idle"), ses("c", "waiting"), ses("d", "waiting")]);
  check("диалог — уведомление, новая сессия (даже в диалоге) — нет", notices.length === 1 && /диалоге/.test(notices[0]));
  await poll([ses("a", "idle"), ses("b", "idle"), ses("c", "waiting"), ses("d", "waiting")]);
  check("без перемен — без уведомлений", notices.length === 0);
  plugin.settings.notify = false;
  await poll([ses("a", "busy"), ses("b", "idle"), ses("c", "waiting"), ses("d", "idle")]);
  await poll([ses("a", "idle"), ses("b", "idle"), ses("c", "waiting"), ses("d", "idle")]);
  check("уведомления выключены — молчит, счётчик живёт", notices.length === 0 && plugin.waitingCount === 4);
  plugin.settings.notify = true;
  served = null;
  await plugin.pollActive();
  check("сервер не ответил — счётчик не сбрасывается", plugin.waitingCount === 4);
  workspace.active = null;
  plugin.app.workspace.activeLeaf = leafA;
  await poll([ses("a", "busy", { ancestors: [5001] })]);
  await poll([ses("a", "idle", { ancestors: [5001] })]);
  check("смотришь на эту вкладку — не уведомляет", notices.length === 0);
  plugin.app.workspace.activeLeaf = null;

  // Окно Obsidian не впереди: уведомление внутри него не увидеть — ещё и системное macOS.
  plugin.settings.systemNotify = true;
  focusedWindow = true;
  systemNotes.length = 0;
  await poll([ses("a", "busy", { ancestors: [5001] })]);
  await poll([ses("a", "idle", { ancestors: [5001] })]);
  check("окно впереди — только уведомление Obsidian", notices.length === 1 && systemNotes.length === 0);
  focusedWindow = false;
  await poll([ses("a", "busy", { ancestors: [5001] })]);
  await poll([ses("a", "idle", { ancestors: [5001] })]);
  check("окно не впереди — ещё и уведомление macOS", systemNotes.length === 1
        && /Сессия a/.test(systemNotes[0].body) && !/^Session Atlas:/.test(systemNotes[0].body));
  workspace.active = null;
  systemNotes[0].onclick();
  await settle();
  check("клик по уведомлению macOS: окно и вкладка сессии", windowFocusCalls > 0 && workspace.active === leafA);
  plugin.app.workspace.activeLeaf = leafA;
  await poll([ses("a", "busy", { ancestors: [5001] })]);
  await poll([ses("a", "idle", { ancestors: [5001] })]);
  check("окно не впереди — уведомляет, даже если вкладка активна", systemNotes.length === 2);
  plugin.app.workspace.activeLeaf = null;
  plugin.settings.systemNotify = false;
  await poll([ses("a", "busy", { ancestors: [5001] })]);
  await poll([ses("a", "idle", { ancestors: [5001] })]);
  check("системные выключены — только Obsidian", systemNotes.length === 2 && notices.length === 1);
  plugin.settings.systemNotify = true;
  FakeNotification.permission = "denied";
  await poll([ses("a", "busy", { ancestors: [5001] })]);
  await poll([ses("a", "idle", { ancestors: [5001] })]);
  check("macOS запретил уведомления — без ошибки", systemNotes.length === 2 && notices.length === 1);
  FakeNotification.permission = "granted";
  focusedWindow = true;

  // --- «Поднять» сервер со страницы ---

  const raised = [];
  let ensureCalls = 0;
  let ensureResult = true;
  plugin.ensureServer = async () => { ensureCalls++; await settle(30); return ensureResult; };
  const raiseFrame = { postMessage: (m, origin) => raised.push({ m, origin }) };
  const raiseMsg = (origin = good.origin) => plugin.handleMessage({ origin, source: raiseFrame,
    data: { source: "session-atlas", type: "ensure-server" } });
  raiseMsg();
  raiseMsg();                                   // двойное нажатие
  await settle(80);
  check("«Поднять»: один запуск на двойное нажатие", ensureCalls === 1);
  check("«Поднять»: ответ каталогу", raised.length === 1 && raised[0].m.type === "server-ensured"
        && raised[0].m.ok === true && raised[0].origin === good.origin);
  ensureResult = false;
  raiseMsg();
  await settle(80);
  check("«Поднять»: не вышло — с причиной", raised[1].m.ok === false && /не поднял/.test(raised[1].m.reason));
  raiseMsg("https://evil.example");
  await settle(80);
  check("«Поднять»: чужой origin ничего не запускает", ensureCalls === 2 && raised.length === 2);

  // --- после перезапуска Obsidian: вернуть сессии, что были открыты во вкладках ---

  const restoring = new SessionAtlasPlugin();
  const stamp = Date.now();
  restoring.stored = { openSessions: [
    { session_id: "r1", title: "Ремонт сборки", at: stamp - 60e3 },
    { session_id: "r2", title: "Жива и сейчас", at: stamp - 60e3 },
    { session_id: "r3", title: "Давняя", at: stamp - 5 * 24 * 3600e3 }] };
  restoring.app = { workspace: { on: () => null, onLayoutReady: () => {},
    getLeavesOfType: (type) => (type === "terminal:terminal" ? [leafA] : []) } };
  await restoring.onload();
  const alive = [{ session_id: "r2", title: "Жива и сейчас", ancestors: [5001] },
                 { session_id: "r9", title: "Не во вкладке", ancestors: [] }];
  restoring.fetchActive = async () => ({ sessions: alive });
  await restoring.pollActive();
  const graceReplies = [];
  restoring.replyRestorable({ postMessage: (m) => graceReplies.push(m) });
  check("перезапуск: первые 20 с список не готов — вкладки поднимают сессии сами",
        graceReplies[0] && graceReplies[0].ready === false);
  restoring.loadedAt = Date.now() - 30000;
  check("перезапуск: закрытые — к восстановлению, живые и давние — нет",
        JSON.stringify(restoring.restorable.map((x) => x.session_id)) === '["r1"]');
  check("перезапуск: открытые сейчас запомнены",
        JSON.stringify(restoring.stored.openSessions.map((x) => x.session_id)) === '["r2"]');
  const restoreReplies = [];
  const restoreFrame = { postMessage: (m, origin) => restoreReplies.push({ m, origin }) };
  restoring.handleMessage({ origin: good.origin, source: restoreFrame,
                            data: { source: "session-atlas", type: "list-restorable" } });
  check("перезапуск: список уходит только каталогу", restoreReplies.length === 1
        && restoreReplies[0].origin === good.origin && restoreReplies[0].m.type === "restorable"
        && restoreReplies[0].m.ready === true && restoreReplies[0].m.sessions[0].title === "Ремонт сборки");
  restoring.handleMessage({ origin: "https://evil.example", source: restoreFrame,
                            data: { source: "session-atlas", type: "list-restorable" } });
  check("перезапуск: чужой origin списка не получает", restoreReplies.length === 1);
  // Сессию закрыли, пока Obsidian работал, — восстанавливать её после перезапуска не нужно.
  restoring.fetchActive = async () => ({ sessions: [] });
  await restoring.pollActive();
  check("закрыта вручную — не запоминается", restoring.stored.openSessions.length === 0);
  restoring.handleMessage({ origin: good.origin, source: restoreFrame,
    data: { source: "session-atlas", type: "forget-restorable", sessionIds: ["r1"] } });
  check("«не нужно» — забыть", restoring.restorable.length === 0
        && restoreReplies[restoreReplies.length - 1].m.sessions.length === 0);

  // Загрузка плагина: настройки, вкладка настроек, опрос после раскладки, заголовок вкладки.
  const fresh = new SessionAtlasPlugin();
  let layoutReady = null;
  fresh.stored = { notify: false };
  fresh.app = { workspace: { on: () => null, onLayoutReady: (fn) => { layoutReady = fn; },
                             getLeavesOfType: () => [] } };
  fresh.fetchActive = async () => null;
  await fresh.onload();
  check("настройки читаются из data.json", fresh.settings.notify === false);
  check("системные уведомления по умолчанию включены", fresh.settings.systemNotify === true);
  check("есть вкладка настроек", !!fresh.settingTab);
  check("опрос стартует после раскладки", typeof layoutReady === "function");
  layoutReady();
  check("опрос зарегистрирован как интервал плагина", intervals.length === 1);
  const view = views["session-atlas"]({}, fresh);
  fresh.waitingCount = 3;
  check("заголовок вкладки: Session Atlas (3)", view.getDisplayText() === "Session Atlas (3)");
  fresh.waitingCount = 0;
  check("без ждущих — просто Session Atlas", view.getDisplayText() === "Session Atlas");

  // --- слияние: вкладки агентов, защита закрытия, проводник, языки ---
  {
  const ID = "6e4043ad-81c1-49a2-87f4-47c469933cf3";
  // Строки — ровно как их печатает shlex.quote на сервере (atlas/actions.py, atlas/launch.py).
  const P = agents.parseLaunch;
  check("разбор: продолжить", JSON.stringify(P(`cd '/Users/u/Library/Mobile Documents/iCloud~md~obsidian' && claude --resume ${ID}`))
        === JSON.stringify({ cwd: "/Users/u/Library/Mobile Documents/iCloud~md~obsidian", mode: "resume", sessionId: ID, prompt: "" }));
  check("разбор: форк", P(`cd /x && claude --resume ${ID} --fork-session`).mode === "resume-fork");
  const withQuote = P(`cd /x && claude --session-id ${ID} 'it'"'"'s «новый» $HOME'`);
  check("разбор: новая с запросом, апостроф и $ внутри кавычек", withQuote && withQuote.mode === "new"
        && withQuote.prompt === "it's «новый» $HOME", withQuote);
  check("разбор: запрос с «-» в начале — с пробелом, как отдаёт сервер",
        P(`cd /x && claude --session-id ${ID} ' -v'`).prompt === " -v");
  for (const bad of [`cd /x && claude --resume ${ID}; rm -rf ~`, `cd /x && claude --resume ${ID} && rm x`,
                     `cd /x && claude --resume $(id)`, `cd x && claude --resume ${ID}`,
                     `cd /x && claude --resume 1`, `cd /x && claude --resume ${ID} --dangerously-skip-permissions`,
                     `cd /x && codex resume ${ID}`, `cd /x '&&' claude --resume ${ID}`,
                     `cd '/x && claude --resume ${ID}`, `cd /x && claude --session-id ${ID} "a$b"`,
                     `cd /x;id && claude --resume ${ID}`, `cd /x|id && claude --resume ${ID}`]) {
    check("разбор: чужое не узнаётся — " + bad.slice(20, 60), P(bad) === null);
  }
  const args = agents.agentArgs("/v/.obsidian/scripts/a b.zsh", "claude", "claude-x-1",
                                { mode: "new", sessionId: ID, prompt: "it's $HOME" });
  const words = agents.shellWords(args[3]);
  check("аргументы вкладки: скрипт, агент, id вкладки, старт, запрос — без подстановок оболочки",
        args.slice(0, 3).join(" ") === "-l -i -c" && JSON.stringify(words)
          === JSON.stringify(["exec", "/v/.obsidian/scripts/a b.zsh", "claude", "claude-x-1", "new", ID, "it's $HOME"]),
        words);

  // Каталог → вкладка через скрипт; неузнанная команда — как раньше, напрямую.
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-vault-"));
  fs.mkdirSync(path.join(vault, ".obsidian", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(vault, agents.SCRIPT_REL), "#!/bin/zsh\n");
  const agentPlugin = new SessionAtlasPlugin();
  agentPlugin.settings = { language: "ru" };
  agentPlugin.dataDirOverride = path.join(vault, "no-runtime");   // без распакованной сборки — копия в vault
  const states = [];
  const newLeaf = () => ({ setViewState: async (st) => states.push(st) });
  agentPlugin.app = {
    plugins: { enabledPlugins: new Set(["terminal"]) },
    vault: { adapter: { getBasePath: () => vault } },
    workspace: { getLeaf: newLeaf, getLeavesOfType: () => [], setActiveLeaf() {}, revealLeaf() {} },
  };
  agentPlugin.app.plugins.enabledPlugins.delete("terminal");      // свой терминал: Terminal не нужен
  await agentPlugin.openCommandInTerminal(`cd '/Users/u/Code/p' && claude --resume ${ID}`, "/Users/u/Code/p", "SOC Gen");
  let st = states.pop();
  let term = st && st.state;
  let w = term && agents.shellWords(term.command);
  check("каталог: своя вкладка через скрипт — папка сессии, подпись, старт «продолжить»",
        st && st.type === "session-atlas-terminal" && term.cwd === "/Users/u/Code/p" && term.title === "SOC Gen"
        && term.kind === "claude" && w[1] === path.join(vault, agents.SCRIPT_REL) && w[2] === "claude"
        && w[3] === term.instance && /^claude-/.test(w[3]) && w[4] === "resume" && w[5] === ID, st);
  const before = states.length;
  await agentPlugin.openCommandInTerminal("cd '/x' && claude --resume 1", "/x", "старая");
  st = states[states.length - 1];
  check("каталог: неузнанная команда — во вкладке как есть", states.length === before + 1
        && st.type === "session-atlas-terminal" && st.state.command === "cd '/x' && claude --resume 1"
        && st.state.instance === null);
  await agentPlugin.openAgent("codex");
  term = states[states.length - 1].state;
  w = agents.shellWords(term.command);
  check("кнопка Codex: заголовок «Codex», папка vault, без старта", term.title === "Codex"
        && term.cwd === vault && term.kind === "codex" && w[2] === "codex" && w.length === 4);
  fs.rmSync(path.join(vault, agents.SCRIPT_REL));
  notices.length = 0;
  const openedNoScript = await agentPlugin.openAgent("claude");
  check("нет скрипта — не открываем, говорим как починить", openedNoScript === false
        && notices.some((n) => /install_plugin/.test(n)));
  fs.rmSync(vault, { recursive: true, force: true });

  // Защита закрытия: крестик, средний клик, ⌘W — окно; заметки закрываются как обычно.
  const guard = new SessionAtlasPlugin();
  guard.settings = { language: "ru" };
  guard.pendingCloseConfirms = new WeakSet();
  const header = {};
  const tLeaf = { tabHeaderEl: header, view: { getViewType: () => "terminal:terminal", getDisplayText: () => "Claude" },
                  getViewState: () => ({ state: { "terminal:terminal": { profile: { name: "Claude Code" } } } }),
                  detach() { this.detached = true; } };
  const aLeaf = { tabHeaderEl: {}, view: { getViewType: () => "session-atlas" }, detach() {} };
  const nLeaf = { tabHeaderEl: {}, view: { getViewType: () => "markdown" }, detach() { this.detached = true; } };
  let active = tLeaf;
  const closeCommand = { checkCallback(checking) { if (!checking) active.detach(); return true; } };
  guard.app = { plugins: { enabledPlugins: new Set() }, commands: { commands: { "workspace:close": closeCommand } },
                workspace: { iterateAllLeaves: (fn) => [tLeaf, aLeaf, nLeaf].forEach(fn), activeLeaf: null,
                             getMostRecentLeaf: () => active } };
  check("защита: терминал, каталог — да, заметка — нет", guard.guardKind(tLeaf) === "terminal"
        && guard.guardKind(aLeaf) === "atlas" && guard.guardKind(nLeaf) === null);
  const ev = (headerEl, extra) => Object.assign({
    target: { closest: (sel) => (sel === ".workspace-tab-header-inner-close-button"
      ? { closest: () => headerEl } : headerEl) },
    button: 0, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {},
    stopImmediatePropagation() {} }, extra);
  const m0 = modals.length;
  const down = ev(header);
  guard.onCloseButton(down, false);
  check("крестик: pointerdown гасится, окна ещё нет", down.prevented && modals.length === m0);
  guard.onCloseButton(ev(header), true);
  const shown = modals[modals.length - 1];
  check("крестик: click — окно по-русски, с именем профиля", modals.length === m0 + 1
        && shown.title === "Закрыть вкладку с сессией?" && /«Claude Code»/.test(shown.text) && shown.keepLabel === "Оставить");
  shown.close();
  check("«Оставить» — вкладка живёт", !tLeaf.detached);
  guard.onMiddleClick(ev(header, { button: 1 }));
  check("средний клик по заголовку — то же окно", modals.length === m0 + 2);
  modals[modals.length - 1].close();
  guard.register = () => {};
  guard.patchCloseTabCommand();
  closeCommand.checkCallback(false);
  check("⌘W на терминале — окно, не закрытие", modals.length === m0 + 3 && !tLeaf.detached);
  modals[modals.length - 1].confirmed = true;
  modals[modals.length - 1].close();
  check("подтвердили — закрыта", tLeaf.detached);
  active = nLeaf;
  closeCommand.checkCallback(false);
  check("⌘W на заметке — закрывается сразу", nLeaf.detached && modals.length === m0 + 3);
  guard.settings.language = "en";
  guard.confirmClose(aLeaf);
  check("английский: окно каталога", modals[modals.length - 1].title === "Close the Session Atlas tab?"
        && modals[modals.length - 1].keepLabel === "Keep open");
  modals[modals.length - 1].close();
  guard.app.plugins.enabledPlugins.add("agent-terminal-ribbons");
  check("старый плагин включён — терминалы спрашивает он, не дважды", guard.guardKind(tLeaf) === null
        && guard.guardKind(aLeaf) === "atlas");

  // Проводник: левый — новая вкладка, средний — текущая, открытый — переход; прочее не трогаем.
  const { TFile } = stubs.obsidian;
  const ex = new SessionAtlasPlugin();
  ex.settings = { explorerClicks: true };
  const openedFiles = [];
  const fileLeaf = (where) => ({ openFile: async (f) => openedFiles.push([where, f.path]) });
  let focusedLeaf = null;
  const openLeaf = { getViewState: () => ({ state: { file: "open.md" } }) };
  ex.app = { plugins: { enabledPlugins: new Set() },
             vault: { getAbstractFileByPath: (p) => (p.endsWith(".md") ? new TFile(p) : { path: p }) },
             workspace: { getLeaf: () => fileLeaf("new"), getMostRecentLeaf: () => fileLeaf("current"),
                          iterateAllLeaves: (fn) => [openLeaf].forEach(fn),
                          setActiveLeaf: (l) => { focusedLeaf = l; }, revealLeaf() {} } };
  const click = (p, extra) => Object.assign({ button: 0, prevented: false,
    target: { closest: () => ({ getAttribute: () => p }) },
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} }, extra);
  ex.onExplorerClick(click("a.md"), true);
  ex.onExplorerClick(click("b.md", { button: 1 }), false);
  await settle();
  check("проводник: левый — новая вкладка, средний — текущая",
        JSON.stringify(openedFiles) === '[["new","a.md"],["current","b.md"]]', openedFiles);
  ex.onExplorerClick(click("open.md"), true);
  await settle();
  check("проводник: открытый файл не дублируется — переход к нему", focusedLeaf === openLeaf && openedFiles.length === 2);
  const folder = click("папка");
  ex.onExplorerClick(folder, true);
  const withCmd = click("c.md", { metaKey: true });
  ex.onExplorerClick(withCmd, true);
  check("проводник: папка и клик с ⌘ — как в Obsidian", !folder.prevented && !withCmd.prevented);
  ex.settings.explorerClicks = false;
  const off = click("d.md");
  ex.onExplorerClick(off, true);
  ex.settings.explorerClicks = true;
  ex.app.plugins.enabledPlugins.add("swap-click-open");
  const legacy = click("e.md");
  ex.onExplorerClick(legacy, true);
  check("проводник: выключено или включён старый плагин — не вмешиваемся", !off.prevented && !legacy.prevented);

  // Языки и загрузка рядом со старыми плагинами.
  check("язык: выбор в настройках важнее языка Obsidian", i18n.resolveLanguage("en", "ru") === "en"
        && i18n.resolveLanguage("auto", "ru") === "ru" && i18n.resolveLanguage("auto", "de") === "en");
  check("перевод: подстановка и запасной английский", i18n.translate("ru", "terminal.opened", { label: "X" }) === "Открыто: X"
        && i18n.translate("de", "close.keep") === "Keep open" && i18n.translate("ru", "нет.ключа") === "нет.ключа");
  check("переводы: у русского и английского одни ключи", JSON.stringify(Object.keys(i18n.STRINGS.ru).sort())
        === JSON.stringify(Object.keys(i18n.STRINGS.en).sort()));
  const coexist = new SessionAtlasPlugin();
  coexist.app = { plugins: { enabledPlugins: new Set(["agent-terminal-ribbons", "swap-click-open"]) },
                  workspace: { on: () => null, onLayoutReady: () => {}, getLeavesOfType: () => [] } };
  notices.length = 0;
  await coexist.onload();
  check("старые плагины включены: без второй пары кнопок, с просьбой их выключить",
        coexist.ribbons.length === 1 && notices.filter((n) => /disable the "/.test(n)).length === 2);   // по умолчанию — английский
  // Агенты: галочки, аргументы в файл для скрипта, Codex — только если установлен.
  const ag = new SessionAtlasPlugin();
  ag.app = { plugins: { enabledPlugins: new Set() },
             workspace: { on: () => null, onLayoutReady: () => {}, getLeavesOfType: () => [] } };
  await ag.onload();
  const ribbon = (i) => ({ style: {} , i });
  ag.agentRibbons = { claude: ribbon(1), codex: ribbon(2) };
  ag.shellProbe = async () => ({ claude: "/x/claude" });          // codex не найден
  await ag.detectAgents();
  check("Codex не установлен — выключен и кнопка скрыта", ag.settings.agents.codex === false
        && ag.agentRibbons.codex.style.display === "none" && ag.agentRibbons.claude.style.display === "");
  ag.settings.agents.codex = true;
  ag.refreshAgentButtons();
  const codexCommand = ag.commands.find((c) => c.id === "open-codex-terminal");
  check("включили Codex — кнопка и команда есть сразу", ag.agentRibbons.codex.style.display === ""
        && codexCommand.checkCallback(true) === true);
  ag.settings.agents.claude = false;
  check("выключили Claude Code — команды в палитре нет",
        ag.commands.find((c) => c.id === "open-claude-code-terminal").checkCallback(true) === false);
  ag.settings.agentArgs = { claude: "--chrome\n--channels x", codex: "" };
  ag.writeAgentArgs();
  const argsFile = require("fs").readFileSync(path.join(TEST_DATA, "agent-args", "claude"), "utf8");
  check("аргументы — одной строкой в файл для скрипта", argsFile === "--chrome --channels x\n", argsFile);

  const alone = new SessionAtlasPlugin();
  alone.app = { plugins: { enabledPlugins: new Set() },
                workspace: { on: () => null, onLayoutReady: () => {}, getLeavesOfType: () => [] } };
  await alone.onload();
  check("первый запуск: аргументы из файла переходят в настройки, файл не затёрт",
        alone.settings.agentArgs.claude === "--chrome --channels x"
        && require("fs").readFileSync(path.join(TEST_DATA, "agent-args", "claude"), "utf8") === "--chrome --channels x\n");
  alone.settings.agentArgs = { claude: "", codex: "" };
  await alone.saveData(alone.settings);
  const again = new SessionAtlasPlugin();
  again.app = alone.app;
  again.loadData = async () => ({ agentArgs: { claude: "", codex: "" } });
  await again.onload();
  check("аргументы очищены в настройках — файл тоже пустой, из файла не возвращаются",
        again.settings.agentArgs.claude === ""
        && require("fs").readFileSync(path.join(TEST_DATA, "agent-args", "claude"), "utf8") === "\n");
  // Перезагрузка без закрытия вкладок: тихая выгрузка (не «выключено пользователем») и загрузка.
  const calls = [];
  const rp = new SessionAtlasPlugin();
  rp.manifest = { id: "session-atlas", dir: "plug" };
  rp.app = { plugins: { plugins: {}, disablePlugin: async (id, user) => { calls.push(["off", id, user]); },
                        enablePlugin: async (id) => { calls.push(["on", id]); } } };
  rp.app.plugins.plugins["session-atlas"] = rp;
  const first = rp.reloadInPlace();
  const second = rp.reloadInPlace();
  await new Promise((r) => setTimeout(r, 150));
  check("перезагрузка: тихая выгрузка и загрузка, без флага пользователя, один раз",
        first === true && second === false && calls.length === 2 && calls[0][0] === "off"
        && calls[0][2] !== true && calls[1][0] === "on", calls);
  const other = new SessionAtlasPlugin();
  other.manifest = rp.manifest;
  other.app = rp.app;
  check("не текущий экземпляр — не перезагружает", other.reloadInPlace() === false);

  // Новая сборка на диске — плагин перезагружается сам.
  const fsT = require("fs");
  const vaultDir = fsT.mkdtempSync(path.join(require("os").tmpdir(), "atlas-reload-"));
  fsT.mkdirSync(path.join(vaultDir, "plug"));
  fsT.writeFileSync(path.join(vaultDir, "plug", "main.js"), "old");
  const wp = new SessionAtlasPlugin();
  wp.manifest = { id: "session-atlas", dir: "plug" };
  wp.app = { vault: { adapter: { getBasePath: () => vaultDir } } };
  let reloads = 0;
  wp.reloadInPlace = () => { reloads++; return true; };
  wp.watchOwnBuild();
  await new Promise((r) => setTimeout(r, 300));
  fsT.writeFileSync(path.join(vaultDir, "plug", "main.js"), "new build, longer");
  await new Promise((r) => setTimeout(r, 4500));
  fsT.unwatchFile(path.join(vaultDir, "plug", "main.js"));
  check("новая сборка на диске — перезагрузка сама, один раз", reloads === 1, reloads);
  fsT.rmSync(vaultDir, { recursive: true, force: true });

  check("Shift+Enter — ESC+Enter (новая строка в Claude Code), прочие Enter — как есть",
        specialKey({ key: "Enter", shiftKey: true }) === "\x1b\r" && specialKey({ key: "Enter" }) === null
        && specialKey({ key: "Enter", shiftKey: true, metaKey: true }) === null && specialKey({ key: "a", shiftKey: true }) === null);
  {
    const palette = { light: { "--background-primary": "#ffffff", "--text-normal": "#222222" },
                      dark: { "--background-primary": "#1e1e1e", "--text-normal": "#dddddd" } };
    let current = palette.light;
    const realStyle = global.getComputedStyle;
    global.getComputedStyle = () => ({ getPropertyValue: (n) => current[n] || "" });
    const term = { options: { theme: {} } };
    const first = applyTheme(term, {});
    current = palette.dark;
    const switched = applyTheme(term, {});
    const again = applyTheme(term, {});
    global.getComputedStyle = realStyle;
    check("тема Obsidian сменилась — открытый терминал перекрашивается, без лишних перерисовок",
          first && switched && !again && term.options.theme.background === "#1e1e1e"
          && term.options.theme.foreground === "#dddddd", term.options.theme);
  }
  check("скрытая вкладка (нулевой размер) не подгоняется — программа не перерисовывает экран",
        canFit({ isConnected: true, clientWidth: 900, clientHeight: 600 })
        && !canFit({ isConnected: true, clientWidth: 0, clientHeight: 0 })
        && !canFit({ isConnected: false, clientWidth: 900, clientHeight: 600 }) && !canFit(null));
  // Название вкладки агента — из заголовка, который присылает программа (OSC 0/2).
  let headerUpdates = 0;
  let layoutSaves = 0;
  const tv = new AgentTerminalView({ updateHeader: () => { headerUpdates++; } }, alone);
  tv.app = { workspace: { requestSaveLayout: () => { layoutSaves++; } } };
  let headerText = "";
  tv.titleEl = { setText: (t) => { headerText = t; } };
  tv.state = { kind: "claude", instance: "claude-x", title: "Claude Code" };
  tv.setLiveTitle("◑ Claude Code Reviewer с LiteLLM");
  tv.setLiveTitle("   ");
  check("заголовок программы — в название вкладки и в её состояние",
        tv.getDisplayText() === "◑ Claude Code Reviewer с LiteLLM" && tv.getState().title === tv.getDisplayText()
        && headerUpdates === 1 && layoutSaves === 1 && headerText === tv.getDisplayText(),
        [tv.getDisplayText(), headerUpdates, layoutSaves, headerText]);
  const boot = new SessionAtlasPlugin();
  const ready = [];
  boot.app = { plugins: { enabledPlugins: new Set() },
               workspace: { on: () => null, onLayoutReady: (fn) => ready.push(fn), getLeavesOfType: () => [] } };
  let started = 0;
  boot.ensureServer = async () => { started++; return true; };
  boot.watchOwnBuild = () => {};
  boot.detectAgents = async () => {};
  boot.startWatch = () => {};
  await boot.onload();
  ready.forEach((fn) => fn());
  check("сервер поднимается при загрузке плагина, а не только из вкладки каталога", started === 1, started);
  check("один: кнопки каталога, Claude Code и Codex; настройки по умолчанию",
        alone.ribbons.map((r) => r.icon).join() === "library,bot,codex-bot"
        && alone.settings.explorerClicks === true && alone.settings.language === "en");

  }
  finished = true;
  console.log(failures ? `\n${failures} проверок упало` : "\nвсе проверки моста прошли");
  process.exit(failures ? 1 : 0);
})();
