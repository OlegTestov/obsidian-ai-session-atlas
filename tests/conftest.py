"""Fixtures: synthetic transcripts for each case covered in the spec."""
from __future__ import annotations

import json
import os
import threading
import uuid

import pytest

from atlas import config

HOME = os.path.expanduser("~")
NOTES = os.path.join(HOME, "Notes")       # test profile vault: path resolution is lexical

# Neutral test profile: for a real user all of this comes from their config.json.
TEST_CONFIG = {
    "language": "ru",
    "vaults": [{"path": "~/Notes", "id": "vault"}],
    "workspace_roots": ["~/Code"],
    "workspace_containers": ["~/Code/MCPs"],
    "domains": [{"id": d, "description": f"домен {d}"}
                for d in ("work", "business", "projects", "personal", "tools")],
    "vault_domain_rules": [["Work", "work"], ["Business", "business"], ["Projects", "projects"],
                           ["Personal", "personal"], ["Finance", "personal"]],
    "project_domains": {"claude-config": "tools"},
    "sensitive": {"vault_areas": ["Personal", "Finance"], "projects": ["secret-client"]},
    "ticket_prefixes": ["ABC", "XYZ", "OPS"],
    "llm_enabled": True,
}


def write_config(home, extra=None) -> None:
    os.makedirs(home, exist_ok=True)
    with open(os.path.join(home, "config.json"), "w", encoding="utf-8") as fh:
        json.dump(dict(TEST_CONFIG, **(extra or {})), fh, ensure_ascii=False)
    config.reset()


@pytest.fixture(autouse=True)
def _test_profile(tmp_path, monkeypatch):
    """Each test gets its own data folder and test profile; real settings stay untouched."""
    home = tmp_path / "atlas-profile"
    monkeypatch.setenv("ATLAS_HOME", str(home))
    write_config(str(home))
    yield
    config.reset()


def rec(**kw) -> str:
    return json.dumps(kw, ensure_ascii=False) + "\n"


def user_text(text, ts="2026-09-01T10:00:00.000Z", cwd="/Users/u/Code/demo", **kw):
    return rec(type="user", timestamp=ts, cwd=cwd, entrypoint="cli", gitBranch="main",
               message={"role": "user", "content": [{"type": "text", "text": text}]}, **kw)


def assistant_text(text, ts="2026-09-01T10:01:00.000Z", cwd="/Users/u/Code/demo"):
    return rec(type="assistant", timestamp=ts, cwd=cwd, entrypoint="cli",
               message={"role": "assistant", "model": "claude-opus-5",
                        "content": [{"type": "text", "text": text}]})


def assistant_tool(name, args, ts="2026-09-01T10:02:00.000Z", cwd="/Users/u/Code/demo"):
    return rec(type="assistant", timestamp=ts, cwd=cwd, entrypoint="cli",
               message={"role": "assistant", "model": "claude-opus-5",
                        "content": [{"type": "tool_use", "id": "t1", "name": name,
                                     "input": args}]})


def tool_result(payload, ts="2026-09-01T10:03:00.000Z"):
    return rec(type="user", timestamp=ts, cwd="/Users/u/Code/demo", entrypoint="cli",
               message={"role": "user",
                        "content": [{"type": "tool_result", "tool_use_id": "t1",
                                     "content": payload}]})


def image_block(ts="2026-09-01T10:04:00.000Z"):
    return rec(type="user", timestamp=ts, cwd="/Users/u/Code/demo", entrypoint="cli",
               message={"role": "user",
                        "content": [{"type": "image",
                                     "source": {"type": "base64", "media_type": "image/png",
                                                "data": "SEKRETBASE64PAYLOAD"}}]})


@pytest.fixture
def atlas_env(tmp_path, monkeypatch):
    """Isolated ATLAS_HOME and transcript root; real data stays untouched."""
    home = tmp_path / "atlas-home"
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setenv("ATLAS_HOME", str(home))
    monkeypatch.setenv("ATLAS_PROJECTS_ROOT", str(projects))
    write_config(str(home))
    import importlib

    from atlas import index as index_mod
    importlib.reload(index_mod)
    return {"home": home, "projects": projects}


@pytest.fixture
def write_session(atlas_env):
    def _write(slug: str, lines: list[str], session_id: str | None = None) -> str:
        folder = atlas_env["projects"] / slug
        folder.mkdir(parents=True, exist_ok=True)
        session_id = session_id or str(uuid.uuid4())
        path = folder / f"{session_id}.jsonl"
        path.write_text("".join(lines), encoding="utf-8")
        os.utime(path, None)
        return str(path)
    return _write


@pytest.fixture
def live_server(atlas_env):
    import socket

    from atlas import server
    with socket.socket() as probe:              # free port: parallel runs do not collide
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server.PORT = port
    server.ALLOWED_HOSTS = {f"127.0.0.1:{port}", f"localhost:{port}"}
    server.ALLOWED_ORIGINS = {f"http://127.0.0.1:{port}"}
    from http.server import ThreadingHTTPServer
    httpd = ThreadingHTTPServer(("127.0.0.1", port), server.Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{port}", server.csrf_token()
    httpd.shutdown()
    httpd.server_close()
