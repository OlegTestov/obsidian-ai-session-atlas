import json
import os
import shutil
import sqlite3
from contextlib import closing
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from atlas import actions, agent_opencode as oc, classify, cli, config, db, index, search, stats
from tests.conftest import user_text

FIXTURES = Path(__file__).parent / "fixtures" / "opencode"


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    source = tmp_path / "data # OpenCode" / "opencode.db"
    source.parent.mkdir()
    shutil.copyfile(FIXTURES / "opencode.db", source)
    monkeypatch.setenv("ATLAS_OPENCODE_HOME", str(source.parent))
    with closing(db.connect()) as conn:
        yield source, conn, lambda **kw: index.index_all(conn, root=str(tmp_path / "claude"), **kw)


def titles(conn):
    return {row["title"]: row for row in conn.execute("SELECT * FROM sessions WHERE agent='opencode'")}


def test_catalog_projection(catalog):
    _, conn, scan = catalog
    Path(config.path()).write_text(json.dumps({"vaults": [{"path": "/projects/atlas-fixture", "id": "fixture"}]}))
    config.reset()
    assert scan()["indexed"] == 8
    rows = titles(conn)
    plain = rows["OpenCode fixture plain"]
    assert plain["human_turns"] == 1
    assert plain["cost_usd"] is None
    assert plain["started_at"] and plain["last_activity_at"] >= plain["started_at"]
    assert plain["cwd_last"] == "/projects/atlas-fixture"
    sid = plain["session_id"]
    assert search.load_session(conn, sid)["projects"] == ["fixture"]
    assert search.load_prompts(conn, sid) == ["Fixture plain request"]
    assert search.local_state(conn, sid)["last_answer"] == "Synthetic assistant reply"
    assert "OpenCode" in actions.actions_for(conn, sid)["resume_error"]
    assert len(search.recent(conn, agents=["opencode"], limit=30)) == 8
    assert rows["OpenCode fixture empty"]["human_turns"] == 0
    assert rows["OpenCode fixture archived"]["human_turns"] == 1
    assert conn.execute("SELECT human_turns FROM sessions WHERE session_id IN "
                        "(SELECT parent_id FROM session_forks)").fetchone()[0] == 2
    conn.execute("INSERT INTO user_overrides(session_id,title,updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
                 (sid, "Atlas title"))
    conn.commit()
    scan(full=True)
    assert search.load_session(conn, sid)["title"] == "Atlas title"


def test_source_readonly(catalog):
    source, _, _ = catalog
    with oc.open_readonly(source) as conn:
        assert conn.execute("PRAGMA query_only").fetchone()[0] == 1
        assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 3000
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            conn.execute("CREATE TABLE rejected(id)")
        conn.execute("PRAGMA query_only=0")
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            conn.execute("CREATE TABLE still_rejected(id)")
    with closing(sqlite3.connect(source)) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE TABLE visible_from_wal(id)")
        writer.commit()
        with oc.open_readonly(source) as reader:
            assert reader.execute("SELECT COUNT(*) FROM visible_from_wal").fetchone()[0] == 0
            reader.execute("PRAGMA query_only=0")
            with pytest.raises(sqlite3.OperationalError, match="readonly"):
                reader.execute("CREATE TABLE rejected_with_wal(id)")


@pytest.mark.parametrize(("fixture", "expected"), [("v1.db", "v1"), ("unsupported.db", "unsupported")])
def test_version_gate_preserves_rows(catalog, fixture, expected):
    source, conn, scan = catalog
    scan()
    original = titles(conn)
    shutil.copyfile(FIXTURES / fixture, source)
    assert scan(full=True)["removed"] == 0
    assert db.get_meta(conn, "opencode_state") == expected
    assert titles(conn) == original
    assert search.load_prompts(conn, original["OpenCode fixture plain"]["session_id"])


def test_v2_ignores_legacy_tables(catalog):
    source, conn, scan = catalog
    with oc.open_readonly(source) as raw:
        assert raw.execute("SELECT COUNT(*) FROM session").fetchone()[0] == 10
    scan()
    assert not any(title.startswith("Legacy") for title in titles(conn))
    assert not search.search(conn, "legacyonlytext", scope="all")


def test_fingerprint_and_per_session_updates(catalog, monkeypatch):
    source, conn, scan = catalog
    scan()
    original = oc.open_readonly

    def unexpected(*_args):
        pytest.fail("The no-change pass must not connect to OpenCode SQLite")

    with monkeypatch.context() as patch:
        patch.setattr(oc, "open_readonly", unexpected)
        assert scan()["skipped"] == 8

    monkeypatch.setattr(oc, "open_readonly", original)
    sid = titles(conn)["OpenCode fixture empty"]["session_id"]
    with closing(sqlite3.connect(source)) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("INSERT INTO session_message(id, session_id, type, seq, time_created, time_updated, data) "
                       "VALUES ('msg_fixture_added', ?, 'user', 4, 1000, 1000, '{\"text\":\"walonlytext\"}')", (sid,))
        writer.commit()
        assert scan()["indexed"] == 1
        assert search.load_prompts(conn, sid) == ["walonlytext"]
        assert scan()["skipped"] == 8



def test_cold_wal_read_does_not_create_sidecars(catalog):
    source, _, scan = catalog
    with closing(sqlite3.connect(source)) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
    assert list(source.parent.iterdir()) == [source]
    assert scan()["indexed"] == 8
    assert list(source.parent.iterdir()) == [source]


@pytest.mark.parametrize("change", ["wal", "main"])
def test_cold_snapshot_is_discarded_if_source_changes(catalog, monkeypatch, change):
    source, conn, scan = catalog
    with closing(sqlite3.connect(source)) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
    read = oc.read

    def change_source(*args, **kwargs):
        result = read(*args, **kwargs)
        if change == "wal":
            source.with_name(source.name + "-wal").touch()
        else:
            os.utime(source, ns=(source.stat().st_atime_ns, source.stat().st_mtime_ns + 100))
        return result

    with monkeypatch.context() as patch:
        patch.setattr(oc, "read", change_source)
        assert scan()["indexed"] == 0
        assert not titles(conn)
    source.with_name(source.name + "-wal").unlink(missing_ok=True)
    assert scan()["indexed"] == 8


def test_fingerprint_follows_real_wal_and_ctime(catalog):
    source, conn, scan = catalog
    real = source.with_name("real.db")
    source.rename(real)
    source.symlink_to(real)
    with closing(sqlite3.connect(real)) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE INDEX IF NOT EXISTS atlas_fixture_session_titles ON session_v2(title)")
        writer.commit()
        scan()
        before = real.stat()
        writer.execute("UPDATE session_v2 SET title='WAL title' WHERE title='OpenCode fixture empty'")
        writer.commit()
        assert real.stat().st_mtime_ns == before.st_mtime_ns
        assert scan()["indexed"] == 1
        assert "WAL title" in titles(conn)
    scan()
    before = real.stat()
    with closing(sqlite3.connect(real)) as writer, writer:
        writer.execute("UPDATE session_v2 SET title='NEW title' WHERE title='WAL title'")
    os.utime(real, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert real.stat().st_size == before.st_size
    assert scan()["indexed"] == 1
    assert "NEW title" in titles(conn)


def test_existing_message_edit_reindexes_last_answer_block(catalog):
    source, conn, scan = catalog
    scan()
    sid = titles(conn)["OpenCode fixture plain"]["session_id"]
    with closing(sqlite3.connect(source)) as writer, writer:
        mid, data = writer.execute(
            "SELECT id,data FROM session_message WHERE session_id=? AND type='assistant'", (sid,)).fetchone()
        edited = json.loads(data)
        edited["content"] = [{"type": "text", "text": "first " * 150},
                             {"type": "tool", "name": "read"},
                             {"type": "text", "text": "finalanswerblock"}]
        writer.execute("UPDATE session_message SET data=?,time_updated=time_updated+10000 WHERE id=?",
                       (json.dumps(edited), mid))
    assert scan()["indexed"] == 1
    assert search.search(conn, "finalanswerblock", scope="all")
    assert search.local_state(conn, sid)["last_answer"] == "finalanswerblock"


def test_indexed_answer_uses_completed_steps(catalog):
    source, conn, scan = catalog
    scan()
    sid = titles(conn)["OpenCode fixture plain"]["session_id"]
    with closing(sqlite3.connect(source)) as writer, writer:
        seq = writer.execute("SELECT MAX(seq) FROM session_message WHERE session_id=?", (sid,)).fetchone()[0]
        writer.execute("INSERT INTO session_message VALUES (?, ?, 'assistant', ?, 1, 1, ?)",
                       ("msg_" + "u" * 26, sid, seq + 1,
                        json.dumps({"content": [{"type": "text", "text": "Unsettled fixture answer"}]})))
    assert scan()["indexed"] == 1
    assert search.local_state(conn, sid)["last_answer"] == "Synthetic assistant reply"


def test_index_purges_orphaned_answer_times_left_by_an_old_writer(catalog):
    _, conn, scan = catalog
    scan()
    sid = titles(conn)["OpenCode fixture plain"]["session_id"]
    orphan = "ses_" + "o" * 26
    with conn:
        conn.execute("INSERT INTO opencode_answer_times VALUES (?,?)", (orphan, 1000))
    assert scan()["indexed"] == 0
    assert conn.execute("SELECT ts FROM opencode_answer_times WHERE session_id=?", (orphan,)).fetchone() is None
    assert conn.execute("SELECT ts FROM opencode_answer_times WHERE session_id=?", (sid,)).fetchone()[0] is not None


def test_purge_only_after_complete_read(catalog, monkeypatch):
    source, conn, scan = catalog
    scan()
    rows = titles(conn)
    deleted = rows["OpenCode fixture empty"]["session_id"]
    with closing(sqlite3.connect(source)) as writer, writer:
        writer.execute("DELETE FROM session_v2 WHERE id=?", (deleted,))
        writer.execute("UPDATE session_v2 SET time_updated=time_updated+100 WHERE id<>?", (deleted,))
    parse = oc.read

    def fail(*args, **kwargs):
        if kwargs["row"]["id"] == rows["OpenCode fixture plain"]["session_id"]:
            raise sqlite3.OperationalError("incomplete read")
        return parse(*args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(oc, "read", fail)
        assert scan()["errors"] == 1
        assert titles(conn) == rows
    assert scan()["removed"] == 1
    assert search.load_session(conn, deleted) is None
    source.unlink()
    assert scan()["removed"] == 0
    assert conn.execute("SELECT count(*) FROM sessions WHERE agent='opencode'").fetchone()[0] == 7


def test_search_whitelist_and_children(catalog):
    _, conn, scan = catalog
    scan()
    rows = titles(conn)
    parent = rows["OpenCode fixture parent"]["session_id"]
    tools = rows["OpenCode fixture tools"]["session_id"]

    def hits(term):
        return [item["session_id"] for item in search.search(conn, term, scope="all")]

    assert hits("childonlymarker") == [parent]
    assert "Run synthetic child" not in rows
    assert hits("atlas-fixture.txt") == [tools]
    assert hits("printf") == [tools]
    assert hits("write") == [tools]
    assert not hits("hiddenfilecontents")
    assert not hits("synthetic compacted transcript")
    assert conn.execute("SELECT resolved_path FROM session_files WHERE session_id=?", (tools,)).fetchone()[0] \
        == "/projects/atlas-fixture/atlas-fixture.txt"


def test_stats_children_forks_compactions_and_cost(catalog):
    source, conn, scan = catalog
    scan()
    rows = titles(conn)
    parent = rows["OpenCode fixture parent"]["session_id"]
    many, fork = conn.execute("SELECT parent_id,session_id FROM session_forks").fetchone()
    compact = rows["OpenCode fixture compaction"]["session_id"]
    plain = rows["OpenCode fixture plain"]["session_id"]
    assert search.load_prompts(conn, fork) == [
        "Fixture first request", "Fixture second request", "Fixture fork request"]
    assert conn.execute("SELECT parent_id FROM session_forks WHERE session_id=?", (fork,)).fetchone()[0] == many
    assert rows["OpenCode fixture parent"]["subagent_turns"] == 1
    assert conn.execute("SELECT COUNT(*) FROM activity WHERE session_id=? AND sub=1", (parent,)).fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM activity WHERE session_id=?", (fork,)).fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM activity WHERE session_id=? AND kind='a'", (compact,)).fetchone()[0] == 2
    assert conn.execute("SELECT cost FROM activity WHERE session_id=? AND kind='a'", (plain,)).fetchone()[0] is None
    with oc.open_readonly(source) as raw:
        boundary = raw.execute("SELECT fork_boundary FROM session_v2 WHERE id=?", (fork,)).fetchone()[0]
        assert '"type":"through"' in boundary
    summary = stats.summary(conn, "all", agents=["opencode"])
    assert summary["totals"]["answers"] == 15
    assert summary["totals"]["prompts"] == 9
    assert summary["totals"]["tokens"] == {"input": 150, "output": 60, "cache_read": 30,
                                           "cache_write": 0, "reasoning": 15, "total": 255}
    assert summary["totals"]["unpriced_models"] == ["atlas/unpriced"]
    assert summary["totals"]["cost"] == 0.28
    assert summary["by_agent"][0]["name"] == "opencode"
    assert summary["by_agent"][0]["tokens"] == 255
    conn.execute("DELETE FROM activity WHERE session_id<>?", (plain,))
    assert stats.summary(conn, "all")["totals"]["cost"] is None
    assert {point["cost"] for point in stats.summary(conn, "all")["series"]["points"] if point["sessions"]} == {None}


def test_home_default_config_and_profile_override(tmp_path, monkeypatch):
    monkeypatch.delenv("ATLAS_OPENCODE_HOME")
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    assert oc.data_home() == tmp_path / ".local/share/opencode"
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "xdg"))
    assert oc.data_home() == tmp_path / "xdg/opencode"
    Path(config.path()).write_text(json.dumps({"opencode_home": "~/custom path"}))
    config.reset()
    assert oc.data_home() == tmp_path / "custom path"
    monkeypatch.setenv("ATLAS_OPENCODE_HOME", str(tmp_path / "fixture"))
    assert oc.data_home() == tmp_path / "fixture"


def test_whitelist_with_extra_message_fields(catalog):
    source, conn, scan = catalog
    with closing(sqlite3.connect(source)) as writer, writer:
        sid = writer.execute("SELECT id FROM session_v2 WHERE title='OpenCode fixture plain'").fetchone()[0]
        for kind in ("assistant", "user"):
            key, payload = writer.execute("SELECT id, data FROM session_message WHERE session_id=? AND type=?",
                                          (sid, kind)).fetchone()
            data = json.loads(payload)
            if kind == "user":
                data["files"] = [{"filename": "privateattachmentname", "uri": "data:text/plain,privateattachmentbody"}]
            else:
                data["content"].extend([
                    {"type": "reasoning", "text": "privatereasoning"},
                    {"type": "tool", "name": "read", "state": {
                        "input": {"filePath": "readable-name.md", "irrelevant": "privatearg"},
                        "content": [{"type": "text", "text": "privatetooloutput"}],
                        "error": "privatetoolerror", "metadata": {"output": "privatetoolmetadata"},
                    }},
                ])
                data["tokens"]["cache"]["write"] = 3
                data["model"]["id"] = "claude-synthetic"
            writer.execute("UPDATE session_message SET data=? WHERE id=?", (json.dumps(data), key))
    scan()
    assert search.search(conn, "readable-name.md", scope="all")[0]["session_id"] == sid
    for excluded in ("privateattachmentname", "privateattachmentbody", "privatereasoning", "privatearg",
                     "privatetooloutput", "privatetoolerror", "privatetoolmetadata"):
        assert not search.search(conn, excluded, scope="all")
    summary = stats.summary(conn, "all")
    assert summary["totals"]["tokens"]["cache_write"] == 3
    assert "atlas/claude-synthetic" in {row["name"] for row in summary["models"]}


def test_rebuild_retains_opencode_when_missing(catalog, monkeypatch, tmp_path, capsys):
    source, conn, scan = catalog
    scan()
    before = titles(conn)
    directory = tmp_path / "claude" / "fixture"
    directory.mkdir(parents=True)
    transcript = directory / "orphan.jsonl"
    transcript.write_text(user_text("orphanmarker"))
    scan()
    transcript.unlink()
    conn.execute("DELETE FROM sources WHERE session_id='orphan'")
    conn.commit()
    assert search.search(conn, "orphanmarker")
    source.unlink()
    scan_all = index.index_all
    monkeypatch.setattr(index, "index_all", lambda c, **kw: scan_all(c, root=str(tmp_path / "claude"), **kw))
    assert cli.cmd_rebuild(conn, None) == 0
    assert json.loads(capsys.readouterr().out)["stats"]["removed"] == 0
    assert titles(conn) == before
    assert not search.search(conn, "orphanmarker")
    assert classify.pending(conn) == []


def test_cli_refuses_resume_when_id_has_disappeared(catalog, capsys):
    from types import SimpleNamespace

    source, conn, scan = catalog
    scan()
    sid = titles(conn)["OpenCode fixture plain"]["session_id"]
    source.unlink()
    assert cli.cmd_resume(conn, SimpleNamespace(session_id=sid, no_refresh=True)) == cli.EXIT_NOT_FOUND
    assert "OpenCode" in capsys.readouterr().err


def test_open_code_api_rejects_terminal_and_ai_actions(live_server, catalog, monkeypatch):
    from atlas import server

    source, conn, scan = catalog
    base, token = live_server
    scan()
    monkeypatch.setattr(server, "catch_up", lambda **_kw: False)
    sid = titles(conn)["OpenCode fixture plain"]["session_id"]

    def refuse_native(*_args):
        pytest.fail("OpenCode catalog actions must not start a process")

    monkeypatch.setattr(actions, "open_in_terminal", refuse_native)
    original = source.read_bytes()
    headers = {"Origin": base, "X-Atlas-Token": token, "Content-Type": "application/json"}
    for endpoint, values in [
        ("terminal", {"command": "opencode --session " + sid}),
        ("launch", {}),
        ("preview", {"artifact_kind": "handoff"}),
    ]:
        body = json.dumps({"session_id": sid, **values}).encode()
        with pytest.raises(HTTPError) as response:
            urlopen(Request(f"{base}/api/{endpoint}", data=body, headers=headers), timeout=5)
        assert response.value.code == 400
        assert "opencode" in json.load(response.value)["error"]
    with urlopen(f"{base}/api/index-status", timeout=5) as response:
        assert json.load(response)["opencode"] == {"state": "v2", "available": True}
    assert [r["agent"] for r in search.recent(conn, limit=30)] == ["opencode"] * 8
    assert source.read_bytes() == original


def test_open_code_forks_use_shared_copy_numbers(catalog, monkeypatch):
    from atlas import opencode_live, opencode_tabs

    source, conn, scan = catalog
    with closing(sqlite3.connect(source)) as writer, writer:
        writer.row_factory = sqlite3.Row
        native = writer.execute("SELECT * FROM session_v2 WHERE fork_session_id IS NOT NULL").fetchone()
        duplicate = dict(native)
        duplicate.update(id="ses_" + "f" * 26, time_created=native["time_created"] + 1000)
        columns = ", ".join(duplicate)
        marks = ", ".join("?" for _ in duplicate)
        writer.execute(f"INSERT INTO session_v2 ({columns}) VALUES ({marks})", tuple(duplicate.values()))
    scan()
    source_id = native["fork_session_id"]
    first_id, second_id = native["id"], duplicate["id"]
    expected = ["OpenCode fixture multiple (2)", "OpenCode fixture multiple (3)"]
    assert [search.load_session(conn, sid)["title"] for sid in (first_id, second_id)] == expected
    assert [entry["title"] for entry in search.load_session(conn, source_id)["forks"]] == expected
    monkeypatch.setattr(opencode_tabs, "active_tabs", lambda _table: {first_id: 101, second_id: 102})
    cards = {card["session_id"]: card for card in opencode_live.list_live(conn, {})}
    assert [cards[sid]["title"] for sid in (first_id, second_id)] == expected
    with closing(sqlite3.connect(source)) as writer, writer:
        writer.execute("UPDATE session_v2 SET title=? WHERE id=?", ("Manual name (fork #9)", second_id))
    scan()
    assert search.load_session(conn, second_id)["title"] == "Manual name (fork #9)"


def test_opencode_statistics_group_skill_and_subagent_invocations(catalog):
    source, conn, scan = catalog
    with closing(sqlite3.connect(source)) as writer, writer:
        key, raw = writer.execute(
            "SELECT m.id,m.data FROM session_message m JOIN session_v2 s ON s.id=m.session_id "
            "WHERE s.title='OpenCode fixture plain' AND m.type='assistant'"
        ).fetchone()
        data = json.loads(raw)
        data["content"].extend([
            {"type": "tool", "name": "skill", "state": {"input": {"id": "atlas-fixture"}}},
            {"type": "tool", "name": "subagent", "state": {"input": {"agent": "fixture-worker"}}},
        ])
        writer.execute("UPDATE session_message SET data=? WHERE id=?", (json.dumps(data), key))
    scan()
    result = stats.summary(conn, "all", agents=["opencode"])
    assert {"name": "atlas-fixture", "count": 1} in result["skills"]
    assert {"name": "fixture-worker", "count": 1} in result["agents"]


def test_opencode_artifact_preview_uses_an_explicit_provider_without_changing_classification(catalog):
    from atlas import enrich, runner

    _, conn, scan = catalog
    Path(config.path()).write_text(json.dumps({"ai_agent": "claude", "opencode_ai_model": "atlas/fake"}))
    config.reset()
    scan()
    sid = titles(conn)["OpenCode fixture plain"]["session_id"]
    result = enrich.preview(conn, sid, "catalog_summary")
    assert (result["backend"], result["model_id"]) == ("opencode-service", "atlas/fake")
    assert "Fixture plain request" in json.dumps(result)
    assert runner.backend() == runner.CLAUDE_BACKEND


def test_open_code_generator_submits_only_to_the_verified_model_and_checks_cancellation(monkeypatch):
    from atlas import opencode_service, runner

    calls = []

    class Native:
        version = opencode_service.TESTED_VERSION

        def check_verified_database(self):
            calls.append("verified")

        def call(self, method, route, payload, *, before_send, timeout):
            before_send()
            calls.append((method, route, payload, timeout))
            return {"data": {"text": "Fixture artifact"}}

    monkeypatch.setattr(opencode_service, "verified_client", lambda _: Native())
    monkeypatch.setattr(runner, "llm_enabled", lambda: True)
    result = runner.run_isolated("Only the confirmed excerpt", model="atlas/fake", backend_name="opencode-service",
                                 timeout=25, before_send=lambda: calls.append("cancelled checked"))
    assert result == "Fixture artifact"
    assert calls == ["verified", "cancelled checked", ("POST", "experimental/generate/text", {
        "model": {"providerID": "atlas", "id": "fake"}, "prompt": "Only the confirmed excerpt",
    }, 25)]


def test_open_code_artifact_http_requires_the_previewed_model_and_excerpt(live_server, catalog, monkeypatch):
    import time

    from atlas import opencode_service

    _, conn, scan = catalog
    Path(config.path()).write_text(json.dumps({"ai_agent": "claude", "opencode_ai_model": "atlas/fake"}))
    config.reset()
    scan()
    callback = []

    class Native:
        version = opencode_service.TESTED_VERSION

        def check_verified_database(self):
            pass

        def call(self, method, route, body, *, before_send, timeout):
            before_send()
            callback.append((method, route, body, timeout))
            return {"data": {"text": '{"did":"Fixture generated summary","work_outcome":"done"}'}}

    monkeypatch.setattr(opencode_service, "verified_client", lambda _: Native())
    base, token = live_server
    sid = titles(conn)["OpenCode fixture plain"]["session_id"]
    kind = "catalog_summary"
    headers = {"Origin": base, "X-Atlas-Token": token, "Content-Type": "application/json"}

    def request(route, body=None):
        url = base + "/api/" + route
        data = None if body is None else json.dumps(body).encode()
        with urlopen(Request(url, headers=headers, data=data), timeout=5) as reply:
            return json.loads(reply.read())

    initial = {"session_id": sid, "artifact_kind": kind}
    preview = request("preview", initial)
    assert preview["agent_name"] == "OpenCode"
    assert preview["model_id"] == "atlas/fake"
    assert "Fixture plain request" in preview["text"]
    assert callback == []
    confirmed = {
        **initial, "confirmed": True,
        **{key: preview[key] for key in ("backend", "model_id", "effort", "content_hash", "excerpt_hash")},
    }
    with pytest.raises(HTTPError) as refused:
        request("job", {**confirmed, "model_id": "other/fake"})
    assert refused.value.code == 409 and callback == []
    job = request("job", confirmed)
    for _ in range(100):
        state = request("job/" + job["job_id"])["state"]
        if state in {"done", "error"}:
            break
        time.sleep(0.02)
    assert state == "done"
    assert len(callback) == 1
    method, route, body, _ = callback[0]
    assert (method, route) == ("POST", "experimental/generate/text")
    assert set(body) == {"model", "prompt"}
    assert body["model"] == {"providerID": "atlas", "id": "fake"}
    assert preview["text"] in body["prompt"]
