"""Images for a quick reply: the page stores them here, the plugin pastes the path into the terminal.

Claude Code turns a pasted image path into an `[Image #N]` attachment itself (verified on a
live TUI). So the image is passed as a file, not as bytes through the terminal.
"""
from __future__ import annotations

import base64
import binascii
import os
import re
import stat
import time
import uuid
from pathlib import Path

from . import db
from .messages import msg

MAX_BYTES = 10 * 1024 * 1024
KEEP_SECONDS = 7 * 24 * 3600
# OpenCode echoes the base64 files in its admission response. Leave room for text and metadata.
REPLY_IMAGE_BYTES = 2 * 1024 * 1024
UPLOAD_NAME = re.compile(r"[0-9a-f]{32}\.(?:png|jpg|gif|webp)")
# Type is detected from the first bytes, not the name: the page sends the extension.
SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
)


class UploadError(ValueError):
    """The message is shown to the user as is."""


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
    """Old uploads do not pile up: a week leaves room for "reply tomorrow"."""
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


def reply_files(images):
    """Validate file references produced by /api/upload before passing them to a local service."""
    if not isinstance(images, list) or len(images) > 5:
        raise UploadError(msg("opencode.live_image_missing"))
    if not images:
        return []
    base = Path(uploads_dir()).absolute()
    files = []
    total = 0
    try:
        if not stat.S_ISDIR(base.lstat().st_mode):
            raise OSError
        for image in images:
            raw = image.get("path") if isinstance(image, dict) else None
            if not isinstance(raw, str):
                raise ValueError
            file = Path(raw)
            if file.parent != base or not UPLOAD_NAME.fullmatch(file.name):
                raise ValueError
            fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or _kind(stream.read(12)) != file.suffix[1:]:
                    raise ValueError
                total += info.st_size
            name = image.get("name")
            if (not isinstance(name, str) or not name or len(name) > 255 or not name.isprintable()
                    or name in {".", ".."} or "/" in name or "\\" in name):
                name = file.name
            files.append({"uri": file.as_uri(), "name": name})
    except (OSError, ValueError):
        raise UploadError(msg("opencode.live_image_missing")) from None
    if total > REPLY_IMAGE_BYTES:
        raise UploadError(msg("opencode.live_image_size", mb=REPLY_IMAGE_BYTES // (1024 * 1024)))
    return files
