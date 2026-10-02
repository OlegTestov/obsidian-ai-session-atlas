"""Правила: проект, вид сессии, домен, чувствительность. Без БД; что где лежит — из config."""
from __future__ import annotations

import os
import posixpath
import re
from dataclasses import dataclass

from . import config

HOME = os.path.expanduser("~")

# Подпапка конкретной сессии, а не проект: /private/tmp/claude-501/<slug>/<uuid>/scratchpad/...
SCRATCHPAD_RE = re.compile(r"^/private/tmp/claude-\d+/[^/]+/[0-9a-f-]{36}/scratchpad(/|$)")

UNCLASSIFIED = "unclassified"


@dataclass(frozen=True)
class Workspace:
    kind: str  # project | scratchpad | home | unknown
    project_id: str | None
    root: str | None
    area: str | None  # первый уровень под корнем; для vault — его папка верхнего уровня


def _under(path: str, root: str) -> bool:
    """Сравнение по компонентам пути, а не startswith: /Code-old не под /Code."""
    try:
        return os.path.commonpath([os.path.normpath(path), root]) == root
    except ValueError:
        return False


def normalize(path: str, cwd_at_record: str | None = None) -> str:
    """Абсолютный лексически нормализованный путь; относительный — от cwd на момент записи."""
    if not path:
        return ""
    if not os.path.isabs(path) and cwd_at_record:
        path = os.path.join(cwd_at_record, path)
    path = os.path.expanduser(path)
    # /tmp на macOS — симлинк на /private/tmp; приводим к одной форме, не трогая диск.
    if path.startswith("/tmp/"):
        path = "/private" + path
    return os.path.normpath(path)


def classify_path(path: str, cwd_at_record: str | None = None) -> Workspace:
    p = normalize(path, cwd_at_record)
    if not p:
        return Workspace("unknown", None, None, None)
    if SCRATCHPAD_RE.match(p):
        return Workspace("scratchpad", None, None, None)
    for vault, vault_id in config.vaults():
        if _under(p, vault):
            rel = posixpath.relpath(p, vault)
            area = None if rel == "." else rel.split("/")[0]
            return Workspace("project", vault_id, vault, area)
    roots = config.workspace_roots()
    containers = config.workspace_containers()
    for prefix in sorted(roots, key=len, reverse=True):
        if _under(p, prefix) and p != prefix:
            rel_to_prefix = posixpath.relpath(p, prefix)
            name = rel_to_prefix.split("/")[0]
            # Файл, лежащий прямо в корне проектов, проектом не является.
            if rel_to_prefix == name and (name.startswith(".") or os.path.splitext(name)[1]):
                return Workspace("unknown", None, None, None)
            root = os.path.join(prefix, name)
            if root in containers:
                continue  # это контейнер, проект уровнем глубже
            rel = posixpath.relpath(p, root)
            return Workspace("project", name, root, None if rel == "." else rel.split("/")[0])
    if _under(p, os.path.join(HOME, ".claude")):
        return Workspace("project", "claude-config", os.path.join(HOME, ".claude"), None)
    if p == HOME:
        return Workspace("home", None, None, None)
    return Workspace("unknown", None, None, None)


# Headless-поверхности. Всё остальное (cli, claude-desktop, ide) — человек за клавиатурой.
HEADLESS_ENTRYPOINTS = {"sdk-cli", "sdk", "sdk-ts", "sdk-py"}


def session_kind(entrypoint: str | None, human_turns: int) -> str:
    """Фоновые прогоны (хуки, ночной агент) идут через SDK или вовсе без промптов человека."""
    if entrypoint in HEADLESS_ENTRYPOINTS:
        return "automation"
    if human_turns == 0:
        return "automation"
    return "interactive"


def resolve_projects(cwds: list[str], file_paths: list[str]) -> tuple[list[tuple[str, str]], str]:
    """Возвращает [(project_id, role)] с ровно одним primary и workspace_kind сессии."""
    workspace_kind = "project"
    primary: str | None = None
    for cwd in cwds:
        ws = classify_path(cwd)
        if ws.kind == "scratchpad":
            workspace_kind = "scratchpad"
            continue
        if ws.project_id and primary is None:
            primary = ws.project_id
    touched: list[str] = []
    for path in file_paths:
        ws = classify_path(path)
        if ws.project_id and ws.project_id != primary and ws.project_id not in touched:
            touched.append(ws.project_id)
    if primary is None:
        # Скретчпад-сессия правила реальные файлы — берём их проект основным.
        if touched:
            primary, touched = touched[0], touched[1:]
        else:
            return [], workspace_kind
    return [(primary, "primary")] + [(p, "touched") for p in touched], workspace_kind


def resolve_domains(cwds: list[str], file_paths: list[str]) -> list[str]:
    """Домен по пути — только где его задал человек: область vault или проект целиком.
    Репозиторий сам по себе о домене не говорит — остальное решает классификатор."""
    domains: list[str] = []
    vault_ids = {vid for _, vid in config.vaults()}
    rules = [(r[0].split("/")[0], r[1]) for r in config.get("vault_domain_rules") or []
             if isinstance(r, (list, tuple)) and len(r) == 2]
    by_project = config.get("project_domains") or {}
    for path in list(cwds) + list(file_paths):
        ws = classify_path(path)
        domain = None
        if ws.project_id in vault_ids and ws.area:
            domain = next((d for area, d in rules if area == ws.area), None)
        elif ws.project_id in by_project:
            domain = by_project[ws.project_id]
        if domain and domain not in domains:
            domains.append(domain)
    return domains


def resolve_sensitivity(cwds: list[str], file_paths: list[str]) -> str:
    """По умолчанию unclassified, и это запрещает отправку наружу. Fail-closed."""
    rules = config.get("sensitive") or {}
    areas = set(rules.get("vault_areas") or [])
    projects = set(rules.get("projects") or [])
    vault_ids = {vid for _, vid in config.vaults()}
    for path in list(cwds) + list(file_paths):
        ws = classify_path(path)
        if ws.project_id in vault_ids and ws.area in areas:
            return "sensitive"
        if ws.project_id in projects:
            return "sensitive"
    return UNCLASSIFIED


# Claude Code иногда называет сессию первой строкой сводки компактации — это не заголовок.
COMPACT_TITLE_PREFIX = "This session is being continued"


def fallback_title(title: str | None, user_text: list[str], last_prompt: str | None,
                   assistant_text: list[str], session_id: str) -> tuple[str, str]:
    if title and title.strip() and not title.strip().startswith(COMPACT_TITLE_PREFIX):
        return title.strip(), "recorded"
    for source, label in ((user_text[0] if user_text else None, "first-prompt"),
                          (last_prompt, "last-prompt"),
                          (assistant_text[0] if assistant_text else None, "assistant")):
        if source and source.strip():
            flat = " ".join(source.strip().splitlines()[0].split())
            return (flat[:80] + "…") if len(flat) > 80 else flat, label
    return session_id[:8], "uuid"
