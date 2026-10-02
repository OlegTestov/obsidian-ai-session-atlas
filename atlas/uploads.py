"""Картинки для быстрого ответа: страница кладёт их сюда, плагин вставляет путь в терминал.

Claude Code сам превращает вставленный путь к картинке во вложение `[Image #N]` — проверено
на живом TUI. Поэтому картинка передаётся файлом, а не байтами через терминал.
"""
from __future__ import annotations

import base64
import binascii
import os
import time
import uuid

from . import db
from .messages import msg

MAX_BYTES = 10 * 1024 * 1024
KEEP_SECONDS = 7 * 24 * 3600
# Тип — по первым байтам, а не по имени: расширение присылает страница.
SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)


class UploadError(ValueError):
    """Объяснение уходит пользователю как есть."""


def uploads_dir() -> str:
    path = os.path.join(db.atlas_home(), "uploads")
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def _kind(data: bytes) -> str | None:
    for magic, ext in SIGNATURES:
        if data.startswith(magic):
            return ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def cleanup(now: float | None = None) -> int:
    """Старые загрузки не копятся: неделя — с запасом на «ответить завтра»."""
    now = now or time.time()
    removed = 0
    for name in os.listdir(uploads_dir()):
        path = os.path.join(uploads_dir(), name)
        try:
            if now - os.stat(path).st_mtime > KEEP_SECONDS:
                os.remove(path)
                removed += 1
        except OSError:
            continue
    return removed


def save_image(data_b64: str) -> dict:
    if not isinstance(data_b64, str) or not data_b64:
        raise UploadError(msg("upload.missing"))
    if "," in data_b64[:100] and data_b64.startswith("data:"):
        data_b64 = data_b64.split(",", 1)[1]           # data:image/png;base64,…
    try:
        data = base64.b64decode(data_b64, validate=True)
    except (binascii.Error, ValueError):
        raise UploadError(msg("upload.corrupt")) from None
    if len(data) > MAX_BYTES:
        raise UploadError(msg("upload.too_big", mb=MAX_BYTES // (1024 * 1024)))
    ext = _kind(data)
    if ext is None:
        raise UploadError(msg("upload.format"))
    cleanup()
    path = os.path.join(uploads_dir(), f"{uuid.uuid4().hex}.{ext}")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return {"path": path, "bytes": len(data), "kind": ext}
