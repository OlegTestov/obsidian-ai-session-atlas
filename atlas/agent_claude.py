"""Claude Code file discovery and transcript reads for the catalog."""
from __future__ import annotations

import os
import sys
import time

from . import agents


def discover(root: str, codex_root: str) -> agents.Discovery:
    from . import index

    return "complete", [agents.SourceRef(agents.CLAUDE, path) for path in index.discover(root)]


def read(ref: agents.SourceRef, *, conn, title=None, subagents=(), checkpoint=None) -> agents.SourceFacts:
    from . import parse, store

    path = ref.locator
    session_id = os.path.splitext(os.path.basename(path))[0]
    if checkpoint is not None:
        facts = parse.parse_tail(path, checkpoint)
        facts.session_id, facts.source_path = session_id, path
        return agents.SourceFacts(facts)
    parent, handed_over = store.continuation_of(conn, session_id)
    facts = parse.parse_file(path, session_id, continued_from=parent, copied_until=handed_over)
    return agents.SourceFacts(facts, (parse.parse_file(p, session_id) for p in subagents))


def _index_one(conn, ref, st):
    from . import index, store

    store.store_full(conn, ref.locator, st, index._signature(ref.locator, []), [], "")


def _index_refs(conn, refs, _home, known, present, stats, full, paced, protected):
    from . import store
    from .index import (
        _changed,
        _deferred,
        _files_signature,
        _note_cost,
        _relink_continuations,
        _retry_full,
        _signature,
        discover_subagents,
    )

    for ref in refs:
        path = ref.locator
        present.add(path)
        stats["seen"] += 1
        if protected and os.path.splitext(os.path.basename(path))[0] in protected:
            continue
        try:
            st = os.stat(path)
        except FileNotFoundError:
            continue
        subagents = discover_subagents(path)
        stats["subagent_files"] += len(subagents)
        sig = _signature(path, subagents)
        if not full and not _changed(known.get(path), sig):
            stats["skipped"] += 1
            continue
        sub_sig = _files_signature(subagents)
        try:
            # An appended file is read from where the last pass stopped; otherwise in full.
            if full or known.get(path) is None \
                    or not store.store_tail(conn, path, st, sig, sub_sig):
                session_id = os.path.splitext(os.path.basename(path))[0]
                if paced and not full and known.get(path) is not None and _deferred(conn, session_id):
                    stats["deferred"] += 1        # its sources row is kept: seen as changed again
                    continue
                started = time.monotonic()
                store.store_full(conn, path, st, sig, subagents, sub_sig)
                _note_cost(conn, session_id, time.monotonic() - started)   # same transaction
                stats["full"] += 1
            else:
                stats["tail"] += 1
            conn.commit()
            stats["indexed"] += 1
        except Exception as exc:  # one unreadable transcript must not stop the pass
            conn.rollback()
            stats["errors"] += 1
            print(f"atlas index: {path}: {type(exc).__name__}: {exc}", file=sys.stderr)
            _retry_full(conn, path)
    _relink_continuations(conn, stats)
