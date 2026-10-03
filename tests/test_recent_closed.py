"""The "Recently closed" list: fresh interactive sessions without a live process."""
from __future__ import annotations

from datetime import datetime, timezone

from atlas import active, db, index
from tests.conftest import rec, user_text

NOW = datetime(2026, 9, 1, 18, 0, tzinfo=timezone.utc)
LIVE, CLOSED, OLD, AUTO = ("1" * 8 + "-1111-1111-1111-111111111111", "2" * 8 + "-2222-2222-2222-222222222222",
                           "3" * 8 + "-3333-3333-3333-333333333333", "4" * 8 + "-4444-4444-4444-444444444444")


def test_only_recent_interactive_sessions_without_a_process(atlas_env, write_session):
    write_session("p", [user_text("живая", ts="2026-09-01T17:50:00.000Z")], session_id=LIVE)
    write_session("p", [user_text("закрыта час назад", ts="2026-09-01T17:00:00.000Z")], session_id=CLOSED)
    write_session("p", [user_text("вчерашняя", ts="2026-08-31T08:00:00.000Z")], session_id=OLD)
    write_session("p", [rec(type="user", timestamp="2026-09-01T17:30:00.000Z", entrypoint="sdk-cli",
                            cwd="/Users/u/Code/demo",
                            message={"role": "user", "content": [{"type": "text", "text": "ночной"}]})],
                  session_id=AUTO)
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    got = active.recently_closed(conn, {LIVE}, now=NOW)
    assert [r["session_id"] for r in got] == [CLOSED]
    assert got[0]["title"] and got[0]["human_turns"] == 1
