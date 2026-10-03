"""Server texts in two languages: the page language arrives in the X-Atlas-Lang header."""
from __future__ import annotations

import json
import re
import threading
import urllib.error
import urllib.request

import pytest

from atlas import messages, server
from atlas.messages import msg
from tests.test_actions_security import _post


def _fields(text) -> set:
    items = text if isinstance(text, list) else [text]
    return {f for t in items for f in re.findall(r"\{(\w+)\}", t)}


def test_every_key_has_both_languages_with_the_same_fields():
    for key, table in messages.MESSAGES.items():
        assert set(table) == set(messages.LANGS), key
        assert _fields(table["en"]) == _fields(table["ru"]), key
        if isinstance(table["ru"], list):
            assert len(table["ru"]) == 3 and len(table["en"]) == 2, key


def test_default_is_english_and_unknown_language_falls_back():
    t = threading.Thread(target=lambda: out.append(messages.request_lang()))
    out: list = []
    t.start()
    t.join()
    assert out == ["en"]                                  # a new thread has no language of its own
    assert messages.normalize(None) == "en" and messages.normalize("de") == "en"
    assert messages.normalize("RU") == "ru"
    assert msg("stats.no_topic", "de") == "no topic"


def test_use_lang_switches_and_restores():
    before = messages.request_lang()
    with messages.use_lang("ru"):
        assert msg("server.no_job") == "нет такой джобы"
        assert msg("upload.too_big", mb=10) == "картинка больше 10 МБ"
    assert messages.request_lang() == before
    assert msg("server.no_job", "en") == "no such job"


@pytest.mark.parametrize("n, ru, en", [
    (1, "прочитал 1 файл", "read 1 file"),
    (3, "прочитал 3 файла", "read 3 files"),
    (11, "прочитал 11 файлов", "read 11 files"),
    (22, "прочитал 22 файла", "read 22 files"),
])
def test_plural_forms(n, ru, en):
    assert messages.plural("feed.read", n, "ru") == ru
    assert messages.plural("feed.read", n, "en") == en


def test_server_answers_in_the_page_language(live_server):
    base, token = live_server
    with pytest.raises(urllib.error.HTTPError) as en:
        urllib.request.urlopen(f"{base}/api/job/nope", timeout=5)
    assert json.loads(en.value.read())["error"] == "no such job"

    req = urllib.request.Request(f"{base}/api/job/nope", headers={"X-Atlas-Lang": "ru"})
    with pytest.raises(urllib.error.HTTPError) as ru:
        urllib.request.urlopen(req, timeout=5)
    assert json.loads(ru.value.read())["error"] == "нет такой джобы"
    assert messages.last_lang() == "ru"                   # the background scheduler picks it up

    with pytest.raises(urllib.error.HTTPError) as bad:
        _post(f"{base}/api/auto-classify", {"enabled": "yes"},
              {"Origin": base, "X-Atlas-Token": token, "X-Atlas-Lang": "ru"})
    assert json.loads(bad.value.read())["error"] == "нужно enabled: true или false"


def test_export_labels_follow_the_language(monkeypatch, tmp_path):
    monkeypatch.setattr(server.os.path, "expanduser", lambda p: str(tmp_path))
    (tmp_path / "Desktop").mkdir()
    monkeypatch.setattr(server.config, "workspace_roots", lambda: [])
    monkeypatch.setattr(server.config, "workspace_containers", lambda: [])
    assert list(server.export_destinations("en")) == ["Desktop"]
    assert list(server.export_destinations("ru")) == ["Рабочий стол"]
