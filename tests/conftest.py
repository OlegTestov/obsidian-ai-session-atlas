"""Fixtures: synthetic transcripts for each case covered in the spec."""
from __future__ import annotations

import json
import os
import threading
import uuid

import pytest

from atlas import codex_usage, config

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
    # The indexer also reads Codex rollouts: never the real ~/.codex in tests.
    monkeypatch.setenv("ATLAS_CODEX_HOME", str(tmp_path / "codex-home"))
    # Never the real codex: an empty value turns the binary search off; tests set a stand-in.
    monkeypatch.setenv("ATLAS_CODEX_BIN", "")
    codex_usage.reset()
    write_config(str(home))
    yield
    codex_usage.reset()
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


# --- Codex rollouts: made-up content in the real record structure (docs/codex-plan.md) ---

def cx(kind, payload, ts="2026-09-01T10:00:00.000Z") -> str:
    """Compact separators and key order as Codex writes them: the parser skips some lines by their head."""
    return json.dumps({"timestamp": ts, "type": kind, "payload": payload},
                      ensure_ascii=False, separators=(",", ":")) + "\n"


def cx_meta(thread_id, cwd="/Users/u/Code/demo", originator="codex-tui", source="cli",
            thread_source="user", branch="main", ts="2026-09-01T10:00:00.000Z"):
    return cx("session_meta", {"id": thread_id, "timestamp": ts, "cwd": cwd,
                               "originator": originator, "cli_version": "0.160.0",
                               "source": source, "thread_source": thread_source,
                               "base_instructions": {"text": "SYSTEM-INSTRUCTIONS-NEVER-INDEXED"},
                               "git": {"branch": branch, "commit_hash": "abc123"}}, ts)


def cx_meta_current(thread_id, cwd="/Users/u/Code/demo", ts="2026-10-05T09:13:40.170Z") -> str:
    """session_meta exactly as codex-cli 0.160 writes it (sanitized): `ordinal` in the record, the
    payload opens with creator_user_id/creator_account_id, then session_id and id; compact JSON."""
    payload = {"creator_user_id": "user-PLACEHOLDER", "creator_account_id": "acct-PLACEHOLDER",
               "session_id": thread_id, "id": thread_id, "timestamp": ts, "cwd": cwd,
               "runtime_workspace_roots": [cwd], "originator": "codex-tui", "cli_version": "0.160.0",
               "source": "vscode", "thread_source": "user", "model_provider": "openai",
               "base_instructions": {"text": "SYSTEM-INSTRUCTIONS-NEVER-INDEXED " * 400},
               "history_mode": "paginated", "context_window": 272000,
               "git": {"commit_hash": "abc123", "branch": "main"}}
    return json.dumps({"timestamp": ts, "ordinal": 0, "type": "session_meta", "payload": payload},
                      ensure_ascii=False, separators=(",", ":")) + "\n"


def cx_context(model="gpt-5.5-codex", cwd="/Users/u/Code/demo", ts="2026-09-01T10:00:01.000Z"):
    return cx("turn_context", {"turn_id": "t1", "cwd": cwd, "model": model, "effort": "high"}, ts)


def cx_user(text, ts="2026-09-01T10:00:02.000Z"):
    return (cx("response_item", {"type": "message", "role": "user",
                                 "content": [{"type": "input_text", "text": text}]}, ts)
            + cx("event_msg", {"type": "user_message", "message": text, "images": []}, ts))


def cx_agent(text, ts="2026-09-01T10:00:30.000Z"):
    return (cx("response_item", {"type": "message", "role": "assistant",
                                 "content": [{"type": "output_text", "text": text}]}, ts)
            + cx("event_msg", {"type": "agent_message", "message": text}, ts))


def cx_exec(cmd, ts="2026-09-01T10:00:10.000Z"):
    return (cx("response_item", {"type": "function_call", "name": "exec_command", "call_id": "c1",
                                 "arguments": json.dumps({"cmd": cmd, "workdir": "/Users/u/Code/demo"})}, ts)
            + cx("response_item", {"type": "function_call_output", "call_id": "c1",
                                   "output": "RAW-TOOL-OUTPUT-NEVER-INDEXED"}, ts))


def cx_patch(body, ts="2026-09-01T10:00:20.000Z"):
    return cx("response_item", {"type": "custom_tool_call", "name": "apply_patch", "call_id": "p1",
                                "input": "*** Begin Patch\n" + body + "*** End Patch\n"}, ts)


def cx_patch_end(changes, ts="2026-09-01T10:00:21.000Z", success=True):
    return cx("event_msg", {"type": "patch_apply_end", "call_id": "p1", "success": success,
                            "changes": changes, "stdout": "", "stderr": ""}, ts)


def cx_tokens(inp, cached, out, reasoning=0, total=None, ts="2026-09-01T10:00:31.000Z"):
    last = {"input_tokens": inp, "cached_input_tokens": cached, "output_tokens": out,
            "reasoning_output_tokens": reasoning, "total_tokens": inp + out}
    return cx("event_msg", {"type": "token_count", "rate_limits": {},
                            "info": {"last_token_usage": last,
                                     "total_token_usage": dict(last, total_tokens=total or inp + out)}}, ts)


def cx_reasoning(ts="2026-09-01T10:00:05.000Z"):
    return cx("response_item", {"type": "reasoning", "summary": [{"type": "summary_text",
                                "text": "REASONING-NEVER-INDEXED"}], "encrypted_content": "QUJD"}, ts)


def write_codex_state(home, titles: dict) -> str:
    """A minimal state_5.sqlite: {thread id: (title, name)}."""
    import sqlite3
    os.makedirs(home, exist_ok=True)
    path = os.path.join(home, "state_5.sqlite")
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, name TEXT)")
    conn.executemany("INSERT INTO threads (id, title, name) VALUES (?,?,?)",
                     [(k, t, n) for k, (t, n) in titles.items()])
    conn.commit()
    conn.close()
    return path


@pytest.fixture
def codex_home():
    return os.environ["ATLAS_CODEX_HOME"]


@pytest.fixture
def write_rollout(codex_home):
    def _write(lines: list[str], thread_id: str | None = None, archived: bool = False,
               day: str = "2026/09/01") -> str:
        thread_id = thread_id or str(uuid.uuid4())
        folder = os.path.join(codex_home, "archived_sessions") if archived \
            else os.path.join(codex_home, "sessions", *day.split("/"))
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, f"rollout-{day.replace('/', '-')}T10-00-00-{thread_id}.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("".join(lines))
        return path
    return _write
