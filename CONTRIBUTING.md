# Contributing

Thanks for helping with AI Session Atlas. This file explains how to build, test and submit a change.
By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues
privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## Setup

You need macOS, Node.js 20.19 or newer, `python3` 3.8 or newer, and Obsidian 1.8.7 or newer for
manual testing.

```bash
npm ci
python3 -m pip install pytest      # or inside a virtual environment
```

## Build, lint and test

```bash
npm run build             # main.js and styles.css in the repository root, next to manifest.json
npm run lint              # ESLint with the Obsidian recommended rules
npm test                  # Node tests: plugin, page, translations, release bundle
npm run e2e               # browser tests
python3 -m pytest -q      # Python tests
uvx ruff check atlas tests tools   # Python lint
```

CI (`.github/workflows/ci.yml`) runs on every push and pull request: ESLint and Ruff on Linux, then
the Node tests, the build and the Python tests on macOS, both with the system `python3` and with Python 3.8,
the oldest supported version.

To try a change in Obsidian, install the build into a test vault:

```bash
python3 tools/install_plugin.py --vault /path/to/test-vault --dev
```

Open the test vault in a second Obsidian window. With `--dev` the plugin there reloads itself on
every build and runs its own server (port 8788, data in `session-atlas-dev`), so your working vault,
its server and its agent tabs are never touched. Without `--dev` the installer only stages the build:
nothing reloads until you run **Reload the plugin**.

## Code rules

- **Runtime code has no dependencies.** The server in `atlas/` uses only the Python standard library
  and must run on Python 3.8. The plugin (`obsidian-plugin/src/`) is plain JavaScript in ES modules,
  bundled by esbuild; xterm.js is the only bundled library. The page in `web/` is plain JavaScript
  loaded as classic scripts, with no build step. Development tools (esbuild, ESLint, pytest) are
  fine.
- **Follow the Obsidian plugin guidelines.** `npm run lint` must pass with no new warnings. Do not
  add inline styles; put styles in `obsidian-plugin/styles.css` or `web/js/*.css`. Use Obsidian APIs
  where they exist (for example `Setting.setHeading()` for settings headings).
- **Tests come with the change.** A bug fix includes a test that fails without the fix. A new
  feature includes tests for its behaviour. `tools/mutations.py` breaks known behaviours on purpose
  and checks that a test notices; add a mutation for an important new guard.
- **Security checks stay in place.** Changes to `atlas/server.py`, the message bridge between the
  page and the plugin, or anything that deletes files, sends data to a model or edits files outside
  the data folder need a test for the guard, not only for the happy path.
- **Comments are in English** and explain why, not what.

## Tests never touch your agent data

Tests read and change only temporary folders, never your real `~/.claude` or `~/.codex`:

- Python tests: `tests/conftest.py` gives every test its own data folder (`ATLAS_HOME`) and Codex
  home (`ATLAS_CODEX_HOME`); the `atlas_env` fixture also points `ATLAS_PROJECTS_ROOT` at a temporary
  Claude Code projects folder.
- Node tests that start the server (`tests/js/helpers/runtime-suite.mjs`) set `ATLAS_PROJECTS_ROOT`,
  `ATLAS_CODEX_HOME`, `ATLAS_CLAUDE_SESSIONS`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` to folders inside
  the test's temporary directory.
- A new test that reads an agent folder sets these variables the same way. A test or probe that
  deletes, renames or rewrites session data works on a private copy in a temporary folder, never on
  the originals.

Codex test data is made up as well:

- `cx_*` helpers in `tests/conftest.py` build rollout lines (`cx_meta`, `cx_context`, `cx_user`,
  `cx_agent`, `cx_exec`, `cx_patch`, `cx_patch_end`, `cx_tokens`, `cx_reasoning`); the
  `write_rollout` fixture saves them as a rollout in the temporary Codex home, and
  `write_codex_state` creates a minimal `state_5.sqlite`.
- `tools/fixtures/codex_screens.json` holds Codex terminal screens (approvals, questions, busy and
  idle states) captured from codex-cli 0.160.0; the plugin's screen parser is tested against them,
  as `command_screens.json` and `dialog_screens.json` do for Claude Code. Capture new screens with a
  harmless prompt in a temporary folder and check that they contain no personal paths or text.

## Both languages for every UI string

The interface is in English and Russian. Every user-visible string goes through a dictionary, with
both languages filled in:

| Part | Dictionary | Check |
|---|---|---|
| Page | `web/js/lang-*.js` | `tests/js/i18n.test.mjs` (part of `npm test`): no Cyrillic text outside the dictionaries, every key used exists in both languages, plural forms are complete |
| Plugin | `obsidian-plugin/src/i18n.js` | The Node tests check that English and Russian have the same keys |
| Server messages | `atlas/messages.py` | `tests/test_messages.py` checks that every key has both languages |

Do not hardcode English text in code. If you do not speak Russian, add your best translation and
say so in the pull request; a reviewer will fix it.

The README has a Russian twin, `README.ru.md`. A change to one README goes into the other in the same
pull request, with the same facts and numbers.

## Personal data

The repository is public. Do not commit:

- real session transcripts, prompts, file paths or names from your own machine;
- usernames, home directory paths (`/Users/<name>`), email addresses, tokens or API keys;
- names of employers, clients, colleagues or internal ticket IDs.

Test fixtures use made-up content: `/Users/example`, `~/Code/demo-project`, `ABC-123` and so on.
Probes against a real Claude Code or Codex should use a cheap model; delete the transcripts they
create.

## Commits and pull requests

- Keep a pull request to one topic. Split unrelated changes.
- Write commit messages in English, in the imperative mood: "Fix ...", "Add ...".
- Add an entry under `## [Unreleased]` in `CHANGELOG.md` for any user-visible change.
- Describe what changed and how you tested it. For UI changes, say which macOS and Obsidian versions
  you tried.
- Before you open the pull request, run `npm run lint`, `npm test`, `npm run e2e` and
  `python3 -m pytest -q`.

## Releases

The maintainer publishes releases. The version in `manifest.json` and `package.json` is bumped,
`versions.json` maps the new version to the minimum Obsidian version, and a Git tag equal to the
manifest version (no `v` prefix) starts the release workflow. It builds `main.js`, `manifest.json`
and `styles.css`, attaches them to a GitHub release and adds build provenance attestations.
