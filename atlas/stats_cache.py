"""Stats snapshots prepared in the background: the page gets the last one at once.

A full count over a large index takes seconds, and agents write to the index every few seconds, so
"valid while nothing changed" would almost never hold. A snapshot is fresh for FRESH_S; an older one
is returned at once marked stale while a newer one is computed. One worker thread runs every count
(warm-up, refreshes, first requests), so parallel requests never run several counts at once.
"""
from __future__ import annotations

import copy
import json
import queue
import threading
import time
from collections import OrderedDict

from . import config, db, messages, stats

FRESH_S = 60.0       # a snapshot this young is served as current
RETRY_S = 10.0       # after a failed count the key is not counted again sooner
SIZE = 8             # snapshots kept: periods × automation × agent filters actually opened


def key_for(period: str, automation: bool, agents, lang: str) -> tuple:
    """Everything the numbers depend on besides the data: prices from config.json change costs
    without a reindex, the language changes labels, the UTC offset moves days and hours."""
    prices = config.get("openai_prices") or {}
    return (period, bool(automation), tuple(agents) if agents else None, lang,
            json.dumps(prices, sort_keys=True, default=str), time.localtime().tm_gmtoff)


def compute(key: tuple) -> dict:
    period, automation, agents, lang, prices, _offset = key
    conn = db.connect()
    try:
        with messages.use_lang(lang):
            return stats.summary(conn, period, automation=automation,
                                 agents=list(agents) if agents else None, prices=json.loads(prices))
    finally:
        conn.close()


def _own(error: BaseException) -> BaseException:
    """A copy per caller: raising one shared object from several threads mixes their tracebacks."""
    return copy.copy(error)


class _Job:
    def __init__(self):
        self.done = threading.Event()
        self.error: BaseException | None = None


class Snapshots:
    def __init__(self, count=compute, clock=time.monotonic):
        self._count, self._clock = count, clock
        self._lock = threading.Lock()
        self._entries: OrderedDict = OrderedDict()   # key -> (result, counted_at)
        self._jobs: dict = {}                          # key -> _Job in flight
        self._failed: dict = {}                        # key -> (when its last count failed, error)
        self._queue: queue.Queue = queue.Queue()
        self._worker: threading.Thread | None = None

    def get(self, key: tuple) -> dict:
        """The snapshot for key, with `stale` and `refresh_failed`; waits only when there is none."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                self._entries.move_to_end(key)
                result, counted_at = entry
                stale = self._clock() - counted_at >= FRESH_S
                failed = self._recently_failed(key)
                if stale and not failed:
                    self._schedule(key)
                return dict(result, stale=stale, refresh_failed=stale and failed)
            if self._recently_failed(key):
                raise _own(self._failed[key][1])          # no snapshot and a count just failed
            job = self._schedule(key)
        job.done.wait()
        if job.error is not None:
            raise _own(job.error)
        return self.get(key)

    def warm(self, key: tuple) -> None:
        with self._lock:
            if key not in self._entries:
                self._schedule(key)

    def _recently_failed(self, key) -> bool:
        failed = self._failed.get(key)
        return failed is not None and self._clock() - failed[0] < RETRY_S

    def _schedule(self, key) -> _Job:
        """Under the lock: one job per key; the worker starts on first use."""
        job = self._jobs.get(key)
        if job is None:
            job = self._jobs[key] = _Job()
            self._queue.put(key)
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._run, name="stats-snapshots", daemon=True)
            self._worker.start()
        return job

    def _run(self) -> None:
        while True:
            key = self._queue.get()
            started = self._clock()
            result, error = None, None
            try:
                result = self._count(key)
            except BaseException as exc:      # the worker must outlive any failed count
                error = exc.with_traceback(None)   # kept for 10 s: not with the worker's frames
            with self._lock:
                job = self._jobs.pop(key)
                if error is None:
                    self._entries[key] = (result, started)
                    self._entries.move_to_end(key)
                    while len(self._entries) > SIZE:
                        self._entries.popitem(last=False)
                    self._failed.pop(key, None)
                else:
                    self._failed[key] = (self._clock(), error)
                job.error = error
            job.done.set()


SNAPSHOTS = Snapshots()
