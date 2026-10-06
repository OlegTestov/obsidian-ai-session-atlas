""""Resume with…" against what the installed CLIs accepted, and the server routes.

tests/fixtures/xresume/evidence.json comes from `python3.11 tools/probe_xresume.py --save`: the
converted sessions were resumed by claude 2.1.289 and codex-cli 0.160.0 in a pty against a stand-in
API, and the request each sent after one typed prompt is kept (made-up content only). Generated files
must keep the field-level shape those CLIs took; a format change means running the probe again.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

import pytest

from atlas import convert, convert_read, db, index
from tests import xresume_corpus as X
from tests.conftest import rec

EVIDENCE = os.path.join(os.path.dirname(__file__), "fixtures", "xresume", "evidence.json")


def _shape(value):
    if isinstance(value, dict):
        return {k: _shape(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [_shape(value[0])] if value else []
    return type(value).__name__


@pytest.fixture
def evidence():
    with open(EVIDENCE, encoding="utf-8") as fh:
        return json.load(fh)


@pytest.fixture
def converted(atlas_env, codex_home, tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    cwd = os.path.realpath(str(work))
    X.write_claude(str(atlas_env["projects"]), cwd)
    X.write_codex(codex_home, cwd)
    conn = db.connect()
    index.index_all(conn)
    out = {target: convert.resume_with(conn, sid, target)
           for sid, target in ((X.CODEX_ID, "claude"), (X.CLAUDE_ID, "codex"))}
    out["conn"] = conn
    return out


def _records(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh]


def test_generated_files_keep_the_shape_the_clis_accepted(converted, evidence):
    for agent in ("claude", "codex"):
        assert [_shape(r) for r in _records(converted[agent]["path"])] == evidence[agent]["accepted_records"], agent


def test_the_clis_sent_the_converted_history(evidence):
    assert evidence["versions"]["claude"].startswith("2.1.289")
    assert evidence["versions"]["codex"] == "codex-cli 0.160.0"
    for agent, source in (("claude", "Codex"), ("codex", "Claude Code")):
        msgs = evidence[agent]["request_messages"]
        assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant", "user"]
        assert msgs[0]["text"].startswith("[Continued conversation]") and source in msgs[0]["text"]
        blob = json.dumps(msgs)
        for marker in (X.SUMMARY, X.PROMPT, X.REPLY, X.OUTPUT, "LAST-REPLY-MARKER", "PROBE-QUESTION"):
            assert marker in blob, (agent, marker)
        for secret in (X.BEFORE, *X.SECRETS):
            assert secret not in blob, (agent, secret)
    # What each agent appended on resume: its own records after ours, in its usual format.
    assert ["user", None] in evidence["claude"]["appended_kinds"]
    assert ["event_msg", "user_message"] in evidence["codex"]["appended_kinds"]


def test_claude_reader_follows_the_live_branch_only(tmp_path):
    """A rewind leaves the abandoned branch in the file: only the chain to the last message is copied."""
    base = {"sessionId": "s", "cwd": "/w", "isSidechain": False}
    lines = [
        rec(type="user", uuid="u1", parentUuid=None, message={"role": "user", "content": "first"}, **base),
        rec(type="assistant", uuid="a1", parentUuid="u1",
            message={"role": "assistant", "content": [{"type": "text", "text": "answer"}]}, **base),
        rec(type="user", uuid="dead", parentUuid="a1", message={"role": "user", "content": "DEAD-BRANCH"}, **base),
        rec(type="user", uuid="side", parentUuid="a1", isMeta=True,
            message={"role": "user", "content": "META-NOT-COPIED"}, **{**base, "isSidechain": True}),
        rec(type="user", uuid="u2", parentUuid="a1", message={"role": "user", "content": [
            {"type": "text", "text": "<command-name>/goal</command-name><command-args>ship it</command-args>"},
            {"type": "image", "source": {"type": "base64", "data": "IMAGE-BYTES"}}]}, **base),
    ]
    path = tmp_path / "s.jsonl"
    path.write_text("".join(lines), encoding="utf-8")
    conv = convert_read.read(str(path), "s", "claude")
    assert [(i["role"], i["text"]) for i in conv.items] == [
        ("user", "first"), ("assistant", "answer"), ("user", "/goal ship it"), ("user", "[image]")]
    assert conv.cwd == "/w"


def test_tool_output_is_clipped(tmp_path):
    long = "x" * 5000
    lines = [rec(type="assistant", uuid="a", parentUuid=None, sessionId="s", message={
                 "role": "assistant", "content": [{"type": "tool_use", "id": "t", "name": "Bash",
                                                   "input": {"command": "cat big"}}]}),
             rec(type="user", uuid="r", parentUuid="a", sessionId="s", message={
                 "role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": long}]})]
    path = tmp_path / "s.jsonl"
    path.write_text("".join(lines), encoding="utf-8")
    item = convert_read.read(str(path), "s", "claude").items[0]
    assert item["text"] == "cat big" and len(item["output"]) < convert_read.OUTPUT_LIMIT + 20
    assert item["output"].endswith("…[truncated]")


def _post(base, token, route, body):
    req = urllib.request.Request(f"{base}{route}", data=json.dumps(body).encode(),
                                 headers={"Origin": base, "X-Atlas-Token": token,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def test_routes_need_confirmation_and_index_the_new_session(converted, live_server):
    base, token = live_server
    plan = _post(base, token, "/api/resume-with/plan", {"session_id": X.CLAUDE_ID, "agent": "codex"})
    assert plan["same_agent"] is False and plan["messages"] == 4
    with pytest.raises(urllib.error.HTTPError) as err:
        _post(base, token, "/api/resume-with", {"session_id": X.CLAUDE_ID, "agent": "codex"})
    assert err.value.code == 400
    with pytest.raises(urllib.error.HTTPError) as err:
        _post(base, token, "/api/resume-with", {"session_id": X.CLAUDE_ID, "agent": "gemini", "confirmed": True})
    assert err.value.code == 400
    r = _post(base, token, "/api/resume-with", {"session_id": X.CLAUDE_ID, "agent": "codex", "confirmed": True})
    assert r["converted"] and os.path.exists(r["path"])
    card = None
    for _ in range(100):                  # indexed by a thread right after the response
        try:
            with urllib.request.urlopen(f"{base}/api/session/{r['session_id']}", timeout=20) as resp:
                card = json.loads(resp.read())
            break
        except urllib.error.HTTPError:
            time.sleep(0.05)
    assert card["converted_from"]["session_id"] == X.CLAUDE_ID and card["agent"] == "codex"


def test_claude_reader_without_parent_links_starts_at_the_last_summary(tmp_path):
    """Records without parentUuid (made-up corpora, very old transcripts): file order, last summary on."""
    def user(uid, text, **kw):
        return rec(type="user", uuid=uid, sessionId="s", message={"role": "user", "content": text}, **kw)
    lines = [user("u1", "before the compaction"),
             user("s1", X.COMPACT + "the summary", isCompactSummary=True),
             user("u2", "after the compaction"),
             rec(type="assistant", uuid="a2", sessionId="s",
                 message={"role": "assistant", "content": [{"type": "text", "text": "done"}]})]
    path = tmp_path / "s.jsonl"
    path.write_text("".join(lines), encoding="utf-8")
    conv = convert_read.read(str(path), "s", "claude")
    assert conv.summary.endswith("the summary")
    assert [i["text"] for i in conv.items] == ["after the compaction", "done"]
