"""User settings: `config.json` in the data folder. The plugin writes it; editing by hand also works.

Everything that differs between people lives here: where notes and projects are, which work
domains exist, what tickets look like, what is sensitive, which models to call. Without the file,
neutral defaults apply: the catalog works but knows no domains or tickets, and AI features are off.

The file is re-read when its mtime changes: the server is long-lived and settings change on the fly.
"""
from __future__ import annotations

import functools
import hashlib
import json
import os
import re
import threading
import time

DEFAULTS = {
    "language": "en",                 # language of topics, descriptions and handoffs: en | ru
    # Note folders (Obsidian vault): the folder itself is a project, its first level is an area.
    "vaults": [],                     # [{"path": "~/…", "id": "vault"}]
    # Roots whose first level is a standalone project; in containers the project is one level deeper.
    "workspace_roots": ["~/Code", "~/Projects", "~/Developer", "~/src"],
    "workspace_containers": [],       # ["~/Code/MCPs"]
    # Work domains for filters and the classifier. Empty: no domains are assigned.
    "domains": [
        {"id": "work", "description": "work for an employer or clients"},
        {"id": "projects", "description": "own products, tools and experiments"},
        {"id": "personal", "description": "personal life: health, family, money, documents"},
    ],
    "vault_domain_rules": [],         # [["Work", "work"], …]: vault area → domain
    "project_domains": {},            # {"claude-config": "tools"}: project → domain
    "sensitive": {"vault_areas": [], "projects": []},   # never sent to the model
    "ticket_prefixes": [],            # ["ABC", "OPS"] → tickets ABC-123; empty: no ticket search
    "llm_enabled": False,             # AI features spend the subscription: explicit consent only
    "models": {
        "classification": ["sonnet", "low"],
        "catalog_summary": ["sonnet", "low"],
        "handoff": ["sonnet", "medium"],
    },
    "force_1m": False,                # [1m] suffix for models without a native 1M window (not on every plan)
    "claude_bin": None,               # path to claude; the plugin finds it via the login shell
    "service_label": "io.github.session-atlas",
}

_lock = threading.Lock()
_cache = {"path": None, "mtime": None, "data": None, "checked": 0.0}
RECHECK_SECONDS = 1.0                 # path resolution reads settings thousands of times per pass


def path() -> str:
    from .db import atlas_home  # db does not depend on config: no import cycle
    return os.path.join(atlas_home(), "config.json")


def _merge(base: dict, extra: dict) -> dict:
    """Unknown top-level keys are dropped; a nested dict is merged with all its keys,
    since it can hold keys of its own (project_domains: {"claude-config": …})."""
    out = dict(base)
    for key, value in (extra or {}).items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            out[key] = dict(base[key], **value)
        elif key in base:
            out[key] = value
    return out


def load() -> dict:
    p = path()
    now = time.monotonic()
    data = _cache["data"]
    if data is not None and _cache["path"] == p and now - _cache["checked"] < RECHECK_SECONDS:
        return data
    try:
        mtime = os.stat(p).st_mtime
    except OSError:
        mtime = None
    with _lock:
        if _cache["path"] == p and _cache["mtime"] == mtime and _cache["data"] is not None:
            _cache["checked"] = now
            return _cache["data"]
        data = dict(DEFAULTS)
        if mtime is not None:
            try:
                with open(p, encoding="utf-8") as fh:
                    user = json.load(fh)
                if isinstance(user, dict):
                    data = _merge(DEFAULTS, user)
            except (OSError, ValueError):
                pass                                # broken file: use defaults
        _cache.update(path=p, mtime=mtime, data=data, checked=now)
        return data


def reset() -> None:
    """For tests: the next load() re-reads the file right away."""
    with _lock:
        _cache.update(path=None, mtime=None, data=None, checked=0.0)


def get(key: str):
    return load()[key]


def expand(p: str) -> str:
    return os.path.normpath(os.path.expanduser(p)) if p else ""


def vaults() -> list[tuple[str, str]]:
    """[(path, project id)]."""
    out = []
    for v in get("vaults") or []:
        if isinstance(v, str):
            v = {"path": v}
        if isinstance(v, dict) and v.get("path"):
            full = expand(v["path"])
            out.append((full, v.get("id") or os.path.basename(full)))
    return out


def workspace_roots() -> tuple[str, ...]:
    return tuple(expand(p) for p in (get("workspace_roots") or []) + (get("workspace_containers") or []))


def workspace_containers() -> tuple[str, ...]:
    return tuple(expand(p) for p in get("workspace_containers") or [])


def domain_ids() -> tuple[str, ...]:
    return tuple(d["id"] for d in get("domains") or [] if isinstance(d, dict) and d.get("id"))


def ticket_re():
    """Ticket regex built from the prefixes. None means no ticket search."""
    return _ticket_re(tuple(get("ticket_prefixes") or ()))


@functools.lru_cache(maxsize=8)
def _ticket_re(prefixes: tuple):
    valid = [re.escape(p) for p in prefixes if isinstance(p, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", p)]
    if not valid:
        return None
    # Alternation, not literal vertical bars. At least two digits: "ABC-1" in text
    # about prefixes is a fragment, not a ticket.
    return re.compile(r"\b(?:" + "|".join(valid) + r")-\d{2,}\b")


def index_fingerprint() -> str:
    """What the derived index depends on: when it changes, the index is rebuilt."""
    keys = ("vaults", "workspace_roots", "workspace_containers", "vault_domain_rules",
            "project_domains", "sensitive", "ticket_prefixes")
    blob = json.dumps({k: get(k) for k in keys}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]
