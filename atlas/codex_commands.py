"""Codex reply-box suggestions: its slash commands, your skills (typed as `$name`) and its models.

The commands are the ones codex-cli 0.167 lists when you type "/" (checked on the live CLI; /usage
is in its command table but was not listed with an API-key login, it is about plan limits). Codex
uses a skill when you mention it with `$name`: the list is Codex's own (codex_skills.py).
`/model <slug> --reasoning=<level>` switches model and effort for the session.
"""
from __future__ import annotations

import json
import os

from . import messages

# (name, English, Russian). Order = how often they are needed; the rest follow alphabetically.
BUILTIN = (
    ("model", "pick the model and reasoning effort", "выбрать модель и глубину рассуждений"),
    ("goal", "set or show the goal of a long task", "поставить или показать цель долгой задачи"),
    ("compact", "compact the conversation to free context", "сжать разговор, чтобы освободить контекст"),
    ("plan", "switch to plan mode", "перейти в режим планирования"),
    ("status", "show the model, settings and tokens used", "показать модель, настройки и расход токенов"),
    ("usage", "show plan usage and limits", "показать расход и лимиты подписки"),
    ("review", "review the current changes", "проверить текущие изменения"),
    ("diff", "show git changes, new files too", "показать изменения в git, с новыми файлами"),
    ("new", "start a new chat in this tab", "начать новый разговор в этой вкладке"),
    ("resume", "resume a saved chat", "продолжить сохранённый разговор"),
    ("fork", "copy the current chat", "создать копию разговора"),
    ("rename", "rename the chat", "переименовать разговор"),
    ("side", "ask a side question in a throwaway copy", "спросить в стороне, во временной копии"),
    ("recap", "sum up the conversation now", "подвести итог разговора"),
    ("copy", "copy the last reply", "скопировать последний ответ"),
    ("export", "export the conversation as Markdown", "выгрузить разговор в Markdown"),
    ("init", "create AGENTS.md for the project", "создать AGENTS.md для проекта"),
    ("mcp", "list MCP tools", "показать инструменты MCP"),
    ("skills", "pick a skill", "выбрать скилл"),
    ("agents", "open the agent overview", "открыть обзор агентов"),
    ("hooks", "view and set up hooks", "посмотреть и настроить хуки"),
    ("permissions", "choose what Codex may do", "выбрать, что Codex можно делать"),
    ("approve", "allow one retry of a denied action", "разрешить один повтор отклонённого действия"),
    ("ps", "list background terminals", "показать фоновые терминалы"),
    ("stop", "stop all background terminals", "остановить все фоновые терминалы"),
    ("clear", "clear the screen and start a new chat", "очистить экран и начать новый разговор"),
    ("memories", "set up memory", "настроить память"),
    ("presets", "run or save prompt presets", "запустить или сохранить заготовки"),
    ("worktree", "continue in a new git worktree", "продолжить в новом git worktree"),
    ("cd", "change the working folder", "сменить рабочую папку"),
    ("pwd", "show the working folder", "показать рабочую папку"),
    ("config", "open Codex settings", "открыть настройки Codex"),
    ("experimental", "turn experimental features on or off", "включить или выключить новые функции"),
    ("archive", "archive this chat", "убрать разговор в архив"),
    ("delete", "delete this chat for good", "удалить разговор навсегда"),
    ("import", "bring setup and chats over from Claude Code", "перенести настройки и разговоры из Claude Code"),
    ("plugins", "browse plugins", "посмотреть плагины"),
    ("app", "continue in the Codex app", "продолжить в приложении Codex"),
    ("warnings", "show warnings and diagnostics", "показать предупреждения и диагностику"),
    ("theme", "pick a code color theme", "выбрать цвета для кода"),
    ("statusline", "choose what the status line shows", "выбрать, что показывать в строке статуса"),
    ("title", "choose what the terminal title shows", "выбрать, что показывать в заголовке терминала"),
    ("keymap", "change key bindings", "изменить сочетания клавиш"),
    ("vim", "turn Vim mode on or off", "включить или выключить режим Vim"),
    ("raw", "turn plain scrollback on or off for copying", "включить или выключить простую прокрутку"),
    ("ide", "add context from your IDE", "добавить контекст из IDE"),
    ("logout", "log out of Codex", "выйти из аккаунта Codex"),
    ("feedback", "send logs to the Codex team", "отправить логи команде Codex"),
    ("quit", "exit Codex", "выйти из Codex"),
)
FREQUENT = 8                      # the first entries keep their order, the rest are sorted
SKILL_SIGIL = "$"


def _roots(home: str | None) -> list[str]:
    if home:
        return [os.path.join(home, ".codex", "skills"), os.path.join(home, ".agents", "skills")]
    return [os.path.join(_codex_home(), "skills"), os.path.join(os.path.expanduser("~"), ".agents", "skills")]


def _codex_home() -> str:
    # The index imports a lot: only when asked.
    from .index import codex_home
    return codex_home()


def skills(home: str | None = None) -> list[dict]:
    """Skills as the `$` list in Codex shows them, by Codex's own names (codex_skills.available)."""
    from . import codex_skills

    codex_home = os.path.join(home, ".codex") if home else _codex_home()
    return [dict(skill, kind="skill", sigil=SKILL_SIGIL) for skill in codex_skills.available(codex_home, _roots(home))]


def all_commands(home: str | None = None) -> list[dict]:
    english = messages.request_lang() != "ru"
    builtin = [{"name": n, "description": en if english else ru, "kind": "builtin"} for n, en, ru in BUILTIN]
    rest = sorted(builtin[FREQUENT:], key=lambda c: c["name"])
    return builtin[:FREQUENT] + rest + skills(home)


def models(home: str | None = None) -> list[dict]:
    """The models Codex lists in its own /model picker, with their efforts (its cache, read only)."""
    path = os.path.join(home, ".codex", "models_cache.json") if home \
        else os.path.join(_codex_home(), "models_cache.json")
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    out = []
    for m in data.get("models") or [] if isinstance(data, dict) else []:
        if not isinstance(m, dict) or m.get("visibility") != "list" or not isinstance(m.get("slug"), str):
            continue
        levels = [lv.get("effort") for lv in m.get("supported_reasoning_levels") or []
                  if isinstance(lv, dict) and isinstance(lv.get("effort"), str)]
        out.append({"slug": m["slug"], "name": str(m.get("display_name") or m["slug"]), "efforts": levels})
    return out
