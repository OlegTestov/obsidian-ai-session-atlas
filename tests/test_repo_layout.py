"""Repository layout Obsidian's review expects; Node tests live in tests/js (npm test)."""
from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _json(name: str) -> dict:
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        return json.load(fh)


def test_plugin_source_lives_in_the_repo_not_only_in_the_vault():
    """Code is not stored in the vault: it holds a copy, the source is here."""
    for name in ("obsidian-plugin/src/main.js", "manifest.json", "versions.json", "esbuild.config.mjs"):
        assert os.path.exists(os.path.join(HERE, name))


def test_versions_match_the_manifest_and_package():
    manifest, package, versions = _json("manifest.json"), _json("package.json"), _json("versions.json")
    assert manifest["version"] == package["version"]
    assert versions[manifest["version"]] == manifest["minAppVersion"]


def test_manifest_description_follows_the_directory_rules():
    description = _json("manifest.json")["description"]
    assert len(description) <= 250 and description.endswith(".")
    assert "obsidian" not in description.lower()
