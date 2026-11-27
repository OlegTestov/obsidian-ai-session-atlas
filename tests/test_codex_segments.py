"""Paginated Codex rollouts: live identity, selected history and catalog history."""
from __future__ import annotations

import json
import os
import sqlite3
import statistics
import subprocess
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlencode

import pytest

from atlas import (
    active,
    activity,
    agents,
    codex_feed,
    codex_live,
    codex_parse,
    codex_procs,
    codex_rollouts,
    codex_skills,
    codex_tail,
    convert_read,
    delete,
    feed,
    index,
    relocate,
)
from tests.conftest import cx, cx_agent, cx_meta, cx_tokens, cx_user, write_codex_state
from tests.test_codex_active import CODEX, SUB, TID, FakeLsof, _cards, _conn, claude_dir as claude_dir, table

A = "019e0000-aaaa-7000-8000-000000000011"
B = "019e0000-aaaa-7000-8000-000000000012"
C = "019e0000-aaaa-7000-8000-000000000013"
NEIGHBOR = "019e0000-aaaa-7000-8000-000000000002"


def turn(name, minute, key=None):
    stamp = f"2026-09-01T10:{minute:02}"
    return [
        cx("event_msg", {"type": "task_started", "turn_id": key or name}, f"{stamp}:01Z"),
        cx_user(name, ts=f"{stamp}:02Z"),
        cx_agent(f"reply {name}", ts=f"{stamp}:03Z"),
        cx_tokens(120, 100, minute, ts=f"{stamp}:04Z"),
        cx("event_msg", {"type": "task_complete", "turn_id": key or name}, f"{stamp}:05Z"),
    ]


def size(lines):
    return len("".join(lines).encode())


def base_ref(physical, offset):
    return {"thread_id": physical, "end_byte_offset": offset, "end_ordinal_exclusive": 0}


@pytest.fixture
def rollout(write_rollout):
    def write(*lines, tid=TID, segment=None, parent=None, history=None, archived=False, cwd=None, branch=None):
        metadata = {}
        if cwd is not None:
            metadata["cwd"] = cwd
        if branch is not None:
            metadata["git"] = {"branch": branch}
        if parent:
            metadata.update(thread_source="subagent", parent_thread_id=parent)
        if history:
            metadata["history_base"] = history
        payload = json.loads(cx_meta(tid))["payload"]
        payload.update(metadata)
        path = write_rollout([cx("session_meta", payload), *lines],
                             thread_id=f"{tid}_{segment}" if segment else tid, archived=archived)
        return path
    return write


@pytest.mark.parametrize("command, children", [(CODEX, 0), (CODEX, 3), (f"{CODEX} resume {TID}", 0)])
def test_segment_live_card_keeps_the_human_thread(atlas_env, codex_home, claude_dir, rollout, command, children):
    human = rollout(*turn("human", 1), segment=A)
    others = [rollout(tid=tid, parent=TID) for tid in (SUB, B, C)[:children]]
    os.utime(human, (1, 1))
    write_codex_state(codex_home, {TID: ("Automatic", "Thread title")})
    fake = FakeLsof({101: [human, *others]})
    t = table((101, command))
    assert codex_procs.rollouts_for(t, run=fake, fresh=True) == {101: human}
    card, = _cards(atlas_env, claude_dir, t, fake)
    assert (card["session_id"], card["title"], card.get("pending")) == (TID, "Thread title", None)
    assert feed.feed_page(human)["turns"][0]["prompt"] == "human"


def test_only_suffixed_subagents_follow_root_or_stay_pending(atlas_env, claude_dir, rollout):
    root = rollout(*turn("root", 1))
    parent = rollout(tid=SUB, segment=A, parent=TID)
    child = rollout(tid=NEIGHBOR, segment=B, parent=SUB)
    t = table((101, CODEX))
    fake = FakeLsof({101: [child]})
    assert codex_procs.rollouts_for(t, run=fake, fresh=True) == {101: root}
    assert codex_procs.find_rollout(NEIGHBOR) is None
    os.remove(root)
    assert codex_procs.rollouts_for(t, run=fake, fresh=True) == {}
    card, = _cards(atlas_env, claude_dir, t, fake)
    assert card["pending"] and card["session_id"] not in (SUB, NEIGHBOR)
    assert Path(parent).exists()


def test_segment_lineage_pagination_deduplication_and_tail(rollout):
    prefix = [cx_meta(TID), *turn("old", 1), *turn("duplicate old", 2, "duplicate")]
    rollout(*prefix[1:], *turn("excluded", 3))
    head = rollout(*turn("duplicate new", 4, "duplicate"), *turn("latest", 5),
                   segment=A, history=base_ref(TID, size(prefix) + 2))
    last = feed.feed_page(head, turns=1, with_events=True, full_text=True)
    assert [t["prompt"] for t in last["turns"]] == ["latest"] and last["has_more"]
    mid = feed.feed_page(head, turns=1, before_id=last["turns"][0]["id"])
    assert [t["prompt"] for t in mid["turns"]] == ["duplicate new"] and mid["has_more"]
    first = feed.feed_page(head, before_id=mid["turns"][0]["id"])
    assert [t["prompt"] for t in first["turns"]] == ["old"] and not first["has_more"]
    for cursor in ({"since_id": first["turns"][0]["id"]}, {"since": first["turns"][0]["prompt_at"]}):
        assert [t["prompt"] for t in feed.feed_page(head, **cursor)["turns"]] == [
            "old", "duplicate new", "latest"]
    assert [t["prompt"] for t in feed.feed_page(head, before=mid["turns"][0]["prompt_at"])["turns"]] == ["old"]
    empty = rollout(segment=B, history=base_ref(TID, size(prefix[:6])))
    assert codex_tail.read(empty)["reply"] == "reply old"
    assert active.last_messages(empty)["last_at"] == "2026-09-01T10:01:03Z"
    assert [i["text"] for i in convert_read.read_codex(head, TID).items if i["role"] == "user"] == [
        "old", "duplicate new", "latest"]


def test_nested_lineage_with_archived_ancestor_and_missing_reference(rollout):
    root = rollout(*turn("root", 1), archived=True)
    retained = turn("retained", 2)
    mid = rollout(*retained, *turn("discarded", 3), segment=A,
                  history=base_ref(TID, os.path.getsize(root) + 100))
    first = Path(mid).read_bytes().splitlines(keepends=True)[0]
    head = rollout(*turn("head", 4), segment=B, history=base_ref(A, len(first) + size(retained)))
    page = feed.feed_page(head, turns=1)
    middle = feed.feed_page(head, turns=1, before_id=page["turns"][0]["id"])
    older = feed.feed_page(head, turns=1, before_id=middle["turns"][0]["id"])
    assert [x["turns"][0]["prompt"] for x in (older, middle, page)] == ["root", "retained", "head"]
    assert not older["has_more"]
    os.remove(root)
    assert [t["prompt"] for t in feed.feed_page(head)["turns"]] == ["retained", "head"]


def test_cycle_stops_at_the_first_repeated_physical_rollout(rollout):
    head = rollout(*turn("head", 1), segment=A, history=base_ref(B, 10000))
    prior = rollout(*turn("ancestor", 2), segment=B, history=base_ref(A, 10000))
    assert [part.path for part in codex_rollouts.lineage(head)] == [prior, head]
    assert [t["prompt"] for t in feed.feed_page(head)["turns"]] == ["ancestor", "head"]


def test_skills_in_an_ancestor_are_available_after_revert(codex_home, rollout):
    developer = cx("response_item", {"type": "message", "role": "developer", "content": [
        {"type": "input_text", "text": "### Available skills\n- review: Review changes (file: /a/review/SKILL.md)"}
    ]})
    base = rollout(developer)
    head = rollout(segment=A, history=base_ref(TID, os.path.getsize(base)))
    os.utime(base, (1, 1))
    os.utime(head, (2, 2))
    assert codex_skills.available(codex_home, []) == [{"name": "review", "description": "Review changes"}]


def test_selected_sqlite_rollout_and_live_writer_precedence(atlas_env, codex_home, rollout):
    base = rollout(*turn("base", 1))
    old = rollout(*turn("selected", 2), segment=A)
    new = rollout(*turn("writer", 3), segment=B)
    os.utime(base, (1, 1))
    os.utime(old, (2, 2))
    os.utime(new, (3, 3))
    state = write_codex_state(codex_home, {TID: (None, None)})
    with sqlite3.connect(state) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("UPDATE threads SET rollout_path=? WHERE id=?", (old, TID))
        writer.commit()
        assert codex_procs.find_rollout(TID) == old
        t = table((101, CODEX))
        assert codex_procs.rollouts_for(t, run=FakeLsof({101: [new]}), fresh=True) == {101: new}
        assert active.live_transcript(_conn(atlas_env), TID) == new
        writer.execute("UPDATE threads SET rollout_path=? WHERE id=?", (base, TID))
        writer.commit()
        assert codex_procs.find_rollout(TID) == base


def test_index_groups_siblings_migrates_source_and_delete_covers_archive(atlas_env, rollout, monkeypatch):
    original = rollout(*turn("rootword", 1), *turn("rootextra", 2))
    neighbor = rollout(*turn("neighborword", 3), tid=NEIGHBOR)
    conn = _conn(atlas_env)
    index.index_all(conn)
    assert codex_procs.find_rollout(TID) == original
    archived = rollout(*turn("siblingword", 4), segment=A, archived=True,
                       history=base_ref(TID, os.path.getsize(original)))
    head = rollout(*turn("headword", 5), *turn("rootduplicate", 6, "rootword"), segment=B,
                   history=base_ref(TID, size([cx_meta(TID), *turn("rootword", 1)])),
                   cwd=str(atlas_env["home"]))
    sub = rollout(*turn("childword", 7), tid=SUB, segment=C, parent=TID)
    os.utime(original, (1, 1))
    os.utime(archived, (2, 2))
    os.utime(head, (3, 3))
    assert codex_parse.rollout_ids(head) == (TID, B)
    assert codex_procs.all_rollouts(TID) == sorted([original, archived, head])
    assert codex_procs.find_rollout(TID) == head
    t = table((101, CODEX))
    assert codex_procs.move_owner(101, TID, t, FakeLsof({101: [head]})) == (head, False)
    for _ in range(2):
        result = index.index_all(conn)
        assert result["errors"] == 0
        assert sorted(tuple(r) for r in conn.execute("SELECT session_id,source_path FROM sessions")) == [
            (TID, head), (NEIGHBOR, neighbor)]
        assert conn.execute("SELECT COUNT(*) FROM sources WHERE session_id=?", (TID,)).fetchone()[0] == 1
        for word in ("rootword", "rootextra", "siblingword", "headword", "childword"):
            row, = conn.execute("SELECT DISTINCT session_id FROM fts WHERE fts MATCH ?", (word,))
            assert row[0] == TID
        assert conn.execute("SELECT human_turns FROM sessions WHERE session_id=?", (TID,)).fetchone()[0] == 4
        answers, = conn.execute("SELECT COUNT(*) FROM activity WHERE session_id=? AND kind=?",
                                (TID, activity.ANSWER)).fetchone()
        assert answers == 5
    monkeypatch.setattr(active, "process_table", lambda: {})
    result = delete.delete_session(conn, TID)
    assert result["removed"] == 4
    assert not any(Path(p).exists() for p in (original, archived, head, sub))
    assert Path(neighbor).exists()
    assert agents.session_agent(conn, TID) is None


def test_live_head_prefers_writable_descriptor_to_newer_reader(rollout):
    writer = rollout(*turn("writer", 1), segment=A)
    reader = rollout(*turn("reader", 2), segment=B)
    os.utime(writer, (1, 1))
    os.utime(reader, (2, 2))

    def lsof(cmd, **_):
        fields = cmd[cmd.index("-F") + 1]
        writable, readonly = ("au\n", "ar\n") if "a" in fields else ("", "")
        # Multiple descriptors for one path can be reported in either order.
        stdout = f"p101\nf10\n{writable}n{writer}\nf11\n{readonly}n{writer}\nf12\n{readonly}n{reader}\n"
        return subprocess.CompletedProcess(cmd, 0, stdout, "")

    processes = table((101, f"{CODEX} resume {TID}"))
    assert codex_procs.rollouts_for(processes, run=lsof, fresh=True) == {101: writer}
    assert codex_procs.owner_rollout(101, TID, processes, run=lsof) == writer


def test_pending_replacement_supersedes_excerpt_prompt_and_tail_reply(rollout):
    contents = [*turn("retained", 1), *turn("superseded", 2, "shared")]
    base = rollout(*contents)
    head = rollout(cx_user("replacement", ts="2026-09-01T10:03:00Z"),
                   cx("event_msg", {"type": "task_started", "turn_id": "shared"}, "2026-09-01T10:03:01Z"),
                   segment=A, history=base_ref(TID, os.path.getsize(base)))
    os.utime(base, (1, 1))
    os.utime(head, (2, 2))
    facts = codex_parse.parse_lineage(head, TID)
    assert facts.user_text == ["retained", "replacement"]
    assert facts.assistant_text == ["reply retained"]


def test_card_tail_skips_the_pending_turns_superseded_reply(rollout):
    contents = [*turn("retained", 1), *turn("superseded", 2, "shared")]
    base = rollout(*contents)
    head = rollout(cx_user("replacement", ts="2026-09-01T10:03:00Z"),
                   cx("event_msg", {"type": "task_started", "turn_id": "shared"}, "2026-09-01T10:03:01Z"),
                   segment=A, history=base_ref(TID, os.path.getsize(base)))
    tail = codex_tail.read(head)
    assert (tail["status"], tail["prompt"], tail["reply"]) == ("busy", "replacement", "reply retained")


def test_index_metadata_follows_sqlite_selection_while_fts_and_stats_include_siblings(atlas_env, codex_home,
                                                                                   rollout):
    base = rollout(*turn("retained", 1), cwd="/base", branch="base")
    head = rollout(*turn("selected", 2), segment=A, history=base_ref(TID, os.path.getsize(base)),
                   cwd="/selected", branch="selected-branch")
    rollout(*turn("abandoned", 3), segment=B, cwd="/abandoned", branch="abandoned-branch")
    state = write_codex_state(codex_home, {TID: (None, None)})
    with sqlite3.connect(state) as writer:
        writer.execute("UPDATE threads SET rollout_path=? WHERE id=?", (head, TID))
    conn = _conn(atlas_env)
    assert index.index_all(conn)["errors"] == 0
    row = conn.execute("SELECT source_path, last_prompt, cwd_last, branch_last, last_activity_at, human_turns "
                       "FROM sessions WHERE session_id=?", (TID,)).fetchone()
    assert tuple(row) == (head, "selected", "/selected", "selected-branch", "2026-09-01T10:02:05Z", 3)
    assert conn.execute("SELECT DISTINCT session_id FROM fts WHERE fts MATCH 'abandoned'").fetchone()[0] == TID


def test_index_prefers_one_live_physical_copy_even_if_sqlite_points_to_the_archive(atlas_env, codex_home, rollout):
    records = [cx_user("physical prompt"), cx_agent("physical reply")]
    live = rollout(*records)
    archive = rollout(*records, archived=True)
    os.utime(live, (10, 10))
    os.utime(archive, (10, 10))
    state = write_codex_state(codex_home, {TID: (None, None)})
    with sqlite3.connect(state) as writer:
        writer.execute("UPDATE threads SET rollout_path=? WHERE id=?", (archive, TID))
    conn = _conn(atlas_env)
    assert index.index_all(conn)["errors"] == 0
    row = conn.execute("SELECT source_path, human_turns, machine_turns FROM sessions WHERE session_id=?",
                       (TID,)).fetchone()
    assert tuple(row) == (live, 1, 1)
    assert len(list(conn.execute("SELECT rowid FROM fts WHERE fts MATCH 'physical' AND turn >= 0"))) == 1
    assert set(codex_procs.all_rollouts(TID)) == {live, archive}


def test_same_inode_rewrite_invalidates_history_meta(rollout):
    base = rollout(*turn("before repair", 1))
    head = rollout(*turn("segment", 2), segment=A, history=base_ref(TID, os.path.getsize(base)))
    assert [t["prompt"] for t in feed.feed_page(head)["turns"]] == ["before repair", "segment"]
    old = os.stat(head)
    raw = Path(head).read_bytes()
    repaired = raw.replace(str(os.path.getsize(base)).encode(), b"0", 1)
    assert repaired != raw
    Path(head).write_bytes(repaired)
    os.utime(head, ns=(old.st_atime_ns, old.st_mtime_ns))
    assert os.stat(head).st_ino == old.st_ino
    assert [t["prompt"] for t in feed.feed_page(head)["turns"]] == ["segment"]


def test_tail_cache_does_not_reread_oversized_partial_line(rollout, monkeypatch):
    base = rollout(*turn("finished", 1))
    with open(base, "ab") as out:
        out.write(b"x" * (60 * 1024 * 1024))
    head = rollout(segment=A, history=base_ref(TID, os.path.getsize(base) + 500))
    opened = []
    real_open = open

    def observe(path, *args, **kwargs):
        if path == base:
            opened.append(path)
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(codex_rollouts, "open", observe, raising=False)
    assert codex_tail.read(head)["reply"] == "reply finished"
    opened.clear()
    assert codex_tail.read(head)["reply"] == "reply finished"
    assert opened == []


def test_live_subagents_count_threads_instead_of_open_physical_files(rollout):
    human = rollout(*turn("root", 1))
    child = rollout(tid=SUB, parent=TID)
    segment = rollout(tid=SUB, segment=A, parent=TID)
    other = rollout(tid=NEIGHBOR, parent=TID)
    processes = table((101, CODEX))
    assert codex_procs.rollouts_for(processes, run=FakeLsof({101: [human, child, segment, other]}),
                                    fresh=True) == {101: human}
    assert codex_live.live_subagents(101, processes, TID) == 2


@pytest.fixture
def large_lineage(rollout):
    base = rollout()
    bulk = cx("response_item", {"type": "reasoning", "text": "x" * (1024 * 1024 - 400)})
    with open(base, "a", encoding="utf-8") as out:
        for n in range(60):
            out.write(bulk)
            out.writelines(turn(f"base-{n}", n))
        for n in range(35):
            out.writelines(turn(f"recent-{n}", n))
        out.write(cx("event_msg", {"type": "patch_apply_end", "changes": {"old.txt": {"type": "add"}}}))
    cutoff = os.path.getsize(base)
    head = rollout(*turn("head", 59), segment=A, history=base_ref(TID, cutoff))
    conventional = rollout(tid=NEIGHBOR)
    Path(conventional).write_bytes(Path(base).read_bytes() + b"".join(
        line.encode() for line in turn("head", 59)))
    assert 60 * 1024 * 1024 <= cutoff < 61 * 1024 * 1024
    return base, head, conventional


def test_segmented_refresh_reuses_the_same_ancestor_after_head_appends(large_lineage, monkeypatch):
    base, head, _ = large_lineage
    cursor = feed.feed_page(head)["turns"][-1]["id"]
    assert codex_feed.session_files(head)["files"][0]["path"] == "old.txt"
    with open(head, "a", encoding="utf-8") as out:
        out.writelines(turn("appended", 59))
    scanned = []
    real_lines = codex_rollouts.lines

    def observe(part):
        if part.path == base:
            scanned.append(part.path)
        return real_lines(part)

    monkeypatch.setattr(codex_rollouts, "lines", observe)
    assert [t["prompt"] for t in feed.feed_page(head, since_id=cursor)["turns"]] == ["head", "appended"]
    assert feed.feed_page(head, with_events=True)["turns"][-1]["prompt"] == "appended"
    assert codex_feed.session_files(head)["files"][0]["path"] == "old.txt"
    assert scanned == []


@pytest.mark.parametrize("refresh", ["first", "since_id"])
def test_warm_segmented_feed_within_twice_conventional_file(large_lineage, refresh):
    _, head, conventional = large_lineage

    def request_for(path):
        cursor = feed.feed_page(path)["turns"][-1]["id"]
        params = {"since_id": cursor} if refresh == "since_id" else {}
        return lambda: feed.feed_page(path, **params)

    segmented, single = request_for(head), request_for(conventional)
    got, expected = segmented(), single()
    assert got["has_more"] == expected["has_more"]
    assert [{k: v for k, v in t.items() if k != "id"} for t in got["turns"]] == [
        {k: v for k, v in t.items() if k != "id"} for t in expected["turns"]]
    samples = [[], []]
    for _ in range(11):
        for request, measurements in zip((segmented, single), samples):
            start = time.perf_counter()
            request()
            measurements.append((time.perf_counter() - start) * 1000)
    seg_ms, single_ms = map(statistics.median, samples)
    print(f"{refresh}: segmented {seg_ms:.3f} ms, conventional {single_ms:.3f} ms ({seg_ms / single_ms:.2f}×)")
    assert seg_ms <= 2 * single_ms


@pytest.mark.parametrize("reverse", [False, True])
def test_latest_writer_supersedes_resume_argv_and_all_descriptors_protect_delete(rollout, reverse):
    a = rollout(*turn("original", 1))
    b = rollout(*turn("switched", 2), tid=NEIGHBOR, segment=B)
    os.utime(a, (10, 10))
    os.utime(b, (20, 20))
    processes = table((101, f"{CODEX} resume {TID}"))

    def lsof(cmd, **_):
        files = [b, a] if reverse else [a, b]
        return subprocess.CompletedProcess(cmd, 0, "p101\n" + "".join(
            f"f{fd}\nau\nn{path}\n" for fd, path in enumerate(files, 10)), "")

    assert codex_procs.rollouts_for(processes, run=lsof, fresh=True) == {101: b}
    assert not codex_procs.owner(101, TID, processes, run=lsof)
    assert codex_procs.owner(101, NEIGHBOR, processes, run=lsof)
    assert codex_procs.running(TID, processes, run=lsof)
    os.utime(a, (20, 20))
    assert codex_procs.rollouts_for(processes, run=lsof, fresh=True) == {101: a}


@pytest.mark.parametrize("where", ["sibling", "child", "content", "duplicate"])
def test_any_rollout_sensitivity_survives_selected_metadata(atlas_env, codex_home, rollout, where, monkeypatch):
    from atlas import autoclassify, runner
    from tests.conftest import NOTES

    base = rollout(*turn("public work", 1), cwd="/public")
    private = str(Path(NOTES) / "Personal")
    head = rollout(*turn("selected", 2), segment=A, cwd="/public",
                   history=base_ref(TID, os.path.getsize(base)))
    if where == "sibling":
        rollout(*turn("sibling ABC-441", 3), segment=B, cwd=private)
    elif where == "child":
        rollout(*turn("child ABC-441", 3), tid=SUB, parent=TID, cwd=private)
    elif where == "duplicate":
        duplicate = rollout(archived=True, cwd=private)
        assert os.path.getsize(duplicate) < os.path.getsize(base)
    else:
        patch = cx("event_msg", {"type": "patch_apply_end", "changes": {
            str(Path(private) / "private.txt"): {"type": "add"}}})
        rollout(*turn("patch ABC-441", 3), patch, segment=B, cwd="/public")
    state = write_codex_state(codex_home, {TID: (None, None)})
    with sqlite3.connect(state) as writer:
        writer.execute("UPDATE threads SET rollout_path=? WHERE id=?", (head, TID))
    conn = _conn(atlas_env)
    assert index.index_all(conn)["errors"] == 0
    assert conn.execute("SELECT cwd_last FROM sessions WHERE session_id=?", (TID,)).fetchone()[0] == "/public"
    assert runner.sensitivity_of(conn, TID) == "sensitive"
    assert TID not in dict(autoclassify.candidates(conn))
    monkeypatch.setattr(runner.codex_app, "find_codex", lambda: "/synthetic/codex")
    assert runner.artifact_fallback(runner.CLAUDE_BACKEND, runner.sensitivity_of(conn, TID)) is None
    with pytest.raises(runner.EgressDenied):
        runner.check_egress(conn, TID, "synthetic", "catalog_summary", runner.CODEX_BACKEND, "synthetic")


def test_complete_physical_copy_is_used_by_index_and_lineage(atlas_env, rollout):
    live_lines = turn("in both copies", 1)
    live = rollout(*live_lines)
    archive = rollout(*live_lines, *turn("archiveextra", 2), archived=True)
    os.utime(live, (20, 20))
    os.utime(archive, (10, 10))
    assert codex_procs.find_rollout(TID) == archive
    head = rollout(*turn("head", 3), segment=A, history=base_ref(TID, os.path.getsize(archive)))
    assert codex_rollouts.lineage(head)[0].path == archive
    conn = _conn(atlas_env)
    assert index.index_all(conn)["errors"] == 0
    assert conn.execute("SELECT human_turns FROM sessions WHERE session_id=?", (TID,)).fetchone()[0] == 3
    assert conn.execute("SELECT DISTINCT session_id FROM fts WHERE fts MATCH 'archiveextra'").fetchone()[0] == TID
    Path(live).write_bytes(Path(archive).read_bytes())
    os.utime(archive, (10, 10))
    os.utime(live, (20, 20))
    assert codex_rollouts.lineage(head)[0].path == live


def test_conventional_cursor_survives_the_first_segment(rollout):
    base = rollout(*turn("earlier", 1), *turn("retained", 2))
    cursor = feed.feed_page(base)["turns"][-1]["id"]
    head = rollout(*turn("segment", 3), segment=A, history=base_ref(TID, os.path.getsize(base)))
    assert [t["prompt"] for t in feed.feed_page(head, before_id=cursor)["turns"]] == ["earlier"]
    after = feed.feed_page(head, since_id=cursor)
    assert not after.get("reset")
    retained = after["turns"][0]
    assert (retained["prompt"], retained["id"]) == ("retained", cursor)
    page = feed.feed_page(head, before_id="missing", before=retained["prompt_at"])
    assert [t["prompt"] for t in page["turns"]] == ["earlier"]


def test_feed_distinguishes_a_changed_history_from_a_missing_cursor(rollout):
    kept = turn("kept", 1)
    base = rollout(*kept, *turn("reverted", 2), *turn("previous latest", 3))
    page = feed.feed_page(base, turns=1)
    history = page.get("history")
    assert history
    cursor = page["turns"][0]["id"]
    older = feed.feed_page(base, turns=1, before_id=cursor, history=history)
    assert older["history"] == history

    with open(base, "a") as fh:
        fh.writelines(turn("appended", 4))
    append = feed.feed_page(base, since_id=cursor, history=history)
    assert not append.get("history_changed")
    assert [t["prompt"] for t in append["turns"]] == ["previous latest", "appended"]
    missing = feed.feed_page(base, since_id="missing", history=append["history"])
    assert missing["reset"] is True and not missing.get("history_changed")

    cutoff = size([cx_meta(TID), *kept])
    retained = feed.feed_page(base)["turns"][0]["id"]
    reasoning = cx("response_item", {"type": "reasoning", "summary": "x" * os.path.getsize(base)})
    head = rollout(*turn("replacement", 5), reasoning, segment=A, history=base_ref(TID, cutoff))
    for anchor in ({"since_id": cursor}, {"before_id": cursor}, {"since_id": retained}):
        rewound = feed.feed_page(head, turns=1, history=append["history"], **anchor)
        assert rewound["history_changed"] is True and rewound["has_more"] is True
        assert [t["prompt"] for t in rewound["turns"]] == ["replacement"]
        older = feed.feed_page(head, before_id=rewound["turns"][0]["id"], history=rewound["history"])
        assert [t["prompt"] for t in older["turns"]] == ["kept"]

    os.truncate(base, cutoff)
    shortened = feed.feed_page(base, since_id=cursor, history=append["history"])
    assert shortened["history_changed"] is True
    assert [t["prompt"] for t in shortened["turns"]] == ["kept"]


def test_active_feed_round_trips_codex_history(rollout, live_server, monkeypatch):
    kept = turn("kept", 1)
    selected = rollout(*kept, *turn("reverted", 2))
    monkeypatch.setattr(active, "live_transcript", lambda *_: selected)
    base, _ = live_server

    def page(**params):
        with urllib.request.urlopen(f"{base}/api/active/feed/{TID}?{urlencode(params)}", timeout=5) as response:
            return json.load(response)

    first = page(view="turns")
    selected = rollout(*turn("replacement", 3), segment=A, history=base_ref(TID, size([cx_meta(TID), *kept])))
    rewound = page(view="turns", history=first["history"], since_id=first["turns"][0]["id"])
    assert rewound["history_changed"] is True
    assert [t["prompt"] for t in rewound["turns"]] == ["kept", "replacement"]


def test_equal_size_ctime_repairs_invalidate_meta_and_projection(rollout):
    lines = turn("first version", 1)
    base = rollout(*lines, *turn("tail", 2))
    cutoff = size([cx_meta(TID), *lines])
    head = rollout(*turn("head", 3), segment=A, history=base_ref(TID, cutoff))
    before = feed.feed_page(head)
    assert before["turns"][0]["prompt"] == "first version"

    def repair(path, old, new):
        stat = os.stat(path)
        data = Path(path).read_bytes()
        Path(path).write_bytes(data.replace(old, new))
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        assert os.stat(path).st_size == stat.st_size

    repair(base, b"first version", b"fixed version")
    assert feed.feed_page(head)["turns"][0]["prompt"] == "fixed version"
    repair(head, str(cutoff).encode(), str(os.path.getsize(base)).encode())
    assert "tail" in [t["prompt"] for t in feed.feed_page(head)["turns"]]


def test_tail_read_error_does_not_skip_or_cache_readable_ancestors(rollout, monkeypatch):
    base = rollout(*turn("base", 1))
    middle = rollout(*turn("middle", 2), segment=A, history=base_ref(TID, os.path.getsize(base)))
    head = rollout(segment=B, history=base_ref(A, os.path.getsize(middle)))
    lines = codex_rollouts.lines

    def unavailable(part):
        if part.path == middle:
            raise PermissionError(middle)
        return lines(part)

    with monkeypatch.context() as patch:
        patch.setattr(codex_rollouts, "lines", unavailable)
        assert codex_tail.read(head)["reply"] == "reply base"
    assert codex_tail.read(head)["reply"] == "reply middle"


def test_warm_segmented_files_reuse_counts(rollout, monkeypatch):
    change = cx("event_msg", {"type": "patch_apply_end", "changes": {"a.txt": {"type": "add"}}})
    base = rollout(*turn("base", 1), change)
    head = rollout(segment=A, history=base_ref(TID, os.path.getsize(base)))
    result = codex_feed.session_files(head)
    assert result["files"][0]["write"] == 1

    def recount(*_):
        pytest.fail("an unchanged Files request rebuilt the counts")

    monkeypatch.setattr(codex_feed, "_file_record", recount)
    assert codex_feed.session_files(head) == result


def test_move_validates_owner_and_other_holders_in_one_snapshot(rollout, monkeypatch):
    a = rollout()
    b = rollout(tid=NEIGHBOR)
    processes = table((101, CODEX), (102, CODEX))

    def lsof(cmd, **_):
        pids = cmd[cmd.index("-p") + 1]
        path = a if pids == "101" else b
        out = f"p101\nf10\nau\nn{path}\n" if "101" in pids.split(",") else ""
        return subprocess.CompletedProcess(cmd, 0, out, "")

    def kill(*_):
        pytest.fail("the PID switched threads before the signal")

    monkeypatch.setattr(relocate.os, "kill", kill)
    with pytest.raises(relocate.RelocateError):
        relocate.stop_for_move(TID, 101, agent="codex", table_fn=lambda: processes, run=lsof)


def test_projection_single_flight(rollout, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from atlas import codex_projection

    path = rollout(*turn("once", 1))
    part = codex_rollouts.Part(path)
    entered, release = Event(), Event()
    reads = []
    lines = codex_rollouts.lines

    def observe(part):
        reads.append(part)
        entered.set()
        assert release.wait(2)
        return lines(part)

    monkeypatch.setattr(codex_rollouts, "lines", observe)
    with ThreadPoolExecutor(max_workers=2) as workers:
        a = workers.submit(codex_projection._get, part, codex_feed._keep_feed_record)
        assert entered.wait(2)
        b = workers.submit(codex_projection._get, part, codex_feed._keep_feed_record)
        time.sleep(0.05)
        release.set()
        assert a.result() is b.result()
    assert reads == [part]


def test_projection_budget_includes_pinned_parts_and_spills_oversized(rollout, monkeypatch):
    from atlas import codex_projection

    monkeypatch.setattr(codex_projection, "CACHE_BYTES", 10_000)
    paths = [rollout(*turn("x" * n, 1, key=key), segment=seg)
             for n, key, seg in [(2000, "copied", A), (2000, "copied", B), (8000, "large", C)]]
    parts = [codex_rollouts.Part(p) for p in paths]
    held = [codex_projection._get(part, codex_feed._keep_feed_record) for part in parts]
    assert sum(p.weight for p in held) <= codex_projection.CACHE_BYTES
    assert held[0].weight > 0
    assert all(p.weight == 0 and p.disk_bytes > 0 for p in held[1:])
    result, _ = codex_feed.lineage_window(parts, 20)
    assert len([r for r in result if r["type"] == "user"]) == 2


def test_parallel_spill_readers_serialize_sqlite_calls_without_holding_the_lock_at_yield(rollout, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event, Lock, current_thread

    from atlas import codex_projection

    connect = sqlite3.connect
    guard = Lock()
    reading, ready, collision = Event(), Event(), Event()
    reader_a = None

    def sql_call(method, *args, pause=False):
        if not guard.acquire(blocking=False):
            collision.set()
            raise AssertionError("parallel calls to the same SQLite spill connection")
        try:
            if pause and current_thread() is reader_a and not reading.is_set():
                reading.set()
                assert ready.wait(5)
                collision.wait(0.25)
            return method(*args)
        finally:
            guard.release()

    class Cursor:
        def __init__(self, cursor, lines):
            self.cursor, self.lines = cursor, lines

        def fetchone(self):
            return sql_call(self.cursor.fetchone, pause=self.lines)

        def close(self):
            sql_call(self.cursor.close)

        def __iter__(self):
            return self

        def __next__(self):
            return sql_call(next, self.cursor, pause=self.lines)

    class Connection:
        def __init__(self, *args, **kwargs):
            self.db = connect(*args, **kwargs)

        def __getattr__(self, name):
            return getattr(self.db, name)

        def execute(self, query, *args):
            return Cursor(sql_call(self.db.execute, query, *args), query.startswith("SELECT offset"))

    monkeypatch.setattr(codex_projection.sqlite3, "connect", Connection)
    monkeypatch.setattr(codex_projection, "CACHE_BYTES", 0)
    part = codex_rollouts.Part(rollout(*turn("first", 1), *turn("second", 2), segment=A))
    projection = codex_projection._get(part, codex_feed._keep_feed_record)
    assert projection.disk_bytes > 0
    done = Event()

    def read_forward():
        nonlocal reader_a
        reader_a = current_thread()
        for group in projection.groups():
            if group.turn_id == "first":
                lines = iter(group.lines)
                next(lines)
                assert done.wait(5), "a suspended iterator blocked another reader"
                assert list(lines)
                return
        raise AssertionError("first turn was missing")

    def read_backward():
        try:
            assert reading.wait(5)
            ready.set()
            assert projection.contains("first") and not projection.contains("missing")
            groups = [(g.turn_id, list(g.lines)) for g in projection.groups(reverse=True, reverse_lines=True)]
            assert [tid for tid, _ in groups] == ["second", "first", None]
            assert all(lines == sorted(lines, reverse=True) for _, lines in groups)
        finally:
            done.set()

    with ThreadPoolExecutor(max_workers=2) as workers:
        forward = workers.submit(read_forward)
        backward = workers.submit(read_backward)
        backward.result(timeout=10)
        forward.result(timeout=10)
    assert not collision.is_set()
