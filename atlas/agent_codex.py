"""Codex rollout discovery and transcript reads for the catalog."""
from __future__ import annotations

import hashlib
import os
import sys
from collections import defaultdict

from . import agents


def discover(root: str, codex_root: str) -> agents.Discovery:
    from . import index

    return "complete", [agents.SourceRef(agents.CODEX, path) for path in index.discover_codex(codex_root)]


def read(ref: agents.SourceRef, *, conn, title=None, subagents=(), checkpoint=None, rollouts=()) -> agents.SourceFacts:
    from . import codex_parse, codex_rollouts, index, store

    path = ref.locator
    parent, converted_at = store.continuation_of(conn, codex_parse.session_id_of(path) or "")
    turns: set = set()             # copied turns across segments and subagents count once
    facts = codex_parse.parse_group(path, rollouts, title=title, continued_from=parent,
                                   copied_until=converted_at, turns=turns)
    children = sorted(codex_rollouts.preferred_copies(subagents, index.codex_home()).values())
    if not facts.sensitive_location:
        facts.sensitive_location = codex_parse.sensitive_copies(set(subagents).difference(children))
    return agents.SourceFacts(facts, (codex_parse.parse_file(p, turns=turns) for p in children))


def _index_head(rollouts, saved, home):
    from . import codex_rollouts

    copies, saved = codex_rollouts.saved_copy(rollouts, saved, home)
    # An orphaned subagent remains searchable on its own, as before.
    return codex_rollouts.select(copies, saved, allow_subagent=True)


def _index_one(conn, ref, st):
    from . import codex_parse, codex_rollouts, index, store

    home = index.codex_home()
    sid = codex_parse.session_id_of(ref.locator)
    rollouts = codex_rollouts.all_rollouts(sid, home)
    selected = codex_parse.selected_paths(home, sid).get(sid)
    path = _index_head(rollouts, selected, home) or ref.locator
    siblings = [p for p in rollouts if p != path]
    subagents = index.codex_subagents(index.discover_codex(home)).get(path, [])
    title = codex_parse.thread_titles(home, (sid,)).get(sid) if sid else None
    store.store_codex(conn, path, st if path == ref.locator else os.stat(path),
                     _codex_signature(path, title, siblings + subagents), title, subagents, rollouts=siblings)


def _codex_signature(path: str, title: str | None, files=()) -> str:
    """File changes and renames in Codex both invalidate the grouped row."""
    from . import codex_parse
    from .index import _signature

    sig = _signature(path, files, include_ctime=True) + f"|p:{codex_parse.PARSE_VERSION}"
    return sig + ("|t:" + hashlib.sha1(title.encode()).hexdigest()[:12] if title else "")


def _index_refs(conn, refs, home, known, present, stats, full, _paced, protected):
    from . import codex_parse, store
    from .index import _changed, _retry_full, codex_subagents

    paths_ = [ref.locator for ref in refs]
    if not paths_:
        return
    children = codex_subagents(paths_)
    folded = {p for subs in children.values() for p in subs}
    threads = defaultdict(list)
    for path in paths_:
        sid = codex_parse.session_id_of(path)
        if path not in folded:
            threads[sid].append(path)
    titles = codex_parse.thread_titles(home, threads)
    selected = codex_parse.selected_paths(home)
    previous = defaultdict(list)
    for path, row in known.items():
        previous[row["session_id"]].append(path)
    for sid, rollouts in threads.items():
        if sid in protected:
            continue
        path = _index_head(rollouts, selected.get(sid), home)
        if not path:
            continue
        present.add(path)
        stats["seen"] += 1
        stats["codex"] += 1
        title = titles.get(sid)
        subagents = children.get(path, [])
        siblings = [p for p in rollouts if p != path]
        stats["subagent_files"] += len(subagents)
        sig = _codex_signature(path, title, siblings + subagents)
        if not full and not _changed(known.get(path), sig):
            stats["skipped"] += 1
            continue
        try:
            store.store_codex(conn, path, os.stat(path), sig, title, subagents, rollouts=siblings)
            conn.commit()
            stats["full"] += 1
            stats["indexed"] += 1
        except Exception as exc:  # one unreadable rollout must not stop the pass
            conn.rollback()
            present.update(previous[sid])
            stats["errors"] += 1
            print(f"atlas index: {path}: {type(exc).__name__}: {exc}", file=sys.stderr)
            _retry_full(conn, path)
