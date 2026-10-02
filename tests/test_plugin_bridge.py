"""Мост плагина Obsidian проверяется своим тестом на node — здесь только запуск."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.mark.skipif(shutil.which("node") is None, reason="node не установлен")
def test_plugin_bridge_rejects_foreign_origins():
    proc = subprocess.run(["node", os.path.join(HERE, "tools", "test_plugin.js")],
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "все проверки моста прошли" in proc.stdout


@pytest.mark.skipif(shutil.which("node") is None, reason="node не установлен")
def test_bundled_plugin_behaves_like_the_sources(tmp_path):
    """В vault уходит склейка src/*.js: те же проверки моста гоняются и на ней."""
    bundle = tmp_path / "main.js"
    subprocess.run([sys.executable, os.path.join(HERE, "tools", "install_plugin.py"),
                    "--bundle-to", str(bundle)], check=True, timeout=60)
    proc = subprocess.run(["node", os.path.join(HERE, "tools", "test_plugin.js"), str(bundle)],
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "все проверки моста прошли" in proc.stdout


@pytest.mark.skipif(shutil.which("node") is None, reason="node не установлен")
def test_page_logic_in_node():
    """Разбор Markdown, фильтры, сетка, навигация, стоимость, связь с терминалом."""
    proc = subprocess.run(["node", os.path.join(HERE, "tools", "test_page.js")],
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "все проверки страницы прошли" in proc.stdout


def test_plugin_source_lives_in_the_repo_not_only_in_the_vault():
    """Код в vault не хранится: там копия, исходник здесь."""
    for name in ("src/main.js", "manifest.json"):
        assert os.path.exists(os.path.join(HERE, "obsidian-plugin", name))

