// Shared fixtures: the run's state from the global setup, the page language, and a page that fails
// the test on any console error, uncaught exception or failed request.
import fs from "node:fs";
import { test as base, expect } from "@playwright/test";

export { expect };

/** Written by global-setup.mjs: server address, temp folders, fixture ids and live PIDs. */
export const run = JSON.parse(fs.readFileSync(process.env.E2E_STATE, "utf8"));
export const ids = run.ids;

// Interface text the specs look for, in both languages (web/js/lang-*.js).
export const TEXT = {
  en: { agent: "Agent", agents: "Agents", sessions: n => `${n} session${n === 1 ? "" : "s"}`,
        resume: "Resume", rename: "rename", save: "Save", userPrompts: "User prompts",
        editedFiles: n => `Edited files (${n})`, deleteMenu: "Delete session…",
        deleteConfirm: "Delete permanently", rollout: "Codex transcript",
        history: n => `${n} prompt${n === 1 ? "" : "s"} from the input history (↑)`,
        catalog: "Catalog data", running: "This session is running", deleted: "Session deleted.",
        codexNote: "Codex itself may still list this thread",
        working: "working", idle: "waiting", detailed: "detailed",
        turns: "Turns", steps: "Steps", files: "Files", feed: "Session feed", background: "background runs",
        cost: "API cost", codexLimits: /^Codex 5h 100%, used up until [^·]+ · wk 68%$/, codexLive: "live from Codex itself",
        claudeLimits: "Claude 5h 42% · wk 87% · 3 h ago", claudeAsOf: "(numbers as of ", tokensTile: "Tokens", sessionsTile: "Sessions", you: "You", exit: "exit 1" },
  ru: { agent: "Агент", agents: "Агенты",
        sessions: n => `${n} ${pluralRu(n, "сессия", "сессии", "сессий")}`,
        resume: "Восстановить", rename: "переименовать", save: "Сохранить", userPrompts: "Запросы пользователя",
        editedFiles: n => `Правленые файлы (${n})`, deleteMenu: "Удалить сессию…",
        deleteConfirm: "Удалить навсегда", rollout: "Транскрипт Codex",
        history: n => `${n} ${pluralRu(n, "запрос", "запроса", "запросов")} из истории ввода (↑)`,
        catalog: "Данные каталога", running: "Сессия запущена", deleted: "Сессия удалена.",
        codexNote: "Сам Codex может ещё какое-то время показывать этот тред",
        working: "работает", idle: "ждёт", detailed: "подр.",
        turns: "Ходы", steps: "Шаги", files: "Файлы", feed: "Лента сессии", background: "фоновые прогоны",
        cost: "Цена по API", codexLimits: /^Codex 5ч 100%, исчерпан до [^·]+ · нед 68%$/, codexLive: "прямо из Codex",
        claudeLimits: "Claude 5ч 42% · нед 87% · 3 ч назад", claudeAsOf: "(цифры на ", tokensTile: "Токены", sessionsTile: "Сессии", you: "Ты", exit: "exit 1" },
};

function pluralRu(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** GET a server API from the test itself, in the page language. */
export async function api(path, lang = "en") {
  const r = await fetch(run.base + path, { headers: { "X-Atlas-Lang": lang } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

export const test = base.extend({
  lang: ["en", { option: true }],
  t: async ({ lang }, use) => { await use(TEXT[lang]); },

  page: async ({ page }, use) => {
    const problems = [];
    const allowed = [];                 // URL patterns a negative test expects to answer 4xx
    const isAllowed = url => allowed.some(re => re.test(url));
    page.on("console", msg => {
      if (msg.type() !== "error") return;
      // The browser logs every 4xx response as a console error too: those of allowed URLs are expected.
      if (/Failed to load resource/.test(msg.text()) && isAllowed(msg.location().url || "")) return;
      problems.push(`console: ${msg.text()} (${msg.location().url || "?"})`);
    });
    page.on("pageerror", err => problems.push(`uncaught: ${err.message}`));
    page.on("requestfailed", req => {
      // Aborted on purpose: search cancels a stale request; a reload cancels the poll in flight.
      if (/ERR_ABORTED/.test(req.failure()?.errorText || "")) return;
      problems.push(`request failed: ${req.method()} ${req.url()} ${req.failure()?.errorText}`);
    });
    page.on("response", res => {
      if (res.status() >= 400 && !isAllowed(res.url())) problems.push(`HTTP ${res.status()}: ${res.url()}`);
    });
    page.expectHttpError = re => allowed.push(re);
    await use(page);
    expect(problems, "console errors and failed requests").toEqual([]);
  },

  /** Open the page in the project's language: `open("active")`, `open("search", "#s=<id>")`. */
  open: async ({ page, lang }, use) => {
    await use(async (view = "search", hash = "") => {
      const params = new URLSearchParams(hash.replace(/^#/, ""));
      if (view !== "search") params.set("view", view);
      await page.goto(`${run.base}/?lang=${lang}#${params}`);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
    });
  },
});

/** Read back what the browser stored, to check a pick survives a reload. */
export async function stored(page, key) {
  return page.evaluate(k => JSON.parse(window.localStorage.getItem(k) || "null"), key);
}
