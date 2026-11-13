"""Copies Claude Code makes of a session (`--fork-session`, /branch).

The copy keeps the source's records: every copied record keeps the source's id in `session_id`
(`sessionId` is the copy's own), /branch also marks them with `forkedFrom`. The copy carries the
source's title too, so the list numbers it: "Title (2)". Made-up content in the real record shape.
"""
from __future__ import annotations

import json
import os
import urllib.request
from datetime import datetime, timezone

import pytest

from atlas import actions, active, convert, db, index, parse, search, store
from tests.conftest import rec

CWD = "/Users/u/Code/demo"
A = "aaaaaaaa-0000-4000-8000-000000000001"
B = "bbbbbbbb-0000-4000-8000-000000000002"
C = "cccccccc-0000-4000-8000-000000000003"
D = "dddddddd-0000-4000-8000-000000000004"
TITLE = "Billing export"


def _user(text, ts, sid, source=None, forked=None):
    """A prompt in `sid`'s transcript; `source` is the session it was copied from."""
    extra = {"session_id": source or sid}
    if forked:
        extra["forkedFrom"] = {"sessionId": forked, "messageUuid": "m-" + ts}
    return rec(type="user", timestamp=ts, sessionId=sid, cwd=CWD, entrypoint="cli", **extra,
               message={"role": "user", "content": [{"type": "text", "text": text}]})


def _title(sid, title):
    return rec(type="custom-title", customTitle=title, sessionId=sid)


def original(sid=A, title=TITLE):
    return [_title(sid, title), _user("first prompt", "2026-09-01T10:00:00.000Z", sid)]


def copy(sid, of, at, title=TITLE, older=(), forked=None):
    """A copy of `of` made at `at`: the source's records up to then, then the copy's own prompt.

    `--fork-session` writes the copy's own records under its own id; the process that ran /branch
    (`forked`) keeps writing the source's id on them for as long as it runs."""
    copied = [_user("an older prompt", "2026-09-01T10:00:00.000Z", sid, source=o) for o in older]
    copied.append(_user("the last copied reply", at, sid, source=of, forked=forked))
    own = _user("the copy goes on", at.replace("T10:00", "T10:30"), sid, source=of if forked else None)
    return [_title(sid, title), *copied, own]


def used(sid, of, at):
    """Later work in a /branch copy: still under the source's id."""
    return _user("more work in the copy", at, sid, source=of)


def _index(atlas_env):
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    return conn


def _titles(conn):
    return {sid: search.load_session(conn, sid)["title"] for sid in (A, B, C, D)
            if search.load_session(conn, sid)}


def test_a_copy_is_numbered_and_linked_to_its_source(atlas_env, write_session):
    write_session("p", original(), session_id=A)
    write_session("p", copy(B, A, "2026-09-02T10:00:00.000Z"), session_id=B)
    conn = _index(atlas_env)
    assert conn.execute("SELECT parent_id FROM session_forks WHERE session_id=?", (B,)).fetchone()[0] == A
    assert _titles(conn) == {A: TITLE, B: f"{TITLE} (2)"}
    card = search.load_session(conn, B)
    assert card["forked_from"] == {"session_id": A, "title": TITLE}
    assert search.load_session(conn, A)["forks"] == [{"session_id": B, "title": f"{TITLE} (2)"}]
    assert search.load_session(conn, A)["forked_from"] is None


def test_the_last_copied_record_names_the_direct_source(atlas_env, write_session):
    """A copy of a copy also keeps the older id; /branch's forkedFrom wins over session_id."""
    write_session("p", original(), session_id=A)
    write_session("p", copy(B, A, "2026-09-02T10:00:00.000Z"), session_id=B)
    write_session("p", copy(C, B, "2026-09-03T10:00:00.000Z", older=[A]), session_id=C)
    write_session("p", copy(D, A, "2026-09-04T10:00:00.000Z", forked=A), session_id=D)
    conn = _index(atlas_env)
    parents = dict(conn.execute("SELECT session_id, parent_id FROM session_forks").fetchall())
    assert parents == {B: A, C: B, D: A}
    # One family: a copy of a copy and a later sibling never share a number.
    assert _titles(conn) == {A: TITLE, B: f"{TITLE} (2)", C: f"{TITLE} (3)", D: f"{TITLE} (4)"}


def test_copies_are_numbered_in_the_order_they_were_made(atlas_env, write_session):
    """Not in session id order: D was made first."""
    write_session("p", original(), session_id=A)
    write_session("p", copy(D, A, "2026-09-02T10:00:00.000Z"), session_id=D)
    write_session("p", copy(B, A, "2026-09-05T10:00:00.000Z"), session_id=B)
    conn = _index(atlas_env)
    assert _titles(conn) == {A: TITLE, D: f"{TITLE} (2)", B: f"{TITLE} (3)"}
    assert [c["session_id"] for c in search.load_session(conn, A)["forks"]] == [D, B]


@pytest.mark.skipif(not hasattr(os.stat_result, "st_birthtime"), reason="no file creation time here")
def test_a_copy_used_for_days_keeps_the_place_it_was_made_in(atlas_env, write_session):
    """/branch keeps the source's id on the copy's own records: their last timestamp is not when
    the copy was made. The file's creation time is."""
    write_session("p", original(), session_id=A)
    write_session("p", [*copy(B, A, "2026-09-02T10:00:00.000Z", forked=A),
                        used(B, A, "2026-09-20T10:00:00.000Z")], session_id=B)
    write_session("p", copy(C, A, "2026-09-03T10:00:00.000Z", forked=A), session_id=C)
    conn = _index(atlas_env)
    assert _titles(conn) == {A: TITLE, B: f"{TITLE} (2)", C: f"{TITLE} (3)"}
    assert [c["session_id"] for c in search.load_session(conn, A)["forks"]] == [B, C]


def test_when_a_copy_was_made_never_moves(atlas_env, write_session, monkeypatch):
    """Without a creation time, the copy's last marked record at first sight; set once."""
    monkeypatch.setattr(store, "_created", lambda st: None)
    write_session("p", original(), session_id=A)
    b = write_session("p", copy(B, A, "2026-09-02T10:00:00.000Z", forked=A), session_id=B)
    write_session("p", copy(C, A, "2026-09-03T10:00:00.000Z", forked=A), session_id=C)
    conn = _index(atlas_env)
    made = conn.execute("SELECT at FROM session_forks WHERE session_id=?", (B,)).fetchone()[0]
    assert _titles(conn) == {A: TITLE, B: f"{TITLE} (2)", C: f"{TITLE} (3)"}
    for day in ("10", "11"):                     # the copy is used on, read on from where it stopped
        with open(b, "a", encoding="utf-8") as fh:
            fh.write(used(B, A, f"2026-09-{day}T10:00:00.000Z"))
        conn = _index(atlas_env)
        assert _titles(conn) == {A: TITLE, B: f"{TITLE} (2)", C: f"{TITLE} (3)"}
    index.index_all(conn, root=str(atlas_env["projects"]), full=True)
    assert conn.execute("SELECT at FROM session_forks WHERE session_id=?", (B,)).fetchone()[0] == made
    assert _titles(conn) == {A: TITLE, B: f"{TITLE} (2)", C: f"{TITLE} (3)"}


def test_copies_keep_their_numbers_when_the_source_is_gone(atlas_env, write_session):
    source = write_session("p", original(), session_id=A)
    write_session("p", copy(B, A, "2026-09-02T10:00:00.000Z"), session_id=B)
    write_session("p", copy(C, A, "2026-09-03T10:00:00.000Z"), session_id=C)
    conn = _index(atlas_env)
    os.remove(source)
    conn = _index(atlas_env)
    assert _titles(conn) == {B: f"{TITLE} (2)", C: f"{TITLE} (3)"}
    assert search.load_session(conn, B)["forked_from"] is None     # no link to a session that is gone
    assert conn.execute("SELECT count(*) FROM session_forks").fetchone()[0] == 2


def test_a_copy_that_is_gone_leaves_no_row(atlas_env, write_session):
    write_session("p", original(), session_id=A)
    write_session("p", copy(B, A, "2026-09-02T10:00:00.000Z"), session_id=B)
    gone = write_session("p", copy(C, A, "2026-09-03T10:00:00.000Z"), session_id=C)
    conn = _index(atlas_env)
    os.remove(gone)
    conn = _index(atlas_env)
    assert [r[0] for r in conn.execute("SELECT session_id FROM session_forks")] == [B]


def test_resume_with_writes_the_name_without_the_number(atlas_env, write_session, tmp_path, monkeypatch):
    write_session("p", original(), session_id=A)
    write_session("p", copy(B, A, "2026-09-02T10:00:00.000Z"), session_id=B)
    conn = _index(atlas_env)
    monkeypatch.setattr(convert.actions, "resume_cwd", lambda conn, sid: str(tmp_path))
    assert convert._source(conn, B, "codex")["title"] == TITLE
    # The card of the new session names its source as the list does.
    conn.execute("INSERT INTO conversions VALUES (?,?,?,?,?,?)",
                 ("0199a1b2-c3d4-7e5f-8a6b-00000000ffff", B, "claude", "codex", "x", "2026-09-03T00:00:00Z"))
    assert search.conversions(conn, "0199a1b2-c3d4-7e5f-8a6b-00000000ffff")["converted_from"]["title"] \
        == f"{TITLE} (2)"


def test_forked_from_marker_names_the_parent_even_with_older_ids_after_it(tmp_path):
    path = tmp_path / f"{C}.jsonl"
    path.write_text("".join([_user("p", "2026-09-01T10:00:00.000Z", C, source=A, forked=B),
                             _user("q", "2026-09-01T10:01:00.000Z", C, source=A, forked=B)]))
    facts = parse.parse_file(str(path), C)
    assert facts.copied_from == A and facts.forked_from == B
    assert parse.fork_source(facts) == B


def test_a_renamed_copy_is_not_numbered(atlas_env, write_session):
    """Renamed in Claude Code (/rename: a new custom-title) or in Atlas: shown as named."""
    write_session("p", original(), session_id=A)
    write_session("p", [*copy(B, A, "2026-09-02T10:00:00.000Z"), _title(B, "Day scoring fix")], session_id=B)
    write_session("p", copy(C, A, "2026-09-03T10:00:00.000Z"), session_id=C)
    conn = _index(atlas_env)
    assert _titles(conn) == {A: TITLE, B: "Day scoring fix", C: f"{TITLE} (2)"}
    actions.rename_session(conn, C, "Second try", write_to_transcript=False)
    assert _titles(conn) == {A: TITLE, B: "Day scoring fix", C: "Second try"}
    assert search.load_session(conn, C)["fork_no"] is None


def test_renaming_the_source_leaves_its_copies_numbered_among_themselves(atlas_env, write_session):
    write_session("p", original(), session_id=A)
    write_session("p", copy(B, A, "2026-09-02T10:00:00.000Z"), session_id=B)
    write_session("p", copy(C, A, "2026-09-03T10:00:00.000Z"), session_id=C)
    conn = _index(atlas_env)
    actions.rename_session(conn, A, "The original", write_to_transcript=False)
    assert _titles(conn) == {A: "The original", B: TITLE, C: f"{TITLE} (2)"}
    assert search.load_session(conn, B)["forked_from"] == {"session_id": A, "title": "The original"}


def test_a_parked_conversations_job_is_a_continuation_not_a_copy(atlas_env, write_session):
    """The job copies the parent's records too, but the parent hands the conversation over."""
    handed_over = rec(type="continued-in", timestamp="2026-09-01T10:05:00.000Z", sessionId=A,
                      continuedInSessionId=B)
    write_session("p", [*original(), handed_over], session_id=A)
    write_session("p", copy(B, A, "2026-09-01T10:06:00.000Z"), session_id=B)
    conn = _index(atlas_env)
    assert conn.execute("SELECT count(*) FROM session_forks").fetchone()[0] == 0
    assert search.load_session(conn, B)["forked_from"] is None


def test_a_conversion_is_not_a_copy():
    facts = parse.SessionFacts(session_id=B, copied_from=A, continued_from=A)
    assert parse.fork_source(facts) is None
    assert parse.fork_source(parse.SessionFacts(session_id=B, copied_from=A, agent="codex")) is None
    assert parse.fork_source(parse.SessionFacts(session_id=B, copied_from=A)) == A


def test_copies_indexed_before_the_table_existed_are_read_again_once(atlas_env, write_session):
    write_session("p", original(), session_id=A)
    write_session("p", copy(B, A, "2026-09-02T10:00:00.000Z"), session_id=B)
    conn = _index(atlas_env)
    # The catalog an older version left: the same files, no copy rows, no scan marker.
    conn.execute("DELETE FROM session_forks")
    conn.execute("DELETE FROM meta WHERE key='copies_scanned'")
    conn.commit()
    stats_ = index.index_all(conn, root=str(atlas_env["projects"]))
    assert stats_["full"] == 1        # only the copy is read again; the original stays skipped
    assert _titles(conn) == {A: TITLE, B: f"{TITLE} (2)"}
    assert index.index_all(conn, root=str(atlas_env["projects"]))["full"] == 0


def test_lists_show_the_numbered_title(atlas_env, write_session, live_server):
    write_session("p", original(), session_id=A)
    write_session("p", copy(B, A, "2026-09-02T10:00:00.000Z"), session_id=B)
    conn = _index(atlas_env)
    recent = {r["session_id"]: r["title"] for r in search.recent(conn)}
    assert recent == {A: TITLE, B: f"{TITLE} (2)"}
    found = {r["session_id"]: r for r in search.search(conn, "Billing")}
    assert "".join(s["t"] for s in found[B]["title_segments"]).endswith("export (2)")
    closed = active.recently_closed(conn, set(), now=datetime(2026, 9, 2, 12, 0, tzinfo=timezone.utc))
    assert {r["session_id"]: r["title"] for r in closed} == {B: f"{TITLE} (2)"}
    base, _ = live_server
    with urllib.request.urlopen(f"{base}/api/session/{B}") as resp:
        card = json.loads(resp.read())
    assert card["title"] == f"{TITLE} (2)" and card["forked_from"]["session_id"] == A


def test_the_copy_check_reads_past_the_metadata_and_stops_at_the_first_prompt(tmp_path):
    """Claude Code writes ~200 KB of titles, settings and attachments before a copy's first prompt."""
    meta = [rec(type="history-suppression", sessionId=B, cause="fork_inherit"), _title(B, TITLE),
            *[rec(type="attachment", sessionId=B, attachment={"type": "instructions", "text": "x" * 4000})
              for _ in range(40)],
            rec(type="system", sessionId=B, timestamp="2026-09-02T10:00:00.000Z")]
    copied = tmp_path / f"{B}.jsonl"
    copied.write_text("".join([*meta, _user("copied", "2026-09-01T10:00:00.000Z", B, source=A)]))
    assert copied.stat().st_size > 128 << 10 and index.is_copy_head(str(copied))
    # Not a copy: its first prompt is its own; whatever comes later is not looked at.
    own = tmp_path / f"{C}.jsonl"
    own.write_text("".join([_user("mine", "2026-09-01T10:00:00.000Z", C),
                            _user("pasted", "2026-09-01T10:01:00.000Z", C, source=A)]))
    assert not index.is_copy_head(str(own))
