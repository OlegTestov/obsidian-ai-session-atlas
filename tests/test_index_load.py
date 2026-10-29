"""An expensive full parse is not repeated every pass while a session's subagents write."""
from __future__ import annotations

import os

import pytest

from atlas import db, index
from tests.conftest import assistant_text, user_text

SID = "33333333-3333-3333-3333-333333333333"


def _conn(home, name="atlas.sqlite3"):
    return db.connect(os.path.join(str(home), name))


def _dump(conn):
    """What a full rebuild produces: cards, every FTS row, activity and the link tables."""
    out = {}
    for table, order in (("sessions", "session_id"), ("activity", "session_id, key"),
                         ("session_tickets", "session_id"), ("session_files", "session_id"),
                         ("session_projects", "session_id"), ("session_domains", "session_id")):
        out[table] = [tuple(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY {order}")]
    out["fts"] = sorted(tuple(r) for r in conn.execute("SELECT * FROM fts"))
    out["fts_paths"] = sorted(tuple(r) for r in conn.execute("SELECT * FROM fts_paths"))
    return out


@pytest.fixture
def busy(atlas_env, write_session, monkeypatch):
    """A session whose subagent keeps writing, and a clock the test moves."""
    clock = {"now": 1_000_000.0}
    monkeypatch.setattr(index, "_clock", lambda: clock["now"])
    path = write_session("p", [user_text("общий план работ")], session_id=SID)
    sub_dir = os.path.join(os.path.dirname(path), SID, "subagents")
    os.makedirs(sub_dir)
    sub = os.path.join(sub_dir, "agent-a1.jsonl")

    def subagent_writes(text):
        with open(sub, "a", encoding="utf-8") as fh:
            fh.write(assistant_text(text))
        st = os.stat(sub)
        os.utime(sub, (st.st_atime, st.st_mtime + 5))

    subagent_writes("первая находка субагента")
    conn = _conn(atlas_env["home"])
    index.index_all(conn, root=str(atlas_env["projects"]), paced=True)
    return {"conn": conn, "clock": clock, "write": subagent_writes, "root": str(atlas_env["projects"])}


def _cost(conn, seconds, at):
    conn.execute("INSERT OR REPLACE INTO index_costs VALUES (?,?,?)", (SID, seconds, at))
    conn.commit()


def _sub_text(conn):
    return conn.execute("SELECT subagent_text FROM fts WHERE session_id=? AND turn=-1", (SID,)).fetchone()[0]


def test_a_slow_full_parse_is_measured_and_then_put_off(busy, monkeypatch):
    """No cost injected: the parse itself is timed (30 s on a fake clock) and the next change waits."""
    real = index.store.store_full
    ticks = {"t": 0.0}
    monkeypatch.setattr(index.time, "monotonic", lambda: ticks["t"])

    def slow(*a, **kw):
        real(*a, **kw)
        ticks["t"] += 30.0
    monkeypatch.setattr(index.store, "store_full", slow)
    conn = busy["conn"]
    busy["write"]("вторая находка")
    busy["clock"]["now"] += 1000                                       # the fixture's cheap parse is long past
    assert index.index_all(conn, root=busy["root"], paced=True)["full"] == 1
    full_s, at = conn.execute("SELECT full_s, at FROM index_costs WHERE session_id=?", (SID,)).fetchone()
    assert full_s == 30.0 and at == busy["clock"]["now"]
    busy["write"]("третья находка")
    assert index.index_all(conn, root=busy["root"], paced=True)["deferred"] == 1


def test_a_refresh_someone_asked_for_is_never_put_off(busy):
    """The update button and `atlas search` call index_all without `paced`."""
    conn = busy["conn"]
    _cost(conn, 30.0, busy["clock"]["now"])
    busy["write"]("ещё")
    stats = index.index_all(conn, root=busy["root"])
    assert stats["deferred"] == 0 and stats["full"] == 1


def test_only_the_servers_background_pass_is_paced(monkeypatch):
    from atlas import cli, server
    commands = []
    monkeypatch.setattr(server.subprocess, "Popen", lambda cmd, **kw: commands.append(cmd) or _Done())
    server._Pass()
    assert commands[0][-2:] == ["index", "--paced"]
    assert cli.build_parser().parse_args(["index"]).paced is False            # `atlas index` by hand


class _Done:
    def wait(self, timeout=None): return 0
    def poll(self): return 0
    returncode = 0


def test_a_clock_set_back_does_not_stretch_the_wait(busy):
    conn = busy["conn"]
    _cost(conn, 30.0, busy["clock"]["now"] + 86400)        # recorded "tomorrow", then the clock went back
    busy["write"]("ещё")
    assert index.index_all(conn, root=busy["root"], paced=True)["full"] == 1


def test_an_expensive_session_waits_then_ends_as_a_full_rebuild(busy, atlas_env, tmp_path):
    conn = busy["conn"]
    _cost(conn, 30.0, busy["clock"]["now"])                # its last full parse took 30 s
    busy["write"]("вторая находка субагента")
    busy["clock"]["now"] += 299                            # inside 10 × 30 s
    stats = index.index_all(conn, root=busy["root"], paced=True)
    assert stats["deferred"] == 1 and stats["full"] == 0 and stats["indexed"] == 0
    assert "вторая" not in _sub_text(conn)
    again = index.index_all(conn, root=busy["root"], paced=True)
    assert again["deferred"] == 1                          # still changed: looked at again, not lost

    busy["clock"]["now"] += 2                              # the window has passed
    stats = index.index_all(conn, root=busy["root"], paced=True)
    assert stats["deferred"] == 0 and stats["full"] == 1
    assert "вторая" in _sub_text(conn)

    fresh = _conn(atlas_env["home"], "fresh.sqlite3")      # the same files indexed from scratch
    index.index_all(fresh, root=busy["root"])
    assert _dump(conn) == _dump(fresh)


def test_the_wait_is_capped(busy):
    conn = busy["conn"]
    _cost(conn, 600.0, busy["clock"]["now"])               # 10 × 600 s would be 100 minutes
    busy["write"]("ещё")
    busy["clock"]["now"] += index.FULL_SPACING_MAX_S - 1
    assert index.index_all(conn, root=busy["root"], paced=True)["deferred"] == 1     # still within the cap
    busy["clock"]["now"] += 1
    assert index.index_all(conn, root=busy["root"], paced=True)["full"] == 1


def test_a_cheap_session_is_never_put_off(busy):
    conn = busy["conn"]
    _cost(conn, index.FULL_COST_MIN_S - 0.1, busy["clock"]["now"])
    busy["write"]("ещё")
    assert index.index_all(conn, root=busy["root"], paced=True)["full"] == 1


def test_a_forced_pass_is_never_put_off(busy):
    conn = busy["conn"]
    _cost(conn, 30.0, busy["clock"]["now"])
    busy["write"]("ещё")
    stats = index.index_all(conn, root=busy["root"], full=True, paced=True)
    assert stats["deferred"] == 0 and stats["full"] == 1


def test_a_new_session_is_never_put_off(atlas_env, write_session, monkeypatch):
    conn = _conn(atlas_env["home"])
    conn.execute("INSERT INTO index_costs VALUES (?,?,?)", (SID, 30.0, 1_000_000.0))
    conn.commit()
    monkeypatch.setattr(index, "_clock", lambda: 1_000_001.0)
    write_session("p", [user_text("новая сессия с тем же id")], session_id=SID)
    stats = index.index_all(conn, root=str(atlas_env["projects"]), paced=True)
    assert stats["full"] == 1 and stats["deferred"] == 0


def test_a_removed_session_takes_its_cost_record(busy):
    conn = busy["conn"]
    os.remove(os.path.join(busy["root"], "p", f"{SID}.jsonl"))
    index.index_all(conn, root=busy["root"], paced=True)
    assert conn.execute("SELECT count(*) FROM index_costs").fetchone()[0] == 0


def test_after_a_long_pass_the_next_one_waits_as_long_as_it_ran(monkeypatch):
    from atlas import server
    now = {"t": 1000.0}
    monkeypatch.setattr(server.time, "monotonic", lambda: now["t"])
    started = []

    class Ended:
        def __init__(self, *a, **kw):
            started.append(now["t"])
            self.started, self.ended = now["t"], None
        def is_alive(self): return self.ended is None
        def join(self, timeout=None): pass
    monkeypatch.setattr(server, "_Pass", Ended)
    monkeypatch.setattr(server, "_catchup_proc", None)
    monkeypatch.setattr(server, "_catchup_at", 0.0)
    server.catch_up(wait=False)
    now["t"] += 40
    server._catchup_proc.ended = now["t"]                 # it ran 40 s
    now["t"] += 39
    assert server.catch_up(wait=False) is False and len(started) == 1
    now["t"] += 1                                         # rested as long as it ran
    assert server.catch_up(wait=False) is True and len(started) == 2
    server._catchup_proc.ended = now["t"]                 # that one ended at once
    now["t"] += server.CATCHUP_EVERY
    assert server.catch_up(wait=False) is True and len(started) == 3
    now["t"] += 40
    server._catchup_proc.ended = now["t"]                 # ran 40 s again
    now["t"] += 1
    assert server.catch_up(wait=False) is False and len(started) == 3
    assert server.catch_up(now=True, wait=False) is True and len(started) == 4   # a due full pass does not wait
