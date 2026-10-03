"""Hourly: topic and "What was done" for new and changed sessions. Off by default."""
from __future__ import annotations

import calendar
import time

from atlas import autoclassify, db, index
from tests.conftest import assistant_text, user_text

OLD = "11111111-1111-1111-1111-111111111111"
FRESH = "22222222-2222-2222-2222-222222222222"
DONE = "33333333-3333-3333-3333-333333333333"
NOW = calendar.timegm(time.strptime("2026-09-27T12:00:00", "%Y-%m-%dT%H:%M:%S"))


def _setup(atlas_env, write_session):
    write_session("p", [user_text("старая сессия про отчёт", ts="2026-09-27T10:00:00.000Z")],
                  session_id=OLD)
    write_session("p", [user_text("только что начатая", ts="2026-09-27T11:50:00.000Z")],
                  session_id=FRESH)
    write_session("p", [user_text("уже размечена", ts="2026-09-27T09:00:00.000Z")],
                  session_id=DONE)
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("INSERT INTO classification (session_id, domain, topic, summary, confidence, "
                 "content_hash, classifier_version, model, backend, created_at) "
                 "VALUES (?,?,?,?,?,?,?,?,?,?)",
                 (DONE, "personal", "x", None, 0.9, "старый", 0, "m", "b", "t"))
    conn.commit()
    return conn


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, conn, ids, job_id=None):
        self.calls.append(list(ids))
        for sid in ids:                          # like the real one: writes the classification
            conn.execute("INSERT OR REPLACE INTO classification (session_id, domain, topic, summary, "
                         "confidence, content_hash, classifier_version, model, backend, created_at) "
                         "VALUES (?,?,?,?,?,?,?,?,?,?)", (sid, "personal", "t", "s", 0.9, "h", 1, "m", "b", "t"))
        conn.commit()
        return {"classified": len(ids), "failed": 0, "errors": []}


class Summaries:
    def __init__(self, fail=()):
        self.calls, self.fail = [], set(fail)

    def __call__(self, conn, sid, job_id):
        self.calls.append(sid)
        if sid in self.fail:
            raise RuntimeError("квота")


def _tick(conn, now, run, summary):
    return autoclassify.tick(conn, now=now, run=run, summary=summary)


def test_off_by_default_and_never_runs(atlas_env, write_session):
    conn = _setup(atlas_env, write_session)
    run, summ = Recorder(), Summaries()
    assert autoclassify.enabled(conn) is False and autoclassify.status(conn)["enabled"] is False
    assert _tick(conn, NOW, run, summ) is None
    assert run.calls == [] and summ.calls == []


def test_first_pass_takes_new_and_only_remembers_already_classified(atlas_env, write_session):
    conn = _setup(atlas_env, write_session)
    assert [sid for sid, _ in autoclassify.candidates(conn, now=NOW)] == [OLD]
    seen = conn.execute("SELECT turns_sig FROM auto_marks WHERE session_id=?", (DONE,)).fetchone()
    assert seen is not None, "a labelled session without a mark is remembered but not recomputed"


def test_new_messages_bring_a_session_back(atlas_env, write_session):
    conn = _setup(atlas_env, write_session)
    autoclassify.candidates(conn, now=NOW)                  # mark for DONE
    write_session("p", [user_text("уже размечена", ts="2026-09-27T09:00:00.000Z"),
                        assistant_text("ответ", ts="2026-09-27T09:10:00.000Z"),
                        user_text("а теперь ещё вот что", ts="2026-09-27T11:00:00.000Z")],
                  session_id=DONE)
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert DONE in [sid for sid, _ in autoclassify.candidates(conn, now=NOW)]


def test_hourly_run_classifies_summarizes_and_marks(atlas_env, write_session):
    conn = _setup(atlas_env, write_session)
    run, summ = Recorder(), Summaries()
    autoclassify.set_enabled(conn, True)
    out = _tick(conn, NOW, run, summ)
    assert run.calls == [[OLD]] and summ.calls == [OLD]
    assert out["classified"] == 1 and out["summaries"] == 1
    job = conn.execute("SELECT state FROM jobs WHERE action_kind='classification'").fetchone()
    assert job["state"] == "done"
    assert _tick(conn, NOW + 600, run, summ) is None, "silent before an hour passes"
    # An hour later: OLD and DONE are unchanged, FRESH just turned half an hour old — only it is taken.
    later = _tick(conn, NOW + 3601, run, summ)
    assert later["candidates"] == 1 and run.calls[-1] == [FRESH]
    autoclassify.set_enabled(conn, False)
    assert _tick(conn, NOW + 99999, run, summ) is None


def test_failed_summary_is_reported_and_retried_only_after_new_messages(atlas_env, write_session):
    conn = _setup(atlas_env, write_session)
    autoclassify.set_enabled(conn, True)
    out = _tick(conn, NOW, Recorder(), Summaries(fail={OLD}))
    assert out["summaries"] == 0 and any("квота" in e for e in out["errors"])
    assert OLD not in [sid for sid, _ in autoclassify.candidates(conn, now=NOW + 3601)]


def test_waits_for_a_running_classification(atlas_env, write_session):
    conn = _setup(atlas_env, write_session)
    autoclassify.set_enabled(conn, True)
    conn.execute("INSERT INTO jobs (job_id, session_id, action_kind, content_hash, state, "
                 "created_at, updated_at) VALUES ('j','batch','classification','h','running','t','t')")
    conn.commit()
    run = Recorder()
    assert _tick(conn, NOW, run, Summaries()) is None and run.calls == []


def test_sensitive_sessions_never_leave(atlas_env, write_session):
    conn = _setup(atlas_env, write_session)
    conn.execute("INSERT INTO user_overrides(session_id, sensitivity, updated_at) VALUES (?,?,?)",
                 (OLD, "sensitive", "t"))
    conn.commit()
    assert OLD not in [sid for sid, _ in autoclassify.candidates(conn, now=NOW)]


def test_caps_sessions_per_run(atlas_env, write_session):
    conn = _setup(atlas_env, write_session)
    many = [f"{i:08d}-0000-0000-0000-000000000000" for i in range(40)]
    conn.executemany("INSERT INTO sessions (session_id, source_path, started_at, session_kind, "
                     "last_activity_at) VALUES (?, ?, ?, 'interactive', ?)",
                     [(sid, "/x/" + sid, "2026-09-27T09:00:00.000Z", "2026-09-27T09:00:00.000Z")
                      for sid in many])
    assert len(autoclassify.candidates(conn, now=NOW)) == autoclassify.MAX_PER_RUN


def test_setting_and_marks_survive_rebuild(atlas_env, write_session):
    conn = _setup(atlas_env, write_session)
    autoclassify.set_enabled(conn, True)
    autoclassify.candidates(conn, now=NOW)
    db.drop_derived(conn)                      # what `atlas rebuild` does
    index.index_all(conn, root=str(atlas_env["projects"]), full=True)
    assert autoclassify.enabled(conn)
    assert conn.execute("SELECT count(*) FROM auto_marks").fetchone()[0] >= 1


def test_summary_goes_the_same_way_as_the_button(atlas_env, write_session, monkeypatch):
    """Send permission covers this session state and this model, then a normal produce."""
    conn = _setup(atlas_env, write_session)
    from atlas import enrich, runner
    produced = []
    monkeypatch.setattr(runner, "build_payload", lambda c, sid, kind: {"content_hash": "h-" + sid[:4]})
    monkeypatch.setattr(enrich, "produce", lambda c, sid, kind, job: produced.append((sid, kind, job)))
    autoclassify.summarize(conn, OLD, "job-1")
    model, _ = runner.model_for("catalog_summary")
    grant = conn.execute("SELECT content_hash, backend, model FROM egress_grants WHERE session_id=? "
                         "AND artifact_kind='catalog_summary'", (OLD,)).fetchone()
    assert tuple(grant) == ("h-1111", runner.EXTERNAL_BACKEND, model)
    assert produced == [(OLD, "catalog_summary", "job-1")]


def test_changes_after_a_run_are_picked_up_next_hour(atlas_env, write_session):
    conn = _setup(atlas_env, write_session)
    autoclassify.set_enabled(conn, True)
    run, summ = Recorder(), Summaries()
    _tick(conn, NOW, run, summ)
    write_session("p", [user_text("старая сессия про отчёт", ts="2026-09-27T10:00:00.000Z"),
                        assistant_text("сделал", ts="2026-09-27T12:10:00.000Z")], session_id=OLD)
    index.index_all(conn, root=str(atlas_env["projects"]))
    _tick(conn, NOW + 3601, run, summ)
    assert OLD in run.calls[-1], "session changes after a pass go to the next pass"
