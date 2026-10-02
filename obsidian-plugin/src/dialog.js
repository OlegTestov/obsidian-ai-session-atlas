// Диалог Claude Code на экране вкладки терминала: разрешение или вопрос с вариантами.
// Пока диалог открыт, в транскрипте вызова ещё нет — поэтому источник только экран.
// Строки — как их отдаёт xterm (`translateToString`), проверено прогоном живого вывода.

const RULE = /^\s*─{8,}\s*$/;
const FOOTER = /Esc to cancel/;
const OPTION = /^(\s*)(?:❯\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/;
// Эти варианты ждут ввода текста — цифрой из карточки их не выбрать.
const NEEDS_TEXT = /^(Type something|Chat about this)/;
const MAX_DETAIL_LINES = 12;

// Диалог выхода из режима планирования: подвала «Esc to cancel» у него нет, зато внизу путь
// к файлу плана. Последний вариант — поле ввода: цифра только ставит в него курсор, текст
// набирается прямо в строку варианта, Enter отклоняет план с этим текстом (проверено на CLI).
const PLAN_PATH = /(~\/\.claude\/plans\/[\w.-]+\.md)/;
const PLAN_ASK = /Would you like to|proceed\?|Ready to code\?/;   // вопрос переносится на две строки
const PLAN_OPTION = /^\s*(❯\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/;
const FEEDBACK_HINT = /shift\+tab to approve with this feedback/;
const FEEDBACK_LABEL = "Tell Claude what to change";
const PLAN_END = /ctrl\+g to edit|~\/\.claude\/plans\//;

function parsePlanDialog(rows) {
  let pathRow = -1;
  let planPath = null;
  let end = rows.length;                       // свежая сессия рисует сверху, ниже — пустые строки
  while (end > 0 && !rows[end - 1].trim()) end--;
  for (let i = end - 1; i >= 0 && end - i <= 8; i--) {
    const m = PLAN_PATH.exec(rows[i]);
    if (m) { pathRow = i; planPath = m[1]; break; }
  }
  if (pathRow < 0) return null;
  let first = -1;
  for (let i = pathRow - 1; i >= 0 && pathRow - i <= 30; i--) {
    const m = PLAN_OPTION.exec(rows[i]);
    if (m && m[2] === "1") { first = i; break; }
  }
  if (first < 0 || !rows.slice(Math.max(0, first - 4), first).some((r) => PLAN_ASK.test(r))) return null;
  const options = [];
  let feedback = null;
  for (let i = first; i < pathRow; i++) {
    const row = rows[i];
    if (PLAN_END.test(row)) break;
    const m = PLAN_OPTION.exec(row);
    if (m && Number(m[2]) === options.length + 1) {
      options.push({ n: Number(m[2]), text: m[3], selected: !!m[1] });
    } else if (FEEDBACK_HINT.test(row) && options.length) {
      feedback = options.pop();                       // над подсказкой — строка поля ввода
    } else if (row.trim() && options.length) {
      options[options.length - 1].text += " " + row.trim();   // перенос длинной строки
    }
  }
  if (!feedback || !options.length) return null;
  return {
    kind: "plan", title: "План готов", details: [], question: "", planPath,
    options: options.map((o) => ({ n: o.n, text: o.text, detail: "" })),
    // Пока ничего не набрано, в строке — подпись; набранное её заменяет.
    feedback: { n: feedback.n, label: FEEDBACK_LABEL, selected: feedback.selected,
                typed: feedback.text === FEEDBACK_LABEL ? "" : feedback.text },
    answerable: true, reason: null,
  };
}

/**
 * lines — строки экрана сверху вниз. null — диалога нет.
 * {kind, title, details[], question, options[{n, text, detail}], answerable, reason}
 */
function parseDialog(lines) {
  if (!Array.isArray(lines)) return null;
  const rows = lines.map((l) => String(l || "").replace(/\s+$/, ""));
  const plan = parsePlanDialog(rows);
  if (plan) return plan;
  let footer = -1;
  for (let i = rows.length - 1; i >= 0 && rows.length - i <= 6; i--) {
    if (FOOTER.test(rows[i])) { footer = i; break; }
  }
  if (footer < 0) return null;
  // Первый вариант «1.» над подвалом; блок начинается с линии над ним.
  let first = -1;
  for (let i = footer - 1; i >= 0 && footer - i <= 40; i--) {
    const m = OPTION.exec(rows[i]);
    if (m && m[2] === "1") { first = i; break; }
  }
  if (first < 0) return null;
  let start = -1;
  for (let i = first - 1; i >= 0 && first - i <= 40; i--) {
    if (RULE.test(rows[i])) { start = i; break; }
  }
  if (start < 0) return null;

  const options = [];
  for (let i = first; i < footer; i++) {
    const row = rows[i];
    if (!row.trim() || RULE.test(row)) continue;
    const m = OPTION.exec(row);
    if (m && Number(m[2]) === options.length + 1) {
      options.push({ n: Number(m[2]), text: m[3], detail: "" });
    } else if (options.length) {
      const last = options[options.length - 1];
      last.detail = (last.detail ? last.detail + " " : "") + row.trim();
    }
  }
  const head = rows.slice(start + 1, first).map((l) => l.trim()).filter(Boolean);
  const tabs = head.length && /^(←\s*)?[☐☒✔]/.test(head[0]) ? head[0] : null;
  const kind = tabs ? "question" : "permission";
  let title = "";
  let question = "";
  let details = [];
  if (kind === "question") {
    // «← ☐ Colour  ☐ Fruits  ✔ Submit →» → «Colour · Fruits»
    title = tabs.replace(/[←→]/g, "").split(/[☐☒✔]/).map((t) => t.trim())
      .filter((t) => t && t !== "Submit").join(" · ");
    question = head.slice(1).join(" ");
  } else {
    const ask = head.findIndex((l) => /^Do you want/.test(l));
    title = head[0] || "";
    question = ask >= 0 ? head[ask] : "";
    details = head.slice(1, ask >= 0 ? ask : head.length)
      .filter((l) => !/^╌+$/.test(l)).slice(0, MAX_DETAIL_LINES);
  }
  // В разрешении продолжение строки — перенос длинной подписи, в вопросе — описание варианта.
  if (kind === "permission") {
    options.forEach((o) => { if (o.detail) { o.text += " " + o.detail; o.detail = ""; } });
  }
  const choices = options.filter((o) => !NEEDS_TEXT.test(o.text));
  // Несколько вопросов разом: цифры переключают галочки и вкладки, а не отвечают.
  const multi = !!tabs && (/Submit/.test(tabs) || (tabs.match(/[☐☒✔]/g) || []).length > 1);
  return {
    kind,
    title,
    details,
    question,
    options: choices,
    answerable: !multi && choices.length > 0,
    reason: multi ? "несколько вопросов разом — ответь во вкладке" : null,
  };
}

/** Тот же ли вариант под этим номером — перед нажатием, если экран успел смениться. */
function sameOption(dialog, n, text) {
  if (!dialog || !dialog.answerable) return false;
  const option = dialog.options.find((o) => o.n === n);
  return !!option && option.text === text;
}

const PANEL_RULE = /^\s*▔{8,}\s*$/;
const MAX_OUTPUT_LINES = 60;

const trimBlank = (lines) => {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};

/**
 * Что показала слэш-команда: открытая панель (/usage, /effort без аргумента, /goal) — всё под
 * её верхней линией ▔▔▔; иначе — текст над полем ввода, после эха «❯ /команда», если оно видно
 * (у длинного /context оно уезжает за верх экрана). {text, panel} или null.
 */
function extractCommandOutput(lines, command) {
  if (!Array.isArray(lines)) return null;
  const rows = lines.map((l) => String(l || "").replace(/\s+$/, ""));
  let panel = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (PANEL_RULE.test(rows[i])) { panel = i; break; }
  }
  let body;
  if (panel >= 0) {
    body = rows.slice(panel + 1);
  } else {
    // Поле ввода — «────», «❯ …», «────» внизу; всё, что выше, — вывод.
    let promptRule = -1;
    for (let i = rows.length - 1; i >= 1; i--) {
      if (RULE.test(rows[i - 1]) && /^❯/.test(rows[i])) { promptRule = i - 1; break; }
    }
    body = promptRule >= 0 ? rows.slice(0, promptRule) : rows;
    const cmd = String(command || "").trim();
    for (let i = body.length - 1; i >= 0 && cmd; i--) {
      if (body[i].replace(/^❯\s*/, "").trim() === cmd && /^❯/.test(body[i])) {
        body = body.slice(i + 1);
        break;
      }
    }
  }
  // «⎿» — значок ответа команды в Claude Code, в карточке он лишний.
  body = trimBlank(body.map((l) => l.replace(/^(\s*)⎿ {1,2}/, "$1"))).slice(-MAX_OUTPUT_LINES);
  if (!body.length) return null;
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return { text: body.map((l) => l.slice(indent)).join("\n"), panel: panel >= 0 };
}

/** Сравнение набранного с экраном: поле переносит длинный текст, пробелы на стыках теряются. */
const squash = (text) => String(text || "").replace(/\s+/g, "");

module.exports = { parseDialog, sameOption, extractCommandOutput, squash, FEEDBACK_LABEL };
