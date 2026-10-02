/** Поля настроек ↔ config.json: разбор и обратно без потерь.   node tools/test_config_form.js */
const path = require("path");
const F = require(path.join(__dirname, "..", "obsidian-plugin", "src", "config-form.js"));
let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : " → " + JSON.stringify(detail)}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const domains = F.textToDomains("work — моя работа: тикеты OPS-*\n  home\nbad id — x\nwork — дубль\nside-projects: своё");
check("домены: id — описание, пустое описание, плохие id и дубли отброшены", eq(domains,
  [{ id: "work", description: "моя работа: тикеты OPS-*" }, { id: "home", description: "" },
   { id: "side-projects", description: "своё" }]), domains);
check("домены: туда и обратно", eq(F.textToDomains(F.domainsToText(domains)), domains));
check("правила: Область → домен, разные разделители", eq(F.textToRules("Work → work\nPersonal - personal\nмусор"),
  [["Work", "work"], ["Personal", "personal"]]));
check("тикеты: запятые, пробелы, дефис в конце, мусор", eq(F.textToPrefixes("ABC, OPS- 12x a|b ops"),
  ["ABC", "OPS", "ops"]));
const vaults = F.textToVaults("/Users/a/Notes\n/Users/a/Work/\n/Users/a/Notes", [{ path: "/Users/a/Notes", id: "vault" }]);
check("папки заметок: id прежний сохраняется, новый — имя папки, без дублей", eq(vaults,
  [{ path: "/Users/a/Notes", id: "vault" }, { path: "/Users/a/Work/", id: "Work" }]), vaults);
check("модель: «opus high», эффорт по умолчанию, пусто — прежняя", eq(F.textToModel("opus high"), ["opus", "high"])
  && eq(F.textToModel("haiku", ["sonnet", "low"]), ["haiku", "low"]) && eq(F.textToModel("  ", ["sonnet", "low"]), ["sonnet", "low"])
  && eq(F.textToModel("opus turbo"), ["opus", "medium"]));
console.log(failures ? `\n${failures} проверок упало` : "\nполя настроек в порядке");
process.exit(failures ? 1 : 0);
