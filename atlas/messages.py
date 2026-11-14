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
    "server.bad_session_id": {
        "en": "invalid session id",
        "ru": "неверный id сессии"},
    "server.no_session": {
        "en": "session not found",
        "ru": "сессия не найдена"},
    "server.no_such_session": {
        "en": "session not found",
        "ru": "сессия не найдена"},
    "server.plan_not_found": {"en": "plan not found", "ru": "план не найден"},
    "server.no_job": {
        "en": "background task not found",
        "ru": "фоновое задание не найдено"},
    "server.no_path": {
        "en": "no such address",
        "ru": "нет такого адреса"},
    "server.no_file": {"en": "no such file", "ru": "нет такого файла"},
    "server.unknown_artifact": {
        "en": "unknown result type",
        "ru": "неизвестный тип результата"},
    "server.agent_changed": {
        "en": "The settings now send this to {agent}, not to the agent in the preview. Open the preview again.",
        "ru": "По настройкам это теперь уйдёт в {agent}, а не в агента из предпросмотра. Открой предпросмотр снова."},
    "server.page_outdated": {
        "en": "This page is from before an update. Reload the page, then try again.",
        "ru": "Эта страница открыта до обновления. Обнови страницу и попробуй снова."},
    "auto.paused": {
        "en": "Paused: it was turned on for {was}, and AI features now go to {now}. "
              "Turn it off and on to go on with {now}.",
        "ru": "Приостановлено: её включили для {was}, а ИИ-функции теперь идут в {now}. "
              "Выключи и включи снова, чтобы продолжить с {now}."},
    "server.need_confirm": {
        "en": "confirm in the preview first",
        "ru": "сначала подтверди в предпросмотре"},
    "server.no_workdir": {"en": "no working folder for this session",
                          "ru": "нет рабочей папки для этой сессии"},
    "server.handoff_first": {
        "en": "create a session note first",
        "ru": "сначала создай заметку по сессии"},
    "server.bad_destination": {
        "en": "destination is not in the allowed list",
        "ru": "эта папка не из списка разрешённых"},
    "server.llm_off": {"en": "AI features are off — turn them on in the plugin settings",
                       "ru": "ИИ-функции выключены — включи их в настройках плагина"},
    "server.enabled_bool": {"en": "enabled must be true or false",
                            "ru": "нужно enabled: true или false"},
    "export.desktop": {"en": "Desktop", "ru": "Рабочий стол"},
    "export.documents": {"en": "Documents", "ru": "Документы"},
    "delete.running": {
        "en": "the session is still running — stop it first; closing the tab does not stop a background session",
        "ru": "сессия ещё работает — сначала останови её; фоновую сессию закрытие вкладки не останавливает"},
    "delete.outside": {"en": "refusing to delete outside the Claude Code folder: {path}",
                       "ru": "не удаляю за пределами папки Claude Code: {path}"},
    "delete.outside_codex": {"en": "refusing to delete outside the Codex folder: {path}",
                             "ru": "не удаляю за пределами папки Codex: {path}"},
    "delete.codex_app_note": {
        "en": "Codex itself may still list this session for a while, until it notices the file is gone",
        "ru": "Сам Codex может ещё какое-то время показывать эту сессию в списке, пока не заметит, что файла нет"},
    "delete.codex_by_codex": {
        "en": "Codex deletes the session with its own command (codex delete), so its session list updates too",
        "ru": "Codex удалит сессию своей командой (codex delete), и его список сессий тоже обновится"},
    "delete.codex_failed": {
        "en": "Codex could not delete it itself ({error}); the files were removed, and Codex may still list "
              "the session for a while",
        "ru": "Codex не смог удалить её сам ({error}); файлы удалены, но Codex может ещё какое-то время "
              "показывать сессию в списке"},
    "session_id.invalid": {
        "en": "invalid session id",
        "ru": "неверный id сессии"},

    # --- actions.py ---
    "terminal.osascript_failed": {"en": "could not run osascript: {error}",
                                  "ru": "не удалось вызвать osascript: {error}"},
    "terminal.automation_hint": {
        "en": " — Automation permission for Terminal seems missing: System Settings → Privacy & Security → "
              "Automation",
        "ru": " — похоже, нет разрешения на управление Terminal: «Системные настройки» → «Конфиденциальность и "
              "безопасность» → «Автоматизация»"},
    "terminal.osascript_error": {"en": "osascript returned an error",
                                 "ru": "osascript вернул ошибку"},
    "terminal.sent": {"en": "command sent to Terminal", "ru": "команда отправлена в Terminal"},
    "rename.empty": {"en": "empty title", "ru": "пустой заголовок"},
    "rename.no_transcript": {
        "en": "history file not found in the catalog",
        "ru": "файл истории не найден в каталоге"},
    "rename.codex_failed": {
        "en": "renamed in the catalog only: Codex could not rename it ({error})",
        "ru": "переименовано только в каталоге: Codex не смог переименовать ({error})"},
    "rename.codex_old": {
        "en": "renamed in the catalog only: this Codex version cannot rename sessions — update Codex",
        "ru": "переименовано только в каталоге: эта версия Codex не умеет переименовывать — обнови Codex"},
    "rename.append_failed": {
        "en": "the name was saved in the catalog but not in the history file: {error}",
        "ru": "имя сохранено в каталоге, но не в файле истории: {error}"},
    "actions.no_workdir": {
        "en": "The session's working folder no longer exists — the terminal launch is unavailable; run it yourself "
              "from the right folder.",
        "ru": "Рабочей папки сессии больше нет — запуск в терминале недоступен, запусти вручную из нужной папки."},
    "actions.resume_copy": {
        "en": "The CLI may continue this same session or open a copy of it — "
              "neither is guaranteed.",
        "ru": "CLI может продолжить эту же сессию, а может открыть её копию — "
              "гарантии в обе стороны нет."},

    "job.interrupted": {
        "en": "Atlas restarted before this task finished. Please try again.",
        "ru": "Atlas перезапустился до завершения задачи. Запусти её ещё раз."},

    # --- folders.py (the folder field of "+ Session") ---
    "folder.not_text": {
        "en": "the folder path must be text",
        "ru": "путь к папке должен быть текстом"},
    "folder.empty": {
        "en": "type a folder path or pick one",
        "ru": "впиши путь к папке или выбери из списка"},
    "folder.bad_chars": {"en": "the path has control characters or is too long",
                         "ru": "в пути управляющие символы, или он слишком длинный"},
    "folder.relative": {"en": "not a full path: start with / or ~",
                        "ru": "это не полный путь: начни с / или ~"},
    "folder.relative_vaults": {
        "en": "not a full path: start with /, ~ or a vault name ({names})",
        "ru": "это не полный путь: начни с /, ~ или имени хранилища ({names})"},
    "folder.dotdot": {
        "en": "“..” is not supported: type the full folder path",
        "ru": "«..» не поддерживается: впиши полный путь к папке"},
    "folder.missing": {"en": "no such folder: {path}", "ru": "такой папки нет: {path}"},
    "folder.not_dir": {"en": "not a folder: {path}", "ru": "это не папка: {path}"},
    "folder.temp": {
        "en": "sessions are not started in temporary or system folders",
        "ru": "во временных и системных папках сессия не запускается"},

    # --- launch.py ---
    "launch.prompt_not_text": {"en": "the prompt must be text", "ru": "запрос должен быть текстом"},
    "launch.bad_agent": {"en": "unknown agent — pick Claude Code or Codex",
                         "ru": "неизвестный агент — выбери Claude Code или Codex"},
    "launch.prompt_too_long": {"en": "the first prompt is too long",
                               "ru": "слишком длинный первый запрос"},

    # --- convert.py ("Resume with…") ---
    "convert.busy": {"en": "The catalog is busy. Please try again shortly.",
                     "ru": "Каталог занят. Повтори попытку чуть позже."},
    "convert.empty": {
        "en": "nothing to copy: the session has no messages since its last compaction",
        "ru": "копировать нечего: после последнего сжатия контекста в сессии нет сообщений"},
    "convert.no_transcript": {
        "en": "the session's history file is gone",
        "ru": "файла истории сессии больше нет"},
    "convert.long_folder": {"en": "the folder path is too long for Claude Code's project folder",
                            "ru": "путь папки слишком длинный для папки проекта Claude Code"},

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
    "step.edit": {
        "en": "edited {name}",
        "ru": "изменил {name}"},
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
    "limits.hours": {"en": "{n} h", "ru": "{n} ч"},
    "limits.days": {"en": "{n} d", "ru": "{n} дн."},
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
    "feed.agents": {
        "en": ["{n} subagent", "{n} subagents"],
        "ru": ["{n} субагент", "{n} субагента", "{n} субагентов"]},
    "feed.web": {"en": "web: {n}", "ru": "веб: {n}"},

    # --- session fact card: payload (runner.py) and classifier signal (classify.py) ---
    # Sent to the model and shown in the "what will be sent out" preview.
    "fact.session": {"en": "# Session {sid}", "ru": "# Сессия {sid}"},
    "fact.title": {"en": "Title: {value}", "ru": "Заголовок: {value}"},
    "fact.period": {"en": "Period: {start} → {end}", "ru": "Период: {start} → {end}"},
    "fact.folder": {"en": "Folder: {cwd} · branch: {branch}", "ru": "Папка: {cwd} · ветка: {branch}"},
    "fact.workdir": {"en": "Working folder: {cwd} · branch: {branch}",
                     "ru": "Рабочая папка: {cwd} · ветка: {branch}"},
    "fact.turns": {
        "en": "User prompts: {value}",
        "ru": "Запросов пользователя: {value}"},
    "fact.tickets": {"en": "Tickets: {value}", "ru": "Тикеты: {value}"},
    "fact.projects": {"en": "Projects by path: {value}", "ru": "Проекты по путям: {value}"},
    "fact.files_n": {
        "en": "Changed files ({n}): {value}",
        "ru": "Изменённые файлы ({n}): {value}"},
    "fact.files": {
        "en": "Changed files:",
        "ru": "Изменённые файлы:"},
    "fact.links": {"en": "Links: {value}", "ru": "Ссылки: {value}"},
    "fact.first_prompt": {"en": "First prompt: {value}", "ru": "Первый запрос: {value}"},
    "fact.last_prompt": {"en": "Last prompt: {value}", "ru": "Последний запрос: {value}"},
    "fact.prompt_n": {"en": "Prompt {i}: {value}", "ru": "Запрос {i}: {value}"},
    "fact.separator": {"en": "--- Session {n} ---", "ru": "--- Сессия {n} ---"},
    "payload.header": {
        "en": "Session details",
        "ru": "Сведения о сессии"},
    "payload.summaries": {
        "en": "Compaction summaries",
        "ru": "Сводки сжатия контекста"},
    "payload.prompts": {"en": "User prompts", "ru": "Запросы пользователя"},
    "payload.answers": {
        "en": "Latest agent replies",
        "ru": "Последние ответы агента"},
    "payload.commands": {
        "en": "Latest commands",
        "ru": "Последние команды"},
    "payload.skipped": {"en": "\n\n…  {n} characters skipped  …\n\n",
                        "ru": "\n\n…  пропущено {n} символов  …\n\n"},

    # --- runner.py ---
    "runner.no_claude": {"en": "claude not found in PATH or in {paths}",
                         "ru": "claude не найден ни в PATH, ни в {paths}"},
    "runner.no_session": {"en": "no such session: {sid}", "ru": "нет такой сессии: {sid}"},
    "runner.egress_denied": {
        "en": "the session is marked “{sensitivity}”: sending to {backend}/{model} was not confirmed",
        "ru": "сессия помечена как «{sensitivity}»: отправка в {backend}/{model} не подтверждена"},
    "runner.preflight_prompt": {"en": "Reply with one word: ok", "ru": "Ответь одним словом: ок"},
    "runner.preflight_failed": {
        "en": "the pre-call check failed: {detail}",
        "ru": "проверка перед вызовом не прошла: {detail}"},
    "runner.cli_error": {"en": "claude -p returned an error", "ru": "claude -p вернул ошибку"},
    "runner.no_codex": {"en": "codex not found — install Codex or pick Claude Code for AI features in the settings",
                        "ru": "codex не найден — установи Codex или выбери Claude Code для ИИ-функций в настройках"},
    "runner.codex_error": {"en": "codex exec returned an error", "ru": "codex exec вернул ошибку"},
    "runner.codex_default_model": {"en": "default", "ru": "по умолчанию"},

    # --- enrich.py ---
    "enrich.no_json": {"en": "the model did not return JSON", "ru": "модель не вернула JSON"},
    "enrich.no_did": {"en": "the JSON lacks the required field did",
                      "ru": "в JSON нет обязательного поля did"},
    "enrich.handoff_missing": {
        "en": "the session note lacks required sections: {sections}",
        "ru": "в заметке по сессии нет обязательных разделов: {sections}"},
    "enrich.cancelled": {"en": "cancelled before start", "ru": "отменено до запуска"},
    "enrich.no_handoff": {
        "en": "the session note has not been created yet",
        "ru": "заметка по сессии ещё не создана"},

    # --- classify.py / autoclassify.py ---
    "classify.registry_empty": {"en": "(empty so far — create topics yourself)",
                                "ru": "(пока пуст — заводи темы сам)"},
    "classify.no_array": {"en": "the classifier did not return a JSON array",
                          "ru": "классификатор не вернул массив JSON"},
    "classify.bad_domain": {
        "en": "the model returned a category that is not configured: {domain}",
        "ru": "модель вернула направление не из настроек: {domain}"},
    "classify.empty_topic": {"en": "empty topic", "ru": "пустая тема"},
    "classify.batch_failed": {
        "en": "could not classify the batch from {sid}: {error}",
        "ru": "не удалось классифицировать группу с {sid}: {error}"},
    "classify.merge_failed": {
        "en": "topic merge: {error}",
        "ru": "объединение тем: {error}"},
    "classify.merge_no_json": {
        "en": "the topic merge did not return JSON",
        "ru": "объединение тем не вернуло JSON"},
    "classify.note": {
        "en": "Sensitive sessions are not included. A fact card is sent, not the conversation history: title, "
              "first and last prompt, paths, tickets — plus the topic list and context.md.",
        "ru": "Конфиденциальные сессии в выборку не попадают. Уходит карточка фактов, а не история разговора: "
              "заголовок, первый и последний запрос, пути, тикеты — плюс список тем и context.md."},
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
