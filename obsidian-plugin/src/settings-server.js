// Catalog server settings (config.json).
import defaultDomains from "../../atlas/default-domains.json";
import * as F from "./config-form";
import { agentKinds } from "./agent-registry";
import { supportsTerminal } from "./agents";
import { automatic, definition, group, textDefinition } from "./settings-fields";

const DEFAULT_MODELS = { classification: ["sonnet", "low"], catalog_summary: ["sonnet", "low"],
                         handoff: ["sonnet", "medium"] };

const AI_AGENTS = ["auto", ...agentKinds.filter(kind => kind !== "opencode" && supportsTerminal(kind))];

function catalogDefinitions(tab) {
  const { plugin } = tab, cfg = () => plugin.readServerConfig() || {};
  const t = key => plugin.t(key);
  const save = changes => plugin.writeServerConfig(changes);
  return group(tab, "cfg.heading", [
    textDefinition(tab, "cfg.vaults", () => F.vaultsToText(cfg().vaults),
      v => save({ vaults: F.textToVaults(v, cfg().vaults) }), { rows: 2, placeholder: t("cfg.vaults.placeholder") }),
    textDefinition(tab, "cfg.roots", () => F.listToText(cfg().workspace_roots || ["~/Code", "~/Projects", "~/Developer", "~/src"]),
      v => save({ workspace_roots: F.textToList(v) }), { rows: 3, placeholder: t("cfg.roots.placeholder") }),
    textDefinition(tab, "cfg.domains", () => {
      const { domains } = cfg();
      return domains === undefined ? defaultDomains.map(({ id }) => `${id} — ${t(`cfg.domains.default.${id}`)}`).join("\n")
        : F.domainsToText(domains);
    },
      v => save({ domains: F.textToDomains(v) }), { rows: 4, placeholder: t("cfg.domains.placeholder") }),
    textDefinition(tab, "cfg.rules", () => F.rulesToText(cfg().vault_domain_rules),
      v => save({ vault_domain_rules: F.textToRules(v) }), { rows: 2, placeholder: t("cfg.rules.placeholder") }),
    textDefinition(tab, "cfg.tickets", () => F.prefixesToText(cfg().ticket_prefixes),
      v => save({ ticket_prefixes: F.textToPrefixes(v) }), { placeholder: t("cfg.tickets.placeholder") }),
  ]);
}

function aiDefinitions(tab, watchIndex) {
  const { plugin } = tab, cfg = () => plugin.readServerConfig() || {};
  const save = changes => plugin.writeServerConfig(changes);
  return group(tab, "ai.heading", [
    definition(tab, "ai.enabled", "ai.enabled.desc", setting => setting.addToggle(toggle =>
      toggle.setValue(cfg().llm_enabled !== false).onChange(v => save({ llm_enabled: v })))),
    definition(tab, "ai.agent", "ai.agent.desc", setting => setting.addDropdown(dropdown => {
      for (const choice of AI_AGENTS) dropdown.addOption(choice, plugin.t(`ai.agent.${choice}`));
      const choice = cfg().ai_agent;
      // An invalid configured agent blocks AI runs until the user picks a valid value.
      const emptyContainer = choice && typeof choice === "object" && Object.keys(choice).length === 0;
      let selected = !choice || emptyContainer ? "auto" : choice;
      if (!AI_AGENTS.includes(selected)) {
        dropdown.addOption("", plugin.t("ai.agent.invalid", { value: JSON.stringify(choice) }));
        selected = "";
      }
      dropdown.setValue(selected).onChange(value => {
        if (value === selected || !AI_AGENTS.includes(value)) return;
        save({ ai_agent: value });
        selected = value;
      });
    })),
    textDefinition(tab, "cfg.sensitive",
      () => {
        const { vault_areas: areas, projects } = cfg().sensitive || {};
        return F.listToText((areas || []).map(area => "vault:" + area).concat(projects || []));
      },
      v => {
        const items = F.textToList(v);
        save({ sensitive: { vault_areas: items.filter(x => x.startsWith("vault:")).map(x => x.slice(6)),
                             projects: items.filter(x => !x.startsWith("vault:")) } });
      }, { rows: 3, placeholder: plugin.t("cfg.sensitive.placeholder") }),
    definition(tab, "ai.classification", "ai.classification.desc", setting => watchIndex(info => {
      const auto = info?.auto_classify;
      const state = typeof auto?.enabled !== "boolean" ? "desc" : !auto.enabled ? "off"
        : auto.paused || cfg().llm_enabled === false ? "paused" : "on";
      setting.setDesc(plugin.t(`ai.classification.${state}`));
    })),
  ]);
}

function modelDefinitions(tab) {
  const { plugin } = tab, cfg = () => plugin.readServerConfig() || {};
  const save = changes => plugin.writeServerConfig(changes);
  const validate = (_, raw) => {
    const [, effort, extra] = raw.trim().split(/\s+/);
    if (extra || (effort && !F.EFFORTS.includes(effort))) {
      return plugin.t("ai.model.invalidEffort", { efforts: F.EFFORTS.join(", ") });
    }
  };
  return group(tab, "adv.models", [
    ...Object.entries(DEFAULT_MODELS).map(([kind, fallback]) => textDefinition(tab, `ai.model.${kind}`,
      () => F.modelToText(cfg().models?.[kind]), v => {
        const models = Object.assign({}, cfg().models, { [kind]: F.textToModel(v, fallback) });
        save({ models });
      }, { desc: "ai.model.desc", placeholder: automatic(tab, fallback.join(" ")), validate })),
    definition(tab, "ai.force1m", "ai.force1m.desc", setting => setting.addToggle(toggle =>
      toggle.setValue(!!cfg().force_1m).onChange(v => save({ force_1m: v })))),
    {
      ...textDefinition(tab, "ai.codexModel", () => F.modelToText(cfg().codex_model),
        v => save({ codex_model: F.textToModel(v, null) }), { placeholder: plugin.t("ai.codexModel.placeholder"), validate }),
      aliases: ["Codex"],
    },
  ]);
}

export { catalogDefinitions, aiDefinitions, modelDefinitions, DEFAULT_MODELS };
