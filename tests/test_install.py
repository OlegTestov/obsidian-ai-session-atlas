"""Plugin installer: the build and agent tab scripts go into the vault, at their usual places."""
from __future__ import annotations

import os
from pathlib import Path

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_install_puts_agent_scripts_where_saved_tabs_expect_them(tmp_path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("install_plugin", os.path.join(HERE, "tools", "install_plugin.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    (tmp_path / ".obsidian").mkdir()
    mod.install(str(tmp_path), enable=False)
    src = os.path.join(HERE, "obsidian-plugin", "scripts")
    names = sorted(os.listdir(src))
    assert names == ["agent-registry-lib.zsh", "agent-resume-terminal.zsh", "agent-session-hook.zsh",
                     "agent-sessions-lib.zsh"]
    for name in names:
        dest = tmp_path / ".obsidian" / "scripts" / name
        assert dest.read_bytes() == Path(src, name).read_bytes()
        assert os.access(dest, os.X_OK)
    assert (tmp_path / ".obsidian" / "plugins" / "session-atlas" / "main.js").exists()


def test_dev_install_marks_itself_and_a_staged_install_clears_the_marks(tmp_path):
    """A test vault reloads itself and runs apart; the working vault never reloads on its own."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("install_plugin", os.path.join(HERE, "tools", "install_plugin.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    (tmp_path / ".obsidian").mkdir()
    target = tmp_path / ".obsidian" / "plugins" / "session-atlas"
    mod.install(str(tmp_path), enable=False, dev=True)
    assert (target / ".hotreload").exists() and (target / ".dev").exists()
    mod.install(str(tmp_path), enable=False)
    assert not (target / ".hotreload").exists() and not (target / ".dev").exists()
