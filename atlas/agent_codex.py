"""Codex rollout discovery and transcript reads for the catalog."""
from __future__ import annotations

import hashlib
import os
import sys

from . import agents


def discover(root: str, codex_root: str) -> agents.Discovery:
    from . import index

    # A missing home has always been an empty scan, including removal of vanished rollouts.
    return "complete", [agents.SourceRef(agents.CODEX, path) for path in index.discover_codex(codex_root)]


def read(ref: agents.SourceRef, *, conn, title=None, subagents=(), checkpoint=None) -> agents.SourceFacts:
    from . import codex_parse, store

    path = ref.locator
    parent, converted_at = store.continuation_of(conn, codex_parse.session_id_of(path) or "")
    turns: set = set()             # a subagent's copy of its parent's turns is counted once, there
    facts = codex_parse.parse_file(path, title=title, continued_from=parent, copied_until=converted_at,
                                  turns=turns)
    return agents.SourceFacts(facts, (codex_parse.parse_file(p, turns=turns) for p in subagents))


def _index_one(conn, ref, st):
    from . import store

    store.store_codex(conn, ref.locator, st, _codex_signature(ref.locator, None))


def _codex_signature(path: str, title: str | None) -> str:
    """A rename in Codex changes only its state database: the title is part of the signature."""
    from . import codex_parse
    from .index import _signature

    sig = _signature(path, []) + f"|p:{codex_parse.PARSE_VERSION}"     # a parser change rereads them once
    return sig + ("|t:" + hashlib.sha1(title.encode()).hexdigest()[:12] if title else "")


def _index_refs(conn, refs, home, known, present, stats, full, _paced, protected):
    from . import codex_parse, store
    from .index import _changed, _files_signature, _retry_full, codex_subagents

    paths_ = [ref.locator for ref in refs]
    if not paths_:
        return
    ids = {path: codex_parse.session_id_of(path) for path in paths_}
    titles = codex_parse.thread_titles(home, (sid for sid in ids.values() if sid is not None))
    children = codex_subagents(paths_)
    folded = {p for subs in children.values() for p in subs}
    for path in paths_:
        if path in folded:
            continue             # part of its root thread's session; a row of its own is purged below
        present.add(path)
        stats["seen"] += 1
        stats["codex"] += 1
        if ids[path] in protected:
            continue
        try:
            st = os.stat(path)
        except FileNotFoundError:
            continue
        title = titles.get(ids[path] or "")
        subagents = children.get(path, [])
        stats["subagent_files"] += len(subagents)
        sig = _codex_signature(path, title) + ("|s:" + _files_signature(subagents) if subagents else "")
        if not full and not _changed(known.get(path), sig):
            stats["skipped"] += 1
            continue
        try:
            store.store_codex(conn, path, st, sig, title, subagents)
            conn.commit()
            stats["full"] += 1
            stats["indexed"] += 1
        except Exception as exc:  # one unreadable rollout must not stop the pass
            conn.rollback()
            stats["errors"] += 1
            print(f"atlas index: {path}: {type(exc).__name__}: {exc}", file=sys.stderr)
            _retry_full(conn, path)
