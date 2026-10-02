"""Установщик плагина: сборка и скрипты вкладок агентов — в vault, на прежние места."""
from __future__ import annotations

import os

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
    assert names == ["agent-registry-lib.zsh", "agent-resume-terminal.zsh", "agent-session-hook.zsh"]
    for name in names:
        dest = tmp_path / ".obsidian" / "scripts" / name
        assert dest.read_bytes() == open(os.path.join(src, name), "rb").read()
        assert os.access(dest, os.X_OK)
    assert (tmp_path / ".obsidian" / "plugins" / "session-atlas" / "main.js").exists()
