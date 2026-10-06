"""Actions, job idempotency, fail-closed egress and local server protection."""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from atlas import actions, db, enrich, index, prompts, runner, search
from tests.conftest import user_text, write_config


def page_source(here: str) -> str:
    """The whole page: markup, styles and scripts live in web/index.html and web/js/."""
    import glob as _glob
    parts = [Path(here, "web", "index.html").read_text(encoding="utf-8")]
    for path in sorted(_glob.glob(os.path.join(here, "web", "js", "*"))):
        parts.append(Path(path).read_text(encoding="utf-8"))
    return "\n".join(parts)

def _conn(atlas_env):
    return db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))


# --- commands -------------------------------------------------------------

def test_apostrophe_in_path_does_not_break_the_command():
    cwd = "/Users/u/Anna's Code/demo"
    import shlex
    cmd = actions.resume_command(cwd, "11111111-1111-1111-1111-111111111111")
    # The apostrophe is escaped, so it is not visible literally — what matters is that the shell
    # parses the command back into exactly the same arguments.
    assert shlex.split(cmd.split("&&", 1)[0]) == ["cd", cwd]
    assert shlex.split(cmd.split("&&", 1)[1])[:2] == ["claude", "--resume"]


def test_invalid_session_id_yields_no_command():
    assert actions.resume_command("/tmp", "не-uuid; rm -rf /") is None
    assert not actions.valid_session_id("'; osascript -e 'x")


def test_new_session_command_carries_a_real_first_prompt():
    cmd = actions.new_session_command("/Users/u/demo",
                                      "22222222-2222-2222-2222-222222222222",
                                      "/path/to/HANDOFF.md")
    assert "--session-id" in cmd
    assert "/path/to/HANDOFF.md" in cmd
    assert "Прочитай" in cmd


# --- jobs ----------------------------------------------------------------

def test_double_press_returns_the_same_job(atlas_env, write_session):
    write_session("p", [user_text("работа")], session_id="11111111-1111-1111-1111-111111111111")
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    first, created1 = actions.claim_job(conn, "11111111-1111-1111-1111-111111111111",
                                        "handoff", "hash-a")
    second, created2 = actions.claim_job(conn, "11111111-1111-1111-1111-111111111111",
                                         "handoff", "hash-a")
    assert first == second
    assert created1 is True and created2 is False


def test_new_content_starts_a_new_job(atlas_env):
    conn = _conn(atlas_env)
    a, _ = actions.claim_job(conn, "s", "handoff", "hash-a")
    actions.set_job_state(conn, a, "done")
    b, created = actions.claim_job(conn, "s", "handoff", "hash-b")
    assert b != a and created is True


def test_cancel_marks_intent_and_worker_sees_it(atlas_env):
    conn = _conn(atlas_env)
    job, _ = actions.claim_job(conn, "s", "handoff", "hash-a")
    assert actions.cancel_job(conn, job) is True
    assert actions.is_cancelled(conn, job) is True
    assert actions.cancel_job(conn, job) is False   # a repeated cancel changes nothing


def test_pending_launch_becomes_lineage_only_after_the_session_appears(atlas_env, write_session):
    conn = _conn(atlas_env)
    new_id = actions.register_pending_launch(conn, "source-1", "/tmp/h.md")
    assert actions.confirm_launches(conn) == 0
    assert actions.lineage(conn, new_id)["derived_from"]["confirmed_at"] is None

    write_session("p", [user_text("продолжаю по хендоффу")], session_id=new_id)
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert actions.confirm_launches(conn) == 1
    assert actions.lineage(conn, new_id)["derived_from"]["confirmed_at"] is not None


# --- egress ---------------------------------------------------------------

def test_unclassified_session_may_not_leave_without_a_grant(atlas_env):
    conn = _conn(atlas_env)
    with pytest.raises(runner.EgressDenied):
        runner.check_egress(conn, "s", "hash-a", "handoff",
                            runner.EXTERNAL_BACKEND, runner.DEFAULT_MODEL)


def test_grant_is_bound_to_one_content_state(atlas_env):
    conn = _conn(atlas_env)
    runner.grant_egress(conn, "s", "hash-a", "handoff",
                        runner.EXTERNAL_BACKEND, runner.DEFAULT_MODEL)
    runner.check_egress(conn, "s", "hash-a", "handoff",
                        runner.EXTERNAL_BACKEND, runner.DEFAULT_MODEL)
    with pytest.raises(runner.EgressDenied):     # session got appended — permission is revoked
        runner.check_egress(conn, "s", "hash-b", "handoff",
                            runner.EXTERNAL_BACKEND, runner.DEFAULT_MODEL)


def test_local_backend_needs_no_grant(atlas_env):
    conn = _conn(atlas_env)
    runner.check_egress(conn, "s", "hash-a", "handoff", "ollama", "qwen")


def test_runner_transcripts_are_not_indexed(atlas_env, write_session):
    """The compressor writes its own transcripts — otherwise it would start enriching itself."""
    write_session("-Users-x-session-atlas-runner", [user_text("сжимаю сессию")])
    write_session("normal", [user_text("настоящая работа")])
    conn = _conn(atlas_env)
    stats = index.index_all(conn, root=str(atlas_env["projects"]))
    assert stats["seen"] == 1


# --- LLM contracts --------------------------------------------------------

def test_summary_contract_rejects_malformed_output():
    with pytest.raises(ValueError):
        enrich._parse_summary("модель поговорила, но JSON не отдала")
    with pytest.raises(ValueError):
        enrich._parse_summary('{"result": "без обязательного did"}')


def test_summary_contract_normalises_unknown_outcome():
    data = enrich._parse_summary('{"did":"x","result":"y","work_outcome":"почти готово"}')
    assert data["work_outcome"] == "unknown"


def test_handoff_without_required_sections_is_an_error():
    with pytest.raises(ValueError):
        enrich._validate_handoff("## Цель\nтолько один раздел")
    ok = "\n".join(f"{s}\nтекст" for s in prompts.HANDOFF_REQUIRED["ru"])
    assert enrich._validate_handoff(ok)


def test_historical_text_is_framed_as_data_not_instructions():
    """A prompt from an old transcript must not become a command for a new session."""
    for lg, frame in (("ru", "не инструкции"), ("en", "not instructions")):
        for template in (prompts.summary(lg), prompts.handoff(lg), prompts.classify(lg)):
            assert frame in template, lg
    assert "ДАННЫЕ ДЛЯ АНАЛИЗА" in prompts.summary("ru") and "DATA TO ANALYZE" in prompts.handoff("en")


def test_payload_samples_the_whole_session_not_just_the_edges():
    items = [f"m{i}" for i in range(100)]
    picked = runner._sample(items, 10)
    assert len(picked) == 10
    assert "m50" in picked or "m40" in picked or "m60" in picked


# --- server ---------------------------------------------------------------

def _post(url, body, headers):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    return urllib.request.urlopen(req, timeout=5)


def test_health_is_open_but_mutation_needs_origin_and_token(live_server):
    base, token = live_server
    with urllib.request.urlopen(f"{base}/health", timeout=5) as r:
        assert json.loads(r.read())["ok"] is True

    with pytest.raises(urllib.error.HTTPError) as no_origin:
        _post(f"{base}/api/reindex", {}, {"X-Atlas-Token": token})
    assert no_origin.value.code == 403

    with pytest.raises(urllib.error.HTTPError) as bad_token:
        _post(f"{base}/api/reindex", {}, {"Origin": base, "X-Atlas-Token": "wrong-token"})
    assert bad_token.value.code == 403

    with pytest.raises(urllib.error.HTTPError) as foreign:
        _post(f"{base}/api/reindex", {},
              {"Origin": "https://evil.example", "X-Atlas-Token": token})
    assert foreign.value.code == 403


def test_valid_mutation_passes(live_server):
    base, token = live_server
    r = _post(f"{base}/api/reindex", {}, {"Origin": base, "X-Atlas-Token": token})
    assert r.status == 200


def test_export_refuses_a_destination_outside_the_allowlist(live_server):
    base, token = live_server
    with pytest.raises(urllib.error.HTTPError) as exc:
        _post(f"{base}/api/export",
              {"session_id": "11111111-1111-1111-1111-111111111111",
               "destination": "/etc"},
              {"Origin": base, "X-Atlas-Token": token})
    assert exc.value.code == 400


def test_bad_session_id_is_refused_before_any_work(live_server):
    base, token = live_server
    with pytest.raises(urllib.error.HTTPError) as exc:
        _post(f"{base}/api/terminal", {"session_id": "'; rm -rf /"},
              {"Origin": base, "X-Atlas-Token": token})
    assert exc.value.code == 400


def test_page_never_injects_transcript_text_as_html():
    """Transcripts contain HTML and JS of written artifacts — a real XSS vector."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    html = page_source(here)
    assert not re.search(r"\.innerHTML\s*=", html)
    assert not re.search(r"\.outerHTML\s*=", html)
    assert not re.search(r"insertAdjacentHTML|document\.write\(", html)
    assert "Content-Security-Policy" not in html      # the header is set by the server, not the page


def test_unique_index_guards_the_race_python_cannot(atlas_env):
    """The early return in claim_job does not prevent a two-thread race — the DB index does."""
    conn = _conn(atlas_env)
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_jobs_active'"
    ).fetchone()
    assert row is not None, "index ux_jobs_active is missing"
    assert "UNIQUE" in row["sql"].upper()

    # And it really forbids a second active job for the same tuple.
    import sqlite3
    conn.execute("INSERT INTO jobs (job_id, session_id, action_kind, content_hash, state, "
                 "created_at, updated_at) VALUES ('j1','s','handoff','h','queued','t','t')")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO jobs (job_id, session_id, action_kind, content_hash, state, "
                     "created_at, updated_at) VALUES ('j2','s','handoff','h','running','t','t')")


# --- classification ---

def test_sensitive_sessions_are_never_queued_for_external_classification(atlas_env,
                                                                        write_session):
    from atlas import classify
    sid = "77777777-7777-7777-7777-777777777777"
    write_session("p", [user_text("личные документы")], session_id=sid)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert sid in classify.pending(conn)

    conn.execute("INSERT INTO user_overrides(session_id, sensitivity, updated_at) "
                 "VALUES (?,?,?)", (sid, "sensitive", "t"))
    conn.commit()
    assert sid not in classify.pending(conn)


def test_classifier_verdict_contract():
    from atlas import classify
    with pytest.raises(ValueError):
        classify._verdict({"domain": "выдуманный", "topic": "x"})
    with pytest.raises(ValueError):
        classify._verdict({"domain": "personal", "topic": "  "})
    # "разное" (misc) with high confidence is a contradiction, so confidence is reset.
    assert classify._verdict(
        {"domain": "personal", "topic": "разное", "confidence": 0.95})["confidence"] < 0.5
    # The one-line summary is part of the contract: it goes into the list row.
    v = classify._verdict({"domain": "personal", "topic": "Почта",
                           "summary": "  Разбирали   личную почту  ", "confidence": 0.9})
    assert v["summary"] == "Разбирали личную почту"


def test_batch_parser_keeps_only_valid_entries():
    from atlas import classify
    out = classify.parse_batch(
        '[{"n":1,"domain":"personal","topic":"почта","confidence":0.8},'
        ' {"n":2,"domain":"чепуха","topic":"x"},'
        ' {"n":9,"domain":"personal","topic":"вне диапазона"}]', expected=2)
    assert set(out) == {1}
    assert out[1]["topic"] == "почта"


# --- renaming ---

def test_rename_appends_one_line_and_keeps_the_transcript_intact(atlas_env, write_session):
    """The only write to a transcript: append a single line of the same shape Claude writes."""
    sid = "99999999-9999-9999-9999-999999999999"
    path = write_session("p", [user_text("исходная работа")], session_id=sid)
    before = Path(path).read_text(encoding="utf-8")
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))

    result = actions.rename_session(conn, sid, "  Понятное   имя  ")
    assert result["title"] == "Понятное имя"
    assert result["written_to_transcript"] is True and result["error"] is None

    after = Path(path).read_text(encoding="utf-8")
    assert after.startswith(before)                      # existing lines are untouched
    added = after[len(before):].strip().splitlines()
    assert len(added) == 1                               # exactly one new line
    rec_added = json.loads(added[0])
    assert rec_added == {"type": "custom-title", "customTitle": "Понятное имя", "sessionId": sid}

    index.index_all(conn, root=str(atlas_env["projects"]))
    meta = search.load_session(conn, sid)
    assert meta["title"] == "Понятное имя"
    assert meta["title_source"] == "manual"


def test_rename_can_skip_the_transcript(atlas_env, write_session):
    sid = "aaaaaaaa-9999-9999-9999-999999999999"
    path = write_session("p", [user_text("работа")], session_id=sid)
    before = Path(path).read_text(encoding="utf-8")
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    result = actions.rename_session(conn, sid, "Только в каталоге", write_to_transcript=False)
    assert result["written_to_transcript"] is False
    assert Path(path).read_text(encoding="utf-8") == before
    assert search.load_session(conn, sid)["title"] == "Только в каталоге"


def test_rename_refuses_empty_and_bad_id(atlas_env):
    conn = _conn(atlas_env)
    with pytest.raises(ValueError):
        actions.rename_session(conn, "99999999-9999-9999-9999-999999999999", "   ")
    with pytest.raises(ValueError):
        actions.rename_session(conn, "не-uuid", "имя")


def test_rename_opens_the_transcript_in_append_mode():
    """Pins the mode itself: a mutation to "w" once survived a revert via the bytecode cache."""
    import inspect
    src = inspect.getsource(actions.rename_session)
    assert '"a", encoding="utf-8"' in src
    assert '"w"' not in src


# --- embedding in Obsidian ---

def test_csp_allows_framing_only_by_self_and_obsidian(live_server):
    """Obsidian runs on the app:// scheme; nothing else may embed the page."""
    base, _ = live_server
    with urllib.request.urlopen(base + "/", timeout=5) as r:
        csp = r.headers.get("Content-Security-Policy")
    assert "frame-ancestors 'self' app:" in csp
    assert "default-src 'none'" in csp


def test_page_talks_to_the_host_only_when_embedded():
    """The bridge turns on by itself when framed: outside Obsidian the behaviour is unchanged."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    html = page_source(here)
    assert "const EMBEDDED = window.parent !== window;" in html
    assert "if (!EMBEDDED) return false;" in html
    assert "Открыть вкладкой в Obsidian" in html


def test_menu_hidden_rule_matches_id_specificity():
    """#menu beats .hidden on specificity: the hiding rule must have the same weight."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    html = page_source(here)
    assert "#menu.hidden{display:none}" in html
    assert "#rw-menu.hidden{display:none}" in html                # the "Resume with…" menu too
    # And there is exactly one close listener, not one per card opening.
    assert html.count('document.addEventListener("click"') == 1


def test_help_is_built_from_dom_not_markup_strings():
    """Help is built via the DOM: the page has a CSP and bans innerHTML."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    html = page_source(here)
    assert 'id="help-btn"' in html and "function buildHelp()" in html
    assert "Какую кнопку нажимать" in html
    # The dialog is taller than the screen — the body must scroll, or the top is cut off.
    assert "max-height:82vh" in html


def test_dialog_display_is_scoped_to_open_attribute():
    """The browser hides a closed <dialog> itself; an id rule overriding that keeps the dialog visible."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    html = page_source(here)
    assert "#help[open]{display:flex" in html
    help_rule = html.split("#help{", 1)[1].split("}", 1)[0]
    assert "display" not in help_rule, "display on #help without [open] breaks closing"


def test_page_uses_no_native_dialogs():
    """In Obsidian the page runs in Electron: prompt/alert/confirm silently do nothing there."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    html = page_source(here)
    # Comments are not code: they mention these words precisely to explain why they are absent.
    code = "\n".join(line for line in html.splitlines() if not line.strip().startswith("//"))
    for fn in ("prompt(", "alert(", "confirm("):
        assert not re.search(r"(?<![\w.])" + re.escape(fn), code), f"{fn} does not work in Electron"
    assert 'id="rename"' in html and "#rename[open]{display:block}" in html


def test_running_classification_is_visible_to_a_fresh_page(atlas_env, write_session):
    """A job lives on the server: the page can be closed and the progress picked up again."""
    from atlas import server
    sid = "bbbbbbbb-1111-2222-3333-444444444444"
    write_session("p", [user_text("работа")], session_id=sid)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))

    handler = server.Handler.__new__(server.Handler)
    assert handler._facets(conn)["classify_job"] is None

    job_id, _ = actions.claim_job(conn, "batch", "classification", "pending-1")
    assert handler._facets(conn)["classify_job"] == job_id

    actions.set_job_state(conn, job_id, "done")
    assert handler._facets(conn)["classify_job"] is None


def test_long_quote_cannot_widen_the_card():
    """A 178-character path must not widen the grid column and push the card right with a scrollbar."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    html = page_source(here)
    quote_rule = html.split(".quote{", 1)[1].split("}", 1)[0]
    assert "overflow-wrap:anywhere" in quote_rule
    assert "white-space:pre-wrap" in quote_rule, "line breaks in a prompt carry meaning"
    card_rule = html.split("#card{", 1)[1].split("}", 1)[0]
    assert "min-width:0" in card_rule, "a grid cell without min-width:0 grows to fit its content"


def test_responses_are_never_cached():
    """Markup lives on disk: a cached page survives a UI update."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = Path(here, "atlas", "server.py").read_text(encoding="utf-8")
    assert 'self.send_header("Cache-Control", "no-store")' in src


def test_layout_picker_has_a_css_class_for_every_cell():
    """Layout sizes use classes only: the CSP blocks style. No class means the choice silently fails."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    html = page_source(here)
    for n in range(1, 6):                       # compact view — up to 5 × 5
        assert f".agrid.c{n}{{grid-template-columns:repeat({n}," in html
        assert f".agrid.r{n}{{grid-auto-rows:" in html
    for n in range(1, 5):                       # detailed view — up to 4 × 4
        assert f".agrid.full.r{n}{{grid-auto-rows:" in html
    assert "const LAYOUT_MAX = { compact: 5, full: 4 };" in html


def test_keys_hint_is_a_button_that_opens_help():
    """The keyboard hint is a button with a dialog: a title tooltip is barely visible in Obsidian."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    html = page_source(here)
    assert 'el("button", "keys", "?")' in html
    assert 'keys.addEventListener("click", showKeys)' in html
    assert "function showKeys()" in html and 'modal(i18n("keys.title")' in html
    # Help hides the "Copy" button — the other dialogs must bring it back.
    assert '$("#m-copy").classList.remove("hidden");' in html


def test_server_down_shows_a_banner_and_keeps_the_cards():
    """Server down: a network error in api() shows a banner; cards are not wiped by the error."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    html = page_source(here)
    assert 'id="server-banner"' in html
    assert "serverStatus(false);" in html and "serverStatus(true);" in html
    assert 'if (e.name === "AbortError") throw e;' in html, "a cancelled search is not a server failure"
    assert "if (!serverDown || !activeSessions.length) {" in html
    assert 'tellHost("ensure-server", {});' in html


def test_models_come_from_settings_and_default_to_sonnet(tmp_path):
    """Without settings: the sonnet alias, available on any plan, and no [1m] suffix."""
    write_config(os.environ["ATLAS_HOME"], {"models": {}})
    assert runner.model_for("classification") == ("sonnet", "low")
    assert runner.model_for("что-то новое") == ("sonnet", "medium")
    write_config(os.environ["ATLAS_HOME"], {"models": {"classification": ["claude-opus-5-5", "low"],
                                                      "handoff": ["claude-opus-5-5", "medium"]}})
    assert runner.model_for("classification") == ("claude-opus-5-5", "low")
    assert runner.model_for("handoff") == ("claude-opus-5-5", "medium")


def test_force_1m_adds_the_suffix_and_widens_the_budget():
    write_config(os.environ["ATLAS_HOME"], {"models": {"catalog_summary": ["claude-sonnet-5", "low"]}})
    small = runner.budget_chars("handoff")
    assert runner.model_for("catalog_summary") == ("claude-sonnet-5", "low")
    write_config(os.environ["ATLAS_HOME"], {"models": {"catalog_summary": ["claude-sonnet-5", "low"],
                                                      "handoff": ["claude-sonnet-5", "medium"]},
                                            "force_1m": True})
    assert runner.model_for("catalog_summary") == ("claude-sonnet-5[1m]", "low")
    assert runner.budget_chars("handoff") == small * 5         # 1M window vs 200k


def test_index_status_for_the_setup_screen(live_server, write_session):
    base, _ = live_server
    write_session("-Users-u-Code-demo", [user_text("привет")])
    with urllib.request.urlopen(f"{base}/api/index-status", timeout=20) as r:
        data = json.loads(r.read())
    assert set(data) == {"sessions", "indexing"} and isinstance(data["sessions"], int)


def test_server_serves_every_file_the_page_loads(live_server):
    """The whole page via the server: every script and style from index.html is served with the right type."""
    base, _ = live_server
    html = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                "web", "index.html").read_text(encoding="utf-8")
    names = re.findall(r'(?:src|href)="/static/([^"]+)"', html)
    assert "i18n.js" in names and len(names) > 20
    for name in names:
        with urllib.request.urlopen(f"{base}/static/{name}", timeout=10) as r:
            kind = "text/css" if name.endswith(".css") else "text/javascript"
            assert r.status == 200 and r.headers["Content-Type"].startswith(kind), name


def test_shutdown_needs_the_token_and_stops_the_server(live_server):
    base, token = live_server
    with pytest.raises(urllib.error.HTTPError) as no_token:
        _post(f"{base}/api/shutdown", {}, {"Origin": base})
    assert no_token.value.code == 403
    assert _post(f"{base}/api/shutdown", {}, {"Origin": base, "X-Atlas-Token": token}).status == 200
    import time
    for _ in range(40):
        try:
            urllib.request.urlopen(f"{base}/health", timeout=1)
        except OSError:              # refused or silent: the serve loop has stopped
            break
        time.sleep(0.1)
    else:
        raise AssertionError("server did not stop")


def test_csrf_token_file_is_private_from_creation(atlas_env, monkeypatch):
    """The token file is created 0600 at once, not chmod-ed after a world-readable write."""
    from atlas import server
    monkeypatch.setattr(os, "chmod", lambda *a, **k: None)   # a late chmod must not be what protects it
    old_umask = os.umask(0)
    try:
        token = server.csrf_token()
    finally:
        os.umask(old_umask)
    path = os.path.join(db.atlas_home(), "csrf.token")
    assert os.stat(path).st_mode & 0o777 == 0o600
    assert len(token) >= 32 and server.csrf_token() == token


def test_index_pass_with_a_lot_of_stderr_finishes(capsys):
    """stderr of the indexer goes to a file: a pipe nobody reads would stall the process."""
    from atlas import server
    noisy = [sys.executable, "-c", "import sys; sys.stderr.write('x' * 300000); sys.exit(3)"]
    p = server._Pass(noisy)
    p.join(20)
    assert not p.is_alive()
    assert "exit code 3" in capsys.readouterr().err
    assert not p.is_alive()                     # reported once, no second print
    assert capsys.readouterr().err == ""
