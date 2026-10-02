"""Собранный плагин сам поднимает встроенный сервер: node + настоящий python3, без Obsidian."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.mark.skipif(not shutil.which("node"), reason="нужен node")
def test_bundle_extracts_and_runs_the_server(tmp_path):
    bundle = tmp_path / "main.js"
    subprocess.run([sys.executable, os.path.join(HERE, "tools", "install_plugin.py"), "--bundle-to", str(bundle)],
                   check=True, capture_output=True)
    r = subprocess.run(["node", os.path.join(HERE, "tools", "test_runtime.js"), str(bundle)],
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr


@pytest.mark.skipif(not shutil.which("node") or not os.path.exists("/usr/bin/python3")
                    or subprocess.run(["/usr/bin/xcode-select", "-p"], capture_output=True).returncode,
                    reason="нужны node и Command Line Tools")
def test_bundle_on_a_clean_account(tmp_path):
    """Как у коллеги: пустой домашний каталог без профиля, системный PATH, ни Homebrew, ни настроек."""
    bundle = tmp_path / "main.js"
    subprocess.run([sys.executable, os.path.join(HERE, "tools", "install_plugin.py"), "--bundle-to", str(bundle)],
                   check=True, capture_output=True)
    home = tmp_path / "home"
    home.mkdir()
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "SHELL": "/bin/zsh",
           "USER": os.environ.get("USER", "user"), "LANG": "en_US.UTF-8", "TMPDIR": str(tmp_path),
           "ATLAS_EXPECT_PYTHON": "/usr/bin/python3"}
    r = subprocess.run([shutil.which("node"), os.path.join(HERE, "tools", "test_runtime.js"), str(bundle)],
                       capture_output=True, text=True, timeout=120, env=env)
    assert r.returncode == 0, r.stdout + r.stderr


@pytest.mark.skipif(not shutil.which("node"), reason="нужен node")
def test_pty_on_system_tools():
    r = subprocess.run(["node", os.path.join(HERE, "tools", "test_pty.js")], capture_output=True, text=True,
                       timeout=120)
    assert r.returncode == 0, r.stdout + r.stderr


@pytest.mark.skipif(not shutil.which("node"), reason="нужен node")
def test_settings_fields_round_trip():
    r = subprocess.run(["node", os.path.join(HERE, "tools", "test_config_form.js")], capture_output=True,
                       text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr


@pytest.mark.skipif(not shutil.which("node"), reason="нужен node")
def test_status_line_install_is_careful():
    r = subprocess.run(["node", os.path.join(HERE, "tools", "test_statusline.js")], capture_output=True,
                       text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
