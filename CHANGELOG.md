# Changelog

## 2.0.0 — first public release

- Self-contained: the server, the page and the terminal scripts ship inside the plugin and run on the
  system `python3` from Xcode Command Line Tools. No Homebrew, Node, tmux or other Obsidian plugins.
- Built-in agent terminal (xterm.js + the macOS pseudo-terminal); tabs resume their session after a
  restart; closing a tab asks for confirmation.
- Claude Code and Codex as optional agents, each with its own extra launch arguments.
- All personal choices moved to `config.json`: note folders, project roots, domains, ticket prefixes,
  sensitive areas, models. AI features are off by default and use the `sonnet` alias.
- English and Russian interface.
- Active: a detailed card shows the conversation tail (message count in settings, 10 by default); the
  feed opens the whole session, loading earlier turns as you scroll up; cards keep their order while
  you are on the tab and re-sort when you come back.
- Search: delete a finished session for good — its Claude Code files, input history lines and catalog data.
- Search card: the full list of edited files, folded by default.
- Setup checks in settings: macOS, `python3` (3.8+), Claude Code, Codex, server, index rebuild, and an
  opt-in switch for subscription limits in the status line.
