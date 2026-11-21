// Shared by the plugin and the zsh registry generator.
const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export function expandIdPattern(pattern) {
  return pattern === "uuid" ? UUID_PATTERN : pattern;
}
