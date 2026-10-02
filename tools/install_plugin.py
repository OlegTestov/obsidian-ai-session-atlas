"""Установка плагина Obsidian из репозитория в vault.

Исходник живёт здесь, в vault попадает копия: код в vault не хранится.
Obsidian грузит плагин одним файлом `main.js` и относительные `require` не разрешает, поэтому
модули из `obsidian-plugin/src/` склеиваются в один файл с маленьким загрузчиком.

    python3.11 tools/install_plugin.py [--vault PATH] [--no-enable]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from datetime import datetime

# Для разработки: vault, куда ставить сборку, — аргументом или переменной ATLAS_DEV_VAULT.
DEFAULT_VAULT = os.environ.get("ATLAS_DEV_VAULT", "")
PLUGIN_ID = "session-atlas"
FILES = ("main.js", "manifest.json", "styles.css")
PLUGIN_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "obsidian-plugin")
ENTRY = "main"
LOCAL_REQUIRE = re.compile(r'require\("\./([a-z][a-z-]*)"\)')


def build_bundle(src_dir: str | None = None) -> str:
    """Модули src/*.js → один CommonJS-файл. Чужие require уходят в require самого Obsidian."""
    src_dir = src_dir or os.path.join(PLUGIN_DIR, "src")
    names = sorted(f[:-3] for f in os.listdir(src_dir) if f.endswith(".js"))
    vendor_dir = os.path.join(PLUGIN_DIR, "vendor")
    vendor = sorted(f[:-3] for f in os.listdir(vendor_dir) if f.endswith(".js"))
    if ENTRY not in names:
        raise SystemExit(f"нет {ENTRY}.js в {src_dir}")
    parts = ["// Собрано tools/install_plugin.py из obsidian-plugin/src/ — правь исходники там.",
             "const __modules = {};", "const __cache = {};",
             "function __require(name) {",
             "  const local = name.startsWith(\"./\") ? name.slice(2) : null;",
             "  if (local === null || !(local in __modules)) return require(name);",
             "  if (!(local in __cache)) {",
             "    const module = { exports: {} };",
             "    __cache[local] = module;",
             "    __modules[local](module, module.exports, __require);",
             "  }",
             "  return __cache[local].exports;",
             "}"]
    for name in names:
        body = open(os.path.join(src_dir, name + ".js"), encoding="utf-8").read()
        for dep in LOCAL_REQUIRE.findall(body):
            if dep not in names and dep not in vendor and dep != "payload":   # payload — здесь же
                raise SystemExit(f"{name}.js: нет модуля ./{dep}")
        parts.append(f"__modules[{json.dumps(name)}] = function (module, exports, require) {{\n"
                     f"{body.rstrip()}\n}};")
    for name in vendor:                      # xterm.js и дополнения — как есть, со своей лицензией
        body = open(os.path.join(vendor_dir, name + ".js"), encoding="utf-8").read()
        parts.append(f"__modules[{json.dumps(name)}] = function (module, exports, require) {{\n"
                     f"{body.rstrip()}\n}};")
    parts.append(f"__modules[\"payload\"] = function (module) {{ module.exports = {json.dumps(payload(), ensure_ascii=False)}; }};")
    parts.append(f"module.exports = __require(\"./{ENTRY}\");")
    return "\n".join(parts) + "\n"


def build_styles() -> str:
    """styles.css плагина: стили xterm, затем свои."""
    xterm = open(os.path.join(PLUGIN_DIR, "vendor", "xterm.css"), encoding="utf-8").read()
    own = open(os.path.join(PLUGIN_DIR, "styles.css"), encoding="utf-8").read()
    return xterm.rstrip() + "\n\n" + own


# Что плагин распаковывает при запуске: сервер, страница, скрипты вкладок. Только текст.
PAYLOAD_GLOBS = (("atlas", ("*.py", "*.md")), ("web", ("index.html",)), ("web/js", ("*.js", "*.css")),
                 ("obsidian-plugin/scripts", ("*.zsh",)))


def payload() -> dict:
    import glob
    import hashlib
    root = os.path.dirname(PLUGIN_DIR)
    files = {}
    for folder, patterns in PAYLOAD_GLOBS:
        for pattern in patterns:
            for full in sorted(glob.glob(os.path.join(root, folder, pattern))):
                rel = os.path.relpath(full, root)
                # Скрипты вкладок ложатся в runtime/scripts, а не в runtime/obsidian-plugin/scripts.
                rel = rel.replace("obsidian-plugin/scripts/", "scripts/")
                files[rel] = open(full, encoding="utf-8").read()
    digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:16]
    return {"version": digest, "files": files}


def install(vault: str, enable: bool = True) -> dict:
    target = os.path.join(vault, ".obsidian", "plugins", PLUGIN_ID)
    os.makedirs(target, exist_ok=True)
    with open(os.path.join(target, "main.js"), "w", encoding="utf-8") as fh:
        fh.write(build_bundle())
    shutil.copy(os.path.join(PLUGIN_DIR, "manifest.json"), os.path.join(target, "manifest.json"))
    with open(os.path.join(target, "styles.css"), "w", encoding="utf-8") as fh:
        fh.write(build_styles())
    # Скрипты вкладок агентов — туда же, где их ждут сохранённые вкладки и хук Claude Code.
    scripts = os.path.join(vault, ".obsidian", "scripts")
    os.makedirs(scripts, exist_ok=True)
    for name in sorted(os.listdir(os.path.join(PLUGIN_DIR, "scripts"))):
        dest = os.path.join(scripts, name)
        shutil.copy(os.path.join(PLUGIN_DIR, "scripts", name), dest)
        os.chmod(dest, 0o755)

    enabled = None
    if enable:
        listing = os.path.join(vault, ".obsidian", "community-plugins.json")
        data = json.load(open(listing, encoding="utf-8")) if os.path.exists(listing) else []
        if PLUGIN_ID not in data:
            # Конфиг Obsidian чужой — перед правкой кладём копию рядом.
            if os.path.exists(listing):
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                shutil.copy(listing, f"{listing}.bak-{stamp}")
            data.append(PLUGIN_ID)
            with open(listing, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(data, indent=2) + "\n")
        enabled = PLUGIN_ID in data
    return {"target": target, "files": list(FILES), "enabled": enabled}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Поставить плагин Session Atlas в Obsidian")
    parser.add_argument("--vault", default=DEFAULT_VAULT)
    parser.add_argument("--no-enable", action="store_true")
    parser.add_argument("--bundle-to", help="только собрать main.js в этот файл (для тестов)")
    args = parser.parse_args(argv)
    if args.bundle_to:
        with open(args.bundle_to, "w", encoding="utf-8") as fh:
            fh.write(build_bundle())
        return 0
    if not args.vault or not os.path.isdir(os.path.join(args.vault, ".obsidian")):
        parser.error("укажи vault: --vault PATH или переменная ATLAS_DEV_VAULT (папка с .obsidian)")
    result = install(args.vault, enable=not args.no_enable)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    # Плагин сам замечает новый main.js и перезагружается, не закрывая вкладок. Тумблер в
    # настройках закрыл бы вкладки, ⌘R — убил бы процессы в терминалах.
    print("\nОткрытый Obsidian подхватит сборку сам за пару секунд; вкладки и сессии остаются. "
          "Иначе — команда «Session Atlas: Перезагрузить плагин».", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
