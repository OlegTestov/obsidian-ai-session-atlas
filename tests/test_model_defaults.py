"""AI models by default: the cheap alias and a low effort, the same in the server and the plugin."""
from __future__ import annotations

import json
import os
import re

from atlas import config

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _plugin_defaults() -> dict:
    with open(os.path.join(HERE, "obsidian-plugin", "src", "settings-server.js"), encoding="utf-8") as fh:
        body = re.search(r"const DEFAULT_MODELS = (\{.*?\});", fh.read(), re.S).group(1)
    return json.loads(re.sub(r"(\w+):", r'"\1":', body))


def test_server_defaults_spend_little():
    assert config.DEFAULTS["models"] == {
        "classification": ["sonnet", "low"],
        "catalog_summary": ["sonnet", "low"],
        "handoff": ["sonnet", "medium"],
    }


def test_plugin_settings_show_the_server_defaults():
    assert _plugin_defaults() == config.DEFAULTS["models"]
