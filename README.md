# Session Atlas

An Obsidian plugin for people who work with **Claude Code** (and optionally **Codex**) all day.
It turns the pile of session transcripts in `~/.claude/projects` into a searchable catalog, shows your
running sessions as live cards you can answer from, keeps agent terminals inside Obsidian, and brings
them back — with the same session — after a restart.

*[Русская версия](README.ru.md)*

## What you get

- **Search** — full-text search over every Claude Code session: your prompts, the answers, commands,
  files. Filters by project, domain, topic and date. Each result opens a card with the session's
  prompts, cost, files and a one-click **Resume** in an Obsidian terminal tab. **Delete session**
  removes a finished session from the computer for good, after a confirmation that lists every file.
- **Active** — every running session as a card: what it is doing, what it last said, whether it waits
  for you.
  - Answer permission prompts and questions from the card.
  - Read and approve a plan, or send it back with comments.
  - Type a reply, stop the agent, run slash commands.
  - See the agent's task list and a step-by-step feed of tool calls, errors and changed files.
- **Stats** — tokens, active time, API-rate cost and cache hit rate over a period.
  - Breakdowns by model, domain, topic, session, tool, skill and agent.
  - A weekly rhythm heatmap.
  - Answers copied into resumed sessions are counted once, and idle gaps are not counted as work.
- **Agent terminals** — ribbon buttons open Claude Code or Codex in a built-in terminal tab.
  - Each tab remembers the session it holds. After Obsidian restarts it resumes exactly that session.
  - Closing a tab asks for confirmation.
- **Notifications** — when a session finishes or needs a decision, including a macOS notification
  when Obsidian is in the background.
- Optional AI features (off by default) — topics and domains, a one-line summary of what was done,
  and a handoff document for continuing the work in a fresh session.
- English interface; Russian is one switch away in settings.

## Requirements

| | |
|---|---|
| macOS | 12 Monterey or newer |
| Obsidian | desktop app |
| Claude Code and/or Codex | installed and signed in |
| Xcode Command Line Tools | provide the system `python3` (3.8 or newer). If they are missing, macOS offers to install them when the plugin asks — one click, or run `xcode-select --install` |

Nothing else: no Homebrew, Node, tmux or extra Obsidian plugins.

## Install

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/OlegTestov/obsidian-session-atlas/releases/latest).
2. Put them into `<vault>/.obsidian/plugins/session-atlas/`.
3. Obsidian → Settings → Community plugins → enable *Session Atlas*.

The plugin is not in the Obsidian community list yet.

Open it with the library icon in the ribbon. The first start builds the index of your sessions; with
thousands of sessions this takes a few minutes.

## Privacy

Everything runs on your Mac. The plugin starts a small local server (Python standard library only)
on `127.0.0.1:8787`; it reads `~/.claude/projects` and stores its index in
`~/Library/Application Support/session-atlas/`. Nothing is sent anywhere.

The optional AI features call the `claude` CLI you already use, so they spend your own Claude
subscription.

- **A summary or a handoff** is sent only after a preview shows exactly what will go out and you
  confirm it. A handoff may send most of the session — as much as fits the model's window.
- **The hourly automatic mode**, if you turn it on, classifies new sessions from short fact cards
  (title, prompts, paths) and writes summaries without asking each time. It skips sessions in areas
  you marked sensitive.

Deleting a session removes its files from `~/.claude` (transcript, subagents, file history, session
environment, tasks, to-dos) and its lines from `~/.claude/history.jsonl`, the input history.

The plugin writes outside its own folder in one other case: **subscription limits**. Claude Code
reports them only to a status line script, so the "Subscription limits" switch in settings adds the
Session Atlas status line to `~/.claude/settings.json` (a copy of the file is kept next to it). If
you already have your own status line, the plugin leaves it alone.

## How it works

- The plugin bundle carries the server, the page and the terminal scripts. On first start it unpacks
  them into `~/Library/Application Support/session-atlas/runtime/`, then runs the server with the
  system `python3`. The server stops when the plugin unloads.
- Terminal tabs are `xterm.js` connected to a pseudo-terminal provided by macOS itself (`/usr/bin/script`).
- Each agent tab has an id. A small registry maps the tab to the session it currently holds; a Claude
  Code hook keeps it up to date when you switch sessions inside the tab.
- Personal settings — note folders, project roots, domains, ticket prefixes, sensitive areas, models —
  live in `~/Library/Application Support/session-atlas/config.json`. The plugin creates it on first
  start for the current vault.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Xcode Command Line Tools (python3) are needed" | Run `xcode-select --install`, then press Retry on the Session Atlas tab. |
| "the port is used by another program" | Something else listens on 8787 — stop it. |
| The server does not start | See `~/Library/Application Support/session-atlas/server.log`. |
| `claude` is not found in a terminal tab | The tab runs your login shell (`zsh -l -i`). Make sure `claude` is on the PATH your shell profile sets. |

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install pytest
.venv/bin/python -m pytest -q                        # Python + node tests
node tools/check_i18n.js                             # every UI string has en and ru
python3 tools/build.py --out dist                    # release files
python3 tools/install_plugin.py --vault /path/to/vault   # install into a vault for testing
```

Runtime code is Python 3.8+ stdlib and plain JavaScript. There is no build step besides bundling.

## License

MIT — see [LICENSE](LICENSE). xterm.js is MIT-licensed by its authors.
