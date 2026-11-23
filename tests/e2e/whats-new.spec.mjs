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
    ["OpenCode in Active", "See running OpenCode sessions, recent messages and requests waiting for you."],
    ["Reply from an OpenCode card", "Answer questions and permission prompts, queue a reply, or stop a run from an Atlas tab’s card."],
  ],
  ru: [
    ["OpenCode в «Активных»", "Смотри работающие сессии OpenCode, последние сообщения и запросы, которые ждут ответа."],
    ["Ответ из карточки OpenCode", "Отвечай на вопросы и запросы разрешений, ставь ответ в очередь или останови работу из карточки вкладки Atlas."],
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
  await expect(modal.locator(".sa-updates-version")).toHaveText("AI Session Atlas · 2.19.0");
  await expect(modal.locator(".sa-update-card h3")).toHaveText(cards[lang].map(([title]) => title));
  await expect(modal.locator(".sa-update-card p")).toHaveText(cards[lang].map(([, description]) => description));
  await expect(modal.locator(".sa-update-icon[data-icon='activity']")).toHaveCount(1);
  await expect(modal.locator(".sa-update-icon[data-icon='message-square']")).toHaveCount(1);
  await expect(modal.getByRole("link")).toHaveAttribute("href", /\/releases\/tag\/2\.19\.0$/);
});
