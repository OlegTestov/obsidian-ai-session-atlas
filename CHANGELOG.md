# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.2.1] - 2026-10-06

### Fixed

- Hidden page controls use selector specificity instead of a CSS `!important` override.
- Resumed external Codex CLI clients using a shared app server appear in Active when their explicit
  thread is open in that server. Other daemon-held threads are not guessed to belong to that client.
- Codex terminal tabs use `--no-daemon` when supported, preserving per-tab session detection and
  input checks. A shared Codex server is never terminated to move one session.
- The conversion integration test waits for the new card rather than treating a pre-index error
  object as a completed response.

### Changed

- Clipboard disclosures describe explicit copy and paste actions and how pasted content is used.

## [2.2.0] - 2026-10-06

### Added

- Codex sessions in the catalog. Session files (rollouts) in `sessions/` and `archived_sessions/` of
  `$CODEX_HOME` or `~/.codex` are indexed next to Claude Code sessions: prompts, answers, shell
  commands, edited files, compaction summaries, models and tokens. Codex instructions, reasoning and
  tool output are not indexed. Codex's own thread titles are read from its `state_*.sqlite`, opened
  read-only. `codex exec` runs and subagent threads count as automation.
- Agent filter (Claude Code, Codex; both ticked by default) in Search, Active and Statistics, and an
  agent badge on cards.
- Search: resume a Codex session in a Codex tab (`codex resume <id>`); rename a Codex session in the
  catalog (its files are not changed).
- Active: live cards for interactive `codex` processes, matched to their session file with `ps` and
  `lsof`: status, last reply, plan checklist, model, context, cost, and a feed of commands with exit
  codes, applied patches and messages. Recently closed Codex sessions are listed too.
- Active: Codex's 5-hour and weekly limits come from Codex itself, as its `/status` shows them: while
  Codex cards are shown, the server runs `codex app-server` for one `account/rateLimits/read` call (no
  thread, no model request), at most every 5 minutes, with a hard timeout. If that fails, the numbers
  of Codex's last run are shown. Only the account-wide `codex` bucket counts; another bucket never
  hides or replaces it.
- Codex in the plugin's terminal tabs: approvals, questions and choices are read from the screen and
  answered from the card, including "No, and tell Codex what to do differently" with your text;
  reply, stop (one Esc), the output of `/status` and `/mcp` on the card, and notifications when a
  Codex tab waits for you. Checked with codex-cli 0.160.0.
- Move a Codex session from another terminal app into a tab: the process is stopped with `SIGTERM`
  after a check that it holds this session's file open, then the tab runs `codex resume <id>`.
- Delete a Codex session: its session files, its lines in `history.jsonl` of the Codex home and its
  catalog data. Codex's own databases are never written.
- Statistics: a breakdown by agent (cost, tokens, time, prompts, replies, sessions); the agent filter
  narrows every number, the previous period included.
- Codex replies are priced at OpenAI API prices from a table in `atlas/openai_costs.py`, as an
  estimate; `openai_prices` in `config.json` fixes or adds a model's price without a reindex. A model
  without a price shows no cost instead of $0.
- Starting Codex from the catalog: **New from this one** on a Codex session starts Codex with the
  handoff prompt and links the new thread to its source by the handoff file its first prompt names;
  **+ Session** in Active has an agent choice (Codex is offered when it is on in the plugin).
- Notices: how long they stay (10 s, 30 s, 1 min, or until clicked or closed), a close button, one
  notice per session, at most five stacked; a notice goes once its session works again or closes.
- **Resume with…** on the Search card: continue a Claude Code session in Codex or a Codex session in
  Claude Code. A new session of the target agent (`~/.claude/projects/` or `~/.codex/sessions/`) is
  written from the conversation since its last compaction, with the summary, prompts and replies word
  for word and tool calls as text, within half of a 200k-token window; the source is only read. It
  opens with the target's ordinary resume, is linked to its source in the catalog, and its copied
  messages are not counted twice. Checked with Claude Code 2.1.289 and codex-cli 0.160.0.

### Changed

- Active: limits that are not live (Codex's last run, an old status line file of Claude Code) show
  their age on the toolbar ("3 h ago" instead of "(stale)" after 6 hours), and a window at 100% says
  it is used up and when it resets. The tooltip says where the Codex numbers came from.
- The Resume, New from this one and Resume with dialogs close by themselves once the session is
  handed to Obsidian: the tab opens and takes the focus, and a failure shows as Obsidian's notice.
- The repositories are renamed: the plugin's source is github.com/OlegTestov/obsidian-ai-session-atlas
  (the old address redirects).
- The plugin is named AI Session Atlas. The plugin id stays `session-atlas` and the data folder stays
  `~/Library/Application Support/session-atlas`, so existing installs update in place and keep their
  index, settings, hotkeys and terminal tabs.
- The index schema is version 12: every session records its agent and the background job a parked
  conversation went on in. On the first start after the update the derived tables are rebuilt with a
  full reindex; your edits, topics and summaries stay.
- Resume texts and closed-session titles name the session's own agent instead of always Claude.
- Slash-command hints, argument pickers and the plan dialog show only on Claude Code cards.
- **+ Session**: the folder is a text field with suggestions instead of a long list. It takes an
  absolute path, `~/…` or the vault form (`<vault>/…`); suggests the folders sessions ran in, with
  their counts, and the real subfolders of what is typed (folders only, hidden ones skipped); has
  quick picks for the vault root and home; and works with ↑/↓, Enter, Esc and Tab (into the folder).
  The server starts the session only in an existing directory and says what is wrong otherwise.

### Fixed

- Updating the plugin (or turning it off and on) from a version before 2.2 ended the agents in its
  tabs after two minutes: the new version did not recognise what the old one held. They are offered
  back like any held agent.
- A session already running in another process (a terminal app, an old tab that outlived Obsidian)
  is never started a second time: its restored tab says so and offers to end it there and continue
  here; Restore all skips it and names it; Continue on a session whose tab Obsidian brought back but
  has not loaded yet shows that tab instead of opening another.
- Copy in agent tabs: ⌘C and Edit → Copy take the tab's selection even when the keyboard is not in the
  terminal; selecting with ⌥ gives the terminal the keyboard.
- Resume of a Codex session from the catalog ("Resume with… → Codex" included) opened a blank tab for
  about a minute and then a new empty thread. The tab script read the first line of every rollout and
  matched it as text, which current Codex rollouts and converted copies did not pass; it now finds the
  rollout by its file name, in `sessions/` and `archived_sessions/`, and the converted copy is written
  in Codex's own compact form.
- Resume of a Claude Code session that runs in a background job (Claude Code 2.1.289+) failed with
  "That session is running in the background". Search, Recently closed, Active and the restore after a
  restart open it with `claude attach <job>`; the Active card follows the tab the job is attached in.
- Parked sessions (Claude Code 2.1.289+ moves a session's work to a background job): the Active card
  follows the job's status, dialog, reply, subagents and cost instead of showing "waiting for you";
  while the parent's tab is open the job is neither a card of its own nor listed as recently closed. In the catalog the job's
  transcript holds only what was done after the hand-over and links to the session it continued, so
  search and statistics no longer count the copied history twice.
- Turning the plugin off and on in settings closes its tabs, but the agents in them keep running. They
  are now offered back: a banner in Active and a notice bring the tabs back onto the same processes
  (the agents are not restarted), and Go to on a session's card does the same for one. While offered,
  a process is held for 30 minutes instead of ending after two; "End" ends it. They also count as open,
  so an Obsidian restart offers them back. The restore list after a restart no longer flashes before
  it knows which sessions came back by themselves.
- The close confirmation (✕, middle click) works again after the plugin is reloaded or turned off and
  on, and in popout windows that were already open.
- Selecting text in an agent tab while Claude Code holds the mouse: ⌥ (or Shift) and drag selects. Inside
  Obsidian xterm.js did not detect macOS, so its ⌥ rule was off and the drag went to the agent. ⌘C also
  copies on a Cyrillic layout, and a right click opens Copy and Paste.
- Quitting Obsidian ends the processes of tabs opened from a plain command as well.

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

[Unreleased]: https://github.com/OlegTestov/obsidian-ai-session-atlas/compare/2.2.1...HEAD
[2.2.1]: https://github.com/OlegTestov/obsidian-ai-session-atlas/compare/2.2.0...2.2.1
[2.2.0]: https://github.com/OlegTestov/obsidian-ai-session-atlas/compare/2.1.1...2.2.0
[2.1.1]: https://github.com/OlegTestov/obsidian-ai-session-atlas/compare/2.1.0...2.1.1
[2.1.0]: https://github.com/OlegTestov/obsidian-ai-session-atlas/compare/2.0.0...2.1.0
[2.0.0]: https://github.com/OlegTestov/obsidian-ai-session-atlas/releases/tag/2.0.0
