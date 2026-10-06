# AI Session Atlas

AI Session Atlas is an Obsidian plugin for macOS for people who work with Claude Code and Codex
every day. It indexes the session transcripts of both agents (`~/.claude/projects` and Codex's
`~/.codex/sessions`) into one searchable catalog, shows running sessions as live cards you can answer
from, counts tokens and cost, and runs Claude Code and Codex in terminal tabs inside Obsidian that
reopen the same session after a restart. Everything runs locally: the plugin starts a small Python
server on `127.0.0.1`, and nothing is sent anywhere unless you turn on the optional AI features.

*[Русская версия](README.ru.md)*

## Features

- **Search.** Full-text search over every Claude Code and Codex session: your prompts, the answers,
  shell commands and edited files. Filters by agent, project, domain, topic and date. A session card
  shows the prompts, cost and edited files, and has buttons to:
  - resume the session in an Obsidian terminal tab (`claude --resume` or `codex resume`);
  - continue it in the other agent with **Resume with…**: a Claude Code session in Codex, a Codex
    session in Claude Code (see below);
  - rename it (for Claude Code the name is also saved where `claude --resume` shows it);
  - delete it from the computer for good, after a confirmation that lists every file.
- **Active.** Every running Claude Code session and every interactive Codex session as a card: what
  it is doing, what it said last, whether it waits for you. For sessions running in an AI Session
  Atlas terminal tab you can also:
  - answer permission prompts and questions (for Codex: approvals, questions and choices, read from
    the tab's screen);
  - read and approve a Claude Code plan, or send it back with comments;
  - type a reply (Claude Code replies can carry images), stop the agent, run slash commands.

  Each card shows the agent's task list (for Codex, its plan checklist) and a step-by-step feed of
  tool calls, commands with exit codes, errors and changed files. A session running in another
  terminal app can be moved into an Obsidian tab. The header shows each agent's 5-hour and weekly
  limits when they are known.
- **Statistics.** Tokens, active time, cost at API prices and cache hit rate over a period, broken
  down by agent (Claude Code, Codex), model, domain, topic, session, tool, skill and subagent, plus a
  weekly rhythm heatmap. Claude Code replies are priced at Anthropic API prices, Codex replies at
  OpenAI API prices.
- **Agent terminals.** Ribbon buttons and commands open Claude Code or Codex in a terminal tab inside
  Obsidian. Each tab remembers the session it holds and resumes it after Obsidian restarts. Closing a
  tab with a running agent asks for confirmation.
- **Notifications.** A notice when a session finishes its turn or waits for a decision, and a macOS
  notification when Obsidian is in the background. Notices stack, one per session; they hide after
  10 s, 30 s or 1 min, or stay until you click or close them, and go by themselves once the session
  works again.
- **Optional AI features**, off by default: topics and domains for sessions, a one-line summary of
  what was done, and a handoff document for continuing the work in a fresh session.
- **File explorer clicks** (off by default): left click opens a file in a new tab, middle click in
  the current one, and a file that is already open is focused instead of opened twice.
- English and Russian interface.

### Codex support

Search, Active, Statistics, terminal tabs and deletion work for Codex sessions too. Checked with
codex-cli 0.160.0. Differences from Claude Code:

- **Sessions.** The catalog reads Codex session files (rollouts) in `sessions/` and
  `archived_sessions/` of the Codex home. Codex's own thread titles are read from its state database
  (`state_*.sqlite`), opened read-only. Codex instructions, reasoning and tool output are not indexed.
  `codex exec` runs and subagent threads count as automation, like Claude Code SDK runs.
- **Rename** changes the name in the catalog only. Existing Codex session files are never written.
- **Exact context fork** is Claude Code only.
- **New from this one** (a new session with a handoff) starts the source session's agent: a Codex
  session continues in Codex, with the same first prompt that names the handoff file. Codex picks its
  own thread id when it starts, so each Codex launch writes its own handoff file, and the catalog
  links the new thread to its source once a thread whose first prompt names that file is indexed.
- **+ Session** in Active has an **Agent** choice (Claude Code or Codex; Claude Code by default, the
  last choice is remembered in this browser). Codex is offered only when it is turned on in
  **Settings → AI Session Atlas → Agents**. A Codex tab records the new thread id once Codex writes
  its session file, so the tab comes back to that thread after an Obsidian restart.
- **Folder** in **+ Session** is a text field: paste an absolute path, type `~/…`, or the vault name and
  a path inside it, or pick a suggestion (folders your sessions ran in, then the real subfolders of what
  is typed; buttons for the vault root and home). Delete the tail to go up a level; ↑/↓ and Enter pick,
  Tab goes into the highlighted folder, Esc closes the list. A path that is not an existing folder is
  refused with the reason.
- **Active** shows interactive `codex` processes in a terminal, found with `ps` and `lsof`. `codex exec`
  runs and the Codex app are not live cards; their sessions appear in Search.
- **Waiting for you.** Codex writes no permission prompt into its files, so the plugin reads it from
  the screen of its own terminal tab. A Codex session in another terminal app shows only busy or idle;
  move it into a tab to answer from the card.
- **Slash commands.** Command hints and argument pickers are Claude Code only. A command typed for
  Codex is sent as is; the output of `/status` and `/mcp` is shown on the card.
- **Limits.** Codex's 5-hour and weekly limits come from Codex itself, as its `/status` shows them:
  while Codex cards are shown in Active, the server runs `codex app-server`, asks it once for the
  account's usage (`account/rateLimits/read`) and exits it, at most every 5 minutes. No thread is
  started and no model is called. When that fails (Codex not installed or not logged in), the numbers
  of Codex's last run are shown with their age ("3 h ago"); a window at 100% names its reset time.
  Claude Code limits need the **Subscription limits** switch.
- **Cost.** Codex writes tokens but no cost. Statistics and live cards price Codex replies at OpenAI
  API prices from a table built into the plugin; a model the table does not know shows no cost.
  Prices can be fixed or added in `config.json` (see Usage).
- **AI features** work on Codex sessions too, through your `claude` CLI.

### Resume with another agent

**Resume with…** on a Search card lists Claude Code and Codex. The session's own agent is the ordinary
resume. The other agent gets a new session of its own, made from this conversation, and it opens in a
terminal tab with that agent's ordinary resume. Checked with Claude Code 2.1.289 and codex-cli 0.160.0.

- **What is copied:** the conversation since its last compaction, with the compaction summary: your
  prompts and the agent's replies word for word, and tool calls as short text lines (the command or
  the file, and the first 800 characters of the result). Thinking, reasoning and encrypted content
  are never copied.
- **Size:** at most about 100,000 tokens, half of a 200,000-token context window. If the conversation
  is longer, the earliest turns are left out and the new session starts with a note saying so.
- **The first message** says that the conversation continues a Claude Code or Codex session, with its
  id and folder, and that the tool calls in it were made by the other agent.
- **The source session is not changed.** The new session has its own id and its own file:
  `~/.claude/projects/<folder>/<id>.jsonl` for Claude Code, `~/.codex/sessions/YYYY/MM/DD/rollout-…jsonl`
  for Codex. A Codex session names the model provider set in `~/.codex/config.toml` (`openai` if none).
- **In the catalog** the new session is marked "from Claude Code" or "from Codex", and both cards link
  to each other. Its copied messages are not indexed or counted again: search and Statistics see them
  once, in the source session.
- An agent turned off in **Settings → AI Session Atlas → Agents** is shown disabled in the menu.
  Outside Obsidian (in a browser) the menu creates the session and shows the command to run.

## Requirements

| | |
|---|---|
| macOS | 12 Monterey or newer |
| Obsidian | Desktop app, 1.8.7 or newer |
| Python | `python3` 3.8 or newer whose SQLite supports FTS5 with the trigram tokenizer. The system `python3` comes with Xcode Command Line Tools |
| Agents | Claude Code installed and signed in. Codex is optional; checked with codex-cli 0.160.0 |

The plugin looks for `python3` in this order: the path set in **Settings → AI Session Atlas → Advanced → Custom
python3**, `/usr/bin/python3` (only when Command Line Tools are installed, so the plugin never runs
the stub that opens the installer), `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`. If none
fits, a notice says so, and **Settings → AI Session Atlas → Installation check** shows every candidate it tried and an
**Install Command Line Tools** button (it runs `xcode-select --install`).

`claude` and `codex` are found on the `PATH` of your login shell. The plugin needs no Homebrew, Node,
tmux or other Obsidian plugins.

## Installation

From the community plugin directory
([listing](https://community.obsidian.md/plugins/session-atlas)): in Obsidian open
**Settings → Community plugins → Browse**, search for **AI Session Atlas**, install and enable it.

Manually:

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/OlegTestov/obsidian-ai-session-atlas/releases/latest).
2. Put them into `<vault>/.obsidian/plugins/session-atlas/`.
3. In Obsidian, open **Settings → Community plugins** and enable **AI Session Atlas**.

On first start the plugin unpacks its server into
`~/Library/Application Support/session-atlas/runtime/`, starts it and builds the session index. With
many sessions the first index can take a few minutes.

## Usage

- **Catalog.** Click the library icon in the ribbon or run **Open session catalog**. The tab has three
  sections: Search, Active and Statistics.
- **Agent filter.** Search, Active and Statistics each have an **Agent** list with Claude Code and
  Codex. Both are ticked by default, one always stays ticked, and the choice is remembered for each
  section.
- **Terminals.** Click the Claude Code or Codex icon in the ribbon. A tab starts in the vault folder
  and runs your login shell. Sessions opened from the catalog start in their own working folder.
- **Commands:**

  | Command | ID |
  |---|---|
  | Open session catalog | `open-catalog` |
  | Open Claude Code terminal | `open-claude-code-terminal` |
  | Open Codex terminal (when Codex is enabled) | `open-codex-terminal` |
  | Reload the plugin (tabs and sessions stay) | `reload-plugin` |

  Command names follow the plugin language; the table shows the English ones.
- **Settings:**
  - *Installation check:* macOS, `python3`, Claude Code, Codex, the server, the index (with a
    Rebuild button) and the subscription limits switch.
  - *Language:* English, Russian or as in Obsidian.
  - *Agents:* turn Claude Code and Codex on or off, extra launch arguments for each (for example
    `--chrome`), terminal font size, number of messages in a detailed Active card.
  - *Catalog:* note folders, project roots, domains, note areas mapped to domains, sensitive areas
    and projects, ticket prefixes. These live in `config.json` in the data folder.
  - *AI features:* on/off, output language, model and effort for each task, 1M-token window.
  - *Other:* notices and how long they stay, macOS notifications, file explorer clicks.
  - *Advanced:* custom `python3` path and terminal shell.
- **Codex prices.** `openai_prices` in `config.json` fixes or adds the price of a Codex model, in US
  dollars per 1 million tokens:
  `{"openai_prices": {"<model>": {"input": 2, "cached_input": 0.2, "output": 10}}}`.
  `cache_write` is optional; `null` instead of a price leaves the model unpriced. The change shows up
  in Statistics without a reindex. All costs are estimates at API prices, not what a subscription
  costs.

## Disclosures

This section lists everything the plugin does outside Obsidian, as required by the Obsidian
developer policies.

**Network.**
- The plugin starts a local HTTP server bound to `127.0.0.1` on port 8787. The catalog tab is a page
  served by it; the plugin and the page talk only to this server.
- The plugin and its server make no other network requests. There is no telemetry, no analytics, no
  update check, no ads and no account.
- The optional AI features run your own `claude` CLI, which sends data to Anthropic under your
  Claude Code account (see "AI features" below).
- Claude Code and Codex running in terminal tabs connect to their providers as they always do. The
  plugin does not send anything to OpenAI itself.
- While Codex cards are shown in Active, the server may run your `codex` as `codex app-server` to read
  Codex's usage limits, at most every 5 minutes. Codex then asks OpenAI for your account's usage with
  its own login, as its `/status` does. No model is called and nothing from your sessions is sent;
  the plugin never reads Codex's login. OpenAI prices come from a table inside the plugin, not
  from the network.

**Clipboard.** The plugin reads clipboard text only when you choose Paste in a terminal's context
menu, and sends it to that terminal as typed input. Copy actions write the selected terminal text
or the requested catalog text to the clipboard. Pasting into a reply field can also attach images
from the paste event. The plugin does not poll the clipboard or keep a clipboard history. Pasted
content can become part of the agent's transcript or an attached image, as with ordinary input.

**Files outside the vault.**

| Path | Access | Why |
|---|---|---|
| `~/.claude/projects/` | read | Session transcripts: the catalog, Active and Statistics |
| `~/.claude/sessions/`, `~/.claude/tasks/`, `~/.claude/plans/` | read | Running sessions, their task lists and plans |
| `~/.claude/commands/`, `~/.claude/skills/`, `~/.claude/plugins/`, `~/.claude/settings.json` | read | The slash command list in Active |
| `~/.codex/sessions/`, `~/.codex/archived_sessions/` | read | Codex session files: the catalog, Active and Statistics, and the session a terminal tab should resume |
| `~/.codex/state_*.sqlite` | read only, opened in read-only mode | Codex's own thread titles |
| `~/.codex/history.jsonl` | read | How many input history lines a Codex session has, shown before deletion |
| `~/.codex/config.toml` | read, only for **Resume with… → Codex** | The model provider a new Codex session names |
| `~/Library/Application Support/session-atlas/` | read, write | The plugin's data folder: unpacked server, index, settings, logs (see "Privacy & data location") |
| `~/.local/state/obsidian-agent-terminals/` (or `$XDG_STATE_HOME/obsidian-agent-terminals/`) | read, write | Which session each terminal tab holds, so the tab can resume it |
| `~/.claude/settings.json` | write, only when you turn on **Subscription limits** | Adds the AI Session Atlas status line (see below) |
| A session's transcript in `~/.claude/projects/` | append, only when you rename a session | Saves the new name where Claude Code reads it |
| A new file in `~/.claude/projects/<folder>/` | create, only when you use **Resume with… → Claude Code** | A new Claude Code session made from a Codex session |
| A new file in `~/.codex/sessions/YYYY/MM/DD/` | create, only when you use **Resume with… → Codex** | A new Codex session made from a Claude Code session |
| A session's files in `~/.claude/` and its lines in `~/.claude/history.jsonl` | delete, only when you delete a session | See "Deleting a session" below |
| A Codex session's files in `~/.codex/sessions/` and `~/.codex/archived_sessions/`, its lines in `~/.codex/history.jsonl` | delete, only when you delete a Codex session | See "Deleting a session" below |
| `~/Desktop`, `~/Documents` or a project folder | write, only when you export a handoff there | The exported handoff file |

If `CLAUDE_CONFIG_DIR` is set in Obsidian's environment, every `~/.claude` path above means that folder.
If `CODEX_HOME` is set, every `~/.codex` path means that folder. The plugin never writes Codex's
databases or settings and never writes into an existing Codex session file (`codex app-server`, run for
the limits, keeps its own logs and databases there as any Codex run does). It creates a new session
file only when you use **Resume with…** and deletes files only when you delete a session.

**Resume with…** (Search card) creates a new session file of the other agent: in `~/.claude/projects/`
for Claude Code or in `~/.codex/sessions/` for Codex. It happens only after a dialog that names the
folder; the file is created once and never overwritten, and the source session is only read. The new
file holds a copy of the conversation since its last compaction (see "Resume with another agent").
Delete the new session like any other if you no longer need it.

**Processes.**
- `python3 -m atlas.cli serve --port 8787` from the data folder: the catalog server. It stops when the
  plugin unloads. While it runs, it starts short-lived `python3` index passes, runs `ps` to find
  running Claude Code and Codex sessions, and runs `lsof` on interactive `codex` processes to see
  which session file each one holds open (Codex writes no file per process).
- Your login shell (`$SHELL -l -i`), once per start, to read `PATH` and find `claude` and `codex`.
- Codex terminal tabs probe `codex --help` and use `--no-daemon` when supported. Each tab then
  keeps its own session process, so session switches and terminal controls can be verified.
  Existing CLI instances and your Codex settings are left alone.
- Terminal tabs: `/bin/sh`, `cat` and `/usr/bin/script` provide a pseudo-terminal, which runs your
  login shell, a tab script from the data folder, and then `claude` or `codex`. The tab passes Claude
  Code a `SessionStart`/`UserPromptSubmit` hook through `--settings` for that launch only; your
  Claude Code settings files are not changed. `ps` and `stty` are used to find and resize tabs;
  `ps` and `lsof` tell which Codex session a tab runs.
- `sw_vers` and `xcode-select -p` for the installation check; `xcode-select --install` only when you
  press the install button.
- `claude -p`, only when AI features are on (see below).
- When you choose **Move** on an Active card, the plugin sends `SIGTERM` to that Claude Code or Codex
  process in the other terminal app (it exits as on Ctrl+C) and resumes the session in an Obsidian
  tab (`claude --resume` or `codex resume`). It checks first that the process belongs to that
  session; for Codex, that the process holds this session's file open.
  A shared Codex app server is never stopped to move a single session.

**AI features.** Off by default. While they are off, the server refuses every request that would call
a model.
- When on, they run your own `claude` CLI (`claude -p`) with your settings, hooks, MCP servers and
  tools disabled. `ANTHROPIC_API_KEY` is removed from the environment of these calls, so they use the
  account you signed in to Claude Code with and count against your subscription. The model is
  `sonnet` unless you change it. Before a request larger than 200,000 characters, a small test
  request checks that the call works.
- **Summary and handoff:** you see a preview of exactly what will be sent and confirm it. A handoff
  may send most of the session, as much as fits the model's context window. The full text of each
  preview is saved in the data folder (`payloads/`).
- **Topics and domains:** a batch is sent after a preview of its size and samples. Each session is
  sent as a short fact card: title, working folder and branch, projects, tickets, a few prompts and
  edited file paths.
- **Hourly automatic mode**, if you turn it on, does the same for new and changed sessions without
  asking each time, up to 8 sessions an hour.
- Sessions in areas or projects you mark as sensitive are never included in topic batches or the
  automatic mode.
- Claude Code saves these runs as its own transcripts under `~/.claude/projects/`, in a folder the
  catalog skips.

**Subscription limits.** Claude Code reports 5-hour and weekly limits only to a status line script.
The **Subscription limits** switch adds a AI Session Atlas status line to `~/.claude/settings.json`.
Before its first edit the plugin saves a copy as `settings.json.session-atlas.bak` next to it. If you
already have a status line, or the file is not valid JSON, the switch is disabled and the file is
left alone. While enabled, the status line runs for every Claude Code session on the computer and
writes the limits to `rate-limits.json` in the data folder. Turning the switch off removes the
`statusLine` entry.

**Deleting a session** (Search card → Delete session) removes, after a confirmation that lists every
item: the transcript and the session folder in `~/.claude/projects/`, its entries in
`~/.claude/file-history/`, `~/.claude/session-env/`, `~/.claude/tasks/` and `~/.claude/todos/`, its
lines in `~/.claude/history.jsonl` (the input history), its handoffs and its catalog data. For a
Codex session it removes its session files in `~/.codex/sessions/` and `~/.codex/archived_sessions/`,
its lines in `~/.codex/history.jsonl`, its handoffs and its catalog data. Codex's own databases are
not changed, so Codex may list the thread for a while, until it notices the file is gone. Files are
deleted, not moved to the Trash. A running session cannot be deleted.

## Privacy & data location

Everything stays on your Mac. The data folder is `~/Library/Application Support/session-atlas/`,
created with permissions that only your user can read. It contains:

| Item | Content |
|---|---|
| `runtime/` | The server, the page and the tab scripts unpacked from `main.js` |
| `atlas.sqlite3` | The search index of Claude Code and Codex sessions, topics, summaries and your edits |
| `config.json` | Catalog and AI settings, Codex prices |
| `context.md` | Notes about you for the topic classifier; edit it by hand |
| `csrf.token` | The token that protects the local server |
| `server.log` | Server log |
| `agent-args/` | Extra launch arguments for Claude Code and Codex |
| `uploads/` | Images attached to replies; removed after 7 days |
| `handoffs/`, `payloads/`, `runner/` | AI feature output, previews of sent text, the working folder of `claude -p` |
| `rate-limits.json` | Subscription limits, when the status line is enabled |

Plugin settings (language, agents, notifications) are stored by Obsidian in
`<vault>/.obsidian/plugins/session-atlas/data.json`.

## Uninstall

1. If you turned on **Subscription limits**, turn it off first: this removes the status line from
   `~/.claude/settings.json`. Alternatively, restore `~/.claude/settings.json.session-atlas.bak`.
2. Disable and remove the plugin in **Settings → Community plugins**, or delete
   `<vault>/.obsidian/plugins/session-atlas/`. The server stops when the plugin is disabled.
3. Delete the data folder: `~/Library/Application Support/session-atlas/`.
4. Delete the terminal tab registry: `~/.local/state/obsidian-agent-terminals/`.
5. Optionally delete `~/.claude/settings.json.session-atlas.bak` and, if you used the AI features,
   the folder of their runs in `~/.claude/projects/` whose name ends with `session-atlas-runner`.

The plugin adds nothing to the Codex home, so there is nothing to remove there.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Notice "Xcode Command Line Tools (python3) are needed" | Run `xcode-select --install` or press **Install Command Line Tools** in **Settings → AI Session Atlas → Installation check**. Then press **Retry** on the AI Session Atlas tab. If you use another Python, set its path in **Settings → AI Session Atlas → Advanced → Custom python3**. |
| "no python3 fits (...)" | The listed interpreters are older than 3.8 or their SQLite lacks FTS5 with the trigram tokenizer. Update Command Line Tools in Software Update or set a custom `python3`. |
| "the port is used by another program" | Another program listens on `127.0.0.1:8787`. The port is fixed; stop that program and press **Retry**. A server left over from an older AI Session Atlas version is stopped and replaced automatically. |
| "the server did not start, see ..." | Read `~/Library/Application Support/session-atlas/server.log`. Press **Restart** in **Settings → AI Session Atlas → Installation check** after fixing the cause. |
| Claude Code shows as not found, or a tab cannot start `claude` | Tabs run your login shell (`-l -i`). Make sure your shell profile puts `claude` on the `PATH`, or set another shell in **Settings → AI Session Atlas → Advanced → Terminal shell**. |
| Search shows old results | Press **Rebuild** next to "Session index" in **Settings → AI Session Atlas → Installation check**. |
| Codex shows as not found, or a Codex tab cannot start `codex` | Codex is optional. Make sure your shell profile puts `codex` on the `PATH`, as for `claude`, then turn Codex on in **Settings → AI Session Atlas → Agents**. |
| Codex sessions are missing from Search | The catalog reads `$CODEX_HOME` or `~/.codex`. If you moved the Codex home with `CODEX_HOME`, Obsidian must have the variable in its environment too (for example `launchctl setenv CODEX_HOME /path/to/codex-home`, then restart Obsidian). Then press **Rebuild**. Check that Codex is ticked in the **Agent** filter. |
| A Codex tab starts a new session after a restart instead of the old one | The tab script looks for the session in `~/.codex/sessions/` only. With a moved Codex home, resume the session from Search. |
| A Codex card never shows that it waits for you | Codex permission prompts are read from the screen of the plugin's own tab. Move the session into a tab with **Move**. |
| A running Codex session is missing from Active | Only interactive terminal clients are shown. Plugin tabs use `--no-daemon` when available. For external clients using a shared server, only an explicit `codex resume <id>` can be matched; switching threads inside that external client cannot be tracked reliably. Restart that client with `codex --no-daemon resume <id>` for full tracking. The shared server is never stopped by Move. |

## Development

Requirements: Node.js 20.19 or newer and `python3` 3.8 or newer.

```bash
npm ci                    # install build and lint tools
npm run build             # main.js and styles.css in the repository root, next to manifest.json
npm run lint              # ESLint with eslint-plugin-obsidianmd
npm test                  # Node tests, including the check that every page string has English and Russian
npm run e2e               # browser tests
python3 -m pip install pytest
python3 -m pytest -q      # Python tests
python3 tools/install_plugin.py --vault /path/to/test-vault --dev   # build into a test vault
```

With `--dev` the installed plugin reloads itself on every build and runs apart from your working
setup: its own server on port 8788 and its own data folder
(`~/Library/Application Support/session-atlas-dev`). Open that test vault in a second Obsidian
window. Without `--dev` the build is only staged: a running Obsidian keeps the loaded version until
you run **Reload the plugin** or restart Obsidian. Release installs never reload themselves.

`main.js` embeds the Python server, the page and the zsh tab scripts; the plugin unpacks them at
runtime. The server uses only the Python standard library.

Project layout:

| Path | Content |
|---|---|
| `obsidian-plugin/src/` | Plugin source (ES modules, bundled by esbuild) |
| `obsidian-plugin/styles.css` | Plugin styles |
| `obsidian-plugin/scripts/` | zsh scripts for agent terminal tabs |
| `atlas/` | Python server and indexer |
| `web/` | The catalog page (`index.html` and `web/js/`) |
| `tests/` | Python tests (pytest) |
| `tests/js/` | Node tests |
| `tests/e2e/` | Browser tests |
| `tools/` | Development tools: vault installer, status line script, mutation testing, test fixtures |
| `esbuild.config.mjs`, `eslint.config.mjs` | Build and lint configuration |
| `manifest.json`, `versions.json` | Obsidian plugin manifest and version map |
| `main.js`, `styles.css` | Build output, not committed |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in
[SECURITY.md](SECURITY.md). This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). The release `main.js` and `styles.css` include xterm.js and its addons (MIT); see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
