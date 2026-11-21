"""The checked-in zsh registry must match atlas/agents.json: repo-source runs use it as is."""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_checked_in_zsh_registry_is_current():
    generated = subprocess.check_output(["node", str(ROOT / "tools" / "agent_registry.mjs")], text=True)
    assert (ROOT / "obsidian-plugin" / "scripts" / "agent-kinds.zsh").read_text() == generated
