// Поля настроек ↔ config.json сервера: текст в полях — человеческий, в файле — структуры.
// Чистые функции, без Obsidian: проверяются в node.
// «id — описание», «id: описание», «Область → домен»; дефис — только с пробелами (он бывает в id).
const SEP = /\s*(?:—|:|→|->)\s+|\s+-\s+/;

const lines = (text) => String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);

function listToText(list) { return (list || []).join("\n"); }
function textToList(text) { return [...new Set(lines(text))]; }

/** Папки заметок: путь на строку; id — имя папки (так же, как у сервера). */
function vaultsToText(vaults) {
  return (vaults || []).map((v) => (typeof v === "string" ? v : v.path)).filter(Boolean).join("\n");
}
function textToVaults(text, previous) {
  const known = new Map((previous || []).filter((v) => v && v.path).map((v) => [v.path, v.id]));
  return textToList(text).map((p) => ({ path: p, id: known.get(p) || p.replace(/\/+$/, "").split("/").pop() }));
}

/** Домены: «id — описание» на строку. id — латиница, цифры, дефис. */
function domainsToText(domains) {
  return (domains || []).map((d) => (d.description ? `${d.id} — ${d.description}` : d.id)).join("\n");
}
function textToDomains(text) {
  const out = [];
  for (const line of lines(text)) {
    const m = SEP.exec(line);
    const id = (m ? line.slice(0, m.index) : line).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || out.some((d) => d.id === id)) continue;
    out.push({ id, description: m ? line.slice(m.index + m[0].length).trim() : "" });
  }
  return out;
}

/** Правила «Область → домен». */
function rulesToText(rules) { return (rules || []).map(([a, d]) => `${a} → ${d}`).join("\n"); }
function textToRules(text) {
  const out = [];
  for (const line of lines(text)) {
    const m = SEP.exec(line);
    if (m) out.push([line.slice(0, m.index).trim(), line.slice(m.index + m[0].length).trim()]);
  }
  return out.filter(([a, d]) => a && d);
}

/** Префиксы тикетов: «ABC, OPS» — только латиница и цифры, с буквы. */
function textToPrefixes(text) {
  return [...new Set(String(text || "").split(/[\s,;]+/).map((p) => p.trim().replace(/-$/, ""))
    .filter((p) => /^[A-Za-z][A-Za-z0-9]*$/.test(p)))];
}
function prefixesToText(list) { return (list || []).join(", "); }

/** Модель: «sonnet low» → ["sonnet", "low"]; эффорт без модели не бывает. */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
function textToModel(text, fallback) {
  const [model, effort] = String(text || "").trim().split(/\s+/);
  if (!model) return fallback;
  return [model, EFFORTS.includes(effort) ? effort : (fallback ? fallback[1] : "medium")];
}
function modelToText(pair) { return pair ? pair.join(" ") : ""; }

module.exports = { textToList, listToText, vaultsToText, textToVaults, domainsToText, textToDomains,
                   rulesToText, textToRules, textToPrefixes, prefixesToText, textToModel, modelToText, EFFORTS };
