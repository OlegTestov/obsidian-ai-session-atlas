import { addIcon } from "obsidian";
import agentMarks from "../../web/js/agent-marks.js";

export const AGENT_ICONS = Object.fromEntries(Object.keys(agentMarks).map(kind => [kind, `atlas-${kind}`]));

export function registerAgentIcons() {
  for (const [kind, { ribbonTransform, paths }] of Object.entries(agentMarks)) {
    const shape = paths.map(({ d, opacity }) => `<path d="${d}"${opacity ? ` opacity="${opacity}"` : ""}/>`).join("");
    addIcon(AGENT_ICONS[kind], `<g fill="currentColor" transform="${ribbonTransform}">${shape}</g>`);
  }
}
