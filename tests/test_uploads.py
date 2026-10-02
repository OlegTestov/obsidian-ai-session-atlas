"""Картинки для быстрого ответа: что принимается и куда ложится."""
from __future__ import annotations

import base64
import json
import os
import stat
import time
import urllib.error
import urllib.request

import pytest

from atlas import messages, uploads
from tests.test_actions_security import _post, live_server  # noqa: F401 — фикстура

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC")


def test_png_is_saved_privately_under_app_data(atlas_env):
    saved = uploads.save_image(base64.b64encode(PNG).decode())
    assert saved["kind"] == "png" and saved["bytes"] == len(PNG)
    assert os.path.dirname(saved["path"]) == uploads.uploads_dir()
    assert stat.S_IMODE(os.stat(saved["path"]).st_mode) == 0o600
    assert open(saved["path"], "rb").read() == PNG


def test_data_url_prefix_is_accepted(atlas_env):
    url = "data:image/png;base64," + base64.b64encode(PNG).decode()
    assert uploads.save_image(url)["kind"] == "png"


@pytest.mark.parametrize("payload, lang, reason", [
    (base64.b64encode(b"<svg onload=alert(1)>").decode(), "en", "PNG, JPEG"),   # svg — не картинка
    ("это не base64!!", "ru", "повреждена"),
    ("это не base64!!", "en", "corrupted"),
    ("", "ru", "нет картинки"),
    ("", "en", "no image"),
])
def test_non_images_are_refused(atlas_env, payload, lang, reason):
    with messages.use_lang(lang), pytest.raises(uploads.UploadError, match=reason):
        uploads.save_image(payload)


def test_type_comes_from_bytes_not_from_name(atlas_env):
    jpeg = b"\xff\xd8\xff\xe0" + b"0" * 32
    assert uploads.save_image(base64.b64encode(jpeg).decode())["path"].endswith(".jpg")


def test_too_big_is_refused(atlas_env, monkeypatch):
    monkeypatch.setattr(uploads, "MAX_BYTES", 10)
    with pytest.raises(uploads.UploadError, match="larger than"):
        uploads.save_image(base64.b64encode(PNG).decode())


def test_old_uploads_are_cleaned(atlas_env):
    old = uploads.save_image(base64.b64encode(PNG).decode())["path"]
    past = time.time() - uploads.KEEP_SECONDS - 60
    os.utime(old, (past, past))
    fresh = uploads.save_image(base64.b64encode(PNG).decode())["path"]
    assert not os.path.exists(old) and os.path.exists(fresh)


def test_upload_endpoint_needs_origin_and_token(atlas_env, live_server):
    base, token = live_server
    body = {"data": base64.b64encode(PNG).decode()}
    with pytest.raises(urllib.error.HTTPError) as no_origin:
        _post(f"{base}/api/upload", body, {"X-Atlas-Token": token})
    assert no_origin.value.code == 403
    with _post(f"{base}/api/upload", body, {"Origin": base, "X-Atlas-Token": token}) as r:
        saved = json.loads(r.read())
    assert saved["kind"] == "png" and os.path.exists(saved["path"])
