"""Texts the server sends to the page, in two languages.

The language comes from each request's `X-Atlas-Lang` header: server.py puts it in a thread-local,
deeper modules read `request_lang()`. Background threads (jobs, auto-classification) get the
language explicitly via `use_lang`. No header means English.

This is the interface language. The model's reply language is a separate setting (`prompts.lang()`).
Data identifiers (topics, domains, status codes) do not belong here.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager

LANGS = ("en", "ru")
DEFAULT = "en"

_local = threading.local()
_last = {"lang": DEFAULT}          # language of the page's last request, for the background scheduler

# Plurals are lists: en [one, other], ru [one, few, many]; {n} is the number itself.
MESSAGES: dict[str, dict] = {
    # --- server.py: routing and protection errors ---
    "server.bad_host": {"en": "wrong Host", "ru": "неверный Host"},
    "server.foreign_origin": {"en": "foreign Origin", "ru": "чужой Origin"},
    "server.no_origin": {"en": "mutating request without Origin",
                         "ru": "мутирующий запрос без Origin"},
    "server.bad_csrf": {"en": "wrong CSRF token", "ru": "неверный CSRF-токен"},
    "server.bad_session_id": {"en": "bad session id", "ru": "плохой id сессии"},
    "server.no_session": {"en": "no session", "ru": "нет сессии"},
    "server.no_such_session": {"en": "no such session", "ru": "нет такой сессии"},
    "server.plan_not_found": {"en": "plan not found", "ru": "план не найден"},
    "server.no_job": {"en": "no such job", "ru": "нет такой джобы"},
    "server.no_path": {"en": "no such path", "ru": "нет такого пути"},
    "server.no_file": {"en": "no such file", "ru": "нет такого файла"},
    "server.unknown_artifact": {"en": "unknown artifact kind", "ru": "неизвестный вид артефакта"},
    "server.need_confirm": {"en": "preview confirmation required",
                            "ru": "нужно подтверждение preview"},
    "server.no_workdir": {"en": "no working folder for this session",
                          "ru": "нет рабочей папки для этой сессии"},
    "server.handoff_first": {"en": "build the handoff first", "ru": "сначала построй хендофф"},
    "server.bad_destination": {"en": "destination is not in the allowed list",
                               "ru": "цель не из списка разрешённых"},
    "server.llm_off": {"en": "AI features are off — turn them on in the plugin settings",
                       "ru": "ИИ-функции выключены — включи их в настройках плагина"},
    "server.enabled_bool": {"en": "enabled must be true or false",
                            "ru": "нужно enabled: true или false"},
    "export.desktop": {"en": "Desktop", "ru": "Рабочий стол"},
    "export.documents": {"en": "Documents", "ru": "Документы"},
    "delete.running": {"en": "the session is running — stop it or close its tab first",
                       "ru": "сессия запущена — сначала останови её или закрой вкладку"},
    "delete.outside": {"en": "refusing to delete outside the Claude Code folder: {path}",
                       "ru": "не удаляю за пределами папки Claude Code: {path}"},
    "session_id.invalid": {"en": "invalid session_id", "ru": "невалидный session_id"},

    # --- actions.py ---
    "terminal.osascript_failed": {"en": "could not run osascript: {error}",
                                  "ru": "не удалось вызвать osascript: {error}"},
    "terminal.automation_hint": {
        "en": " — Automation permission seems missing in System Settings › Privacy",
        "ru": " — похоже, не выдано разрешение Automation в System Settings › Privacy"},
    "terminal.osascript_error": {"en": "osascript returned an error",
                                 "ru": "osascript вернул ошибку"},
    "terminal.sent": {"en": "command sent to Terminal", "ru": "команда отправлена в Terminal"},
    "rename.empty": {"en": "empty title", "ru": "пустой заголовок"},
    "rename.no_transcript": {"en": "transcript not found in the catalog",
                             "ru": "транскрипт не найден в каталоге"},
    "rename.append_failed": {"en": "could not append to the transcript: {error}",
                             "ru": "не удалось дописать в транскрипт: {error}"},
    "actions.no_workdir": {
        "en": "The session's working folder does not exist — the terminal launch is unavailable, "
              "pick a folder manually.",
        "ru": "Рабочая папка сессии не существует — запуск в терминале недоступен, "
              "выбери папку вручную."},
    "actions.resume_copy": {
        "en": "The CLI may continue this same session or open a copy of it — "
              "neither is guaranteed.",
        "ru": "CLI может продолжить эту же сессию, а может открыть её копию — "
              "гарантии в обе стороны нет."},

    # --- launch.py ---
    "launch.bad_folder": {"en": "folder is not in the list — pick one of the suggested",
                          "ru": "папка не из списка — выбери из предложенных"},
    "launch.prompt_not_text": {"en": "the prompt must be text", "ru": "запрос должен быть текстом"},
    "launch.prompt_too_long": {"en": "the first prompt is too long",
                               "ru": "слишком длинный первый запрос"},

    # --- relocate.py ---
    "relocate.bad_pid": {"en": "invalid process", "ru": "неверный процесс"},
    "relocate.foreign_pid": {"en": "the process is not this session's",
                             "ru": "процесс не этой сессии"},
    "relocate.ended": {"en": "the session has already ended — open it from search",
                       "ru": "сессия уже завершена — открой её из поиска"},
    "relocate.in_obsidian": {"en": "the session is already in an Obsidian tab",
                             "ru": "сессия уже во вкладке Obsidian"},
    "relocate.not_stopped": {"en": "the session in {app} did not exit — quit it there (/exit)",
                             "ru": "сессия в {app} не завершилась — выйди из неё там (/exit)"},
    "relocate.terminal": {"en": "the terminal", "ru": "терминале"},

    # --- uploads.py ---
    "upload.missing": {"en": "no image", "ru": "нет картинки"},
    "upload.corrupt": {"en": "the image is corrupted", "ru": "картинка повреждена"},
    "upload.too_big": {"en": "the image is larger than {mb} MB", "ru": "картинка больше {mb} МБ"},
    "upload.format": {"en": "PNG, JPEG, GIF and WebP are supported",
                      "ru": "поддерживаются PNG, JPEG, GIF и WebP"},

    # --- stats.py ---
    "stats.no_topic": {"en": "no topic", "ru": "без темы"},

    # --- query.py ---
    "query.only_excluded": {
        "en": "Exclusions alone cannot be searched: add at least one word without a minus.",
        "ru": "Одни исключения искать нельзя: добавь хотя бы одно слово без минуса."},
    "query.how.exact": {"en": "exact", "ru": "точно"},
    "query.how.forms": {"en": "any word form", "ru": "любая форма слова"},
    "query.how.phrase": {"en": "whole phrase", "ru": "фраза целиком"},

    # --- steps.py: turn steps in the feed, one at a time ---
    "step.edit": {"en": "edit {name}", "ru": "правка {name}"},
    "step.write": {"en": "wrote {name}", "ru": "записал {name}"},
    "step.read": {"en": "read {name}", "ru": "прочитал {name}"},
    "step.search": {"en": "searched {pattern}", "ru": "искал {pattern}"},
    "step.agent": {"en": "agent {who}: {what}", "ru": "агент {who}: {what}"},
    "step.agent_default": {"en": "agent", "ru": "агент"},
    "step.skill": {"en": "skill {name}", "ru": "скилл {name}"},
    "step.tasks": {"en": "tasks", "ru": "задачи"},
    "step.tasks_what": {"en": "tasks: {what}", "ru": "задачи: {what}"},
    "step.read_many": {"en": ["read {n} file", "read {n} files"],
                       "ru": ["прочитал {n} файл", "прочитал {n} файла", "прочитал {n} файлов"]},
    "step.search_many": {"en": ["searched {n} time", "searched {n} times"],
                         "ru": ["искал {n} раз", "искал {n} раза", "искал {n} раз"]},
    # --- limits.py: subscription limit windows ---
    "limits.five_hour": {"en": "5 hours", "ru": "5 часов"},
    "limits.seven_day": {"en": "week", "ru": "неделя"},
    # --- feed.py: turn steps ---
    "feed.edited": {"en": ["edited {n} file", "edited {n} files"],
                    "ru": ["правил {n} файл", "правил {n} файла", "правил {n} файлов"]},
    "feed.commands": {"en": ["{n} command", "{n} commands"],
                      "ru": ["{n} команда", "{n} команды", "{n} команд"]},
    "feed.read": {"en": ["read {n} file", "read {n} files"],
                  "ru": ["прочитал {n} файл", "прочитал {n} файла", "прочитал {n} файлов"]},
    "feed.searched": {"en": ["searched code {n} time", "searched code {n} times"],
                      "ru": ["искал в коде {n} раз", "искал в коде {n} раза",
                             "искал в коде {n} раз"]},
    "feed.agents": {"en": ["{n} subagent", "{n} subagents"],
                    "ru": ["{n} сабагент", "{n} сабагента", "{n} сабагентов"]},
    "feed.web": {"en": "web: {n}", "ru": "веб: {n}"},

    # --- session fact card: payload (runner.py) and classifier signal (classify.py) ---
    # Sent to the model and shown in the "what will be sent out" preview.
    "fact.session": {"en": "# Session {sid}", "ru": "# Сессия {sid}"},
    "fact.title": {"en": "Title: {value}", "ru": "Заголовок: {value}"},
    "fact.period": {"en": "Period: {start} → {end}", "ru": "Период: {start} → {end}"},
    "fact.folder": {"en": "Folder: {cwd} · branch: {branch}", "ru": "Папка: {cwd} · ветка: {branch}"},
    "fact.workdir": {"en": "Working folder: {cwd} · branch: {branch}",
                     "ru": "Рабочая папка: {cwd} · ветка: {branch}"},
    "fact.turns": {"en": "User turns: {value}", "ru": "Ходов пользователя: {value}"},
    "fact.tickets": {"en": "Tickets: {value}", "ru": "Тикеты: {value}"},
    "fact.projects": {"en": "Projects by path: {value}", "ru": "Проекты по путям: {value}"},
    "fact.files_n": {"en": "Edited files ({n}): {value}", "ru": "Правленые файлы ({n}): {value}"},
    "fact.files": {"en": "Edited files:", "ru": "Правленые файлы:"},
    "fact.links": {"en": "Links: {value}", "ru": "Ссылки: {value}"},
    "fact.first_prompt": {"en": "First prompt: {value}", "ru": "Первый запрос: {value}"},
    "fact.last_prompt": {"en": "Last prompt: {value}", "ru": "Последний запрос: {value}"},
    "fact.prompt_n": {"en": "Prompt {i}: {value}", "ru": "Запрос {i}: {value}"},
    "fact.separator": {"en": "--- Session {n} ---", "ru": "--- Сессия {n} ---"},
    "payload.header": {"en": "Header", "ru": "Шапка"},
    "payload.summaries": {"en": "Compaction summaries", "ru": "Сводки компактации"},
    "payload.prompts": {"en": "User prompts", "ru": "Запросы пользователя"},
    "payload.answers": {"en": "Assistant replies (session tail)",
                        "ru": "Ответы ассистента (хвост сессии)"},
    "payload.commands": {"en": "Commands (tail)", "ru": "Команды (хвост)"},
    "payload.skipped": {"en": "\n\n…  {n} characters skipped  …\n\n",
                        "ru": "\n\n…  пропущено {n} символов  …\n\n"},

    # --- runner.py ---
    "runner.no_claude": {"en": "claude not found in PATH or in {paths}",
                         "ru": "claude не найден ни в PATH, ни в {paths}"},
    "runner.no_session": {"en": "no such session: {sid}", "ru": "нет такой сессии: {sid}"},
    "runner.egress_denied": {
        "en": "the session is marked “{sensitivity}”; there is no permission to send this "
              "session state to an external model ({backend}/{model})",
        "ru": "сессия помечена как «{sensitivity}», разрешения на отправку во внешнюю модель "
              "({backend}/{model}) для этого состояния сессии нет"},
    "runner.preflight_prompt": {"en": "Reply with one word: ok", "ru": "Ответь одним словом: ок"},
    "runner.preflight_failed": {"en": "the call preflight failed: {detail}",
                                "ru": "предпроверка вызова не прошла: {detail}"},
    "runner.cli_error": {"en": "claude -p returned an error", "ru": "claude -p вернул ошибку"},

    # --- enrich.py ---
    "enrich.no_json": {"en": "the model did not return JSON", "ru": "модель не вернула JSON"},
    "enrich.no_did": {"en": "the JSON lacks the required field did",
                      "ru": "в JSON нет обязательного поля did"},
    "enrich.handoff_missing": {"en": "the handoff lacks required sections: {sections}",
                               "ru": "в хендоффе нет обязательных разделов: {sections}"},
    "enrich.cancelled": {"en": "cancelled before start", "ru": "отменено до запуска"},
    "enrich.no_handoff": {"en": "the handoff has not been built yet",
                          "ru": "хендофф ещё не построен"},

    # --- classify.py / autoclassify.py ---
    "classify.registry_empty": {"en": "(empty so far — create topics yourself)",
                                "ru": "(пока пуст — заводи темы сам)"},
    "classify.no_array": {"en": "the classifier did not return a JSON array",
                          "ru": "классификатор не вернул массив JSON"},
    "classify.bad_domain": {"en": "domain outside the canon: {domain}",
                            "ru": "домен вне канона: {domain}"},
    "classify.empty_topic": {"en": "empty topic", "ru": "пустая тема"},
    "classify.batch_failed": {"en": "batch from {sid}: {error}", "ru": "пачка с {sid}: {error}"},
    "classify.merge_failed": {"en": "topic merge: {error}", "ru": "схлопывание тем: {error}"},
    "classify.merge_no_json": {"en": "the merge pass did not return JSON",
                               "ru": "проход схлопывания не вернул JSON"},
    "classify.note": {
        "en": "Sensitive sessions are not included. A fact card is sent, not the transcript: "
              "title, first and last prompt, paths, tickets.",
        "ru": "Чувствительные сессии в выборку не попадают. Уходит карточка фактов, "
              "а не транскрипт: заголовок, первый и последний запрос, пути, тикеты."},
    "auto.summary_failed": {"en": "{sid}: “What was done”: {error}",
                            "ru": "{sid}: «Что сделано»: {error}"},
}


def normalize(value) -> str:
    """Any header value → en | ru; unknown or empty gives the default language."""
    value = str(value or "").strip().lower()
    return value if value in LANGS else DEFAULT


def set_lang(value, remember: bool = True) -> str:
    """Thread language. remember: keep it as the page language for background passes."""
    lang = normalize(value)
    _local.lang = lang
    if remember and value:
        _last["lang"] = lang
    return lang


def request_lang() -> str:
    return getattr(_local, "lang", None) or DEFAULT


def last_lang() -> str:
    """Language of the last request with the header: the scheduler writes page errors in it."""
    return _last["lang"]


@contextmanager
def use_lang(value):
    """Language for the duration of the block, for a background thread that has no request."""
    prev = getattr(_local, "lang", None)
    _local.lang = normalize(value)
    try:
        yield _local.lang
    finally:
        _local.lang = prev


def _pick(key: str, lang: str | None):
    table = MESSAGES[key]
    return table.get(normalize(lang) if lang else request_lang()) or table[DEFAULT]


def msg(key: str, lang: str | None = None, **values) -> str:
    """Text by key in the request's (or the given) language; {name} is filled from values."""
    text = _pick(key, lang)
    return text.format(**values) if values else text


def plural_index(n: int, lang: str) -> int:
    if lang == "ru":
        n = abs(n)
        if n % 10 == 1 and n % 100 != 11:
            return 0
        if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
            return 1
        return 2
    return 0 if n == 1 else 1


def plural(key: str, n: int, lang: str | None = None, **values) -> str:
    """Form by number: en [one, other], ru [one, few, many]."""
    lang = normalize(lang) if lang else request_lang()
    forms = MESSAGES[key].get(lang) or MESSAGES[key][DEFAULT]
    return forms[plural_index(n, lang)].format(n=n, **values)
