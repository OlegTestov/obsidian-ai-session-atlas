"""Run a disposable OpenCode 2.3.2 service with a loopback model and record the native contract."""
from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
from contextlib import contextmanager, suppress
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from build_opencode_fixtures import Model, eventually

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from atlas import opencode_service as oc

PINNED = "2.3.2"


@contextmanager
def profile(root, binary, *, model_handler=Model, permissions=None):
    env = {"PATH": os.defpath, "USER": "atlas-fixture", "LOGNAME": "atlas-fixture",
           "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_MODELS_FETCH": "1"}
    for key, name in (("HOME", "home"), ("XDG_DATA_HOME", "data"), ("XDG_CONFIG_HOME", "config"),
                      ("XDG_STATE_HOME", "state"), ("XDG_CACHE_HOME", "cache"), ("TMPDIR", "tmp")):
        directory = root / name
        directory.mkdir()
        env[key] = str(directory)
    work = root / "work"
    work.mkdir()
    config = root / "config/opencode"
    config.mkdir()
    model = ThreadingHTTPServer(("127.0.0.1", 0), model_handler)
    model_thread = Thread(target=model.serve_forever, daemon=True)
    model_thread.start()
    server_pid = None
    try:
        settings = {"model": "atlas/fake", "small_model": "atlas/fake", "update": "disable",
                    "providers": {"atlas": {
                        "name": "Atlas Stub", "package": "@opencode/ai/providers/openai-compatible",
                        "settings": {"baseURL": f"http://127.0.0.1:{model.server_port}/v1", "apiKey": "synthetic"},
                        "models": {"fake": {"name": "Fixture", "limit": {"context": 100000, "output": 1000}}}}},
                    "permissions": permissions or [{"action": "*", "resource": "*", "effect": "deny"}]}
        (config / "opencode.json").write_text(json.dumps(settings))
        opts = {"cwd": work, "env": env, "check": True, "timeout": 20, "capture_output": True}
        if subprocess.run([binary, "--version"], **opts).stdout.decode().strip() != "opencode v" + PINNED:
            raise ValueError("This probe requires OpenCode " + PINNED)
        with socket.socket() as address:
            address.bind(("127.0.0.1", 0))
            port = address.getsockname()[1]
        subprocess.run([binary, "service", "set", "port", str(port)], **opts)
        subprocess.run([binary, "service", "start"], **opts)
        registration = eventually(lambda: json.loads((root / "state/opencode/service.json").read_text()))
        if registration["url"].rstrip("/") != f"http://127.0.0.1:{port}" or registration["version"] != PINNED:
            raise RuntimeError("Unexpected isolated service registration")
        server_pid = registration["pid"]
        file = root / "state/opencode/service.json"
        client = oc.Client(oc.Discovery("ready", oc._registration(file), file=file))
        identity = client.call("GET", "info")
        if identity["pid"] != server_pid or identity["version"] != PINNED:
            raise RuntimeError("Unexpected isolated service identity")
        yield client, work, env
    finally:
        if server_pid is not None:
            with suppress(ProcessLookupError):
                os.kill(server_pid, signal.SIGTERM)
        model.shutdown()
        model.server_close()
        model_thread.join()


def capture(client, work):
    def create(title, **extra):
        return client.call("POST", "session", {
            "title": title, "location": {"directory": str(work)}, **extra,
        })

    source = create("A2 synthetic source")["data"]["id"]
    child = create("A2 synthetic child", parentID=source)["data"]["id"]
    session = "session/" + source
    client.call("POST", session + "/prompt", {"text": "A2 synthetic request"})

    def settled():
        turns = client.data(session + "/message", expect=list)
        return any(row["type"] == "idle" for row in turns)

    eventually(settled)
    info = client.call("GET", "info")
    client.info = info
    database = client.database_path(work.parent / "data/opencode/opencode.db")
    if database is None:
        raise RuntimeError("Could not verify the isolated service database")
    children = client.call("GET", "session?parentID=" + source)
    empty = create("A2 empty")
    fork = client.call("POST", session + "/fork", {})
    client.call("PATCH", session, {"title": "A2 renamed", "archived": True})
    changed = client.call("GET", session)
    active = client.call("GET", "session/active")
    listing = client.call("GET", "session?limit=100")
    deleted = client.call("DELETE", session)
    for sid in (source, child):
        try:
            client.call("GET", "session/" + sid)
        except oc.ServiceError as exc:
            if exc.status != 404:
                raise
        else:
            raise AssertionError("Native cascade deletion did not remove a session")
    return {"info": info, "observed_database": str(database), "changed": changed, "active": active, "listing": listing,
            "children": children, "empty": empty, "fork": fork, "delete": deleted}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--contract", type=Path, required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="atlas-opencode-a2-") as folder:
        root = Path(folder).resolve()
        with profile(root, str(args.binary.absolute())) as (client, work, _env):
            result = capture(client, work)
            result["info"]["pid"] = 211
            result["info"]["hostname"] = "atlas-fixture"
            result["info"]["urls"] = ["http://127.0.0.1:12345"]
            text = json.dumps(result, indent=2, sort_keys=True).replace(str(root), "/atlas-fixture")
            args.contract.write_text(text + "\n")


if __name__ == "__main__":
    main()
