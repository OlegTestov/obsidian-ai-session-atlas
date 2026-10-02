"""Сборка релиза для Obsidian: dist/main.js, dist/manifest.json, dist/styles.css.

main.js несёт в себе всё: код плагина, xterm.js, сервер, страницу и скрипты вкладок — сообщество
Obsidian ставит плагину только эти три файла.

    python3 tools/build.py [--out dist]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import install_plugin  # noqa: E402  — сборка бандла живёт там, установщик для разработки зовёт её же


def build(out: str) -> dict:
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "main.js"), "w", encoding="utf-8") as fh:
        fh.write(install_plugin.build_bundle())
    with open(os.path.join(out, "styles.css"), "w", encoding="utf-8") as fh:
        fh.write(install_plugin.build_styles())
    shutil.copy(os.path.join(install_plugin.PLUGIN_DIR, "manifest.json"), os.path.join(out, "manifest.json"))
    manifest = json.load(open(os.path.join(out, "manifest.json"), encoding="utf-8"))
    return {"out": out, "version": manifest["version"],
            "sizes": {f: os.path.getsize(os.path.join(out, f)) for f in ("main.js", "manifest.json", "styles.css")}}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=os.path.join(os.path.dirname(HERE), "dist"))
    print(json.dumps(build(parser.parse_args().out), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
