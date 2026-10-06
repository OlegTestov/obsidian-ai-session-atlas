"""Parked conversations (Claude Code 2.1.289+): the work goes on in a background job.

The tab's session file says `idle` with `parkedJobId`; the job has its own process, session file
(`kind: bg`, `jobId`) and transcript. The job's transcript copies the parent's chain since the last
compaction (same uuids and message ids, `sessionKind: bg`) and goes on; the parent ends with a
`continued-in` record. Made-up content in the real record structure.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request
from datetime import datetime, timedelta, timezone

import pytest

from atlas import active, costs, db, index, search, stats
from tests.conftest import rec

START = "Sat Sep 26 15:39:21 2026"
PARENT = "aaaaaaaa-1111-4111-8111-111111111111"
JOB = "eeeeeeee-2222-4222-8222-222222222222"
EARLY_JOB = "00000000-3333-4333-8333-333333333333"     # sorts before its parent: indexed first
HANDED_OVER = "2026-09-01T10:05:00.000Z"
CWD = "/Users/u/Code/demo"
# pid → (ppid, start). 100 is the tab's claude (under PTY proxy 801), 300 is the job's process.
TABLE = {100: (801, START), 300: (299, START), 299: (100, START), 801: (900, START),
         900: (1, START)}


def _user(text, ts, uid, sid, **kw):
    return rec(type="user", timestamp=ts, uuid=uid, sessionId=sid, cwd=CWD, entrypoint="cli",
               message={"role": "user", "content": [{"type": "text", "text": text}]}, **kw)


def _answer(text, ts, uid, mid, sid, **kw):
    usage = {"input_tokens": 100, "output_tokens": 10, "cache_read_input_tokens": 1000,
             "cache_creation_input_tokens": 0}
    return rec(type="assistant", timestamp=ts, uuid=uid, sessionId=sid, cwd=CWD, entrypoint="cli",
               message={"id": mid, "role": "assistant", "model": "claude-opus-5", "usage": usage,
                        "content": [{"type": "text", "text": text}]}, **kw)


def _parent_lines(after=()):
    return [rec(type="ai-title", aiTitle="Разговор", sessionId=PARENT),
            _user("старый вопрос про маяк", "2026-09-01T10:00:00.000Z", "u1", PARENT),
            _answer("старый ответ", "2026-09-01T10:01:00.000Z", "a1", "msg_1", PARENT),
            rec(type="continued-in", timestamp=HANDED_OVER, sessionId=PARENT,
                continuedInSessionId=JOB), *after]


def _job_lines(job=JOB, new=True):
    bg = {"sessionKind": "bg"}
    lines = [rec(type="ai-title", aiTitle="Разговор", sessionId=job),
             rec(type="file-history-snapshot", messageId="u1",
                 snapshot={"timestamp": "2026-09-01T10:00:00.000Z",
                           "trackedFileBackups": {"/Users/u/Code/demo/old.py": {}}}),
             _user("старый вопрос про маяк", "2026-09-01T10:00:00.000Z", "u1", job, **bg),
             _answer("старый ответ", "2026-09-01T10:01:00.000Z", "a1", "msg_1", job, **bg)]
    if new:
        lines += [_user("новый вопрос про шлюз", "2026-09-01T10:10:00.000Z", "u2", job, **bg),
                  _answer("новый ответ", "2026-09-01T10:11:00.000Z", "a2", "msg_2", job, **bg)]
    return lines


def _index(atlas_env):
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    return conn


def _row(conn, sid):
    return conn.execute("SELECT * FROM sessions WHERE session_id=?", (sid,)).fetchone()


@pytest.mark.parametrize("job", [JOB, EARLY_JOB])
def test_job_transcript_is_the_parents_continuation_not_a_copy(atlas_env, write_session, job):
    """Either indexing order: a job read before its parent is read again once the link is known."""
    lines = _parent_lines()
    lines[-1] = rec(type="continued-in", timestamp=HANDED_OVER, sessionId=PARENT,
                    continuedInSessionId=job)
    write_session("p", lines, session_id=PARENT)
    write_session("p", _job_lines(job), session_id=job)
    conn = _index(atlas_env)
    parent, child = _row(conn, PARENT), _row(conn, job)
    assert parent["continued_in"] == job and parent["continued_from"] is None
    assert child["continued_from"] == PARENT and child["session_kind"] == "interactive"
    assert child["human_turns"] == 1 and child["started_at"] == "2026-09-01T10:10:00.000Z"
    # The copied history is found only in the parent, the new work only in the job.
    assert [r["session_id"] for r in search.search(conn, "маяк")] == [PARENT]
    assert [r["session_id"] for r in search.search(conn, "шлюз")] == [job]
    assert search.load_session(conn, job)["continued_from"] == PARENT
    files = [r["raw_path"] for r in conn.execute(
        "SELECT raw_path FROM session_files WHERE session_id=?", (job,))]
    assert files == []                     # the copied file-history snapshot is the parent's
    keys = {r["key"] for r in conn.execute("SELECT key FROM activity WHERE session_id=?", (job,))}
    assert keys == {"u2", "msg_2"}


def test_a_growing_job_is_read_on_from_where_it_stopped(atlas_env, write_session):
    write_session("p", _parent_lines(), session_id=PARENT)
    path = write_session("p", _job_lines(), session_id=JOB)
    conn = _index(atlas_env)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(_user("ещё вопрос про буй", "2026-09-01T10:20:00.000Z", "u3", JOB, sessionKind="bg"))
    stats_ = index.index_all(conn, root=str(atlas_env["projects"]))
    assert stats_["tail"] == 1 and _row(conn, JOB)["human_turns"] == 2
    assert [r["session_id"] for r in search.search(conn, "буй")] == [JOB]
    assert [r["session_id"] for r in search.search(conn, "маяк")] == [PARENT]


def test_stats_count_a_parked_conversation_once(atlas_env, write_session):
    write_session("p", _parent_lines(), session_id=PARENT)
    write_session("p", _job_lines(), session_id=JOB)
    conn = _index(atlas_env)
    now = datetime(2026, 9, 1, 18, 0, tzinfo=timezone.utc)
    totals = stats.summary(conn, "all", now=now)["totals"]
    assert totals["answers"] == 2 and totals["prompts"] == 2
    assert totals["tokens"]["output"] == 20
    # Without the GROUP BY safety net the rows themselves are not duplicated either.
    assert conn.execute("SELECT COUNT(*) FROM activity").fetchone()[0] == 4


def test_a_parent_that_went_on_is_not_handed_over(atlas_env, write_session):
    write_session("p", _parent_lines([
        _user("вернулся во вкладку", "2026-09-01T11:00:00.000Z", "u9", PARENT)]),
        session_id=PARENT)
    write_session("p", _job_lines(), session_id=JOB)
    conn = _index(atlas_env)
    assert _row(conn, PARENT)["continued_in"] is None
    assert _row(conn, JOB)["continued_from"] == PARENT and _row(conn, JOB)["human_turns"] == 1


def test_old_transcripts_and_lone_bg_jobs_are_indexed_as_before(atlas_env, write_session):
    """No `continued-in` anywhere: nothing is linked and nothing is skipped."""
    write_session("p", _job_lines(), session_id=JOB)
    conn = _index(atlas_env)
    row = _row(conn, JOB)
    assert row["continued_from"] is None and row["continued_in"] is None
    assert row["human_turns"] == 2 and row["session_kind"] == "interactive"


def test_subagent_carried_over_to_the_job_stays_the_parents(atlas_env, write_session):
    write_session("p", _parent_lines(), session_id=PARENT)
    write_session("p", _job_lines(), session_id=JOB)
    folder = atlas_env["projects"] / "p"
    own = folder / PARENT / "subagents"
    own.mkdir(parents=True)
    (own / "agent-x.jsonl").write_text(_answer("ответ сабагента", "2026-09-01T10:02:00.000Z",
                                               "s1", "msg_s", PARENT), encoding="utf-8")
    linked = folder / JOB / "subagents"
    linked.mkdir(parents=True)
    os.symlink(own / "agent-x.jsonl", linked / "agent-x.jsonl")
    assert index.discover_subagents(str(folder / f"{JOB}.jsonl")) == []
    assert len(index.discover_subagents(str(folder / f"{PARENT}.jsonl"))) == 1
    conn = _index(atlas_env)
    subs = conn.execute("SELECT session_id FROM activity WHERE sub=1").fetchall()
    assert [r["session_id"] for r in subs] == [PARENT]


# --- Active tab ---------------------------------------------------------------------------

@pytest.fixture
def sessions(tmp_path):
    folder = tmp_path / "sessions"
    folder.mkdir()

    def write(pid, sid, **kw):
        data = {"pid": pid, "sessionId": sid, "cwd": CWD, "startedAt": 1790437190048,
                "procStart": START, "kind": "interactive", "entrypoint": "cli",
                "status": "idle"}
        data.update(kw)
        (folder / f"{pid}.json").write_text(json.dumps(data), encoding="utf-8")
    write.folder = str(folder)
    return write


def _parked(sessions, job_status="busy", **job):
    sessions(100, PARENT, parkedJobId=JOB[:8])
    sessions(300, JOB, kind="bg", jobId=JOB[:8], status=job_status, **job)


def _cards(atlas_env, sessions, conn=None, table=TABLE):
    conn = conn or db.connect()
    return active.list_active(conn, sessions_dir=sessions.folder,
                              projects_root=str(atlas_env["projects"]), table=table)


def test_parked_card_shows_the_jobs_work(atlas_env, write_session, sessions):
    write_session("p", _parent_lines(), session_id=PARENT)
    write_session("p", _job_lines(), session_id=JOB)
    _parked(sessions)
    cards = _cards(atlas_env, sessions)
    assert [c["session_id"] for c in cards] == [PARENT]       # the job is not a card of its own
    card = cards[0]
    assert card["status"] == "busy" and card["activity"] == "busy"
    assert card["job_session_id"] == JOB and card["transcript_session_id"] == JOB
    assert card["reply_tail"] == "новый ответ" and card["last_message_at"].startswith("2026-09-01T10:11")
    one = costs.session_cost(str(atlas_env["projects"] / "p" / f"{PARENT}.jsonl"))["now"]
    assert card["cost_now"] == pytest.approx(2 * one)          # the parent's reply and the job's own


def test_parked_card_without_a_live_job_is_the_tab_itself(atlas_env, write_session, sessions):
    write_session("p", _parent_lines(), session_id=PARENT)
    write_session("p", _job_lines(), session_id=JOB)
    _parked(sessions)
    table = {k: v for k, v in TABLE.items() if k != 300}            # the job's process is gone
    card = _cards(atlas_env, sessions, table=table)[0]
    assert card["status"] == "idle" and card["activity"] == "idle"
    assert card["job_session_id"] is None and card["reply_tail"] == "старый ответ"


def test_dialog_in_the_job_makes_the_card_wait(atlas_env, write_session, sessions):
    write_session("p", _parent_lines(), session_id=PARENT)
    write_session("p", _job_lines(), session_id=JOB)
    _parked(sessions, job_status="waiting", waitingFor="approve Bash")
    card = _cards(atlas_env, sessions)[0]
    assert card["status"] == "waiting" and card["activity"] == "waiting"
    assert card["waiting_for"] == "approve Bash"


def test_job_subagents_are_the_cards_background_work(atlas_env, write_session, sessions):
    write_session("p", _parent_lines(), session_id=PARENT)
    write_session("p", _job_lines(), session_id=JOB)
    folder = atlas_env["projects"] / "p"
    own = folder / PARENT / "subagents"
    own.mkdir(parents=True)
    (own / "agent-x.jsonl").write_text("{}\n", encoding="utf-8")
    jobs = folder / JOB / "subagents"
    jobs.mkdir(parents=True)
    os.symlink(own / "agent-x.jsonl", jobs / "agent-x.jsonl")      # carried over at the hand-over
    (jobs / "agent-y.jsonl").write_text("{}\n", encoding="utf-8")
    _parked(sessions, job_status="idle")
    card = _cards(atlas_env, sessions)[0]
    assert card["background"]["agents"] == 2 and card["activity"] == "background"


def test_old_sessions_without_parking_are_unchanged(atlas_env, write_session, sessions):
    write_session("p", _parent_lines(), session_id=PARENT)
    sessions(100, PARENT, status="busy")
    card = _cards(atlas_env, sessions)[0]
    assert card["status"] == "busy" and card["job_session_id"] is None
    assert card["transcript_session_id"] == PARENT and card["reply_tail"] == "старый ответ"


def test_feed_reads_the_jobs_transcript(atlas_env, write_session, sessions):
    write_session("p", _parent_lines(), session_id=PARENT)
    path = write_session("p", _job_lines(), session_id=JOB)
    _parked(sessions)
    got = active.live_transcript(db.connect(), PARENT, str(atlas_env["projects"]),
                                 sessions_dir=sessions.folder, table=TABLE)
    assert got == path


def test_recently_closed_lists_a_parked_conversation_once(atlas_env, write_session):
    write_session("p", _parent_lines(), session_id=PARENT)
    write_session("p", _job_lines(), session_id=JOB)
    conn = _index(atlas_env)
    now = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
    assert active.recently_closed(conn, {PARENT}, now=now) == []      # the card represents it
    assert active.recently_closed(conn, {JOB}, now=now) == []         # the job still runs
    assert [r["session_id"] for r in active.recently_closed(conn, set(), now=now)] == [JOB]


def test_parked_cost_adds_only_the_jobs_own_replies(atlas_env, write_session):
    parent = write_session("p", _parent_lines(), session_id=PARENT)
    job = write_session("p", _job_lines(), session_id=JOB)
    one = costs.session_cost(parent)["now"]
    got = costs.parked_cost(parent, job)
    assert got["now"] == pytest.approx(2 * one)
    costs._cache.pop(job)
    costs.session_cost(job)                      # scanned once without rows: still counted right
    assert costs.parked_cost(parent, job)["now"] == pytest.approx(2 * one)


def test_live_subagents_count_a_linked_file_once(tmp_path):
    parent, job = tmp_path / "p.jsonl", tmp_path / "j.jsonl"
    (tmp_path / "p" / "subagents").mkdir(parents=True)
    (tmp_path / "j" / "subagents").mkdir(parents=True)
    (tmp_path / "p" / "subagents" / "agent-a.jsonl").write_text("{}\n")
    os.symlink(tmp_path / "p" / "subagents" / "agent-a.jsonl", tmp_path / "j" / "subagents" / "agent-a.jsonl")
    assert active.live_subagents(str(parent), str(job), now=time.time()) == 1


def test_continuation_without_a_new_prompt_is_still_yours(atlas_env, write_session):
    """The job may only work on the prompt you gave the parent: no prompt of its own."""
    lines = [*_job_lines(new=False),
             _answer("готово", "2026-09-01T10:30:00.000Z", "a3", "msg_3", JOB, sessionKind="bg")]
    write_session("p", _parent_lines(), session_id=PARENT)
    write_session("p", lines, session_id=JOB)
    row = _row(_index(atlas_env), JOB)
    assert row["human_turns"] == 0 and row["session_kind"] == "interactive"


def _recent(lines):
    """The same records an hour ago: "Recently closed" looks at the last few hours of real time."""
    hour = (datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=1))
    stamp = hour.strftime("%Y-%m-%dT%H")
    return [line.replace("2026-09-01T10", stamp) for line in lines]


def test_api_follows_the_job(atlas_env, write_session, sessions, live_server, monkeypatch, tmp_path):
    from atlas import actions, server
    monkeypatch.setattr(actions, "resume_cwd", lambda conn, sid: str(tmp_path))     # CWD is made up
    write_session("p", _recent(_parent_lines()), session_id=PARENT)
    write_session("p", _recent(_job_lines()), session_id=JOB)
    _index(atlas_env)
    _parked(sessions)
    monkeypatch.setattr(active, "SESSIONS_DIR", sessions.folder)
    monkeypatch.setattr(server, "_active_cached", {"at": 0.0, "sessions": None})
    base, _ = live_server
    # The tab closed, the job runs on: it is offered once, as `claude attach` (`--resume` refuses
    # a session running in the background), and so is its parent's resume.
    monkeypatch.setattr(active, "process_table",
                        lambda: {k: v for k, v in TABLE.items() if k != 100})
    with urllib.request.urlopen(f"{base}/api/active", timeout=10) as r:
        data = json.loads(r.read())
    assert data["sessions"] == [] and [c["session_id"] for c in data["recent_closed"]] == [JOB]
    for sid in (JOB, PARENT):
        with urllib.request.urlopen(f"{base}/api/session/{sid}", timeout=10) as r:
            assert json.loads(r.read())["actions"]["resume_command"] == f"cd {tmp_path} && claude attach {JOB[:8]}"
    # The tab is back: its feed is the job's transcript.
    monkeypatch.setattr(active, "process_table", lambda: TABLE)
    with urllib.request.urlopen(f"{base}/api/active/feed/{PARENT}", timeout=10) as r:
        assert "шлюз" in r.read().decode("utf-8")
