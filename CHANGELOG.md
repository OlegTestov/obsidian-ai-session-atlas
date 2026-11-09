# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.8.4] - 2026-11-09

### Added

- Several Claude Code questions at once are answered on the Active card, as in the terminal: a tab per
  question, buttons for one answer, checkboxes and **Next** for several, an own typed answer where
  Claude Code takes one, and a **Submit** tab that lists the answers. **Send the answers** stays off
  until every question has one. The plugin then answers key by key and checks the tab's screen after
  each key; nothing reaches Claude Code before the final submit, and on any mismatch it stops so the
  dialog can be finished in the tab. Questions already half answered in the tab, or with previews,
  are still answered there. Compact cards keep the whole dialog in view.

## [2.8.3] - 2026-11-08

### Added

- The session feed opened on the right has the card's reply field under it: text, images, slash
  commands and the send state work as on the card, in the compact view too. Both fields show one
  draft. While a dialog is open, the feed's field says to answer it on the card or in the tab. When
  Obsidian's status bar covers the page's bottom-right corner, the field rises above it.

## [2.8.2] - 2026-11-08

### Changed

- A background session's Active card is no longer marked by a tag: the tab's server icon stands before
  the title, and the status reads "waiting · background" (or the current state).

## [2.8.1] - 2026-11-08

### Added

- An Active card whose tab shows a Claude Code background session says **background session** (with the
  same hint as the tab) and has **Bring back**: the conversation continues in an ordinary tab, as from the
  tab menu. On a narrow card the button shows its icon only, so the row of buttons stays on the card.

### Changed

- In a background tab's menu, **Bring back from the background** stands apart from the group actions,
  after a separator.

## [2.8.0] - 2026-11-08

### Added

- Drag a session group's chip to move all of its tabs together, including into another pane.
  A drop indicator marks the destination; Alt+Left/Right on a focused chip moves it by keyboard.
- Plugin controls appear in Obsidian's settings search (1.13+), in English or Russian.
- “What’s new” for 2.8.0: moving whole groups, folded groups in tab navigation, faster search.

### Changed

- Next/previous tab navigation skips collapsed groups. Explicit navigation to a grouped tab still
  unfolds it. The menu of a note tab that is not in front also has the group actions, and opening
  it does not switch to that tab.
- Same-named groups can be selected separately in Active: the filter distinguishes them by colour
  and, when needed, a number. Renaming a group keeps the selection; older saved filters still load.
- Searches for common words across all fields run 2–5 times faster on a large catalog (on the
  system `python3` of macOS: “claude code” 49 → 9 s, “test” 20 → 7 s). Matches, order and snippets stay
  the same, and the index needs no rebuild. Less common words can take up to 0.7 s longer, because each
  large field is first checked for how many matches it holds.

### Fixed

- A plugin reload waits for earlier settings writes before reading group data. Late callbacks from
  the retired instance cannot overwrite newer settings; failed writes can recover on the next load.
  If storage still refuses the write, the plugin loads with the newest settings instead of failing.
- PTY tests isolate locale; live path-link checks use xterm cell geometry and wait for resolved links.
- Release assets are identical with real or symlinked dependencies and different build directories.
  CI uses pinned current GitHub Actions and Node 24 runtimes.

## [2.7.2] - 2026-11-08

### Fixed

- After **Reload the plugin** (or a new build picked up on its own) the plugin knows its real version.
  Before, Obsidian kept the version it had read at startup until it was restarted, so “What’s new” never
  opened and the plugin list showed the old number.

### Changed

- `npm test` no longer force-exits: on macOS that cut the end of some test files' output, so the run
  reported fewer tests than it ran (failures were never hidden).

## [2.7.1] - 2026-11-06

### Fixed

- Bring back and Stop no longer freeze Obsidian while they look for the background job: the process
  check runs in the background.
- Bring back never stops a session it cannot then open: without a conversation to resume the job
  keeps running, and once stopped the conversation found before is opened.
- One failed process check while a job ends no longer aborts Bring back with the job already stopped.
- The “What’s new” cards no longer touch each other and take less height. A patch release records
  itself quietly instead of showing the same highlights again.

### Changed

- Rows under **In the background, no tab** name a state in the same words as the cards.

## [2.7.0] - 2026-11-05

### Added

- A tab whose Claude Code session runs in a background job of Claude Code (sent there with ← on an
  empty prompt or `/background`, or opened with `claude attach`) shows a server icon in the accent
  colour with a hint. Closing it asks **Keep open**, **Close, keep running** or **Close and stop**:
  the last one runs `claude stop`, and the conversation is kept. Closing a group says how many such
  sessions will keep running.

- Active lists Claude Code background sessions without a tab, with **Bring back to tab** and **Stop**.
- Bring back to an ordinary tab also appears in a background tab's menu. The background process stops first; the same conversation resumes in its group and position. A running reply asks before interruption.
- A bilingual update summary explains the new controls after upgrading.

## [2.6.0] - 2026-11-02

### Added

- A quick **What’s new** summary after updates: two short highlights with a visual guide, in the
  plugin’s language (English or Russian). Shown once per version to existing users; first installs
  stay quiet. Reopen it from the command palette, or turn off automatic summaries in settings.

### Fixed

- Claude Code and Codex opened from the ribbon or command palette stay outside session groups,
  immediately after the current group. Opening from a group's editor still adds the tab to that group.

## [2.5.0] - 2026-11-01

### Added

- Session groups, as Chrome's tab groups. Right-click a tab → **Add to new group**: the group gets a
  name and one of nine colours, a chip before its tabs and a line of its colour under the chip and
  the tabs, going round the tab in front as in Chrome. A click on the chip folds the group to the chip
  and back; a right-click opens the editor (name, colour, a new Claude Code or Codex tab in the group,
  fold, ungroup, close group). A tab dropped onto a group's tab or chip joins the group (a one-tab
  group too); one dropped onto a tab outside the group, or dragged away, leaves it. Groups survive an
  Obsidian restart and a workspace switch. Active shows each card's group, filters by group, and the
  card's label opens the same group menu.

## [2.4.6] - 2026-10-29

### Changed

- Search with common words on a large catalog answers in about a second instead of tens of seconds
  (31 s → 0.5–2 s for two common words on 9,600 sessions); results are unchanged.
- The Stats view opens at once: the last counted numbers come immediately with their time, and newer
  ones replace them when ready ("as of 18:20, updating…"). The default view is counted in the page's
  language as soon as the plugin connects.
- The cost tile caption is one short line; how the cost is estimated and which models have no price
  are behind ⓘ (hover or keyboard focus).
- The background index no longer keeps the computer busy while a large session's subagents write. A
  session whose full re-read is slow waits up to ten times as long as that read took (at most 15
  minutes) before it is re-read again, and the next pass rests as long as the last one ran. On a
  9,600-session catalog with a 644 MB live session, a pass went from 60–81 s to 3–11 s.

### Fixed

- The Topic filter offers the topic set by hand, not the model's one it replaced: picking the
  offered topic no longer hides that session. A session matched by several path rules counts for
  each of their domains in the filters, as on its card.

## [2.4.5] - 2026-10-24

### Added

- Paths that Claude Code and Codex print in terminal tabs are links. A click opens the file in its
  default app, a note of this vault in Obsidian, a folder in Finder; ⌘-click shows the file in
  Finder; the right-click menu adds Open, Show in Finder and Copy path. A path is a link only when
  it exists: relative paths are read from the agent's working folder, a line number (`:12`) and a
  closing full stop are left out, and paths with spaces or broken across lines work. Apps, scripts,
  installers and other executable files are never started by a click: they are shown in Finder.
  File links the program marks itself (OSC 8, including Codex's editor links) open the same way,
  without a browser dialog, and show their target on hover.

## [2.4.4] - 2026-10-21

### Fixed

- A commit inside a guarded search write can no longer silently switch off detection of older
  plugin versions for every process. The guard is restored and the error is reported plainly.

## [2.4.3] - 2026-10-21

### Fixed

- Search updates remain safe when different plugin versions share the same catalog. Older writers
  invalidate the row lookup transactionally; the next new index pass repairs it and refreshes search
  from transcripts. Upgrading from 2.4.2 also repairs existing missing or orphaned search rows in the
  background, preserving manual edits and paid AI results.
- Unreadable sources are retried separately, so one broken transcript cannot repeat a full catalog
  recovery or prevent healthy sessions from catching up.
- Concurrent database upgrades recheck the schema after acquiring the writer lock, so only one
  process fills the search row lookup.

### Changed

- Runtime mutation checks include the indexer cleanup behavior tests.

## [2.4.2] - 2026-10-21

### Fixed

- Updating an indexed session now addresses its search rows directly. Large catalogs no longer
  scan every message inside the indexing write transaction, blocking classification and other saves.
  The database upgrade preserves the catalog, manual edits and previously paid AI results.
- Server shutdown also stops its background indexer. Upgrades reclaim abandoned indexers from
  older builds that hold this catalog's lock; running agents and owned indexing processes are preserved.
- Jobs interrupted by a server restart become retryable instead of remaining stuck as running.

## [2.4.1] - 2026-10-20

### Fixed

- Explicit neutral RGB text in agent terminals stays readable when Obsidian switches themes.
  This fixes Claude Code question headings remaining black on a dark background. The same contrast
  handling runs in Codex tabs, including cached grey Enter/Esc hints. Coloured text, inverse text and
  panels with their own background are preserved.
  Terminal content, input, selection and running sessions are preserved.

## [2.4.0] - 2026-10-19

### Added

- Search cards replace the prompt-only list with an expandable session feed, using the same dialogue
  renderer as Active. Claude Code and Codex conversations load on demand, with earlier turns in pages,
  stable scrolling and retry buttons after a failed request.

### Fixed

- Already submitted Codex prompts follow light and dark terminal themes as well as the input panel,
  including messages revisited in scrollback. Changing themes preserves the draft and terminal input.

## [2.3.4] - 2026-10-19

### Fixed

- Already open Codex terminal tabs update the input and picker panel backgrounds when Obsidian
  switches between light and dark themes. Drafts, terminal selection and running sessions are preserved.

## [2.3.3] - 2026-10-19

### Fixed

- Cross-agent conversion prepares JSONL before taking the catalog writer lock. Serialization
  failures leave no new transcript or conversion link, and serialization no longer holds up other writers.
- Errors removing an incomplete transcript or its catalog link are logged without hiding the
  original write failure. Failed catalog cleanup rolls back its transaction.

## [2.3.2] - 2026-10-18

### Fixed

- Continuing a conversation in the other agent waits for background indexing to release the
  catalog writer lock, avoiding SQLite timeout failures during large index updates.
- The conversion dialog explains that catalog updates may take time and shows a retryable
  message if another database writer remains busy.

## [2.3.1] - 2026-10-17

### Fixed

- Modern Obsidian theme colours (color-mix/oklch and hsl) are resolved to sRGB before passing them
  to xterm. Selection and the cursor stay visible on a light shell after Claude Code exits,
  including after switching tabs or refreshing the theme.
- Background search refreshes keep the visible result in place, including scrolling during a
  pending request and changes to the rows above it.
- Agent terminal tabs print the current resume/attach command after restoring the main screen,
  so the recovery hint survives Ctrl-C and the subsequent shell prompt.
- Pasting a clipboard image into a Codex terminal tab now creates a private local attachment and
  pastes its path, both from the keyboard and the context menu. Text paste and Claude Code
  clipboard handling are preserved; pasting does not submit the prompt.

## [2.3.0] - 2026-10-15

### Added

- The Claude Code status line shows the context window after the limits: used tokens, the point where
  auto-compact fires and the window size, e.g. `context 291k · compact at ~467k · window 1M`, in the
  catalog's language. When auto-compact is off (`DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT` or
  `autoCompactEnabled: false`) it reads `compact off`.
- The compact window is read like Claude Code reads it: `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, then
  `modelSettings.<model>.autoCompactWindow`, then `autoCompactWindow`, from the managed, project-local,
  project and user `settings.json` (in that order of precedence), clamped to 100k–1M and capped at the
  window. The point shown is the window minus Claude Code's 33k buffer, lowered by
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`; Claude Code does not document the exact rule, so it is marked with `~`.
- Known limits: the `--autocompact` launch flag and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` are not visible to
  the status line.

## [2.2.3] - 2026-10-11

### Fixed

- After Obsidian restarts, every agent tab brings its session back by itself, one at a time and
  without taking the keyboard; tabs no longer wait to be opened one by one (setting, on by default).
- An agent no longer outlives Obsidian when Obsidian ends without closing its tabs (a crash, a forced
  quit); such processes left by earlier versions are ended when the plugin starts, instead of making
  their tabs ask "End it there and continue here? [y/N]".
- Answering "y" to that question no longer ends with "Agent exited": the tab waits up to a minute for
  the other Claude Code to save and quit (it took longer than the ten seconds allowed).
- A Claude Code background job started from an agent tab, or any other agent that only inherited the
  tab's variables (a headless `claude -p` run by a hook), no longer takes that tab over: after a
  restart the tab came back in that agent's conversation.
- Two tabs that led to one background job show it once: the spare tab closes itself with a notice,
  and Continue on a job already shown in a tab shows that tab.

## [2.2.2] - 2026-10-06

### Added

- Active: a Claude Code question with a preview per option is read correctly (the options from the left
  column, the preview from its frame) and shown with the options in a column, the highlighted
  option's preview below them, 👁 to see another option's preview (it moves the highlight in the tab,
  nothing is answered), a note sent along with the answer, and Chat about this.
- Active: cards waiting for a decision get their own section on top and an amber strip naming the
  question, instead of a red outline that looked like a selected card.

### Fixed

- In the detailed view a long "now" line of a working session was drawn over the message below it.

### Changed

- New installs start agent terminal tabs at font size 12; a size already saved in the settings is kept.

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

[Unreleased]: https://github.com/OlegTestov/obsidian-ai-session-atlas/compare/2.3.0...HEAD
[2.3.0]: https://github.com/OlegTestov/obsidian-ai-session-atlas/compare/2.2.3...2.3.0
[2.2.3]: https://github.com/OlegTestov/obsidian-ai-session-atlas/compare/2.2.2...2.2.3
[2.2.2]: https://github.com/OlegTestov/obsidian-ai-session-atlas/compare/2.2.1...2.2.2
[2.2.1]: https://github.com/OlegTestov/obsidian-ai-session-atlas/compare/2.2.0...2.2.1
[2.2.0]: https://github.com/OlegTestov/obsidian-ai-session-atlas/compare/2.1.1...2.2.0
[2.1.1]: https://github.com/OlegTestov/obsidian-ai-session-atlas/compare/2.1.0...2.1.1
[2.1.0]: https://github.com/OlegTestov/obsidian-ai-session-atlas/compare/2.0.0...2.1.0
[2.0.0]: https://github.com/OlegTestov/obsidian-ai-session-atlas/releases/tag/2.0.0
