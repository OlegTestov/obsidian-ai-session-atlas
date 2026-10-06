""""Resume with…": a session continues in the other agent as a new native session of that agent.

Made-up sources (tests/xresume_corpus.py) are converted both ways; the result is checked for what the
CLIs need (tests/test_xresume_format.py checks it against the probe evidence), for what must never be
copied, and for the catalog: lineage, dates, and statistics that do not count the copies twice.
"""
from __future__ import annotations

import hashlib
import json
import os
import shlex
from datetime import datetime, timezone

import pytest

from atlas import convert, convert_write, db, delete, index, search, stats
from atlas.convert_write import ConvertError
from tests import xresume_corpus as X


@pytest.fixture
def corpus(atlas_env, codex_home, tmp_path):
    work = tmp_path / "lamp's work"
    work.mkdir()
    cwd = os.path.realpath(str(work))
    paths = {"claude": X.write_claude(str(atlas_env["projects"]), cwd),
             "codex": X.write_codex(codex_home, cwd)}
    conn = db.connect()
    index.index_all(conn)
    return {"conn": conn, "cwd": cwd, "paths": paths, "codex_home": codex_home,
            "projects": str(atlas_env["projects"])}


def _digest(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def _records(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh]


def _convert(corpus, sid, target):
    result = convert.resume_with(corpus["conn"], sid, target)
    index.index_one(corpus["conn"], result["path"], target)
    return result


def test_claude_to_codex_writes_a_rollout_codex_resumes(corpus):
    before = _digest(corpus["paths"]["claude"])
    r = _convert(corpus, X.CLAUDE_ID, "codex")
    assert r["converted"] and r["agent"] == "codex" and r["source_session_id"] == X.CLAUDE_ID
    assert r["command"] == f"cd {shlex.quote(corpus['cwd'])} && codex resume {r['session_id']}"
    assert r["session_id"][14] == "7"                          # a UUID v7 thread id, as Codex makes
    assert os.path.dirname(r["path"]).startswith(os.path.join(corpus["codex_home"], "sessions"))
    assert os.path.basename(r["path"]).startswith("rollout-") and r["path"].endswith(r["session_id"] + ".jsonl")
    assert oct(os.stat(r["path"]).st_mode & 0o777) == "0o600"
    assert _digest(corpus["paths"]["claude"]) == before          # the source is only read
    recs = _records(r["path"])
    meta = recs[0]["payload"]
    assert recs[0]["type"] == "session_meta" and meta["id"] == r["session_id"]
    assert meta["cwd"] == corpus["cwd"] and meta["cli_version"] and meta["model_provider"] == "openai"
    users = [x["payload"]["message"] for x in recs if x["payload"].get("type") == "user_message"]
    assert users[0].startswith("[") and "Claude Code" in users[0] and X.CLAUDE_ID in users[0]
    assert X.SUMMARY in users[0] and X.PROMPT in users[0]
    blob = json.dumps(recs)
    for marker in (X.REPLY, X.COMMAND, X.OUTPUT, "LAST-REPLY-MARKER"):
        assert marker in blob
    for secret in (X.BEFORE, *X.SECRETS):
        assert secret not in blob


def test_codex_to_claude_writes_a_chained_transcript(corpus):
    before = _digest(corpus["paths"]["codex"])
    r = _convert(corpus, X.CODEX_ID, "claude")
    folder = os.path.join(corpus["projects"], convert_write.claude_slug(corpus["cwd"]))
    assert r["path"] == os.path.join(folder, r["session_id"] + ".jsonl")
    assert r["command"] == f"cd {shlex.quote(corpus['cwd'])} && claude --resume {r['session_id']}"
    assert _digest(corpus["paths"]["codex"]) == before
    recs = _records(r["path"])
    chain = [x for x in recs if x["type"] in ("user", "assistant")]
    assert [x["type"] for x in chain] == ["user", "assistant"] * (len(chain) // 2)
    assert chain[0]["parentUuid"] is None
    assert all(b["parentUuid"] == a["uuid"] for a, b in zip(chain, chain[1:]))
    assert len({x["uuid"] for x in chain}) == len(chain)
    assert {x["sessionId"] for x in recs} == {r["session_id"]} and {x["cwd"] for x in chain} == {corpus["cwd"]}
    assert recs[-1] == {"type": "custom-title", "customTitle": r["title"], "sessionId": r["session_id"]}
    first = chain[0]["message"]["content"]
    assert "Codex" in first and X.CODEX_ID in first and X.SUMMARY in first and X.PROMPT in first
    assert "[exec_command] " + X.COMMAND in chain[1]["message"]["content"][0]["text"]
    blob = json.dumps(recs)
    assert X.OUTPUT in blob and "src/lamp.py" in blob
    for secret in (*X.SECRETS, "DEV-NOT-COPIED", "BASE-INSTRUCTIONS-NOT-COPIED"):
        assert secret not in blob
    assert X.BEFORE not in json.dumps(chain)       # (the source's title is its first prompt: fine)
    assert blob.count(X.PROMPT) == 1 and blob.count(X.REPLY) == 1      # event + item: one message


def test_copied_records_are_never_later_than_the_conversion(corpus):
    for sid, target in ((X.CLAUDE_ID, "codex"), (X.CODEX_ID, "claude")):
        r = _convert(corpus, sid, target)
        at = corpus["conn"].execute("SELECT at FROM conversions WHERE session_id=?",
                                    (r["session_id"],)).fetchone()["at"]
        stamps = [x["timestamp"] for x in _records(r["path"]) if "timestamp" in x]
        assert stamps and max(stamps) <= at and stamps == sorted(stamps[:1]) + sorted(stamps[1:])


def test_the_new_session_is_in_search_linked_to_its_source(corpus):
    conn = corpus["conn"]
    for sid, target, source_agent in ((X.CLAUDE_ID, "codex", "claude"), (X.CODEX_ID, "claude", "codex")):
        r = _convert(corpus, sid, target)
        card = search.load_session(conn, r["session_id"])
        assert card["agent"] == target and card["session_kind"] == "interactive"
        assert card["continued_from"] == sid
        assert card["converted_from"]["session_id"] == sid and card["converted_from"]["agent"] == source_agent
        assert card["title"] == r["title"] and card["started_at"] == card["converted_from"]["at"]
        assert card["human_turns"] == 0                       # nothing typed yet: copies are not turns
        assert r["session_id"] in {x["session_id"] for x in search.recent(conn)}
        assert [c["session_id"] for c in search.load_session(conn, sid)["converted_to"]] == [r["session_id"]]
        # The copied text is the source's: a search finds the source, not the copy.
        assert {x["session_id"] for x in search.search(conn, "OUTPUT-MARKER")} <= {X.CLAUDE_ID, X.CODEX_ID}


def _activity(conn, sid):
    return conn.execute("SELECT count(*) FROM activity WHERE session_id=?", (sid,)).fetchone()[0]


def test_statistics_count_only_what_happens_after_the_conversion(corpus):
    conn = corpus["conn"]
    totals = stats.summary(conn, "all")["totals"]
    claude_copy = _convert(corpus, X.CODEX_ID, "claude")
    codex_copy = _convert(corpus, X.CLAUDE_ID, "codex")
    assert _activity(conn, claude_copy["session_id"]) == 0 and _activity(conn, codex_copy["session_id"]) == 0
    assert stats.summary(conn, "all")["totals"] == totals
    # The agent goes on: what it appends after the conversion counts, once.
    new_id = claude_copy["session_id"]
    with open(claude_copy["path"], "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "user", "uuid": "n1", "parentUuid": None, "sessionId": new_id,
                             "timestamp": "2099-01-01T10:00:00.000Z", "cwd": corpus["cwd"], "entrypoint": "cli",
                             "message": {"role": "user", "content": "NEW-WORK-MARKER next step"}}) + "\n")
        fh.write(json.dumps({"type": "assistant", "uuid": "n2", "parentUuid": "n1", "sessionId": new_id,
                             "timestamp": "2099-01-01T10:00:05.000Z", "cwd": corpus["cwd"], "entrypoint": "cli",
                             "message": {"id": "msg_new", "role": "assistant", "model": "claude-opus-5",
                                         "usage": {"input_tokens": 5, "output_tokens": 3},
                                         "content": [{"type": "text", "text": "done"}]}}) + "\n")
    with open(codex_copy["path"], "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"timestamp": "2099-01-01T10:00:00.000Z", "type": "event_msg",
                             "payload": {"type": "user_message", "message": "NEW-WORK-MARKER codex"}}) + "\n")
    index.index_all(conn)
    claude_card = search.load_session(conn, claude_copy["session_id"])
    assert claude_card["human_turns"] == 1 and _activity(conn, claude_copy["session_id"]) == 2
    assert search.load_session(conn, codex_copy["session_id"])["human_turns"] == 1
    assert {x["session_id"] for x in search.search(conn, "NEW-WORK-MARKER")} == {
        claude_copy["session_id"], codex_copy["session_id"]}


def test_budget_drops_the_oldest_turns_with_a_note(corpus, write_session):
    long_id = "c1a0de00-1111-4111-8111-0000000000aa"
    X.write_claude(corpus["projects"], corpus["cwd"], sid=long_id, extra_turns=120)
    index.index_all(corpus["conn"])
    conv = convert.convert_read.read(
        corpus["conn"].execute("SELECT source_path FROM sessions WHERE session_id=?",
                               (long_id,)).fetchone()[0], long_id, "claude")
    budget = 20_000
    messages, omitted = convert_write.turns(conv, lg="en", budget=budget)
    assert omitted
    head = messages[0][1]
    assert head.startswith("[The earlier part of the conversation was omitted") and long_id in head
    assert X.SUMMARY in head                                  # the summary always stays
    assert messages[-1][1] == "LAST-REPLY-MARKER amber"       # the newest turns stay
    assert X.PROMPT not in json.dumps(messages)                # the oldest go first
    assert sum(len(t) for _, t, _ in messages) <= budget + len(head)
    second = messages[0][1].split(X.SUMMARY, 1)[1]
    assert "filler prompt" in second and second.strip().startswith("filler prompt")   # cut at a prompt
    roles = [m[0] for m in messages]
    assert roles == ["user", "assistant"] * (len(roles) // 2)
    small, omitted_small = convert_write.turns(conv, lg="en")
    assert not omitted_small and X.PROMPT in json.dumps(small)


def test_same_agent_is_the_ordinary_resume_and_writes_nothing(corpus):
    before = sorted(os.listdir(os.path.dirname(corpus["paths"]["claude"])))
    r = convert.resume_with(corpus["conn"], X.CLAUDE_ID, "claude")
    assert r == {"agent": "claude", "session_id": X.CLAUDE_ID, "cwd": corpus["cwd"], "converted": False,
                 "command": f"cd {shlex.quote(corpus['cwd'])} && claude --resume {X.CLAUDE_ID}"}
    assert sorted(os.listdir(os.path.dirname(corpus["paths"]["claude"]))) == before
    assert convert.plan(corpus["conn"], X.CODEX_ID, "codex")["same_agent"] is True
    assert corpus["conn"].execute("SELECT count(*) FROM conversions").fetchone()[0] == 0


def test_bad_requests_write_nothing(corpus):
    conn = corpus["conn"]
    with pytest.raises(ConvertError):
        convert.resume_with(conn, X.CLAUDE_ID, "gemini")
    with pytest.raises(ConvertError):
        convert.resume_with(conn, "00000000-0000-4000-8000-000000000000", "codex")
    os.remove(corpus["paths"]["codex"])
    with pytest.raises(ConvertError):
        convert.resume_with(conn, X.CODEX_ID, "claude")
    assert conn.execute("SELECT count(*) FROM conversions").fetchone()[0] == 0


def test_plan_says_what_would_be_written(corpus):
    p = convert.plan(corpus["conn"], X.CLAUDE_ID, "codex")
    assert p["same_agent"] is False and p["messages"] == 4 and p["omitted"] is False and p["chars"] > 0
    assert p["folder"] == os.path.join(corpus["codex_home"], "sessions")
    assert convert.plan(corpus["conn"], X.CODEX_ID, "claude")["folder"].startswith(corpus["projects"])
    assert corpus["conn"].execute("SELECT count(*) FROM conversions").fetchone()[0] == 0


def test_deleting_the_copy_drops_its_link_but_not_the_source(corpus):
    conn = corpus["conn"]
    r = _convert(corpus, X.CODEX_ID, "claude")
    delete.delete_session(conn, r["session_id"])
    assert conn.execute("SELECT count(*) FROM conversions").fetchone()[0] == 0
    assert search.load_session(conn, X.CODEX_ID)["converted_to"] == []
    assert os.path.exists(corpus["paths"]["codex"])


def test_codex_provider_comes_from_the_top_of_config_toml(tmp_path):
    home = tmp_path / "cx"
    home.mkdir()
    assert convert_write.codex_provider(str(home)) == "openai"
    (home / "config.toml").write_text('model = "x"\nmodel_provider = "corp"\n[model_providers.corp]\nname = "c"\n')
    assert convert_write.codex_provider(str(home)) == "corp"
    (home / "config.toml").write_text('model = "x"\n[profiles.p]\nmodel_provider = "other"\n')
    assert convert_write.codex_provider(str(home)) == "openai"


def test_long_folder_uses_the_existing_claude_project_folder(tmp_path):
    projects = tmp_path / "projects"
    cwd = "/" + "/".join(["very-long-folder-name"] * 12)
    slug = convert_write.claude_slug(cwd)
    assert len(slug) > convert_write.SLUG_MAX
    with pytest.raises(ConvertError):
        convert_write.claude_folder(str(projects), cwd)
    (projects / (slug[:convert_write.SLUG_MAX] + "-1x2y3z")).mkdir(parents=True)
    assert convert_write.claude_folder(str(projects), cwd).endswith("-1x2y3z")
    assert convert_write.claude_folder(str(projects), "/Users/a b/c~d") == str(projects / "-Users-a-b-c-d")


def test_stamps_never_pass_the_conversion_or_go_back():
    from datetime import datetime, timezone
    at = datetime(2026, 10, 5, 12, 0, 0, tzinfo=timezone.utc)
    msgs = [("user", "a", "2026-09-01T10:00:00.000Z"), ("assistant", "b", None),
            ("user", "c", "2099-01-01T00:00:00.000Z"), ("assistant", "d", "2026-08-01T00:00:00.000Z")]
    stamps = convert_write._stamps(msgs, at)
    assert stamps[0] == "2026-09-01T10:00:00.000Z" and stamps[1] == stamps[0]
    assert stamps[2] == convert_write.iso(at) == "2026-10-05T12:00:00.000Z"
    assert stamps == sorted(stamps)


def test_an_existing_file_is_never_overwritten(tmp_path):
    path = tmp_path / "s" / "x.jsonl"
    convert_write.write_new(str(path), [{"a": 1}])
    with pytest.raises(FileExistsError):
        convert_write.write_new(str(path), [{"b": 2}])
    assert path.read_text() == '{"a":1}\n'


def test_written_records_are_compact_like_the_agents_own(tmp_path):
    """The agents write compact JSON with raw UTF-8; Codex 0.160 starts the payload with session_id, id."""
    at = datetime(2026, 10, 5, 9, 8, 50, tzinfo=timezone.utc)
    new = convert_write.uuid7()
    path = tmp_path / "r.jsonl"
    convert_write.write_new(str(path), convert_write.codex_records([("user", "вопрос", None)], new, "/w", at))
    first = path.read_text(encoding="utf-8").splitlines()[0]
    assert first.startswith('{"timestamp":"2026-10-05T09:08:50.000Z","ordinal":0,"type":"session_meta",'
                            f'"payload":{{"session_id":"{new}","id":"{new}",')
    assert '"cwd":"/w"' in first and ": " not in first and "вопрос" in path.read_text(encoding="utf-8")
    assert [json.loads(x)["ordinal"] for x in path.read_text(encoding="utf-8").splitlines()] == [0, 1, 2, 3]
