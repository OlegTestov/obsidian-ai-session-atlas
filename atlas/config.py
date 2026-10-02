"""Настройки пользователя: `config.json` в папке данных. Его пишет плагин; править руками тоже можно.

Здесь всё, что у разных людей разное: где заметки и проекты, какие домены работы, как выглядят
тикеты, что чувствительно, какие модели звать. Без файла — нейтральные значения по умолчанию:
каталог работает, но не знает ни доменов, ни тикетов, и ИИ-функции выключены.

Файл читается заново, когда меняется его mtime: сервер живёт долго, а настройки правят на ходу.
"""
from __future__ import annotations

import functools
import hashlib
import json
import os
import re
import threading
import time

DEFAULTS = {
    "language": "en",                 # язык тем, описаний и хендоффов: en | ru
    # Папки заметок (Obsidian vault): сама папка — проект, первый уровень внутри — область.
    "vaults": [],                     # [{"path": "~/…", "id": "vault"}]
    # Корни, под которыми первый уровень — самостоятельный проект; контейнеры — проект глубже.
    "workspace_roots": ["~/Code", "~/Projects", "~/Developer", "~/src"],
    "workspace_containers": [],       # ["~/Code/MCPs"]
    # Домены работы для фильтров и классификатора. Пусто — домены не ставятся.
    "domains": [
        {"id": "work", "description": "work for an employer or clients"},
        {"id": "projects", "description": "own products, tools and experiments"},
        {"id": "personal", "description": "personal life: health, family, money, documents"},
    ],
    "vault_domain_rules": [],         # [["Work", "work"], …]: область vault → домен
    "project_domains": {},            # {"claude-config": "tools"}: проект → домен
    "sensitive": {"vault_areas": [], "projects": []},   # никогда не уходят в модель
    "ticket_prefixes": [],            # ["ABC", "OPS"] → тикеты ABC-123; пусто — не ищем
    "llm_enabled": False,             # ИИ-функции тратят подписку — только по явному согласию
    "models": {
        "classification": ["sonnet", "low"],
        "catalog_summary": ["sonnet", "low"],
        "handoff": ["sonnet", "medium"],
    },
    "force_1m": False,                # суффикс [1m] моделям без родного окна 1M (не на всех тарифах)
    "claude_bin": None,               # путь к claude; плагин находит его через оболочку входа
    "service_label": "io.github.session-atlas",
}

_lock = threading.Lock()
_cache = {"path": None, "mtime": None, "data": None, "checked": 0.0}
RECHECK_SECONDS = 1.0                 # разбор путей зовёт настройки тысячи раз за проход


def path() -> str:
    from .db import atlas_home                      # db не зависит от config: без цикла
    return os.path.join(atlas_home(), "config.json")


def _merge(base: dict, extra: dict) -> dict:
    """Неизвестные ключи верхнего уровня отбрасываются; вложенный словарь дополняется целиком —
    в нём бывают свои ключи (project_domains: {"claude-config": …})."""
    out = dict(base)
    for key, value in (extra or {}).items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            out[key] = dict(base[key], **value)
        elif key in base:
            out[key] = value
    return out


def load() -> dict:
    p = path()
    now = time.monotonic()
    data = _cache["data"]
    if data is not None and _cache["path"] == p and now - _cache["checked"] < RECHECK_SECONDS:
        return data
    try:
        mtime = os.stat(p).st_mtime
    except OSError:
        mtime = None
    with _lock:
        if _cache["path"] == p and _cache["mtime"] == mtime and _cache["data"] is not None:
            _cache["checked"] = now
            return _cache["data"]
        data = dict(DEFAULTS)
        if mtime is not None:
            try:
                with open(p, encoding="utf-8") as fh:
                    user = json.load(fh)
                if isinstance(user, dict):
                    data = _merge(DEFAULTS, user)
            except (OSError, ValueError):
                pass                                # битый файл — значения по умолчанию
        _cache.update(path=p, mtime=mtime, data=data, checked=now)
        return data


def reset() -> None:
    """Для тестов: следующий load() перечитает файл сразу."""
    with _lock:
        _cache.update(path=None, mtime=None, data=None, checked=0.0)


def get(key: str):
    return load()[key]


def expand(p: str) -> str:
    return os.path.normpath(os.path.expanduser(p)) if p else ""


def vaults() -> list[tuple[str, str]]:
    """[(путь, id проекта)]."""
    out = []
    for v in get("vaults") or []:
        if isinstance(v, str):
            v = {"path": v}
        if isinstance(v, dict) and v.get("path"):
            full = expand(v["path"])
            out.append((full, v.get("id") or os.path.basename(full)))
    return out


def workspace_roots() -> tuple[str, ...]:
    return tuple(expand(p) for p in (get("workspace_roots") or []) + (get("workspace_containers") or []))


def workspace_containers() -> tuple[str, ...]:
    return tuple(expand(p) for p in get("workspace_containers") or [])


def domain_ids() -> tuple[str, ...]:
    return tuple(d["id"] for d in get("domains") or [] if isinstance(d, dict) and d.get("id"))


def ticket_re():
    """Регулярка тикетов по префиксам. None — тикеты не ищем."""
    return _ticket_re(tuple(get("ticket_prefixes") or ()))


@functools.lru_cache(maxsize=8)
def _ticket_re(prefixes: tuple):
    valid = [re.escape(p) for p in prefixes if isinstance(p, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", p)]
    if not valid:
        return None
    # Альтернатива, а не литеральные вертикальные черты. Минимум две цифры: «ABC-1» в тексте
    # про префиксы — не тикет, а обрывок.
    return re.compile(r"\b(?:" + "|".join(valid) + r")-\d{2,}\b")


def index_fingerprint() -> str:
    """То, от чего зависит производный индекс: поменялось — индекс пересобирается."""
    keys = ("vaults", "workspace_roots", "workspace_containers", "vault_domain_rules",
            "project_domains", "sensitive", "ticket_prefixes")
    blob = json.dumps({k: get(k) for k in keys}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]
