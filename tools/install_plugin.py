"""Installs the Obsidian plugin from the repository into a vault, for development.

The source lives here and the vault gets a copy: code is not stored in the vault. The release
files come from `npm run build` (esbuild); this script runs the same build into a temporary folder.

    python3.11 tools/install_plugin.py --vault PATH [--dev] [--no-enable]

Without --dev the build is only staged: a running Obsidian keeps the loaded code until you reload
the plugin yourself. --dev is for a separate test vault: the plugin there reloads itself on every
build and runs its own server (port 8788, data in session-atlas-dev), apart from the working one.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime

# For development: the target vault comes from an argument or the ATLAS_DEV_VAULT variable.
DEFAULT_VAULT = os.environ.get("ATLAS_DEV_VAULT", "")
PLUGIN_ID = "session-atlas"
FILES = ("main.js", "manifest.json", "styles.css")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN_DIR = os.path.join(ROOT, "obsidian-plugin")
# Development install markers: reload on every build; own port and data folder.
HOT_RELOAD_MARKER = ".hotreload"
DEV_MARKER = ".dev"


def build(out: str) -> None:
    """`node esbuild.config.mjs --outdir OUT`; needs `npm ci` once."""
    node = shutil.which("node")
    if not node:
        raise SystemExit("node is required to build the plugin (https://nodejs.org)")
    if not os.path.isdir(os.path.join(ROOT, "node_modules", "esbuild")):
        raise SystemExit("run `npm ci` in the repository first")
    subprocess.run([node, os.path.join(ROOT, "esbuild.config.mjs"), "--outdir", out], check=True,
                   cwd=ROOT, stdout=subprocess.DEVNULL)


def install(vault: str, enable: bool = True, dev: bool = False) -> dict:
    target = os.path.join(vault, ".obsidian", "plugins", PLUGIN_ID)
    os.makedirs(target, exist_ok=True)
    with tempfile.TemporaryDirectory() as out:
        build(out)
        # main.js last: the running plugin watches it and reloads once it changes.
        for name in ("manifest.json", "styles.css", "main.js"):
            shutil.copy(os.path.join(out, name), os.path.join(target, name))
    for marker in (HOT_RELOAD_MARKER, DEV_MARKER):
        path = os.path.join(target, marker)
        if dev:
            open(path, "w").close()
        elif os.path.exists(path):
            os.remove(path)
    # Agent tab scripts go where saved tabs and the Claude Code hook expect them.
    scripts = os.path.join(vault, ".obsidian", "scripts")
    os.makedirs(scripts, exist_ok=True)
    for name in sorted(os.listdir(os.path.join(PLUGIN_DIR, "scripts"))):
        dest = os.path.join(scripts, name)
        shutil.copy(os.path.join(PLUGIN_DIR, "scripts", name), dest)
        os.chmod(dest, 0o755)

    enabled = None
    if enable:
        listing = os.path.join(vault, ".obsidian", "community-plugins.json")
        data = []
        if os.path.exists(listing):
            with open(listing, encoding="utf-8") as fh:
                data = json.load(fh)
        if PLUGIN_ID not in data:
            # The Obsidian config is not ours, so a backup copy goes next to it before editing.
            if os.path.exists(listing):
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                shutil.copy(listing, f"{listing}.bak-{stamp}")
            data.append(PLUGIN_ID)
            with open(listing, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(data, indent=2) + "\n")
        enabled = PLUGIN_ID in data
    return {"target": target, "files": list(FILES), "enabled": enabled, "dev": dev}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Install the Session Atlas plugin into Obsidian")
    parser.add_argument("--vault", default=DEFAULT_VAULT)
    parser.add_argument("--no-enable", action="store_true")
    parser.add_argument("--dev", action="store_true",
                        help="test vault: reload on every build, own port 8788 and data folder")
    parser.add_argument("--bundle-to", help="only build main.js into this file (for tests)")
    args = parser.parse_args(argv)
    if args.bundle_to:
        with tempfile.TemporaryDirectory() as out:
            build(out)
            shutil.copy(os.path.join(out, "main.js"), args.bundle_to)
        return 0
    if not args.vault or not os.path.isdir(os.path.join(args.vault, ".obsidian")):
        parser.error("specify a vault: --vault PATH or the ATLAS_DEV_VAULT variable (a folder with .obsidian)")
    result = install(args.vault, enable=not args.no_enable, dev=args.dev)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.dev:
        print("\nThe test vault's plugin picks up the build by itself within a couple of seconds.", file=sys.stderr)
    else:
        print("\nStaged. A running Obsidian keeps the loaded version until you run "
              "«Session Atlas: Reload the plugin» or restart Obsidian.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
