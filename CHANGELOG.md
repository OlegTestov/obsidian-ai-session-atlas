# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.1] - 2026-10-03

### Fixed

- Plugin styles override Obsidian's defaults through selector specificity, without `!important`.
- The home folder comes from the operating system, not from the `HOME` environment variable.
- Images attached to a reply are checked against the uploads folder of the running install, so a
  development install accepts its own uploads.

## [2.1.0] - 2026-10-03

### Changed

- The plugin is built with npm and esbuild (`npm ci`, `npm run build`) instead of a Python bundling
  script. The build writes `main.js` and `styles.css` to the repository root.
- Plugin source files are ES modules.
- xterm.js and its addons come from npm instead of a vendored copy.
- The code is checked with ESLint and the recommended rules of `eslint-plugin-obsidianmd`.
- `manifest.json` lives at the repository root.
- The minimum Obsidian version is 1.8.7: the plugin uses `getLanguage()` to follow the Obsidian
  interface language.
- Command IDs are renamed: `open-session-atlas` to `open-catalog` and `reload-session-atlas` to
  `reload-plugin`. Custom hotkeys bound to the old IDs need to be bound again.
- The catalog command is named "Open session catalog" (Obsidian already prefixes it with the plugin
  name).
- Settings headings use `Setting.setHeading()`; the active tab is read through public workspace APIs.
- Inline styles moved to the stylesheet.
- The plugin reloads itself after a rebuild only in development installs
  (`tools/install_plugin.py --dev`), which also run on their own port and data folder.
- Code comments are in English.
- File explorer clicks are off by default for new installs: they change how Obsidian's file explorer
  opens files, so they are opt-in.
- Node tests use the built-in `node:test` runner (`npm test`); Python code is checked with Ruff.

### Added

- Active, detailed cards: the chat stays at the newest message while you are at the bottom, also
  when images load late or the tab was hidden. Scrolling up keeps your place through updates and
  shows a "Newest" button; scrolling back down follows new messages again.
- Documentation and community files: a Disclosures section in the README, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, issue and pull request templates, `.editorconfig` and
  `THIRD-PARTY-NOTICES.md`.

### Fixed

- A plugin reload, including an update, no longer ends agents in background terminal tabs: Obsidian
  loads those tabs only when shown, and their processes now wait for them instead of being reclaimed.
- The local server's token file is created with owner-only permissions from the start, and two
  concurrent first requests can no longer write different tokens.
- An index pass that writes a lot to stderr no longer stalls.
- Server errors return only the error message; the traceback goes to the server log.
- The server follows `CLAUDE_CONFIG_DIR` for every Claude Code folder, not only the status line.
- The plan dialog title and the "several questions at once" note follow the interface language.
- The "tab script is missing" notice no longer points end users at a development command.
- The runtime is extracted file by file through a rename, so a page load during an update never
  reads half a script.

### Removed

- Compatibility code for two earlier unpublished plugins whose features Session Atlas includes.

## [2.0.0] - 2026-10-02

### Added

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

[Unreleased]: https://github.com/OlegTestov/obsidian-session-atlas/compare/2.1.1...HEAD
[2.1.1]: https://github.com/OlegTestov/obsidian-session-atlas/compare/2.1.0...2.1.1
[2.1.0]: https://github.com/OlegTestov/obsidian-session-atlas/compare/2.0.0...2.1.0
[2.0.0]: https://github.com/OlegTestov/obsidian-session-atlas/releases/tag/2.0.0
