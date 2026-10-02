// Вкладка каталога: iframe на локальный сервер.
const { ItemView } = require("obsidian");
const { atlasTitle } = require("./notify");
const {
  VIEW_TYPE,
  ATLAS_ORIGIN,
  HOST_SOURCE,
} = require("./constants");

const DEFAULT_CARD_MESSAGES = 10;

class AtlasView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.hash = "";
  }

  getViewType() { return VIEW_TYPE; }
  // Счётчик «ждут тебя» виден в заголовке вкладки, даже когда она в фоне.
  getDisplayText() { return atlasTitle(this.plugin.waitingCount || 0); }
  getIcon() { return "library"; }

  /** Вкладка восстанавливается вместе с выбранной сессией: состояние живёт в hash. */
  async setState(state, result) {
    if (state && typeof state.hash === "string") this.hash = state.hash;
    await super.setState(state, result);
    this.render();          // единственная точка отрисовки; onOpen её не дублирует
  }

  getState() {
    const hash = this.frame && this.frame.contentWindow
      ? this.readHash()
      : this.hash;
    return { hash: hash || "" };
  }

  readHash() {
    try {
      return this.frame.contentWindow.location.hash || "";
    } catch (error) {
      return this.hash;   // чужой origin читать нельзя — держим последнее известное
    }
  }

  async onOpen() {
    // Отрисовку запускает setState. Если состояния нет (открыли пустую вкладку) — рисуем сами.
    if (!this.frame) this.render();
    // Скрытая вкладка Obsidian — нулевой ширины. Снова на экране — странице можно переставить
    // карточки: пока ты на вкладке, она их не двигает.
    this.onScreen = this.contentEl.clientWidth > 0;
    this.visibility = new ResizeObserver(() => this.visibilityChanged(this.contentEl.clientWidth > 0));
    this.visibility.observe(this.contentEl);
  }

  visibilityChanged(visible) {
    if (visible && !this.onScreen && this.frame && this.frame.contentWindow) {
      this.frame.contentWindow.postMessage({ source: HOST_SOURCE, type: "shown" }, ATLAS_ORIGIN);
    }
    this.onScreen = visible;
  }

  async onClose() {
    if (this.visibility) this.visibility.disconnect();
  }

  async render() {
    if (this.rendering) return;   // два асинхронных прохода рисовали по блоку ошибки каждый
    this.rendering = true;
    try {
      await this.renderOnce();
    } finally {
      this.rendering = false;
    }
  }

  async renderOnce() {
    const container = this.contentEl;
    container.empty();
    container.style.padding = "0";
    // У каталога свой скролл внутри: внешняя полоса только мешала.
    container.style.overflow = "hidden";

    const up = await this.plugin.ensureServer();
    if (!up) {
      const box = container.createDiv();
      box.style.padding = "24px";
      box.createEl("p", { text: this.plugin.t("server.down") });
      box.createEl("p", { text: this.plugin.t("server.hint"), cls: "mod-warning" });
      const retry = box.createEl("button", { text: this.plugin.t("server.retry") });
      retry.addEventListener("click", () => this.render());
      return;
    }

    this.frame = container.createEl("iframe");
    // Язык страницы — как у плагина: язык Obsidian или выбранный в настройках.
    const messages = Number(this.plugin.settings && this.plugin.settings.cardMessages) || DEFAULT_CARD_MESSAGES;
    this.frame.src = ATLAS_ORIGIN + "/?lang=" + this.plugin.lang() + "&msgs=" + messages + (this.hash || "");
    this.frame.style.width = "100%";
    this.frame.style.height = "100%";
    this.frame.style.border = "none";
    // Строчный iframe оставляет под собой зазор под выносные элементы букв (~4 px),
    // и контейнер начинал прокручиваться на эти пиксели.
    this.frame.style.display = "block";
  }
}

module.exports = { AtlasView };
