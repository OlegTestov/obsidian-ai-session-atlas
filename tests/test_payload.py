"""Сборка выдержки под бюджет: что уходит наружу и в каком приоритете."""
from __future__ import annotations

import json
import os

import pytest

from atlas import db, index, messages, runner, service
from tests.conftest import assistant_text, assistant_tool, rec, user_text


@pytest.fixture
def ru():
    """Подписи разделов — на языке страницы; эти проверки держат русский текст."""
    with messages.use_lang("ru"):
        yield


def _conn(atlas_env):
    return db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))


def _session(write_session, answers=40):
    lines = [rec(type="user", timestamp="2026-09-01T09:00:00.000Z", cwd="/Users/u/Code/demo",
                 entrypoint="cli",
                 message={"role": "user",
                          "content": "This session is being continued from a previous "
                                     "conversation. Summary: ранее чинили ETL"})]
    lines.append(user_text("первый запрос про пайплайн"))
    for i in range(answers):
        lines.append(assistant_text(f"ответ номер {i} " + "детали " * 40,
                                    ts=f"2026-09-01T10:{i % 60:02d}:00.000Z"))
    lines.append(assistant_tool("Bash", {"command": "pytest -q"}))
    lines.append(user_text("последний запрос про релиз"))
    return write_session("p", lines)


def test_summaries_and_prompts_survive_a_tight_budget(atlas_env, write_session, monkeypatch, ru):
    """Цель и решения несут сводки и запросы — они режутся последними."""
    _session(write_session, answers=60)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    sid = conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]

    monkeypatch.setitem(runner.TOKEN_BUDGET, "handoff", int(4000 / runner.CHARS_PER_TOKEN))
    p = runner.build_payload(conn, sid, "handoff")
    assert p["kept"]["Сводки компактации"] == p["totals"]["summaries"]
    assert p["kept"]["Запросы пользователя"] == p["totals"]["prompts"]
    assert p["kept"].get("Ответы ассистента (хвост сессии)", 0) < p["totals"]["answers"]
    assert p["truncated"] is True
    assert p["chars"] <= 4000 + 2000          # шапка может чуть перевесить крошечный бюджет


def test_answers_are_taken_from_the_end(atlas_env, write_session, monkeypatch):
    """«Последняя часть сессии» — это хвост: начало теряется раньше конца."""
    _session(write_session, answers=60)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    sid = conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]

    monkeypatch.setitem(runner.TOKEN_BUDGET, "handoff", int(12000 / runner.CHARS_PER_TOKEN))
    text = runner.build_payload(conn, sid, "handoff")["text"]
    assert "ответ номер 59" in text
    assert "ответ номер 0 " not in text


def test_whole_session_fits_when_budget_allows(atlas_env, write_session, ru):
    _session(write_session, answers=10)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    sid = conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]
    p = runner.build_payload(conn, sid, "handoff")
    assert p["truncated"] is False
    assert p["kept"]["Ответы ассистента (хвост сессии)"] == p["totals"]["answers"]


def test_handoff_budget_is_far_larger_than_summary_budget():
    """Описание для каталога не требует всей сессии, хендофф требует."""
    import os
    from tests.conftest import write_config
    write_config(os.environ["ATLAS_HOME"], {"models": {"handoff": ["claude-opus-5-5", "medium"]}})
    assert runner.TOKEN_BUDGET["handoff"] > 10 * runner.TOKEN_BUDGET["catalog_summary"]
    assert runner.TOKEN_BUDGET["handoff"] >= 700_000
    # Кириллица ~2.1 символа на токен: делить на 4 значит вдвое переполнить окно.
    assert 1.8 < runner.CHARS_PER_TOKEN < 2.6
    assert runner.has_1m_window(runner.model_for("handoff")[0])
    assert not runner.has_1m_window("claude-opus-5")          # без суффикса — 200k


def test_preview_shows_head_and_tail_and_saves_the_full_text(atlas_env, write_session, ru):
    """3 МБ в окно подтверждения не влезут — показываем края, полный текст кладём в файл."""
    _session(write_session, answers=200)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    sid = conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]

    prev = runner.preview_payload(conn, sid, "handoff")
    assert len(prev["text"]) < prev["chars"]
    assert "пропущено" in prev["text"]
    assert os.path.exists(prev["full_path"])
    assert len(open(prev["full_path"], encoding="utf-8").read()) == prev["chars"]
    assert oct(os.stat(prev["full_path"]).st_mode)[-3:] == "600"


def test_argv_carries_the_isolation_flags():
    """Изоляция задаётся флагами; их поломка должна ловиться, а не проявляться в проде."""
    argv = runner._argv("/usr/bin/claude", "claude-sonnet-5", "low")
    joined = " ".join(argv)
    assert "--setting-sources  " in joined + " "     # пустой источник настроек
    assert "--strict-mcp-config" in argv
    assert "--allowed-tools" in argv
    assert "--effort" in argv and "low" in argv
    assert "MultiEdit" not in joined                 # имя тула больше не известно CLI


def test_large_prompt_triggers_preflight(monkeypatch):
    calls = []
    monkeypatch.setattr(runner, "find_claude", lambda: "/fake/bin/claude")   # на CI claude нет
    monkeypatch.setattr(runner, "preflight", lambda **kw: calls.append(kw))
    monkeypatch.setattr(runner.subprocess, "run",
                        lambda *a, **k: type("P", (), {"returncode": 0, "stdout": "ok",
                                                       "stderr": ""})())
    runner.run_isolated("x" * (runner.PREFLIGHT_ABOVE + 1))
    assert len(calls) == 1
    runner.run_isolated("коротко")
    assert len(calls) == 1                            # на маленьком вызове предпроверки нет


def test_claude_is_found_without_a_user_path(monkeypatch, tmp_path):
    """launchd не наследует PATH: сервер под ним не находил claude и классификация падала."""
    monkeypatch.setattr(runner.shutil, "which", lambda name: None)
    monkeypatch.setattr(runner, "CLAUDE_CANDIDATES", ())
    with pytest.raises(RuntimeError, match="claude not found"):     # без заголовка — en
        runner.find_claude()

    fake = tmp_path / "claude"
    fake.write_text("#!/bin/sh\n")
    fake.chmod(0o755)
    monkeypatch.setattr(runner, "CLAUDE_CANDIDATES", (str(fake),))
    assert runner.find_claude() == str(fake)


def test_launchagent_path_carries_local_bin(monkeypatch, tmp_path):
    """launchd не наследует PATH: в plist первым — ~/.local/bin, где ставится claude."""
    target = tmp_path / "agent.plist"
    monkeypatch.setattr(service, "plist_path", lambda: str(target))
    monkeypatch.setattr(service.subprocess, "run", lambda *a, **k: None)     # launchctl не трогаем
    service.install()
    plist = target.read_text(encoding="utf-8")
    path = plist.split("<key>PATH</key><string>")[1].split("</string>")[0].split(":")
    assert path[0] == os.path.expanduser("~/.local/bin") and "/opt/homebrew/bin" in path


def test_summary_is_produced_end_to_end_with_only_the_model_call_faked(atlas_env, write_session,
                                                                       monkeypatch):
    """«Что сделано» целиком, кроме платного вызова: шаблон с JSON-образцом, разбор, запись."""
    from atlas import actions, enrich
    _session(write_session)
    conn = _conn(atlas_env)
    index.index_all(conn, root=str(atlas_env["projects"]))
    sid = conn.execute("SELECT session_id FROM sessions").fetchone()["session_id"]
    sent = []

    def fake_model(prompt, **kw):
        sent.append(prompt)
        return '{"did": "чинил тесты", "result": "зелёные", "open": null, "work_outcome": "done"}'
    monkeypatch.setattr(runner, "run_isolated", fake_model)
    model, _ = runner.model_for("catalog_summary")
    payload = runner.build_payload(conn, sid, "catalog_summary")
    runner.grant_egress(conn, sid, payload["content_hash"], "catalog_summary",
                        runner.EXTERNAL_BACKEND, model)
    job_id, _ = actions.claim_job(conn, sid, "catalog_summary", payload["content_hash"])
    out = enrich.produce(conn, sid, "catalog_summary", job_id)
    assert json.loads(out["payload"])["did"] == "чинил тесты"
    assert payload["text"][:200] in sent[0], "выдержка сессии — в запросе к модели"
    assert '"did"' in sent[0], "образец JSON дошёл до модели как есть"
    art = enrich.cached(conn, sid, "catalog_summary")
    assert art and json.loads(art["payload"])["result"] == "зелёные"
