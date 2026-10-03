# Session Atlas

Session Atlas is an Obsidian plugin for macOS for people who work with Claude Code (and optionally
Codex) every day. It indexes the Claude Code session transcripts in `~/.claude/projects` into a
searchable catalog, shows running Claude Code sessions as live cards you can answer from, and runs
Claude Code and Codex in terminal tabs inside Obsidian that reopen the same session after a restart.
Everything runs locally: the plugin starts a small Python server on `127.0.0.1`, and nothing is sent
anywhere unless you turn on the optional AI features.

*[Русская версия](README.ru.md)*

## Features

- **Search.** Full-text search over every Claude Code session: your prompts, the answers, commands
  and files. Filters by project, domain, topic and date. A session card shows the prompts, cost and
  edited files, and has buttons to:
  - resume the session in an Obsidian terminal tab;
  - rename it (the name is also saved where `claude --resume` shows it);
  - delete it from the computer for good, after a confirmation that lists every file.
- **Active.** Every running Claude Code session as a card: what it is doing, what it said last,
  whether it waits for you. For sessions running in a Session Atlas terminal tab you can also:
  - answer permission prompts and questions;
  - read and approve a plan, or send it back with comments;
  - type a reply (with images), stop the agent, run slash commands.

  Each card shows the agent's task list and a step-by-step feed of tool calls, errors and changed
  files. A session running in another terminal app can be moved into an Obsidian tab.
- **Statistics.** Tokens, active time, cost at API prices and cache hit rate over a period, broken down by
  model, domain, topic, session, tool, skill and agent, plus a weekly rhythm heatmap.
- **Agent terminals.** Ribbon buttons and commands open Claude Code or Codex in a terminal tab inside
  Obsidian. Each tab remembers the session it holds and resumes it after Obsidian restarts. Closing a
  tab with a running agent asks for confirmation.
- **Notifications.** A notice when a session finishes its turn or waits for a decision, and a macOS
  notification when Obsidian is in the background.
- **Optional AI features**, off by default: topics and domains for sessions, a one-line summary of
  what was done, and a handoff document for continuing the work in a fresh session.
- **File explorer clicks** (off by default): left click opens a file in a new tab, middle click in
  the current one, and a file that is already open is focused instead of opened twice.
- English and Russian interface.

The catalog, Active and Statistics cover Claude Code sessions. Codex is supported in terminal tabs.

## Requirements

| | |
|---|---|
| macOS | 12 Monterey or newer |
| Obsidian | Desktop app, 1.8.7 or newer |
| Python | `python3` 3.8 or newer whose SQLite supports FTS5 with the trigram tokenizer. The system `python3` comes with Xcode Command Line Tools |
| Agents | Claude Code installed and signed in. Codex is optional |

The plugin looks for `python3` in this order: the path set in **Settings → Session Atlas → Advanced → Custom
python3**, `/usr/bin/python3` (only when Command Line Tools are installed, so the plugin never runs
the stub that opens the installer), `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`. If none
fits, a notice says so, and **Settings → Session Atlas → Installation check** shows every candidate it tried and an
**Install Command Line Tools** button (it runs `xcode-select --install`).

`claude` and `codex` are found on the `PATH` of your login shell. The plugin needs no Homebrew, Node,
tmux or other Obsidian plugins.

## Installation

From the community plugin directory
([listing](https://community.obsidian.md/plugins/session-atlas)): in Obsidian open
**Settings → Community plugins → Browse**, search for **Session Atlas**, install and enable it.

Manually:

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/OlegTestov/obsidian-session-atlas/releases/latest).
2. Put them into `<vault>/.obsidian/plugins/session-atlas/`.
3. In Obsidian, open **Settings → Community plugins** and enable **Session Atlas**.

On first start the plugin unpacks its server into
`~/Library/Application Support/session-atlas/runtime/`, starts it and builds the session index. With
many sessions the first index can take a few minutes.

## Usage

- **Catalog.** Click the library icon in the ribbon or run **Open session catalog**. The tab has three
  sections: Search, Active and Statistics.
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
  - *Other:* notices, macOS notifications, file explorer clicks.
  - *Advanced:* custom `python3` path and terminal shell.

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
  plugin does not send anything to OpenAI.

**Files outside the vault.**

| Path | Access | Why |
|---|---|---|
| `~/.claude/projects/` | read | Session transcripts: the catalog, Active and Statistics |
| `~/.claude/sessions/`, `~/.claude/tasks/`, `~/.claude/plans/` | read | Running sessions, their task lists and plans |
| `~/.claude/commands/`, `~/.claude/skills/`, `~/.claude/plugins/`, `~/.claude/settings.json` | read | The slash command list in Active |
| `~/.codex/sessions/` | read | Finding the Codex session a terminal tab should resume |
| `~/Library/Application Support/session-atlas/` | read, write | The plugin's data folder: unpacked server, index, settings, logs (see "Privacy & data location") |
| `~/.local/state/obsidian-agent-terminals/` (or `$XDG_STATE_HOME/obsidian-agent-terminals/`) | read, write | Which session each terminal tab holds, so the tab can resume it |
| `~/.claude/settings.json` | write, only when you turn on **Subscription limits** | Adds the Session Atlas status line (see below) |
| A session's transcript in `~/.claude/projects/` | append, only when you rename a session | Saves the new name where Claude Code reads it |
| A session's files in `~/.claude/` and its lines in `~/.claude/history.jsonl` | delete, only when you delete a session | See "Deleting a session" below |
| `~/Desktop`, `~/Documents` or a project folder | write, only when you export a handoff there | The exported handoff file |

If `CLAUDE_CONFIG_DIR` is set in Obsidian's environment, every `~/.claude` path above means that folder.

**Processes.**
- `python3 -m atlas.cli serve --port 8787` from the data folder: the catalog server. It stops when the
  plugin unloads. While it runs, it starts short-lived `python3` index passes and runs `ps` to find
  running Claude Code sessions.
- Your login shell (`$SHELL -l -i`), once per start, to read `PATH` and find `claude` and `codex`.
- Terminal tabs: `/bin/sh`, `cat` and `/usr/bin/script` provide a pseudo-terminal, which runs your
  login shell, a tab script from the data folder, and then `claude` or `codex`. The tab passes Claude
  Code a `SessionStart`/`UserPromptSubmit` hook through `--settings` for that launch only; your
  Claude Code settings files are not changed. `ps` and `stty` are used to find and resize tabs.
- `sw_vers` and `xcode-select -p` for the installation check; `xcode-select --install` only when you
  press the install button.
- `claude -p`, only when AI features are on (see below).
- When you choose **Move** on an Active card, the plugin sends `SIGTERM` to that Claude Code process
  in the other terminal app (Claude Code exits as on Ctrl+C) and resumes the session in an Obsidian
  tab. It checks first that the process belongs to that session.

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
The **Subscription limits** switch adds a Session Atlas status line to `~/.claude/settings.json`.
Before its first edit the plugin saves a copy as `settings.json.session-atlas.bak` next to it. If you
already have a status line, or the file is not valid JSON, the switch is disabled and the file is
left alone. While enabled, the status line runs for every Claude Code session on the computer and
writes the limits to `rate-limits.json` in the data folder. Turning the switch off removes the
`statusLine` entry.

**Deleting a session** (Search card → Delete session) removes, after a confirmation that lists every
item: the transcript and the session folder in `~/.claude/projects/`, its entries in
`~/.claude/file-history/`, `~/.claude/session-env/`, `~/.claude/tasks/` and `~/.claude/todos/`, its
lines in `~/.claude/history.jsonl` (the input history), its handoffs and its catalog data. Files are
deleted, not moved to the Trash. A running session cannot be deleted.

## Privacy & data location

Everything stays on your Mac. The data folder is `~/Library/Application Support/session-atlas/`,
created with permissions that only your user can read. It contains:

| Item | Content |
|---|---|
| `runtime/` | The server, the page and the tab scripts unpacked from `main.js` |
| `atlas.sqlite3` | The search index, topics, summaries and your edits |
| `config.json` | Catalog and AI settings |
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

## Troubleshooting

| Symptom | Fix |
|---|---|
| Notice "Xcode Command Line Tools (python3) are needed" | Run `xcode-select --install` or press **Install Command Line Tools** in **Settings → Session Atlas → Installation check**. Then press **Retry** on the Session Atlas tab. If you use another Python, set its path in **Settings → Session Atlas → Advanced → Custom python3**. |
| "no python3 fits (...)" | The listed interpreters are older than 3.8 or their SQLite lacks FTS5 with the trigram tokenizer. Update Command Line Tools in Software Update or set a custom `python3`. |
| "the port is used by another program" | Another program listens on `127.0.0.1:8787`. The port is fixed; stop that program and press **Retry**. A server left over from an older Session Atlas version is stopped and replaced automatically. |
| "the server did not start, see ..." | Read `~/Library/Application Support/session-atlas/server.log`. Press **Restart** in **Settings → Session Atlas → Installation check** after fixing the cause. |
| Claude Code shows as not found, or a tab cannot start `claude` | Tabs run your login shell (`-l -i`). Make sure your shell profile puts `claude` on the `PATH`, or set another shell in **Settings → Session Atlas → Advanced → Terminal shell**. |
| Search shows old results | Press **Rebuild** next to "Session index" in **Settings → Session Atlas → Installation check**. |

## Development

Requirements: Node.js 20.19 or newer and `python3` 3.8 or newer.

```bash
npm ci                    # install build and lint tools
npm run build             # main.js and styles.css in the repository root, next to manifest.json
npm run lint              # ESLint with eslint-plugin-obsidianmd
npm test                  # Node tests, including the check that every page string has English and Russian
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
