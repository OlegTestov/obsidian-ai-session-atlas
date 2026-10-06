"""Rules: project, session kind, domain, sensitivity. No DB; locations come from config."""
from __future__ import annotations

import os
import posixpath
import re
from dataclasses import dataclass

from . import config, paths

HOME = os.path.expanduser("~")

# A single session's subfolder, not a project: /private/tmp/claude-501/<slug>/<uuid>/scratchpad/...
SCRATCHPAD_RE = re.compile(r"^/private/tmp/claude-\d+/[^/]+/[0-9a-f-]{36}/scratchpad(/|$)")

UNCLASSIFIED = "unclassified"


@dataclass(frozen=True)
class Workspace:
    kind: str  # project | scratchpad | home | unknown
    project_id: str | None
    root: str | None
    area: str | None  # first level under the root; for a vault, its top-level folder


def _under(path: str, root: str) -> bool:
    """Compares path components, not startswith: /Code-old is not under /Code."""
    try:
        return os.path.commonpath([os.path.normpath(path), root]) == root
    except ValueError:
        return False


def normalize(path: str, cwd_at_record: str | None = None) -> str:
    """Absolute, lexically normalized path; a relative one is resolved against the cwd at record time."""
    if not path:
        return ""
    if not os.path.isabs(path) and cwd_at_record:
        path = os.path.join(cwd_at_record, path)
    path = os.path.expanduser(path)
    # On macOS /tmp is a symlink to /private/tmp; normalize to one form without touching the disk.
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
            # A file directly in the projects root is not a project.
            if rel_to_prefix == name and (name.startswith(".") or os.path.splitext(name)[1]):
                return Workspace("unknown", None, None, None)
            root = os.path.join(prefix, name)
            if root in containers:
                continue  # a container; the project is one level deeper
            rel = posixpath.relpath(p, root)
            return Workspace("project", name, root, None if rel == "." else rel.split("/")[0])
    claude = paths.claude_dir()
    if _under(p, claude):
        return Workspace("project", "claude-config", claude, None)
    if p == HOME:
        return Workspace("home", None, None, None)
    return Workspace("unknown", None, None, None)


# Headless surfaces. Everything else (cli, claude-desktop, ide, codex-tui, Codex Desktop) is a
# human at the keyboard. `codex_exec` is Codex's originator for `codex exec` runs.
HEADLESS_ENTRYPOINTS = {"sdk-cli", "sdk", "sdk-ts", "sdk-py", "codex_exec"}


def session_kind(entrypoint: str | None, human_turns: int, spawned: bool = False,
                 continued: bool = False) -> str:
    """Background runs (hooks, nightly agent) go through the SDK or have no human prompts at all.
    A thread spawned by another agent (Codex subagent) gets its prompt from that agent.
    A parked conversation's job works on the prompt you gave its parent: still yours."""
    if entrypoint in HEADLESS_ENTRYPOINTS or spawned:
        return "automation"
    if human_turns == 0 and not continued:
        return "automation"
    return "interactive"


def resolve_projects(cwds: list[str], file_paths: list[str]) -> tuple[list[tuple[str, str]], str]:
    """Returns [(project_id, role)] with exactly one primary, plus the session workspace_kind."""
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
        # A scratchpad session edited real files: their project becomes the primary one.
        if touched:
            primary, touched = touched[0], touched[1:]
        else:
            return [], workspace_kind
    return [(primary, "primary")] + [(p, "touched") for p in touched], workspace_kind


def resolve_domains(cwds: list[str], file_paths: list[str]) -> list[str]:
    """Domain from the path only where a human set it: a vault area or a whole project.
    A repository alone says nothing about the domain; the classifier decides the rest."""
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
    """Defaults to unclassified, which blocks sending data out. Fail-closed."""
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


# Claude Code sometimes names a session after the first line of a compaction summary; that is not a title.
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
