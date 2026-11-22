"""Bind a fixture listener in a process holding only the selected SQLite WAL files."""

import json
import os
import socket
import sqlite3
import sys
from contextlib import ExitStack, closing, contextmanager
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


@contextmanager
def held_wal(path):
    with closing(sqlite3.connect(path)) as conn:
        assert conn.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        with conn:
            conn.execute("CREATE TABLE IF NOT EXISTS fixture_probe(x)")
            conn.execute("INSERT INTO fixture_probe VALUES (1)")
        yield conn


def main():
    """Give lsof a dedicated listener PID with only the selected WAL databases open."""
    config = json.loads(sys.stdin.readline())
    upstream = urlsplit(config["url"])
    address = config.get("address", "127.0.0.1")

    class Listener(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in address else socket.AF_INET

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            size = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(size) if size else None
            with closing(HTTPConnection(upstream.hostname, upstream.port, timeout=3)) as conn:
                conn.request(self.command, self.path, body)
                response = conn.getresponse()
                payload = response.read()
            if self.path == "/api/info" and response.status == 200:
                payload = json.dumps(dict(json.loads(payload), pid=os.getpid())).encode()
            self.send_response(response.status)
            self.end_headers()
            self.wfile.write(payload)

        do_PATCH = do_GET

    with ExitStack() as stack:
        for path in config["paths"]:
            stack.enter_context(held_wal(path))
        listener = stack.enter_context(Listener((address, 0), Handler))
        print(listener.server_port, flush=True)
        listener.serve_forever()


if __name__ == "__main__":
    main()
