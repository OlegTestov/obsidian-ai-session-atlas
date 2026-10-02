# Contributing

- Runtime code stays dependency-free: Python 3.9 standard library for the server, plain JavaScript for
  the page and the plugin. Test-only tools (pytest, node) are fine.
- Every change comes with a test that fails without it; `tools/mutations.py` checks that tests catch
  broken code.
- Every user-visible string goes through the dictionaries (`web/js/lang-*.js`,
  `obsidian-plugin/src/i18n.js`) in both English and Russian; `node tools/check_i18n.js` must pass.
- Probes against a live Claude Code: run them on a cheap model, and delete the transcripts they create.

```bash
.venv/bin/python -m pytest -q && node tools/check_i18n.js && python3 tools/build.py --out dist
```
