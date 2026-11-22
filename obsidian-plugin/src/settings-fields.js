// Imperative rows work in both Obsidian's definitions renderer and the legacy settings tab.
import { Notice } from "obsidian";

function definition(tab, name, desc, render) {
  return { name: tab.plugin.t(name), ...(desc ? { desc: tab.plugin.t(desc) } : {}), render };
}

function group(tab, heading, items) {
  return { type: "group", heading: tab.plugin.t(heading), items };
}

function automatic(tab, value) {
  return value ? tab.plugin.t("settings.automaticValue", { value }) : tab.plugin.t("settings.automatic");
}

function textDefinition(tab, name, getValue, save, {
  placeholder, rows, normalize = value => value, validate, desc = `${name}.desc`,
} = {}) {
  return definition(tab, name, desc, setting => {
    const { failedText } = tab.openCycle;
    const draft = failedText.get(name);
    const value = draft?.raw ?? getValue() ?? "";
    const field = text => {
      if (placeholder) text.setPlaceholder(placeholder);
      text.setValue(value);
      if (rows) {
        text.inputEl.rows = Math.max(rows, value.split("\n").length + 1);
        text.inputEl.spellcheck = false;
      }
      // A rejected save can already have changed the in-memory settings.
      let previous = draft?.previous ?? text.getValue();
      let saving;
      const flush = () => {
        const raw = text.getValue();
        if (!saving && raw === previous) {
          failedText.delete(name);
          return;
        }
        if (saving?.raw === raw) return saving.done;
        // A close or refresh may arrive while blur is already saving this field.
        const done = Promise.resolve(saving?.done).then(async () => {
          if (raw === previous) return;
          const next = normalize(raw);
          const problem = validate?.(next, raw);
          if (problem) {
            if (text.getValue() === raw) text.setValue(previous);
            new Notice(problem);
            return;
          }
          if (next !== previous) {
            await save(next);
            previous = getValue() ?? "";
          }
          if (text.getValue() === raw && raw !== previous) text.setValue(previous);
        }).catch(error => {
          failedText.set(name, { raw: text.getValue(), previous });
          new Notice(tab.plugin.t("settings.saveFailed", { error: error?.message ?? String(error) }));
          return false;
        });
        saving = { raw, done };
        tab.textSaves.add(done);
        void done.then(result => {
          if (saving?.done === done) {
            saving = null;
            if (result !== false) failedText.delete(name);
          }
          tab.textSaves.delete(done);
        });
        return done;
      };
      const field = { value: () => text.getValue(), flush };
      text.inputEl.addEventListener("focus", () => { tab.focusedText = field; });
      text.inputEl.addEventListener("blur", () => {
        if (tab.focusedText === field) tab.focusedText = null;
        return field.flush();
      });
    };
    if (rows) {
      setting.settingEl.addClass("session-atlas-area");
      setting.addTextArea(field);
    } else {
      setting.addText(field);
    }
  });
}

function pluginText(tab, key, name, options, after) {
  return textDefinition(tab, name, () => tab.plugin.settings[key], async value => {
    tab.plugin.settings[key] = value;
    await tab.save();
    await after?.();
  }, options);
}

export { automatic, definition, group, pluginText, textDefinition };
