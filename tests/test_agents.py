"""The registry can describe another agent while native operations still require an implementation."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from atlas import (
    actions,
    agents,
    cache_rewrites,
    config,
    convert,
    convert_read,
    db,
    delete,
    feed,
    index,
    launch,
    relocate,
    runner,
    touched,
)
from tests.conftest import cx_agent, cx_meta, cx_user, user_text

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "atlas" / "agents.json"
FAKE = json.loads((ROOT / "tests/js/helpers/fake-agent.json").read_text())
FAKE_ID = "fk_ab12cd34"
UUID = "01234567-89AB-cdef-0123-456789abcdef"


@pytest.fixture
def fake_registry(tmp_path, monkeypatch):
    path = tmp_path / "agents.json"
    path.write_text(json.dumps([*json.loads(REGISTRY.read_text()), FAKE]))
    registry, patterns = agents._load(path)
    monkeypatch.setattr(agents, "_REGISTRY", registry)
    monkeypatch.setattr(agents, "_PATTERNS", patterns)
    return path


def test_registry_filter_and_grammar(fake_registry):
    assert agents.all() == ("claude", "codex", "opencode", "fake")
    assert agents.get("fake")["short"] == "Fake"
    assert agents.label("codex") == "Codex"
    assert agents.mail_prefix("claude") == "c"
    assert agents.parse_filter(["fake"]) == ["fake"]
    assert agents.parse_filter(["claude,codex,other,fake"]) == ["claude", "codex", "fake"]
    assert agents.parse_filter(["claude,codex,opencode,fake"]) is None
    with pytest.raises(agents.UnknownAgent, match="other"):
        agents.parse_filter(["other"])
    assert [agents.valid_id(kind, UUID) for kind in agents.all()] == [True, True, False, False]
    assert [agents.valid_id(kind, FAKE_ID) for kind in agents.all()] == [False, False, False, True]
    for invalid in ("-" * 36, UUID + "\n", UUID.replace("-", ""), None):
        assert not agents.valid_id("claude", invalid)
    assert not agents.valid_id("fake", FAKE_ID.upper())
    assert actions.resume_command("/tmp", UUID).endswith(UUID)
    with pytest.raises(agents.UnknownAgent, match="other"):
        agents.valid_id("other", UUID)


@pytest.mark.parametrize(("rows", "message"), [
    ([FAKE, FAKE], "Duplicate agent id"),
    ([dict(FAKE, label="")], "Malformed agent registry"),
    ([dict(FAKE, idPattern="fk_")], "Unanchored session id pattern"),
    ([dict(FAKE, idPattern="^[$")], "Invalid session id pattern"),
])
def test_malformed_registry_fails_on_load(tmp_path, rows, message):
    path = tmp_path / "agents.json"
    path.write_text(json.dumps(rows))
    with pytest.raises(ValueError, match=message):
        agents._load(path)


@pytest.mark.usefixtures("fake_registry")
def test_fake_dispatch_refusals(atlas_env, tmp_path, monkeypatch):
    path = tmp_path / (FAKE_ID + ".jsonl")
    path.write_text(user_text("transcript should remain untouched", cwd=str(tmp_path)))
    before = path.read_bytes()
    conn = db.connect()
    conn.executemany(
        "INSERT INTO sessions(session_id, source_path, agent, cwd_last, session_kind) "
        "VALUES (?, ?, ?, ?, 'interactive')",
        [(FAKE_ID, str(path), "fake", str(tmp_path)), (UUID, str(path), "claude", str(tmp_path))],
    )
    conn.execute("INSERT INTO activity(session_id, key, kind, ts, cost) VALUES (?, 'test', 'a', '2026-09-01', 1)",
                 (FAKE_ID,))
    conn.commit()
    monkeypatch.setattr(runner, "llm_enabled", lambda: True)
    original = config.get
    monkeypatch.setattr(config, "get", lambda key: "fake" if key == "ai_agent" else original(key))
    calls = {
        "transcript parsing": lambda: agents.parse_session(str(path), FAKE_ID, "fake"),
        "conversion reads": lambda: convert_read.read(str(path), FAKE_ID, "fake"),
        "conversion writes": lambda: convert.plan(conn, UUID, "fake"),
        "conversation feed": lambda: feed.feed_page(str(path), agent="fake"),
        "touched files": lambda: touched.session_files(str(path), agent="fake"),
        "immediate indexing": lambda: index.index_one(conn, str(path), "fake"),
        "resume": lambda: actions.resume_command(str(tmp_path), FAKE_ID, agent="fake"),
        "new session launch": lambda: launch.new_session(conn, str(tmp_path), "", "fake"),
        "handoff launch": lambda: actions.handoff_name(FAKE_ID, "fake"),
        "rename": lambda: actions.rename_session(conn, FAKE_ID, "new title"),
        "deletion": lambda: delete.delete_session(conn, FAKE_ID),
        "relocation": lambda: relocate.stop_for_move(FAKE_ID, 999999, agent="fake"),
        "AI execution": runner.backend,
        "Unknown AI backend": lambda: runner.run_isolated("prompt", backend_name="fake-cli"),
        "cache pricing": lambda: cache_rewrites.extra_cost({"agent": "fake", "cost": 1}, None),
    }
    for operation, call in calls.items():
        with pytest.raises(agents.UnknownAgent, match=operation):
            call()
    assert path.read_bytes() == before
    assert conn.execute("SELECT COUNT(*) FROM user_overrides").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM conversions").fetchone()[0] == 0


@pytest.mark.usefixtures("fake_registry")
def test_fake_http_entry_points(atlas_env, live_server, monkeypatch, tmp_path):
    from atlas import server

    monkeypatch.setattr(server, "catch_up", lambda **kwargs: False)
    base, token = live_server
    path = tmp_path / "fake-transcript.jsonl"
    path.write_text(user_text("fake transcript", cwd=str(tmp_path)))
    with db.connect() as conn:
        conn.executemany(
            "INSERT INTO sessions(session_id, source_path, agent, session_kind) VALUES (?, ?, ?, 'interactive')",
            [(FAKE_ID, str(path), "fake"), (UUID, str(path), "fake"), ("fk_aaaaaaaa", str(path), "claude")],
        )

    def http(path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = Request(base + path, data=data, headers={"Origin": base, "X-Atlas-Token": token})
        try:
            with urlopen(req, timeout=10) as response:
                return response.status, response.read().decode()
        except HTTPError as exc:
            return exc.code, json.loads(exc.read())["error"]

    status, html = http("/")
    assert status == 200 and '"id": "fake"' in html
    status, payload = http("/api/sessions?agent=fake")
    assert status == 200 and {row["agent"] for row in json.loads(payload)["results"]} == {"fake"}
    assert http("/api/sessions?agent=invented") == (400, "Unknown agent: 'invented'")
    assert http("/api/commands?agent=fake") == (400, "Agent 'fake' does not support command catalog")
    assert http(f"/api/active/feed/{FAKE_ID}")[1] == "Agent 'fake' does not support active feed"
    assert http(f"/api/active/plan/{FAKE_ID}")[1] == "Agent 'fake' does not support active plan"
    assert "invalid" in http(f"/api/active/feed/{UUID}")[1].lower()
    assert "invalid" in http("/api/active/feed/fk_aaaaaaaa")[1].lower()
    assert http("/api/rename", {"session_id": FAKE_ID, "title": "Changed"}) == (
        400, "Agent 'fake' does not support rename"
    )


def test_launcher_requires_an_allowlisted_module_and_runs_fake(fake_registry, tmp_path):
    scripts = tmp_path / "scripts"
    shutil.copytree(ROOT / "obsidian-plugin/scripts", scripts)
    generated = subprocess.check_output(["node", str(ROOT / "tools/agent_registry.mjs"), str(fake_registry)])
    (scripts / "agent-kinds.zsh").write_bytes(generated)
    checked = subprocess.run(
        ["/bin/zsh", "-uc", 'source "$1"; valid_id fake "$2" && valid_id codex "$3" '
         '&& ! valid_id claude "$2" && ! valid_id fake "$3" && ! valid_id fake "$2"$\'\\n\'',
         "grammar", str(scripts / "agent-sessions-lib.zsh"), FAKE_ID, UUID],
        capture_output=True, text=True,
    )
    assert checked.returncode == 0, checked.stderr
    launcher = scripts / "agent-resume-terminal.zsh"
    env = {"HOME": str(tmp_path), "PATH": "/usr/bin:/bin", "OBS_AGENT_TERMINAL_NO_SHELL": "1"}
    (scripts / "agent-unknown.zsh").write_text("print OUTSIDE-ALLOWLIST\n")
    (tmp_path / "outside.zsh").write_text("print OUTSIDE-ALLOWLIST\n")

    def run(kind, sid=FAKE_ID):
        return subprocess.run(["/bin/zsh", str(launcher), kind, "probe", "resume", sid],
                              cwd=tmp_path, env=env, capture_output=True, text=True, timeout=20)

    for kind, message in [("fake", "does not support terminal launch"), ("unknown", "Unknown agent"),
                          ("../../outside", "Unknown agent")]:
        missing = run(kind)
        assert missing.returncode == 64 and message in missing.stderr
        assert "OUTSIDE-ALLOWLIST" not in missing.stdout

    shutil.copy(ROOT / "tests/fixtures/launcher/agent-fake.zsh", scripts)
    mail, extra = tmp_path / "mail", tmp_path / "args"
    mail.mkdir()
    extra.mkdir()
    (mail / "fake").write_text("--mcp 'mail config'")
    (extra / "fake").write_text("--arg 'user flag'")
    env.update(OBS_AGENT_MAIL_ARGS_DIR=str(mail), OBS_AGENT_TERMINAL_ARGS_DIR=str(extra))
    for seed in (FAKE_ID, "fk_12345678"):
        launched = run("fake", seed)
        assert launched.returncode == 0, launched.stderr
        assert "Starting Fake terminal instance: probe" in launched.stdout
        assert "--mcp\x1fmail config --arg\x1fuser flag" in launched.stdout
        assert f"fake resume {FAKE_ID}" in launched.stdout
        assert not launched.stderr


def test_uuid_collision_keeps_the_existing_single_row(atlas_env, write_session, write_rollout, tmp_path):
    """Both sources stay recorded. On a full pass, the later Codex write wins the catalog row."""
    sid = UUID.lower()
    write_session("p", [user_text("Claude side", cwd=str(tmp_path))], session_id=sid)
    rollout = write_rollout([cx_meta(sid, cwd=str(tmp_path)), cx_user("Codex side"), cx_agent("reply")], thread_id=sid)
    conn = db.connect()
    for full in (True, False):
        index.index_all(conn, full=full)
        rows = conn.execute("SELECT agent, source_path FROM sessions WHERE session_id=?", (sid,)).fetchall()
        assert [tuple(row) for row in rows] == [("codex", rollout)]
        assert conn.execute("SELECT COUNT(*) FROM sources WHERE session_id=?", (sid,)).fetchone()[0] == 2
    assert actions.actions_for(conn, sid)["resume_command"].endswith("codex resume " + sid)



@pytest.mark.skipif(not (ROOT / "tools/export_public.py").is_file(), reason="the exporter is private")
def test_public_export_includes_the_runtime_registry(tmp_path):
    out = tmp_path / "public"
    run = subprocess.run(["/usr/bin/python3", str(ROOT / "tools/export_public.py"), str(out)],
                         capture_output=True, text=True)
    assert run.returncode == 0, run.stdout + run.stderr
    assert (out / "atlas/agents.json").read_bytes() == REGISTRY.read_bytes()
    for name in ("obsidian-plugin/scripts/agent-kinds.zsh", "tools/agent_registry.mjs",
                 "obsidian-plugin/scripts/agent-claude.zsh", "obsidian-plugin/scripts/agent-codex.zsh"):
        assert (out / name).read_bytes() == (ROOT / name).read_bytes()


def test_invalid_ai_agent_is_reported_and_recovers_after_settings_change(atlas_env, live_server):
    from atlas import autoclassify
    from tests.conftest import write_config

    base, token = live_server
    write_config(atlas_env["home"], {"ai_agent": "mistyped"})
    with db.connect() as conn:
        db.set_meta(conn, autoclassify.KEY_ENABLED, "1")

    def request(path, body=None):
        req = Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                      headers={"Origin": base, "X-Atlas-Token": token})
        try:
            with urlopen(req, timeout=20) as response:
                return response.status, json.load(response)
        except HTTPError as exc:
            return exc.code, json.load(exc)

    code, status = request("/api/index-status")
    assert code == 200 and status["ai_agent"] == "mistyped"
    message = status["ai_agent_error"]
    assert "ai_agent" in message and "mistyped" in message and "settings" in message
    assert status["auto_classify"]["enabled"] is True
    assert status["auto_classify"]["paused"] == message
    for path, body in [("/api/preview", {"session_id": UUID}),
                       ("/api/classify/preview", {}), ("/api/auto-classify", {"enabled": True})]:
        assert request(path, body) == (400, {"error": message})
    code, facets = request("/api/facets")
    assert code == 200 and facets["auto_classify"]["paused"] == message
    with db.connect() as conn:
        assert autoclassify.tick(conn) is None
        assert db.get_meta(conn, autoclassify.KEY_BACKEND) is None
    assert request("/api/auto-classify", {"enabled": False})[0] == 200
    write_config(atlas_env["home"], {"ai_agent": "claude"})
    code, status = request("/api/index-status")
    assert code == 200 and "ai_agent_error" not in status
    assert status["auto_classify"]["enabled"] is False
    assert request("/api/classify/preview", {})[0] == 200
    write_config(atlas_env["home"], {"ai_agent": False})      # falsy meant auto before the registry
    code, status = request("/api/index-status")
    assert code == 200 and "ai_agent_error" not in status


@pytest.fixture
def fake_catalog(fake_registry, monkeypatch, tmp_path):
    from types import SimpleNamespace

    from atlas.parse import SessionFacts

    source = tmp_path / "fake.txt"
    source.write_text("A transcript read by a test adapter")

    class Fake:
        status = "complete"
        broken = False

        def discover(self, root, codex_root):
            if self.broken:
                raise OSError("fake discovery broke")
            return self.status, [agents.SourceRef("fake", str(source))] if source.exists() else []

        def read(self, ref, *, conn, subagents):
            assert ref == agents.SourceRef("fake", str(source))
            return agents.SourceFacts(SessionFacts(
                session_id=FAKE_ID, source_path=ref.locator, agent=ref.agent,
                title=Path(ref.locator).read_text(), human_turns=1,
            ))

    implementation = Fake()
    monkeypatch.setitem(agents._ADAPTERS, "fake", implementation)
    return SimpleNamespace(adapter=implementation, source=source)


def test_registry_requires_a_catalog_adapter(fake_registry):
    with pytest.raises(agents.UnknownAgent, match=r"fake.*catalog discovery and reads"):
        agents._check_adapters()


@pytest.mark.parametrize("status", ["partial", "unavailable"])
def test_incomplete_fake_discovery_keeps_its_rows_and_source_watermark(fake_catalog, status, write_session):
    conn = db.connect()
    assert index.index_all(conn)["indexed"] == 1
    assert conn.execute("SELECT agent, title FROM sessions WHERE session_id=?", (FAKE_ID,)).fetchone()[:] == (
        "fake", fake_catalog.source.read_text(),
    )
    fake_catalog.adapter.status = status
    fake_catalog.source.write_text("Changed during an incomplete scan")
    source_before = conn.execute("SELECT * FROM sources WHERE session_id=?", (FAKE_ID,)).fetchone()[:]
    write_session("p", [user_text("Claude remains indexable")], session_id=UUID)
    assert index.index_all(conn)["indexed"] == 1
    assert conn.execute("SELECT * FROM sources WHERE session_id=?", (FAKE_ID,)).fetchone()[:] == source_before
    fake_catalog.source.unlink()
    assert index.index_all(conn)["removed"] == 0
    assert conn.execute("SELECT agent FROM sessions WHERE session_id=?", (FAKE_ID,)).fetchone()[0] == "fake"
    assert conn.execute("SELECT COUNT(*) FROM fts WHERE session_id=?", (FAKE_ID,)).fetchone()[0] == 1
    fake_catalog.adapter.status = "complete"
    assert index.index_all(conn)["removed"] == 1
    assert conn.execute("SELECT agent FROM sessions WHERE session_id=?", (FAKE_ID,)).fetchone() is None


def test_discovery_exception_is_logged_and_keeps_both_native_passes(fake_catalog, write_session, write_rollout,
                                                                  monkeypatch, capsys):
    # Put the broken adapter between the native passes to check that the loop continues.
    monkeypatch.setattr(agents, "_REGISTRY", {kind: agents.get(kind) for kind in ("claude", "fake", "codex")})
    conn = db.connect()
    index.index_one(conn, str(fake_catalog.source), "fake")
    fake_catalog.adapter.broken = True
    fake_catalog.source.unlink()
    write_session("p", [user_text("Claude stays")], session_id=UUID)
    cid = "019e0000-1111-7000-8000-000000000003"
    write_rollout([cx_meta(cid), cx_user("Codex stays"), cx_agent("reply")], thread_id=cid)
    summary = index.index_all(conn)
    assert (summary["indexed"], summary["errors"], summary["removed"]) == (2, 1, 0)
    assert {r[0] for r in conn.execute("SELECT agent FROM sessions")} == {"claude", "codex", "fake"}
    assert "fake discovery: OSError: fake discovery broke" in capsys.readouterr().err


def test_incomplete_claude_keeps_tail_checkpoint_and_wins_until_discovery_returns(
        write_session, write_rollout, monkeypatch):
    from atlas import agent_claude

    sid = UUID.lower()
    path = write_session("p", [user_text("Claude before an unavailable scan")], session_id=sid)
    conn = db.connect()
    index.index_all(conn)
    checkpoint = conn.execute("SELECT * FROM parse_state WHERE session_id=?", (sid,)).fetchone()[:]
    write_rollout([cx_meta(sid), cx_user("Codex with the same UUID")], thread_id=sid)
    with monkeypatch.context() as m:
        m.setattr(agent_claude, "discover", lambda *_: ("unavailable", []))
        index.index_all(conn, full=True)
        assert conn.execute("SELECT * FROM parse_state WHERE session_id=?", (sid,)).fetchone()[:] == checkpoint
        assert conn.execute("SELECT source_path FROM sessions WHERE session_id=?", (sid,)).fetchone()[0] == path
        assert db.get_meta(conn, "needs_reindex") == "1"
    assert index.ensure_indexed(conn)["indexed"] == 2
    assert conn.execute("SELECT agent FROM sessions WHERE session_id=?", (sid,)).fetchone()[0] == "codex"
