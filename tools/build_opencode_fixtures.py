"""Build the OpenCode catalog fixtures with the native 2.3.2 CLI and a loopback model."""
import argparse
import base64
import json
import os
import socket
import sqlite3
import subprocess
import tempfile
import time
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.request import ProxyHandler, Request, build_opener


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = request["messages"]
        last = next((i for i in reversed(range(len(messages))) if messages[i]["role"] == "user"), -1)
        content = messages[last]["content"] if last >= 0 else ""
        prompt = content if isinstance(content, str) else " ".join(p.get("text", "") for p in content)
        offered = {t["function"]["name"] for t in request.get("tools", []) if "function" in t}
        tool, arguments = None, {}
        if not any(m["role"] == "tool" for m in messages[last + 1:]):
            if prompt == "Fixture file request" and "write" in offered:
                tool, arguments = "write", {"filePath": "atlas-fixture.txt", "content": "hiddenfilecontents"}
            elif prompt == "Fixture shell request" and "shell" in offered:
                tool, arguments = "shell", {"command": "printf hiddencommandoutput", "description": "Print a marker"}
            elif prompt == "Fixture parent request" and "subagent" in offered:
                tool, arguments = "subagent", {"agent": "general", "prompt": "childonlymarker",
                                               "description": "Run synthetic child"}
        answer = {"content": "Synthetic assistant reply"}
        if any("required summary template" in str(m["content"]) or "## Objective" in str(m["content"])
               for m in messages):
            answer = {"content": "## Objective\n- Verify a synthetic compacted session.\n\n"
                      "## Work State\n### Completed\n- Synthetic compacted transcript.\n\n"
                      "## Next Move\n1. Verify usage."}
        if tool:
            answer = {"tool_calls": [{"index": 0, "id": "call_fixture", "type": "function",
                                      "function": {"name": tool, "arguments": json.dumps(arguments)}}]}
        meta = {"id": "chatcmpl-fixture", "created": 1, "model": request.get("model", "fake")}
        usage = {"prompt_tokens": 12, "completion_tokens": 5, "total_tokens": 17,
                 "prompt_tokens_details": {"cached_tokens": 2},
                 "completion_tokens_details": {"reasoning_tokens": 1}}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for delta, finish in [({"role": "assistant"}, None), (answer, None),
                              ({}, "tool_calls" if tool else "stop")]:
            self.send_event(dict(meta, object="chat.completion.chunk",
                                 choices=[{"index": 0, "delta": delta, "finish_reason": finish}]))
        self.send_event(dict(meta, object="chat.completion.chunk", choices=[], usage=usage))
        self.wfile.write(b"data: [DONE]\n\n")

    def send_event(self, event):
        self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())


def eventually(fn, ready=bool):
    for _ in range(160):
        try:
            result = fn()
            if ready(result):
                return result
        except OSError:
            pass
        time.sleep(0.1)
    raise RuntimeError("The isolated OpenCode operation did not finish")


def fixtures(binary, root, model_port, out):
    for sub in ("home", "data", "state", "config/opencode", "cache", "tmp", "project"):
        (root / sub).mkdir(parents=True)
    env = {key: str(root / value) for key, value in [
        ("HOME", "home"), ("XDG_DATA_HOME", "data"), ("XDG_CONFIG_HOME", "config"),
        ("XDG_STATE_HOME", "state"), ("XDG_CACHE_HOME", "cache"), ("TMPDIR", "tmp"),
    ]}
    env.update(PATH=os.defpath, USER="atlas-fixture", LOGNAME="atlas-fixture",
               OPENCODE_DISABLE_AUTOUPDATE="1", OPENCODE_DISABLE_MODELS_FETCH="1")
    model = {"name": "Fixture model", "limit": {"context": 100000, "output": 1000}, "tool_call": True}
    settings = {"model": "atlas/fake", "small_model": "atlas/fake", "update": "disable",
                "providers": {"atlas": {"name": "Atlas Stub", "package": "@opencode/ai/providers/openai-compatible",
                                         "settings": {"baseURL": f"http://127.0.0.1:{model_port}/v1",
                                                      "apiKey": "synthetic"},
                                         "models": {"fake": dict(model, cost={"input": 1000, "output": 2000}),
                                                    "unpriced": model}}},
                "permissions": [{"action": "*", "resource": "*", "effect": "allow"}]}
    (root / "config/opencode/opencode.json").write_text(json.dumps(settings))
    run = str(binary)
    opts = {"cwd": root / "project", "env": env, "check": True, "timeout": 30, "capture_output": True}
    if subprocess.run([run, "--version"], **opts).stdout.decode().strip() != "opencode v2.3.2":
        raise ValueError("Fixtures require OpenCode 2.3.2")
    with socket.socket() as port:
        port.bind(("127.0.0.1", 0))
        number = port.getsockname()[1]
    subprocess.run([run, "service", "set", "port", str(number)], **opts)
    registry = root / "state/opencode/service.json"
    try:
        subprocess.run([run, "service", "start"], **opts)
        registration = eventually(lambda: json.loads(registry.read_text()))
        if registration["url"].rstrip("/") != f"http://127.0.0.1:{number}":
            raise RuntimeError("Unexpected isolated OpenCode service URL")
        build_rows(root, number, registration["password"], out)
    finally:
        if registry.is_file():
            subprocess.run([run, "service", "stop"], **opts)


def build_rows(root, port, password, out):
    opener = build_opener(ProxyHandler({}))
    auth = base64.b64encode(f"opencode:{password}".encode()).decode()

    def call(method, route, body=None):
        req = Request(f"http://127.0.0.1:{port}/api/{route}", method=method,
                      headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"},
                      data=json.dumps(body).encode() if body is not None else None)
        with opener.open(req, timeout=5) as response:
            raw = response.read()
            return json.loads(raw)["data"] if raw else None

    def create(title, model="fake"):
        return call("POST", "session", {"title": title, "location": {"directory": str(root / "project")},
                                      "model": {"providerID": "atlas", "id": model}})["id"]

    def turns(sid):
        return call("GET", f"session/{sid}/message")

    def wait_idle(sid, count):
        return eventually(lambda: turns(sid), lambda rows: sum(r["type"] == "idle" for r in rows) >= count)

    def prompt(sid, content, count):
        call("POST", f"session/{sid}/prompt", {"text": content})
        wait_idle(sid, count)

    plain = create("OpenCode fixture plain", "unpriced")
    prompt(plain, "Fixture plain request", 1)
    many = create("OpenCode fixture multiple")
    prompt(many, "Fixture first request", 1)
    prompt(many, "Fixture second request", 2)
    fork = call("POST", f"session/{many}/fork", {})["id"]
    prompt(fork, "Fixture fork request", 3)
    tools = create("OpenCode fixture tools")
    prompt(tools, "Fixture file request", 1)
    prompt(tools, "Fixture shell request", 2)
    archive = create("OpenCode fixture archived")
    prompt(archive, "Fixture archive request", 1)
    call("PATCH", f"session/{archive}", {"archived": True})
    parent = create("OpenCode fixture parent")
    prompt(parent, "Fixture parent request", 1)
    child = eventually(lambda: next((r["id"] for r in call("GET", "session?limit=30")
                                     if r.get("parentID") == parent), None))
    wait_idle(child, 1)
    wait_idle(parent, 2)
    compact = create("OpenCode fixture compaction")
    prompt(compact, "Fixture compaction request", 1)
    call("POST", f"session/{compact}/compact", {})
    compacted = eventually(lambda: next((r for r in turns(compact) if r["type"] == "compaction"
                                        and r.get("status") in {"completed", "failed"}), None))
    if compacted["status"] != "completed":
        raise RuntimeError(f"Fixture compaction failed: {compacted.get('error')}")
    wait_idle(compact, 2)
    create("OpenCode fixture empty")
    snapshot(root / "data/opencode/opencode.db", out)


def snapshot(source, out):
    out.mkdir(parents=True, exist_ok=True)
    for name in ("opencode.db", "v1.db", "unsupported.db"):
        target = out / name
        target.unlink(missing_ok=True)
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as src, \
                closing(sqlite3.connect(target)) as dst, dst:
            src.execute("PRAGMA query_only=1")
            src.backup(dst)
            dst.execute("PRAGMA journal_mode=DELETE")
            # V2 fresh installs omit the frozen V1 projections. Model a migrated file with
            # synthetic compatibility rows, including one legacy-only ID.
            dst.executescript("""
                CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT);
                CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
                CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
                INSERT INTO session SELECT id, directory, 'Legacy shadow: ' || title FROM session_v2;
                INSERT INTO session VALUES ('ses_00000000000000000000000000', '/projects/atlas-fixture',
                                            'Legacy only marker');
                INSERT INTO message VALUES ('msg_legacy', 'ses_00000000000000000000000000', '{}');
                INSERT INTO part VALUES ('prt_legacy', 'msg_legacy', 'ses_00000000000000000000000000',
                                         '{"type":"text","text":"legacyonlytext"}');
            """)
            if name == "unsupported.db":
                dst.execute("ALTER TABLE session_v2 RENAME COLUMN time_updated TO unsupported_column")
            elif name == "v1.db":
                for table in ("session_part", "session_message", "session_v2"):
                    dst.execute(f"DROP TABLE {table}")
            else:
                # Portable catalog paths, independent of the build machine's temporary directory.
                dst.execute("UPDATE session_v2 SET directory='/projects/atlas-fixture'")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path, help="Path to the OpenCode 2.3.2 CLI")
    args = parser.parse_args()
    output = Path(__file__).resolve().parents[1] / "tests/fixtures/opencode"
    if output.resolve() != output or any(output.glob("*.db-wal")) or any(output.glob("*.db-shm")):
        raise ValueError("The fixture output must be a closed, local directory in the checkout")
    with tempfile.TemporaryDirectory(prefix="opencode-atlas-fixture-") as temp, \
            ThreadingHTTPServer(("127.0.0.1", 0), Model) as stub:
        Thread(target=stub.serve_forever, daemon=True).start()
        try:
            fixtures(args.binary.resolve(strict=True), Path(temp), stub.server_port, output)
        finally:
            stub.shutdown()
