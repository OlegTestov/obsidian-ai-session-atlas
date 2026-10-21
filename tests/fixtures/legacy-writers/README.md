# Legacy writer fixtures

Unmodified `atlas/db.py`, `index.py`, `store.py` (and the 2.4.2 `search_rows.py`) from source commits
2.4.1 (`8e51ff0`) and 2.4.2 (`f53f13e`). Tests overlay the historical writer modules on
the current package in a temporary directory and run them in a separate process.
Only the historical SQLite/index writer is under test; remaining parser/config
modules are shared. No network, installed agent CLI or user data is used.
