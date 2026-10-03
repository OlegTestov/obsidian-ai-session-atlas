# Security policy

## Supported versions

Security fixes go into the latest release only. Update to the
[latest release](https://github.com/OlegTestov/obsidian-session-atlas/releases/latest) before you
report a problem.

| Version | Supported |
|---|---|
| 2.0.x | Yes |
| Older | No |

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:

1. Open the [Security tab](https://github.com/OlegTestov/obsidian-session-atlas/security) of the
   repository.
2. Choose **Report a vulnerability**. This creates a private security advisory that only you and the
   maintainer can see.

Do not open a public issue, pull request or discussion for a vulnerability. Include the plugin
version, macOS and Obsidian versions, steps to reproduce, and what an attacker could do.

The maintainer replies in the advisory. After a fix is released, the advisory is published with
credit to you unless you ask otherwise.

## Scope

Session Atlas runs a local HTTP server and executes commands on your Mac, so these are in scope:

- **The local server** (`atlas/server.py`). It binds to `127.0.0.1` only. A loopback address is not
  treated as a trust boundary, because any web page in a browser can send requests to it. The server
  therefore checks:
  - the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding;
  - an `Origin` header, when present, must be the server's own origin;
  - every `POST` request must carry an `Origin` header and an `X-Atlas-Token` header equal to the
    CSRF token. The token is random, stored in a file only the user can read, and inserted only into
    the HTML of the page the server itself serves, never into its scripts;
  - the page is sent with a Content-Security-Policy that allows only scripts and styles with a
    per-response nonce, no external resources, and embedding only in itself and in Obsidian;
  - static files are served only from the page folder, by simple names without paths;
  - request bodies are limited in size, session IDs must have the UUID format, the folder for a new
    session must come from the server's own list, and a handoff can be exported only to an allowed
    list of folders;
  - requests that call a model are refused while AI features are off, and sending a session to a
    model needs an explicit confirmation, recorded for the session's current content.
- **The bridge between the page and the plugin.** The plugin accepts messages only from the
  server's origin, accepts only known message types, parses terminal commands from the page against
  a strict pattern, and acts only on its own terminal tabs.
- **Destructive actions:** deleting a session, editing `~/.claude/settings.json` for the status line,
  stopping a Claude Code process to move it into Obsidian.
- **The release build:** `main.js` embeds the server and the tab scripts and unpacks them into
  `~/Library/Application Support/session-atlas/runtime/`.

Out of scope:

- Problems in Claude Code, Codex, Obsidian, Python or macOS themselves. Report those to their
  vendors.
- Attacks that need code already running as your user on the Mac. Such code can read your sessions
  without Session Atlas.
- What the optional AI features send to Anthropic after you confirm the preview. That is the
  documented behaviour; see "Disclosures" in the [README](README.md#disclosures).
