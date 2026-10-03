"""Claude Code's data folder: ~/.claude by default, CLAUDE_CONFIG_DIR when the user moved it."""
from __future__ import annotations

import os

from atlas import commands, paths


def test_default_is_home_dot_claude(monkeypatch):
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    assert paths.claude_dir() == os.path.expanduser("~/.claude")


def test_claude_config_dir_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
    assert paths.claude_dir() == str(tmp_path / "cc")


def test_user_commands_come_from_the_moved_folder(monkeypatch, tmp_path):
    moved = tmp_path / "cc"
    (moved / "commands").mkdir(parents=True)
    (moved / "commands" / "ship.md").write_text("---\ndescription: Ship it\n---\nbody\n")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(moved))
    assert [c["name"] for c in commands.user_commands()] == ["ship"]
