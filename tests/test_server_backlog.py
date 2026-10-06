"""The page loads its ~35 scripts at once: the server must accept a burst of connections."""
from __future__ import annotations

import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from atlas import server


def test_a_burst_of_page_requests_all_succeed(atlas_env):
    assert server.Server.request_queue_size >= 64
    httpd = server.Server(("127.0.0.1", 0), server.Handler)
    port = httpd.server_address[1]
    hosts, origins = server.ALLOWED_HOSTS, server.ALLOWED_ORIGINS
    server.ALLOWED_HOSTS = {f"127.0.0.1:{port}"}
    server.ALLOWED_ORIGINS = {f"http://127.0.0.1:{port}"}
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    def get(_):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/static/actions.js", timeout=10) as r:
            return r.status
    try:
        with ThreadPoolExecutor(max_workers=40) as pool:
            for _ in range(5):
                assert list(pool.map(get, range(40))) == [200] * 40
    finally:
        httpd.shutdown()
        httpd.server_close()
        server.ALLOWED_HOSTS, server.ALLOWED_ORIGINS = hosts, origins
