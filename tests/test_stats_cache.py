"""Stats snapshots: served at once, refreshed in the background by one worker."""
from __future__ import annotations

import json
import threading
import time

import pytest

from atlas import config, stats_cache
from atlas.stats_cache import FRESH_S, RETRY_S, SIZE, Snapshots


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class Counter:
    """A count that can be held, made to fail, and that records which keys ran and how many at once."""

    def __init__(self):
        self.calls, self.running, self.most = [], 0, 0
        self.gate = threading.Event()
        self.gate.set()
        self.fail = False
        self.lock = threading.Lock()

    def __call__(self, key):
        with self.lock:
            self.running += 1
            self.most = max(self.most, self.running)
            self.calls.append(key)
            n = len(self.calls)
        self.gate.wait(5)
        with self.lock:
            self.running -= 1
        if self.fail:
            raise RuntimeError("count failed")
        return {"key": key, "n": n}


def _settle(snap):
    for _ in range(200):
        with snap._lock:
            if not snap._jobs:
                return
        time.sleep(0.01)
    raise AssertionError("the worker did not finish")


@pytest.fixture
def snap():
    clock, count = Clock(), Counter()
    s = Snapshots(count=count, clock=clock)
    s.clock, s.count = clock, count
    return s


def test_first_request_waits_then_repeats_are_fresh(snap):
    first = snap.get(("7d",))
    assert first["n"] == 1 and first["stale"] is False and first["refresh_failed"] is False
    snap.clock.now += FRESH_S - 1
    assert snap.get(("7d",))["n"] == 1
    assert snap.count.calls == [("7d",)]


def test_an_old_snapshot_comes_at_once_and_one_refresh_is_queued(snap):
    snap.get(("7d",))
    snap.clock.now += FRESH_S
    snap.count.gate.clear()                              # the refresh is still counting
    for _ in range(3):
        got = snap.get(("7d",))
        assert got["n"] == 1 and got["stale"] is True
    snap.count.gate.set()
    _settle(snap)
    assert len(snap.count.calls) == 2                    # three stale reads, one refresh
    got = snap.get(("7d",))
    assert got["n"] == 2 and got["stale"] is False


def test_parallel_first_requests_share_one_count_and_never_run_two_at_once(snap):
    snap.count.gate.clear()
    out = []
    threads = [threading.Thread(target=lambda k=k: out.append(snap.get(k)))
               for k in [("7d",), ("7d",), ("30d",), ("all",)]]
    for t in threads:
        t.start()
    time.sleep(0.1)
    snap.count.gate.set()
    for t in threads:
        t.join(5)
    assert len(out) == 4
    assert sorted(snap.count.calls) == [("30d",), ("7d",), ("all",)]
    assert snap.count.most == 1                          # one worker: counts run one after another


def test_a_failed_count_wakes_waiters_keeps_the_snapshot_and_backs_off(snap):
    snap.count.fail = True
    with pytest.raises(RuntimeError):
        snap.get(("7d",))                                # no snapshot yet: the error is returned
    snap.count.fail = False
    with pytest.raises(RuntimeError):
        snap.get(("7d",))                                # within RETRY_S: the saved error, no new count
    assert len(snap.count.calls) == 1
    snap.clock.now += RETRY_S
    assert snap.get(("7d",))["stale"] is False           # a later request counts again
    snap.clock.now += FRESH_S
    snap.count.fail = True
    assert snap.get(("7d",))["stale"] is True             # the old snapshot is still served
    _settle(snap)
    calls = len(snap.count.calls)
    got = snap.get(("7d",))
    assert got["refresh_failed"] is True and got["n"] == 2
    assert len(snap.count.calls) == calls                 # no retry within RETRY_S
    snap.clock.now += RETRY_S
    snap.count.fail = False
    snap.get(("7d",))
    _settle(snap)
    got = snap.get(("7d",))
    assert got["stale"] is False and got["refresh_failed"] is False
    assert snap._worker.is_alive()


def test_every_caller_gets_its_own_copy_of_a_failed_count(snap):
    """One shared exception raised in several threads would mix their tracebacks; the saved one
    does not keep the worker's frames alive."""
    snap.count.fail = True
    with pytest.raises(RuntimeError) as first:
        snap.get(("7d",))
    with pytest.raises(RuntimeError) as second:      # inside the retry window: the saved error
        snap.get(("7d",))
    assert first.value is not second.value and str(first.value) == str(second.value) == "count failed"
    assert snap._failed[("7d",)][1].__traceback__ is None


def test_only_the_last_opened_views_are_kept(snap):
    for i in range(SIZE + 2):
        snap.get((f"k{i}",))
    with snap._lock:
        kept = list(snap._entries)
    assert len(kept) == SIZE and ("k0",) not in kept and (f"k{SIZE + 1}",) in kept


def test_warm_counts_a_view_before_it_is_opened(snap):
    snap.warm(("7d",))
    _settle(snap)
    assert snap.get(("7d",))["n"] == 1 and len(snap.count.calls) == 1


def test_the_key_follows_prices_language_and_timezone(atlas_env, monkeypatch):
    base = stats_cache.key_for("7d", False, None, "ru")
    assert stats_cache.key_for("7d", False, None, "en") != base
    assert stats_cache.key_for("7d", True, ["codex"], "ru") != base
    monkeypatch.setattr(config, "get", lambda name: {"gpt-x": [1, 0.1, 2]} if name == "openai_prices" else None)
    priced = stats_cache.key_for("7d", False, None, "ru")
    assert priced != base and json.loads(priced[4]) == {"gpt-x": [1, 0.1, 2]}


def test_one_count_prices_every_row_from_one_snapshot(atlas_env, monkeypatch):
    """A config edit during a count cannot mix prices: the count gets them once, from the key."""
    from atlas import stats
    seen = []
    monkeypatch.setattr(stats, "summary", lambda conn, period, automation, agents, prices: seen.append(prices) or {})
    reads = []
    monkeypatch.setattr(config, "get", lambda name: reads.append(name) or {"gpt-x": [9, 9, 9]})
    stats_cache.compute(("7d", False, None, "en", json.dumps({"gpt-x": [1, 0.1, 2]}), 0))
    assert seen == [{"gpt-x": [1, 0.1, 2]}] and reads == []


def test_http_hits_answer_at_once_while_the_index_is_busy(atlas_env, write_session, live_server, monkeypatch):
    """Fresh and stale hits stay fast while a pass is due and running and another connection holds
    the writer lock after an index setting changed (the reindex check would wait for it)."""
    import urllib.request

    from atlas import db, index, server
    from tests.conftest import assistant_text, user_text, write_config
    write_session("p", [user_text("hello"), assistant_text("hi")])
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.close()
    clock = Clock()
    monkeypatch.setattr(stats_cache, "SNAPSHOTS", Snapshots(clock=clock))

    class Busy:                                    # an index pass that never finishes
        def __init__(self, *a, **kw): pass
        def is_alive(self): return True
        def join(self, timeout=None): time.sleep(timeout or 0)
        def stop(self): pass
    monkeypatch.setattr(server, "_Pass", Busy)
    monkeypatch.setattr(server, "_catchup_proc", None)
    monkeypatch.setattr(server, "_catchup_at", 0.0)
    base, _ = live_server

    def get():
        started = time.monotonic()
        req = urllib.request.Request(f"{base}/api/stats?period=all&auto=0",   # fixture dates are in the past
                                     headers={"Host": base.split("//")[1]})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())
        return data, time.monotonic() - started

    first, _ = get()                               # the first count: no snapshot yet
    assert first["stale"] is False and "totals" in first
    write_config(str(atlas_env["home"]), {"ticket_prefixes": ["ZZZ"]})   # a reindex is now due
    holder = db.connect()
    holder.execute("BEGIN IMMEDIATE")
    holder.execute("UPDATE meta SET value=value WHERE key='schema_version'")
    try:
        fresh, took = get()
        assert fresh["stale"] is False and took < 0.2
        clock.now += FRESH_S
        stale, took = get()
        assert stale["stale"] is True and took < 0.2
    finally:
        holder.rollback()
        holder.close()


def test_the_warm_up_is_in_the_page_language(atlas_env, live_server, monkeypatch):
    """The server learns the language from the plugin's first request; a restart must not warm
    English for a Russian page."""
    import urllib.request

    from atlas import server
    monkeypatch.setattr(server, "_warmed", set())
    warmed = []
    monkeypatch.setattr(stats_cache.SNAPSHOTS, "warm", warmed.append)
    base, _ = live_server

    def get(lang=None):
        headers = {"Host": base.split("//")[1]}
        if lang:
            headers["X-Atlas-Lang"] = lang
        with urllib.request.urlopen(urllib.request.Request(f"{base}/api/commands", headers=headers), timeout=30):
            pass

    get()                                            # no header: the language is unknown yet
    assert warmed == []
    get("ru")
    get("ru")
    assert [(k[0], k[1], k[2], k[3]) for k in warmed] == [("7d", False, None, "ru")]
    get("en")                                        # the owner switched the language
    assert [k[3] for k in warmed] == ["ru", "en"]
