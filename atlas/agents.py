"""Agent metadata and validation shared by catalog and launcher entry points."""
from __future__ import annotations

import builtins
import json
import re
from pathlib import Path
from types import MappingProxyType
from typing import TYPE_CHECKING, Iterable, List, Literal, NamedTuple, Tuple

if TYPE_CHECKING:
    import sqlite3

    from .parse import SessionFacts

# Use ASCII ranges so this expression has the same meaning in JS and zsh.
UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
_FIELDS = {"id", "label", "short", "mailPrefix", "idPattern"}


class UnknownAgent(ValueError):
    """Unknown identity or missing native implementation for a registered agent."""


def _load(path: Path):
    rows = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(rows, list) or not rows:
        raise ValueError("Agent registry must be a nonempty array")
    registry, patterns = {}, {}
    for row in rows:
        if (not isinstance(row, dict) or row.keys() != _FIELDS
                or not builtins.all(isinstance(v, str) and v.strip() for v in row.values())
                or not re.fullmatch(r"[a-z][a-z0-9-]*", row["id"])
                or not re.fullmatch(r"[a-z]", row["mailPrefix"])):
            raise ValueError(f"Malformed agent registry entry: {row!r}")
        kind = row["id"]
        if kind in registry:
            raise ValueError(f"Duplicate agent id: {kind!r}")
        pattern = UUID_PATTERN if row["idPattern"] == "uuid" else row["idPattern"]
        if not pattern.startswith("^") or not pattern.endswith("$"):
            raise ValueError(f"Unanchored session id pattern for agent {kind!r}")
        try:
            patterns[kind] = re.compile(pattern, re.ASCII)
        except re.error as exc:
            raise ValueError(f"Invalid session id pattern for agent {kind!r}: {exc}") from exc
        registry[kind] = MappingProxyType(row)
    return registry, patterns


_REGISTRY, _PATTERNS = _load(Path(__file__).with_name("agents.json"))


def all() -> tuple[str, ...]:
    return tuple(_REGISTRY)


def get(kind: str):
    if not isinstance(kind, str) or kind not in _REGISTRY:
        raise UnknownAgent(f"Unknown agent: {kind!r}")
    return _REGISTRY[kind]


CLAUDE, CODEX, OPENCODE = (get(kind)["id"] for kind in ("claude", "codex", "opencode"))
ALL = all()

_ADAPTERS = {}
# The Codex hook loads only metadata via a direct import. Catalog startup validates its adapters.
if __package__:
    from . import agent_claude, agent_codex, agent_opencode

    _ADAPTERS = {CLAUDE: agent_claude, CODEX: agent_codex, OPENCODE: agent_opencode}


class SourceRef(NamedTuple):
    agent: str
    locator: str


Discovery = Tuple[Literal["complete", "partial", "unavailable"], List[SourceRef]]


class SourceFacts(NamedTuple):
    facts: SessionFacts
    subagents: Iterable[SessionFacts] = ()


def _check_adapters() -> None:
    for kind in all():
        adapter(kind)


def adapter(kind: str, operation: str = "catalog discovery and reads"):
    return _ADAPTERS[require(kind, _ADAPTERS, operation)]


def require(kind: str, supported, operation: str) -> str:
    get(kind)
    if kind not in supported:
        raise UnknownAgent(f"Agent {kind!r} does not support {operation}")
    return kind


def id_pattern(kind: str) -> str:
    get(kind)
    return _PATTERNS[kind].pattern


def valid_id(kind: str, sid) -> bool:
    get(kind)
    return isinstance(sid, str) and _PATTERNS[kind].fullmatch(sid) is not None


def mail_prefix(kind: str) -> str:
    return get(kind)["mailPrefix"]


def label(kind: str) -> str:
    return get(kind)["label"]


def parse_filter(values) -> list[str] | None:
    """Known values in request order. A filter with only unknown values is an error."""
    picked: list[str] = []
    unknown: list[str] = []
    for value in values or []:
        for part in str(value).split(","):
            part = part.strip().lower()
            if part in _REGISTRY:
                if part not in picked:
                    picked.append(part)
            elif part:
                unknown.append(part)
    if unknown and not picked:
        get(unknown[0])
    return None if not unknown and (not picked or len(picked) == len(_REGISTRY)) else picked


def session_agent(conn: sqlite3.Connection, session_id: str) -> str | None:
    row = conn.execute("SELECT agent FROM sessions WHERE session_id=?", (session_id,)).fetchone()
    return get(row["agent"])["id"] if row else None


def transcript_agent(path: str | None) -> str:
    """Infer a native format only for path-only readers and unindexed transcripts."""
    from . import codex_parse

    return CODEX if path and codex_parse.session_id_of(path) else CLAUDE


def parse_session(path: str, session_id: str, agent: str) -> SessionFacts:
    from . import codex_parse, parse

    readers = {CLAUDE: parse.parse_file, CODEX: codex_parse.parse_lineage}
    return readers[require(agent, readers, "transcript parsing")](path, session_id)


if __package__:
    _check_adapters()
