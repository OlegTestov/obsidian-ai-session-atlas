"""Slash commands for reply-box suggestions: Claude Code built-ins plus your skills and commands."""
from __future__ import annotations

import glob
import json
import os
import re

from . import messages, paths

# Built-ins with a description; order = frequency of use. English texts are in BUILTIN_EN.
BUILTIN = (
    ("goal", "поставить цель: сессия работает, пока условие не выполнено"),
    ("effort", "усилие модели: low … max, ultracode"),
    ("model", "сменить модель"),
    ("compact", "сжать контекст сейчас, с необязательной инструкцией"),
    ("clear", "начать разговор заново в той же сессии"),
    ("context", "сколько занято в окне контекста"),
    ("loop", "повторять запрос или команду по интервалу"),
    ("rewind", "откатить разговор или код к прошлой точке"),
    ("rename", "переименовать сессию"),
    ("fork", "ответвить сессию"),
    ("resume", "открыть прошлую сессию"),
    ("btw", "вопрос сбоку, не сбивая текущую работу"),
    ("plan", "режим плана"),
    ("fast", "быстрый режим"),
    ("usage", "расход лимитов подписки"),
    ("cost", "сколько стоила сессия"),
    ("stats", "статистика использования"),
    ("status", "версия, модель, аккаунт"),
    ("mcp", "MCP-серверы: статус, переподключение"),
    ("skills", "скиллы"),
    ("plugin", "плагины"),
    ("reload-plugins", "перечитать плагины без перезапуска"),
    ("reload-skills", "перечитать скиллы без перезапуска"),
    ("memory", "открыть файлы памяти"),
    ("permissions", "разрешения инструментов"),
    ("hooks", "хуки"),
    ("agents", "субагенты"),
    ("tasks", "фоновые задачи"),
    ("bg", "увести текущую работу в фон"),
    ("workflows", "многоагентные процессы"),
    ("schedule", "задачи по расписанию"),
    ("review", "ревью изменений"),
    ("code-review", "ревью кода"),
    ("ultrareview", "глубокое ревью"),
    ("security-review", "ревью безопасности"),
    ("simplify", "упростить изменённый код"),
    ("diff", "показать изменения"),
    ("copy", "скопировать последний ответ"),
    ("export", "выгрузить разговор"),
    ("recap", "краткий итог сессии"),
    ("add-dir", "добавить рабочую папку"),
    ("config", "настройки"),
    ("doctor", "проверить установку"),
    ("feedback", "отзыв о Claude Code"),
    ("remote-control", "управление с другого устройства"),
    ("artifacts", "артефакты"),
    ("theme", "тема оформления"),
    ("terminal-setup", "настроить терминал"),
    ("keybindings", "клавиши"),
    ("output-style", "стиль ответов"),
    ("sandbox", "песочница"),
    ("ide", "подключить IDE"),
    ("login", "войти"),
    ("logout", "выйти из аккаунта"),
    ("usage-credits", "запросить больше лимита"),
    ("release-notes", "что нового"),
    ("init", "создать CLAUDE.md для проекта"),
    ("help", "справка"),
    ("exit", "завершить сессию"),
)
_FRONT = re.compile(r"^---\s*\n(.*?)\n---", re.S)
_FIELD = re.compile(r"^(name|description):\s*(.+)$", re.M)
DESC_CHARS = 140


# The same descriptions in English, keyed by command name; the language follows the page (messages).
BUILTIN_EN = {
    "goal": "set a goal: the session keeps working until the condition holds",
    "effort": "model effort: low … max, ultracode", "model": "switch the model",
    "compact": "compact the context now, with optional instructions",
    "clear": "start the conversation over in the same session",
    "context": "how much of the context window is used", "loop": "repeat a prompt or command on an interval",
    "rewind": "roll the conversation or code back to an earlier point", "rename": "rename the session",
    "fork": "fork the session", "resume": "open a past session", "btw": "a side question without derailing the work",
    "plan": "plan mode", "fast": "fast mode", "usage": "subscription usage", "cost": "what the session cost",
    "stats": "usage statistics", "status": "version, model, account", "mcp": "MCP servers: status, reconnect",
    "skills": "skills", "plugin": "plugins", "reload-plugins": "reload plugins without restarting",
    "reload-skills": "reload skills without restarting", "memory": "open memory files",
    "permissions": "tool permissions", "hooks": "hooks", "agents": "subagents", "tasks": "background tasks",
    "bg": "send the current work to the background", "workflows": "multi-agent workflows",
    "schedule": "scheduled tasks", "review": "review changes", "code-review": "code review",
    "ultrareview": "deep review", "security-review": "security review",
    "simplify": "simplify the changed code", "diff": "show changes", "copy": "copy the last reply",
    "export": "export the conversation", "recap": "a short recap of the session", "add-dir": "add a working folder",
    "config": "settings", "doctor": "check the installation", "feedback": "feedback about Claude Code",
    "remote-control": "control from another device", "artifacts": "artifacts", "theme": "color theme",
    "terminal-setup": "set up the terminal", "keybindings": "key bindings", "output-style": "reply style",
    "sandbox": "sandbox", "ide": "connect an IDE", "login": "log in", "logout": "log out",
    "usage-credits": "request more usage", "release-notes": "what's new",
    "init": "create CLAUDE.md for the project", "help": "help", "exit": "end the session",
}

def _frontmatter(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            head = fh.read(4000)
    except OSError:
        return {}
    m = _FRONT.match(head)
    fields = dict(_FIELD.findall(m.group(1))) if m else {}
    if "description" not in fields:
        body = head[m.end():] if m else head
        first = next((line.strip("# ").strip() for line in body.splitlines() if line.strip()), "")
        if first:
            fields["description"] = first
    return {k: v.strip().strip("'\"") for k, v in fields.items()}


def _short(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= DESC_CHARS else text[:DESC_CHARS - 1] + "…"


def _folder_commands(root: str, prefix: str, kind: str, command_kind: str | None = None) -> list[dict]:
    """A folder's skills/<name>/SKILL.md and commands/<name>.md; names come from folder and file."""
    out = []
    skills = os.path.join(root, "skills")
    if os.path.isdir(skills):
        for name in sorted(os.listdir(skills)):
            md = os.path.join(skills, name, "SKILL.md")
            if name.startswith(("_", ".")) or not os.path.isfile(md):
                continue
            # Invoked by folder name: some skills have a different name field (connect-chrome).
            out.append({"name": prefix + name, "kind": kind,
                        "description": _short(_frontmatter(md).get("description", ""))})
    commands = os.path.join(root, "commands")
    if os.path.isdir(commands):
        for fname in sorted(os.listdir(commands)):
            if fname.endswith(".md") and not fname.startswith("."):
                out.append({"name": prefix + fname[:-3], "kind": command_kind or kind, "description": _short(
                    _frontmatter(os.path.join(commands, fname)).get("description", ""))})
    return out


def user_commands(home: str | None = None) -> list[dict]:
    claude = os.path.join(home, ".claude") if home else paths.claude_dir()
    return _folder_commands(claude, "", "skill", "command")


def _json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def plugin_commands(home: str | None = None) -> list[dict]:
    """Plugin skills and commands as `/plugin:name`: enabled by you, project and organization ones."""
    claude = os.path.join(home, ".claude") if home else paths.claude_dir()
    plugins = os.path.join(claude, "plugins")
    enabled = _json(os.path.join(claude, "settings.json")).get("enabledPlugins") or {}
    roots: dict[str, str] = {}
    installed = _json(os.path.join(plugins, "installed_plugins.json")).get("plugins") or {}
    for full, entries in installed.items():
        for entry in entries if isinstance(entries, list) else []:
            path = entry.get("installPath") if isinstance(entry, dict) else None
            # A user-scope plugin counts if enabled; a project-scope one is enabled in its project.
            if path and os.path.isdir(path) and (entry.get("scope") != "user" or enabled.get(full)):
                roots.setdefault(full.split("@")[0], path)
    for manifest in glob.glob(os.path.join(glob.escape(plugins), "synced", "*", "*",
                                           ".claude-plugin", "plugin.json")):
        root = os.path.dirname(os.path.dirname(manifest))
        name = _json(manifest).get("name") or os.path.basename(root)
        roots.setdefault(name, root)
    out = []
    for name, root in sorted(roots.items()):
        out.extend(_folder_commands(root, name + ":", "plugin"))
    return out


# Frequent ones first, the rest alphabetically, so you do not hunt for them in a long list.
FREQUENT = ("goal", "effort", "model", "compact", "context", "loop", "rewind", "usage")


def all_commands(home: str | None = None) -> list[dict]:
    english = messages.request_lang() != "ru"
    builtin = [{"name": n, "description": BUILTIN_EN.get(n, d) if english else d, "kind": "builtin"}
               for n, d in BUILTIN]
    seen, pool = set(), []
    for c in builtin + user_commands(home) + plugin_commands(home):
        if c["name"] not in seen:
            seen.add(c["name"])
            pool.append(c)
    first = [c for name in FREQUENT for c in pool if c["name"] == name]
    rest = sorted((c for c in pool if c["name"] not in FREQUENT), key=lambda c: c["name"].lower())
    return first + rest
