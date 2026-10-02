"""ИИ-функции выключены — ни один запрос к модели не уходит: ни с кнопки, ни по расписанию."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

import pytest

from atlas import autoclassify, config, db, runner
from tests.conftest import write_config
from tests.test_actions_security import _post, live_server  # noqa: F401  (фикстура)

SID = "11111111-1111-1111-1111-111111111111"


def _llm(on: bool) -> None:
    write_config(os.environ["ATLAS_HOME"], {"llm_enabled": on})
    config.reset()


def test_runner_refuses_before_touching_claude(monkeypatch):
    _llm(False)
    monkeypatch.setattr(runner, "find_claude", lambda: pytest.fail("claude не должен искаться"))
    with pytest.raises(runner.LlmDisabled):
        runner.run_isolated("hello")


def test_default_config_has_llm_off():
    os.remove(os.path.join(os.environ["ATLAS_HOME"], "config.json"))
    config.reset()
    assert runner.llm_enabled() is False


@pytest.mark.parametrize("path, body", [
    ("/api/job", {"session_id": SID, "artifact_kind": "handoff", "confirmed": True}),
    ("/api/classify", {"confirmed": True}),
    ("/api/auto-classify", {"enabled": True}),
])
def test_model_routes_answer_403_when_off(live_server, path, body):
    base, token = live_server
    _llm(False)
    with pytest.raises(urllib.error.HTTPError) as exc:
        _post(base + path, body, {"Origin": base, "X-Atlas-Token": token, "X-Atlas-Lang": "en"})
    assert exc.value.code == 403
    assert "AI features are off" in json.loads(exc.value.read())["error"]


def test_turning_auto_classify_off_is_always_allowed(live_server):
    base, token = live_server
    _llm(False)
    r = _post(base + "/api/auto-classify", {"enabled": False},
              {"Origin": base, "X-Atlas-Token": token})
    assert r.status == 200


def test_classify_passes_the_gate_when_on(live_server):
    base, token = live_server
    _llm(True)
    r = _post(base + "/api/classify", {"confirmed": True}, {"Origin": base, "X-Atlas-Token": token})
    assert r.status == 200


@pytest.mark.parametrize("on", [False, True])
def test_facets_tell_the_page_whether_ai_is_on(live_server, on):
    base, _ = live_server
    _llm(on)
    with urllib.request.urlopen(base + "/api/facets", timeout=10) as r:
        assert json.loads(r.read())["llm_enabled"] is on


def test_scheduler_does_nothing_when_off(atlas_env):
    conn = db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))
    _llm(True)
    autoclassify.set_enabled(conn, True)
    _llm(False)
    assert autoclassify.tick(conn, now=10**10) is None
    _llm(True)
    assert autoclassify.tick(conn, now=10**10, run=lambda *a, **k: [],
                             summary=lambda *a, **k: None) is not None
