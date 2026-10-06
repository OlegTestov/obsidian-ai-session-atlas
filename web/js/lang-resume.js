// Page strings: "Resume with…" (resume-with.js). Keys start with "rw."; en and ru have the same key set.
(function (root) {
  const I = root.I18N;
  I.add({
    en: {
      "rw.button": "Resume with…",
      "rw.menuLabel": "Resume this session with",
      "rw.own": "this session's agent — the ordinary resume",
      "rw.other": "a new session from this conversation",
      "rw.off": "{agent} is turned off in the plugin settings (Settings → Agents)",
      "rw.title": "Resume in {agent}",
      "rw.note": "A new {agent} session will be created from this {from} conversation since its last "
        + "compaction: {n} messages, about {k}k tokens. Tool calls go in as text. The source session "
        + "stays as it is.",
      "rw.omitted": " The earliest part does not fit and is left out; the new session starts with a note about it.",
      "rw.folder": "Saved to {folder}",
      "rw.createOpen": "Create and open in Obsidian",
      "rw.create": "Create",
      "rw.creating": "creating the session…",
      "rw.failed": "Not created: {msg}",
      "rw.createdOutside": "Created. Run the command in a terminal to open it in {agent}.",
      "rw.from": "Continued from the {agent} session",
      "rw.to": "Continued in:",
      "rw.badge": "↪ from {agent}",
      "rw.badgeHint": "Continued from the {agent} session “{title}”",
      "help.whichResumeWith": "The same conversation in the other agent: Claude Code or Codex. A new "
        + "session of that agent is made from this one; the original is not changed.",
    },
    ru: {
      "rw.button": "Открыть с помощью…",
      "rw.menuLabel": "Открыть эту сессию с помощью",
      "rw.own": "агент этой сессии — обычное восстановление",
      "rw.other": "новая сессия из этого разговора",
      "rw.off": "{agent} выключен в настройках плагина (Настройки → Агенты)",
      "rw.title": "Продолжить в {agent}",
      "rw.note": "Из этого разговора {from} с его последней компактации будет создана новая сессия "
        + "{agent}: сообщений — {n}, примерно {k}k токенов. Вызовы инструментов попадут текстом. "
        + "Исходная сессия не меняется.",
      "rw.omitted": " Самое раннее не помещается и будет опущено; новая сессия начнётся с пометки об этом.",
      "rw.folder": "Сохранится в {folder}",
      "rw.createOpen": "Создать и открыть в Obsidian",
      "rw.create": "Создать",
      "rw.creating": "создаю сессию…",
      "rw.failed": "Не создана: {msg}",
      "rw.createdOutside": "Создана. Выполни команду в терминале, чтобы открыть её в {agent}.",
      "rw.from": "Продолжение сессии {agent}",
      "rw.to": "Продолжена в:",
      "rw.badge": "↪ из {agent}",
      "rw.badgeHint": "Продолжение сессии {agent} «{title}»",
      "help.whichResumeWith": "Тот же разговор в другом агенте: Claude Code или Codex. Из этой сессии "
        + "делается новая сессия того агента; исходная не меняется.",
    },
  });
})(window);
