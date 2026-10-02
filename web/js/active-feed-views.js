// Лента сессии: виды «Шаги» и «Файлы». «Ходы» — в active-feed.js, он же выбирает вид.
// Классический скрипт: общий глобальный контекст с остальными файлами страницы.
// Только чтение: ни один вид ничего не отправляет в сессию.
const FEED_VIEWS = [{ value: "turns", label: i18n("feed.view.turns") },
                    { value: "steps", label: i18n("feed.view.steps") },
                    { value: "files", label: i18n("feed.view.files") }];
const STEP_FILTER_LIST = [["all", i18n("feed.filter.all")], ["error", i18n("feed.filter.error")],
                          ["bash", i18n("feed.filter.bash")], ["edit", i18n("feed.filter.edit")],
                          ["agent", i18n("feed.filter.agent")]];
const STEP_LABEL = { bash: i18n("feed.step.bash"), edit: i18n("feed.step.edit"), read: i18n("feed.step.read"),
                     search: i18n("feed.step.search"), agent: i18n("feed.step.agent"), web: i18n("feed.step.web"),
                     skill: i18n("feed.step.skill"), task: i18n("feed.step.task"), mcp: "MCP",
                     text: i18n("feed.step.text"), other: i18n("feed.step.other") };
let stepFilter = "all";

const clock = iso => (iso ? new Date(iso).toLocaleTimeString(I18N.locale(),
  { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

function stepFilterBar(turns) {
  const errors = turns.reduce((n, t) => n + ((t.events && t.events.errors) || 0), 0);
  const bar = el("div", "ffilter");
  STEP_FILTER_LIST.forEach(([value, label]) => {
    const b = el("button", value === stepFilter ? "on" : null,
                 value === "error" && errors ? `${label} ${errors}` : label);
    b.type = "button";
    if (value === "error" && errors) b.classList.add("bad");
    b.addEventListener("click", () => { stepFilter = value; feedSignature = ""; refreshFeed(false); });
    bar.appendChild(b);
  });
  return bar;
}

function stepRow(ev, running) {
  const row = el("div", "fev " + ev.kind + (ev.status === "error" ? " err" : "") + (running ? " run" : ""));
  row.append(el("span", "fat", clock(ev.at)), el("span", "fk", STEP_LABEL[ev.kind] || ev.kind),
             el("span", "fx", ev.text));
  const took = running ? i18n("feed.running", { time: AtlasLogic.durationText((Date.now() - new Date(ev.at)) / 1000) })
    : ev.took >= 1 ? AtlasLogic.durationText(ev.took) : "";
  row.appendChild(el("span", "ftook", took));
  if (ev.detail) row.title = ev.detail;
  if (ev.status === "error" && ev.error) row.appendChild(el("div", "ferr", ev.error));
  return row;
}

function stepsTurn(t, last, busy) {
  const box = el("section", "fturn");
  box.appendChild(el("div", "fwho", i18n("feed.you", { time: fmtShort(t.prompt_at) })));
  const prompt = el("div", "ftxt mine clip", t.prompt || "");
  prompt.title = t.prompt || "";
  box.appendChild(prompt);
  const ev = t.events || { events: [], earlier: 0 };
  if (ev.earlier) box.appendChild(el("div", "fwho", i18n("feed.earlier", { n: ev.earlier })));
  const shown = ev.events.filter(e => AtlasLogic.stepPasses(e, stepFilter));
  const tail = ev.events[ev.events.length - 1];
  shown.forEach(e => box.appendChild(stepRow(e, last && busy && e === tail && e.status === "run")));
  if (!shown.length) box.appendChild(el("div", "fwho", stepFilter === "all" ? i18n("feed.noSteps") : i18n("feed.noMatchingSteps")));
  if (t.reply) {
    const reply = el("div", "fwho", i18n("feed.replied", { time: fmtShort(t.reply_at) }));
    reply.title = t.reply;
    box.appendChild(reply);
  } else if (t.interrupted) box.appendChild(el("div", "fwho bad", i18n("feed.interrupted")));
  return box;
}

function renderSteps(turns, s) {
  const busy = !!s && ["busy", "background"].includes(s.activity || s.status);
  if (!turns.length) return [el("p", "empty", i18n("feed.noPrompts"))];
  // С фильтром — только ходы, где есть подходящие шаги: иначе строки «нет» заслоняют найденное.
  const keep = turns.map((t, i) => [t, i]).filter(([t]) => stepFilter === "all"
    || ((t.events && t.events.events) || []).some(e => AtlasLogic.stepPasses(e, stepFilter)));
  if (!keep.length) return [stepFilterBar(turns), el("p", "empty", i18n("feed.noMatchInTurns", { n: turns.length }))];
  return [stepFilterBar(turns), ...keep.map(([t, i]) => stepsTurn(t, i === turns.length - 1, busy))];
}

function fileRow(f, cwd, home) {
  const rel = AtlasLogic.relPath(f.path, cwd, home);
  const cut = rel.lastIndexOf("/");
  const row = el("div", "ffile");
  const name = el("span", "fn");
  name.append(el("b", null, rel.slice(cut + 1)), el("span", "fd", cut >= 0 ? " " + rel.slice(0, cut) : ""));
  row.appendChild(name);
  if (f.edit || f.write) {
    const delta = el("span", "fdelta");
    delta.append(el("span", "plus", "+" + f.added));
    if (f.removed) delta.appendChild(el("span", "minus", " −" + f.removed));   // Write: сколько стёр — неизвестно
    row.appendChild(delta);
  }
  const ops = [f.write ? i18n("feed.file.written", { n: f.write }) : null,
               f.edit ? i18n("feed.file.edits", { n: f.edit }) : null,
               f.read ? i18n("feed.file.reads", { n: f.read }) : null].filter(Boolean).join(" · ");
  row.appendChild(el("span", "fops", ops));
  row.appendChild(el("span", "ftook", f.last_at ? ago(f.last_at) : ""));
  row.title = f.path;
  return row;
}

function renderFiles(data) {
  const files = data.files || [];
  if (!files.length) return [el("p", "empty", i18n("feed.files.none"))];
  const changed = files.filter(f => f.edit || f.write);
  const read = files.filter(f => !f.edit && !f.write);
  const out = [];
  const head = el("h4", "fgroup", i18n("feed.files.changed", { n: changed.length }));
  head.title = i18n("feed.files.changed.hint");
  out.push(head);
  if (changed.length) changed.forEach(f => out.push(fileRow(f, data.cwd, data.home)));
  else out.push(el("p", "fwho", i18n("feed.files.noEdits")));
  if (read.length) {
    const more = el("details", "fread");
    more.appendChild(el("summary", "fgroup", i18n("feed.files.readOnly", { n: read.length })));
    read.forEach(f => more.appendChild(fileRow(f, data.cwd, data.home)));
    out.push(more);
  }
  return out;
}
