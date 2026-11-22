import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { expect, test } from "./fixtures.mjs";

const source = esbuild.buildSync({
  stdin: {
    contents: 'export { WhatsNewMethods } from "./whats-new"; export { translate } from "./i18n";',
    resolveDir: fileURLToPath(new URL("../../obsidian-plugin/src/", import.meta.url)),
  },
  bundle: true, write: false, format: "iife", globalName: "Updates", external: ["obsidian"],
}).outputFiles[0].text;

const cards = {
  en: [
    ["OpenCode in the catalog", "OpenCode 2 sessions appear in Search and Statistics next to Claude Code and Codex, with their own filter."],
    ["OpenCode in Obsidian tabs", "Start or continue OpenCode in a tab, copy a session, and rename, archive or delete it from its card."],
  ],
  ru: [
    ["OpenCode в каталоге", "Сессии OpenCode 2 видны в «Поиске» и «Статистике» рядом с Claude Code и Codex, с отдельным фильтром."],
    ["OpenCode во вкладках Obsidian", "Запускай и продолжай OpenCode во вкладке, копируй сессию, переименовывай, архивируй и удаляй её из карточки."],
  ],
};

test("What's new shows the two localized OpenCode cards", async ({ page, lang }) => {
  await page.evaluate(() => {
    // Supply the Obsidian APIs that the real modal uses to render into the browser DOM.
    const element = HTMLElement.prototype;
    element.createEl = function (tag, { cls, text, href, attr } = {}) {
      const child = document.createElement(tag);
      if (cls) child.className = cls;
      if (text) child.textContent = text;
      if (href) child.href = href;
      for (const [name, value] of Object.entries(attr || {})) child.setAttribute(name, value);
      this.appendChild(child);
      return child;
    };
    element.createDiv = function (opts) { return this.createEl("div", opts); };
    element.createSpan = function (opts) { return this.createEl("span", opts); };
    element.addClass = function (cls) { this.classList.add(cls); };
    element.empty = function () { this.replaceChildren(); };
    window.require = () => ({
      Modal: class {
        modalEl = document.body.createDiv({ cls: "modal" });
        titleEl = this.modalEl.createEl("h2");
        contentEl = this.modalEl.createDiv({ cls: "modal-content" });
        setTitle(text) { this.titleEl.textContent = text; }
        open() { this.onOpen(); }
        close() { this.onClose(); this.modalEl.remove(); }
      },
      setIcon(node, icon) { node.dataset.icon = icon; },
    });
  });
  await page.addScriptTag({ content: source });
  await page.evaluate((language) => {
    const { WhatsNewMethods, translate } = window.Updates;
    const plugin = Object.assign(new WhatsNewMethods(), { t: key => translate(language, key) });
    plugin.showWhatsNew();
  }, lang);

  const modal = page.locator(".sa-updates");
  await expect(modal.locator(".sa-updates-version")).toHaveText("AI Session Atlas · 2.18.0");
  await expect(modal.locator(".sa-update-card h3")).toHaveText(cards[lang].map(([title]) => title));
  await expect(modal.locator(".sa-update-card p")).toHaveText(cards[lang].map(([, description]) => description));
  await expect(modal.locator(".sa-update-icon[data-icon='search']")).toHaveCount(1);
  await expect(modal.locator(".sa-update-icon[data-icon='square-terminal']")).toHaveCount(1);
  await expect(modal.getByRole("link")).toHaveAttribute("href", /\/releases\/tag\/2\.18\.0$/);
});
