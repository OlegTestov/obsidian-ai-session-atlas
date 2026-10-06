"""A session running in a Claude Code background job opens with `claude attach <job>`.

Claude Code 2.1.289 refuses `claude --resume` of such a session ("run `claude attach <job>`"). The
job's process runs under Claude Code's daemon; a tab that shows it runs the attach client. Process
files and the process table are made up in the real structure (tests/test_parked.py has the records).
"""
from __future__ import annotations

import json

import pytest

from atlas import actions, active, convert, db, jobs, relocate
from atlas.messages import msg
from tests.test_parked import JOB, PARENT, START, _index, _job_lines, _parent_lines

JOB_ID = JOB[:8]
# 100: the parent's claude in a tab; 300: the job under the daemon (299); 500: `claude attach` in a
# tab whose PTY proxy is 801 (Obsidian), 601: the same in iTerm.
TABLE = {100: (801, START, "claude"), 299: (1, START, "claude daemon run"),
         300: (299, START, f"/Users/u/.local/share/claude/versions/2.1.289 --session-id {JOB}"),
         500: (801, START, f"claude attach {JOB_ID}"), 801: (900, START, "python3 pty-proxy"),
         900: (1, START, "/Applications/Obsidian.app/Contents/MacOS/Obsidian"),
         601: (602, START, f"/Users/u/.local/bin/claude attach {JOB_ID}"),
         602: (1, START, "/Applications/iTerm.app/Contents/MacOS/iTerm2")}


@pytest.fixture
def files(tmp_path):
    folder = tmp_path / "sessions"
    folder.mkdir()

    def write(pid, sid, **kw):
        data = dict({"pid": pid, "sessionId": sid, "cwd": str(tmp_path), "procStart": START,
                     "kind": "interactive", "entrypoint": "cli", "status": "idle"}, **kw)
        (folder / f"{pid}.json").write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    write.folder = str(folder)
    return write


def _job(files, **kw):
    files(300, JOB, **dict({"kind": "bg", "jobId": JOB_ID, "status": "busy"}, **kw))


def test_job_found_for_itself_its_parked_parent_and_the_parent_it_continued(atlas_env, write_session, files):
    write_session("p", _parent_lines(), session_id=PARENT)
    write_session("p", _job_lines(), session_id=JOB)
    conn = _index(atlas_env)
    _job(files)
    for sid in (JOB, PARENT):                                   # PARENT: by `continued_in` in the index
        assert jobs.live_job(conn, sid, files.folder, TABLE)["job_id"] == JOB_ID
    other = "bbbbbbbb-1111-4111-8111-111111111111"
    files(100, other, parkedJobId=JOB_ID)                       # by the parent's process file
    assert jobs.live_job(None, other, files.folder, TABLE)["session_id"] == JOB


@pytest.mark.parametrize("kw,table", [({}, {k: v for k, v in TABLE.items() if k != 300}),
                                      ({"procStart": "Thu Jan  1 00:00:00 2026"}, TABLE),
                                      ({"spare": True}, TABLE), ({"kind": "interactive"}, TABLE),
                                      ({"jobId": "../x"}, TABLE)],
                         ids=["ended", "pid-reused", "spare", "not-a-job", "bad-id"])
def test_no_running_job_no_attach(files, kw, table):
    _job(files, **kw)
    assert jobs.live_job(None, JOB, files.folder, table) is None


def test_actions_attach_to_a_running_job_and_resume_after_it(atlas_env, write_session, files, monkeypatch, tmp_path):
    write_session("p", _parent_lines(), session_id=PARENT)
    write_session("p", _job_lines(), session_id=JOB)
    conn = _index(atlas_env)
    monkeypatch.setattr(actions, "resume_cwd", lambda conn, sid: None)      # CWD is made up: the job's cwd
    monkeypatch.setattr(active, "SESSIONS_DIR", files.folder)
    monkeypatch.setattr(active, "process_table", lambda: TABLE)
    _job(files)
    for sid in (JOB, PARENT):
        a = actions.actions_for(conn, sid)
        assert a["resume_command"] == f"cd {tmp_path} && claude attach {JOB_ID}" and a["can_open_terminal"]
        # Branching off a copy is what Claude Code itself offers next to attach.
        assert a["fork_command"] == f"cd {tmp_path} && claude --resume {sid} --fork-session"
    monkeypatch.setattr(active, "process_table", lambda: {k: v for k, v in TABLE.items() if k != 300})
    monkeypatch.setattr(actions, "resume_cwd", lambda conn, sid: str(tmp_path))
    assert actions.actions_for(conn, JOB)["resume_command"] == f"cd {tmp_path} && claude --resume {JOB}"


def test_resume_with_own_agent_attaches(atlas_env, write_session, files, monkeypatch, tmp_path):
    write_session("p", _parent_lines(), session_id=PARENT)
    write_session("p", _job_lines(), session_id=JOB)
    conn = _index(atlas_env)
    monkeypatch.setattr(actions, "resume_cwd", lambda conn, sid: str(tmp_path))
    monkeypatch.setattr(active, "SESSIONS_DIR", files.folder)
    monkeypatch.setattr(active, "process_table", lambda: TABLE)
    _job(files)
    assert convert.resume_with(conn, JOB, "claude")["command"] == f"cd {tmp_path} && claude attach {JOB_ID}"


def test_attached_job_is_a_card_found_by_its_tab(atlas_env, write_session, files):
    write_session("p", _parent_lines(), session_id=PARENT)
    write_session("p", _job_lines(), session_id=JOB)
    conn = db.connect()
    _job(files)
    table = {k: v for k, v in TABLE.items() if k not in (100, 601)}
    cards = active.list_active(conn, sessions_dir=files.folder, projects_root=str(atlas_env["projects"]), table=table)
    assert [c["session_id"] for c in cards] == [JOB]
    card = cards[0]
    # The tab's process is the attach client: "Go to" looks for its PTY among these, input goes there.
    assert card["pid"] == 500 and 801 in card["ancestors"] and card["host_app"] == "Obsidian"
    assert card["status"] == "busy" and card["reply_tail"] == "новый ответ"
    # Not attached anywhere: no card (Recently closed offers it); a spare is never one.
    table = {k: v for k, v in table.items() if k != 500}
    assert active.list_active(conn, sessions_dir=files.folder, projects_root=str(atlas_env["projects"]),
                              table=table) == []


def test_parked_parent_with_a_live_tab_stays_the_only_card(atlas_env, write_session, files):
    write_session("p", _parent_lines(), session_id=PARENT)
    write_session("p", _job_lines(), session_id=JOB)
    _job(files)
    files(100, PARENT, parkedJobId=JOB_ID)
    cards = active.list_active(db.connect(), sessions_dir=files.folder,
                               projects_root=str(atlas_env["projects"]), table=TABLE)
    assert [c["session_id"] for c in cards] == [PARENT]


def test_attach_client_outside_obsidian_can_be_moved_the_job_keeps_running(files, monkeypatch):
    _job(files)
    killed = []
    monkeypatch.setattr(relocate.os, "kill", lambda pid, sig: killed.append(pid))
    table = dict(TABLE)
    gone = {k: v for k, v in TABLE.items() if k != 601}
    calls = iter([table, gone])
    out = relocate.stop_for_move(JOB, 601, sessions_dir=files.folder, table_fn=lambda: next(calls, gone),
                                 sleep=lambda s: None)
    assert out["stopped"] and killed == [601]
    for sid, pid, why in ((PARENT, 601, "relocate.foreign_pid"),     # another session's client
                          (JOB, 500, "relocate.in_obsidian")):       # the client in Obsidian stays
        with pytest.raises(relocate.RelocateError) as err:
            relocate.stop_for_move(sid, pid, sessions_dir=files.folder, table_fn=lambda: TABLE, sleep=lambda s: None)
        assert str(err.value) == msg(why)
    assert killed == [601]


def test_attach_command_takes_only_a_job_id():
    assert jobs.attach_command("/x y", JOB_ID) == f"cd '/x y' && claude attach {JOB_ID}"
    for bad in (JOB, "eeeeeee", "EEEEEEEE", "eeeeeeee; id", ""):
        assert jobs.attach_command("/x", bad) is None
    assert jobs.attach_command(None, JOB_ID) is None
