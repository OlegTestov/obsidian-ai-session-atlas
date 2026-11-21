import entries from "../../atlas/agents.json";

import { expandIdPattern } from "./agent-id-pattern.mjs";

const registry = new Map();
const patterns = new Map();
const matchers = new Map();

for (const row of entries) {
  const { id, label, short, mailPrefix, idPattern } = row;
  if (!/^[a-z][a-z0-9-]*$/.test(id) || !/^[a-z]$/.test(mailPrefix)
      || ![id, label, short, mailPrefix, idPattern].every(value => typeof value === "string" && value.trim())
      || (idPattern !== "uuid" && !(idPattern.startsWith("^") && idPattern.endsWith("$")))) {
    throw new Error(`Malformed agent registry entry: ${JSON.stringify(row)}`);
  }
  if (registry.has(id)) throw new Error(`Duplicate agent id: ${id}`);
  registry.set(id, Object.freeze(row));
  const pattern = expandIdPattern(idPattern);
  patterns.set(id, pattern);
  matchers.set(id, new RegExp(`^(?:${pattern})$`, "u"));
}

export const agentKinds = Object.freeze([...registry.keys()]);

export class UnknownAgent extends Error {}

export function getAgent(kind) {
  if (!registry.has(kind)) throw new UnknownAgent(`Unknown agent: ${String(kind)}`);
  return registry.get(kind);
}

export function idPattern(kind) {
  getAgent(kind);
  return patterns.get(kind);
}

export function validId(kind, sid) {
  getAgent(kind);
  return typeof sid === "string" && matchers.get(kind).exec(sid)?.[0] === sid;
}
