// OpenCode's dialogs and reply queue are bound to native request and message IDs.
/* exported openCodeDialog, stopOpenCode, sendOpenCodeReply, discardOpenCodeReply, reconcileOpenCode, openCodeComposerText, openCodePickerMatches, submitOpenCodeComposer -- used by Active */
const openCodePermissionDecisions = ["once", "reject"];
const openCodeStopping = new Set();
const openCodeStopTimers = new Map();
const openCodeActions = new Set();
const openCodeForms = new Map();
const openCodeReplying = new Set();
const openCodeReplyChecks = new Set();
const openCodeRestoredReplies = new Map();

function openCodeAnswerValid(fields, answer) {
  if (!Array.isArray(fields) || Object.keys(answer).some(key => !fields.some(f => f.key === key))) return false;
  return fields.every(field => {
    if (!Object.hasOwn(answer, field.key)) return !field.required;
    const value = answer[field.key];
    const allowed = value => field.options.some(option => option.value === value);
    if (field.type === "string") return typeof value === "string" && (!field.required || !!value.trim())
      && (!field.options.length || field.custom || allowed(value));
    return Array.isArray(value) && (!field.required || value.length > 0)
      && (field.minItems == null || value.length >= field.minItems)
      && (field.maxItems == null || value.length <= field.maxItems)
      && value.every(option => typeof option === "string" && !!option.trim() && (field.custom || allowed(option)));
  });
}

function openCodeRequest(s, operation, body = {}) {
  return api("/api/opencode/active/" + operation, { session_id: s.session_id, ...body, generation: s.opencode_generation });
}

function redrawOpenCode() {
  lastSignature = "";
  renderActive(null, true);
}

async function answerOpenCode(s, item, operation, value = {}) {
  const sid = s.session_id;
  if (openCodeActions.has(sid)) return;
  openCodeActions.add(sid);
  dialogNotes.set(sid, { note: i18n("active.sending") });
  redrawOpenCode();
  try {
    await openCodeRequest(s, operation, { item_id: item.id, ...value });
    dialogNotes.set(sid, { note: i18n("active.answerSent"), cls: "ok", settled: item.id });
    openCodeForms.delete(item.id);
  } catch (error) {
    dialogNotes.set(sid, { note: error.message, cls: "bad",
      settled: error.state === "live_stale" && error.reason !== "generation_changed" ? item.id : null });
  } finally {
    openCodeActions.delete(sid);
    redrawOpenCode();
    void loadActive();
  }
}

function openCodeDialogButton(label, cls, disabled, click) {
  const button = el("button", cls, i18n(label));
  button.type = "button";
  button.disabled = disabled;
  button.addEventListener("click", click);
  return button;
}

function openCodeDialog(s, pid, full, box) {
  const sid = s.session_id;
  const item = s.opencode_dialog;
  const note = dialogNotes.get(sid);
  if (!pid || !item) {
    box.append(el("div", "q", i18n(pid ? "active.dialogTabOnly" : "opencode.answerInTab")));
    return box;
  }
  const busy = openCodeActions.has(sid) || openCodeStopping.has(sid) || note?.settled === item.id;
  const controls = el("div", "opts");
  const status = el("div", "note", note?.note);
  status.setAttribute("role", "status");
  if (note?.cls) status.classList.add(note.cls);
  if (item.kind === "permission") {
    box.append(el("div", "t oc-permission-title", i18n("active.permission", { title: item.action })));
    if (item.resources.length) {
      const details = el("pre", "det" + (full ? "" : " short"), item.resources.join("\n"));
      box.appendChild(details);
    }
    openCodePermissionDecisions.forEach(decision => controls.append(openCodeDialogButton(
      "opencode.permission." + decision, decision === "once" ? "primary" : null, busy,
      () => answerOpenCode(s, item, "permission", { decision }))));
    box.append(controls, status);
    return box;
  }

  box.append(el("div", "t", item.title || i18n("opencode.question")));
  if (item.fields) {
    const form = el("div", "oc-form");
    form.dataset.formId = item.id;
    form.dataset.sessionId = sid;
    const draft = openCodeForms.get(item.id)?.fields || new Map();
    openCodeForms.set(item.id, { sid, fields: draft });
    item.fields.forEach(field => form.append(openCodeField(field, draft, busy)));
    box.append(form);
    controls.append(openCodeDialogButton("opencode.submitAnswer", "primary", busy, () => {
      const answer = openCodeFormAnswer(item.fields, draft);
      if (!openCodeAnswerValid(item.fields, answer)) {
        status.textContent = i18n("opencode.invalidAnswer");
        status.classList.add("bad");
        return;
      }
      void answerOpenCode(s, item, "form", { answer });
    }));
  } else box.append(el("div", "q", i18n("active.dialogTabOnly")));
  controls.append(openCodeDialogButton("opencode.dismiss", null, busy, () => answerOpenCode(s, item, "dismiss")));
  box.append(controls, status);
  return box;
}

function openCodeFormAnswer(fields, draft) {
  const answer = Object.create(null);
  for (const field of fields) {
    const state = draft.get(field.key);
    if (!state) continue;
    const custom = state.custom.trim();
    const chosen = [...state.selected];
    if (field.type === "multiselect") {
      for (const entry of state.customValues) {
        const value = entry.value.trim();
        if (value && !chosen.includes(value)) chosen.push(value);
      }
      if (chosen.length) answer[field.key] = chosen;
    } else if (custom || chosen.length) answer[field.key] = custom || chosen[0];
  }
  return answer;
}

function openCodeField(field, draft, busy) {
  const multiple = field.type === "multiselect";
  const state = draft.get(field.key) || { selected: new Set(), custom: "", customValues: [{ value: "" }] };
  draft.set(field.key, state);
  const box = el("fieldset");
  box.disabled = busy;
  box.append(el("legend", null, field.title + (field.required ? " *" : "")));
  if (field.description) box.append(el("div", "q", field.description));
  const name = crypto.randomUUID();
  const custom = el("input", "oc-custom");
  custom.type = "text";
  custom.placeholder = i18n("opencode.customAnswer");
  custom.setAttribute("aria-label", field.title + " · " + custom.placeholder);
  custom.value = state.custom;
  custom.addEventListener("input", () => {
    state.custom = custom.value;
    if (!multiple && custom.value) {
      state.selected.clear();
      for (const input of box.querySelectorAll("input[type=radio]")) input.checked = false;
    }
  });
  for (const option of field.options) {
    const label = el("label", "oc-choice");
    label.title = option.description || option.label;
    const input = el("input");
    input.type = multiple ? "checkbox" : "radio";
    input.name = name;
    input.checked = state.selected.has(option.value);
    input.addEventListener("change", () => {
      if (!multiple) {
        state.selected.clear();
        state.custom = custom.value = "";
      }
      if (input.checked) state.selected.add(option.value);
      else state.selected.delete(option.value);
    });
    label.append(input, option.label);
    box.append(label);
  }
  if (multiple && field.custom) box.append(openCodeCustomValues(field, state.customValues, busy));
  else if (!multiple && (field.custom || !field.options.length)) box.append(custom);
  return box;
}

function openCodeCustomValues(field, entries, busy) {
  const box = el("div");
  const add = openCodeDialogButton("opencode.addAnswer", null, busy, () => {
    const entry = { value: "" };
    entries.push(entry);
    addRow(entry).focus();
  });
  function addRow(entry) {
    const row = el("div", "oc-custom-row");
    const input = el("input", "oc-custom");
    input.type = "text";
    input.placeholder = i18n("opencode.customAnswer");
    input.setAttribute("aria-label", field.title + " · " + input.placeholder);
    input.value = entry.value;
    input.addEventListener("input", () => { entry.value = input.value; });
    const remove = openCodeDialogButton("opencode.removeAnswer", null, busy, () => {
      entries.splice(entries.indexOf(entry), 1);
      row.remove();
      add.focus();
    });
    row.append(input, remove);
    box.insertBefore(row, add);
    return input;
  }
  box.append(add);
  entries.forEach(addRow);
  return box;
}

function pruneOpenCodeStops(running) {
  if (!Array.isArray(running)) return;
  for (const sid of openCodeStopping) {
    if (running.includes(sid)) continue;
    openCodeStopping.delete(sid);
    stopNotes.delete(sid);
  }
}

async function stopOpenCode(s) {
  const sid = s.session_id;
  if (openCodeStopping.has(sid)) return;
  window.clearTimeout(openCodeStopTimers.get(sid));
  openCodeStopTimers.delete(sid);
  openCodeStopping.add(sid);
  stopNotes.set(sid, i18n("opencode.stopping"));
  redrawOpenCode();
  try {
    await openCodeRequest(s, "stop");
  } catch (error) {
    openCodeStopping.delete(sid);
    const note = i18n("active.notStopped", { reason: error.message });
    stopNotes.set(sid, note);
    openCodeStopTimers.set(sid, window.setTimeout(() => {
      openCodeStopTimers.delete(sid);
      stopNotes.delete(sid);
      redrawOpenCode();
    }, 5000));
    redrawOpenCode();
  }
  void loadActive();
}

const openCodePickers = new Map();
const openCodePickerTTL = 30_000;

function openCodePickerCatalog(s) {
  const key = JSON.stringify([s.opencode_generation, s.cwd]);
  const now = Date.now();
  for (const [cachedKey, entry] of openCodePickers) {
    if (now - entry.at > openCodePickerTTL) openCodePickers.delete(cachedKey);
  }
  const cached = openCodePickers.get(key);
  if (cached) return cached.promise;
  const entry = { at: now, promise: openCodeRequest(s, "pickers").catch(error => {
    if (openCodePickers.get(key) === entry) openCodePickers.delete(key);
    throw error;
  }) };
  openCodePickers.set(key, entry);
  return entry.promise;
}

async function openCodePickerMatches(s, text) {
  const category = /^\/(model|skill) +(\S*)$/.exec(text);
  if (!category && !/^\/[^\s]*$/.test(text)) return [];
  try {
    const catalog = await openCodePickerCatalog(s);
    if (!category) {
      const shortcuts = [
        { name: "model", description: i18n("cmd.model"), next: true },
        { name: "skill", description: i18n("opencode.skillPicker"), next: true },
      ];
      const reserved = new Set(shortcuts.map(item => item.name));
      return AtlasLogic.commandMatches([...shortcuts, ...catalog.commands.filter(item => !reserved.has(item.name))], text);
    }
    const [, kind, needle] = category;
    const options = kind === "model" ? catalog.models.map(model => ({
      name: model.name, display: model.name, description: model.provider,
      insertText: "/model " + model.provider + "/" + model.id,
    })) : catalog.skills.map(skill => ({
      ...skill, display: skill.name,
      insertText: i18n("opencode.useSkill", { id: skill.id }) + " ",
    }));
    const q = needle.toLowerCase();
    return options.filter(item => [item.name, item.insertText].some(value => value.toLowerCase().includes(q)));
  } catch {
    return [];
  }
}

async function submitOpenCodeComposer(s, text, images) {
  const slash = /^\/([^\s]+)(?:\s+(.*))?$/s.exec(text.trim());
  if (!slash) return sendOpenCodeReply(s, text, images);
  const sid = s.session_id;
  try {
    const [, name, value = ""] = slash;
    const catalog = await openCodePickerCatalog(s);
    if (name === "model" || name === "skill") {
      const entry = name === "model"
        ? catalog.models.find(model => model.provider + "/" + model.id === value)
        : catalog.skills.find(skill => skill.id === value);
      if (!entry) return setSendNote(sid, i18n("opencode.pickListedOption"), "bad");
      if (name === "model") await runOpenCodePicker(s, text, images, "model", { id: entry.id, provider: entry.provider });
      else {
        const prompt = i18n("opencode.useSkill", { id: entry.id });
        const area = document.querySelector(`.answer textarea[data-id="${CSS.escape(sid)}"]`);
        if (area?.value !== text) return;
        area.value = prompt;
        drafts.set(sid, prompt);
        saveDrafts();
        await sendOpenCodeReply(s, prompt, images);
      }
    } else if (catalog.commands.some(command => command.id === name)) {
      await runOpenCodePicker(s, text, images, "command", { id: name, text: value });
    } else {
      await sendOpenCodeReply(s, text, images);
    }
  } catch (error) {
    setSendNote(sid, i18n("active.notSent", { reason: error.message }), "bad");
  }
}

async function runOpenCodePicker(s, text, images, operation, payload) {
  const sid = s.session_id;
  if (images.length) return setSendNote(sid, i18n("opencode.pickerImages"), "bad");
  if (openCodeReplying.has(sid) || openCodeReplyChecks.has(sid)) return;
  const key = "atlas.opencode.picker." + sid;
  const area = document.querySelector(`.answer textarea[data-id="${CSS.escape(sid)}"]`);
  const run = async confirmed => {
    if (!area?.isConnected || area.value !== text || area.disabled || openCodeReplying.has(sid)) return;
    openCodeReplying.add(sid);
    setSendNote(sid, i18n("active.sending"), "");
    try {
      await withOpenCodeReplyLock(sid, async () => {
        if (pendingOpenCodeReply(sid)) {
          setSendNote(sid, i18n("opencode.retryOriginal"), "bad");
          return;
        }
        const pending = window.localStorage.getItem(key);
        if (pending && pending !== confirmed) {
          setSendNote(sid, "", "");
          const retry = i18n("opencode.runPickerAgain");
          modal(retry, i18n("opencode.pickerUncertain"), "", retry, async () => {
            closeAfterHandOff();
            await run(pending);
          });
          return;
        }
        window.localStorage.setItem(key, crypto.randomUUID());
        try {
          await openCodeRequest(s, operation, payload);
          window.localStorage.removeItem(key);
          clearOpenCodeReplyDraft(sid, { text });
          setSendNote(sid, "", "");
        } catch (error) {
          if (error.status >= 400 && error.status < 500 && error.state !== "live_picker_uncertain") {
            window.localStorage.removeItem(key);
          }
          throw error;
        }
      });
    } catch (error) {
      setSendNote(sid, i18n("active.notSent", { reason: error.message }), "bad");
    } finally {
      openCodeReplying.delete(sid);
      void loadActive();
    }
  };
  await run();
}

const openCodeReplyPrefix = "atlas.opencode.reply.";

function openCodeReplyKey(sid) {
  return openCodeReplyPrefix + sid;
}

function withOpenCodeReplyLock(sid, run) {
  const locks = window.navigator?.locks;
  return locks ? locks.request(openCodeReplyKey(sid), run) : run();
}

function openCodeReplyBlank(text) {
  // Python str.strip() includes the four information separators and excludes the BOM.
  // eslint-disable-next-line no-control-regex -- match those separators without altering reply text
  return /^[\p{White_Space}\u001c-\u001f]*$/u.test(text);
}

function openCodeReplyTooLong(text) {
  // Atlas validates the reply length in Unicode code points.
  const limit = 100_000;
  if (text.length <= limit) return false;
  let length = 0;
  for (let offset = 0; offset < text.length;) {
    offset += text.codePointAt(offset) > 0xFFFF ? 2 : 1;
    if (++length > limit) return true;
  }
  return false;
}

function sameOpenCodeReply(item, text, images) {
  return item?.text === text && JSON.stringify(item.images || []) === JSON.stringify(images);
}

function pendingOpenCodeReply(sid) {
  const saved = loadStored(openCodeReplyKey(sid), null);
  // Older pages could persist text rejected by Atlas before admission.
  if (!saved || !/^msg_[A-Za-z0-9]{26}$/.test(saved.id) || typeof saved.text !== "string"
      || openCodeReplyTooLong(saved.text)) return null;
  if (saved.images !== undefined && (!Array.isArray(saved.images) || saved.images.length > MAX_ATTACH
      || saved.images.some(image => typeof image?.path !== "string" || typeof image.name !== "string"))) return null;
  return !openCodeReplyBlank(saved.text) || saved.images?.length ? saved : null;
}

function openCodeComposerText(sid) {
  const saved = pendingOpenCodeReply(sid);
  const text = drafts.get(sid) || saved?.text || "";
  if (saved?.text === text) {
    if (saved.images?.length && !attachments.has(sid)) attachments.set(sid, saved.images.map(image => ({ ...image })));
    openCodeRestoredReplies.set(sid, saved);
  }
  return text;
}

window.addEventListener("storage", event => {
  if (event.storageArea !== window.localStorage || event.newValue !== null
      || !event.key?.startsWith(openCodeReplyPrefix)) return;
  const sid = event.key.slice(openCodeReplyPrefix.length);
  const restored = openCodeRestoredReplies.get(sid);
  if (!restored) return;
  // A delayed removal event must not clear a composer restored from a different reply.
  let removed;
  try { removed = JSON.parse(event.oldValue); } catch { return; }
  if (removed?.id !== restored.id) return;
  forgetRestoredReply(sid, restored);
  if (pendingOpenCodeReply(sid)) return;
  clearOpenCodeReplyDraft(sid, restored);
  setSendNote(sid, "", "");
  sendState.delete(sid);
});

function forgetRestoredReply(sid, item) {
  if (openCodeRestoredReplies.get(sid)?.id === item.id) openCodeRestoredReplies.delete(sid);
}

function forgetOpenCodeReply(sid, item) {
  if (pendingOpenCodeReply(sid)?.id !== item.id) return false;
  window.localStorage.removeItem(openCodeReplyKey(sid));
  return true;
}

function clearOpenCodeReplyDraft(sid, item) {
  if (drafts.get(sid) === item.text) {
    drafts.delete(sid);
    saveDrafts();
  }
  const area = document.querySelector(`.answer textarea[data-id="${CSS.escape(sid)}"]`);
  if (area?.value === item.text) { area.value = ""; autosize(area); }
  if (item.images?.length) {
    const sent = new Set(item.images.map(image => image.path));
    const remaining = (attachments.get(sid) || []).filter(image => !sent.has(image.path));
    attachments.set(sid, remaining);
    renderThumbs(sid);
  }
}

function finishOpenCodeReply(sid, item) {
  const saved = pendingOpenCodeReply(sid);
  if (saved ? !forgetOpenCodeReply(sid, item) : openCodeRestoredReplies.get(sid)?.id !== item.id) return;
  clearOpenCodeReplyDraft(sid, item);
  openCodeRestoredReplies.delete(sid);
  if (!openCodeReplyBlank(item.text)) rememberSent(item.text);
  setSendNote(sid, "", "");
  sendState.delete(sid);
}

function discardOpenCodeReply(sid) {
  const item = pendingOpenCodeReply(sid);
  if (!item || openCodeReplying.has(sid)) return;
  const label = i18n("opencode.discardReply");
  modal(label, i18n("opencode.discardReplyWarning"), "", label, async () => {
    await withOpenCodeReplyLock(sid, () => {
      if (!openCodeReplying.has(sid) && forgetOpenCodeReply(sid, item)) {
        forgetRestoredReply(sid, item);
        clearOpenCodeReplyDraft(sid, item);
        setSendNote(sid, "", "");
        sendState.delete(sid);
      }
    });
    closeAfterHandOff();
  });
}

async function sendOpenCodeReply(s, text, files = []) {
  const sid = s.session_id;
  const images = files.map(({ path, name }) => ({ path, name }));
  if (openCodeReplying.has(sid) || openCodeReplyChecks.has(sid) || (openCodeReplyBlank(text) && !images.length)) return;
  if (openCodeReplyTooLong(text)) {
    setSendNote(sid, i18n("opencode.replyTooLong"), "bad");
    return;
  }
  openCodeReplying.add(sid);
  setSendNote(sid, i18n("active.sending"), "");
  try {
    // Pages share one pending ID. Hold the lock through dispatch so another page
    // cannot overwrite it, or start a concurrent retry of the same message.
    await withOpenCodeReplyLock(sid, () => submitOpenCodeReply(s, text, images));
  } catch (error) {
    setSendNote(sid, i18n("active.notSent", { reason: error.message }), "bad");
  } finally {
    openCodeReplying.delete(sid);
    void loadActive();
  }
}

async function submitOpenCodeReply(s, text, images) {
  const sid = s.session_id;
  let item;
  let retry;
  try {
    const saved = pendingOpenCodeReply(sid);
    const restored = openCodeRestoredReplies.get(sid);
    retry = sameOpenCodeReply(restored, text, images) ? restored : null;
    if (sameOpenCodeReply(saved, text, images) && (!retry || retry.id === saved.id)) retry = saved;
    if (saved && saved.id !== retry?.id) {
      const checked = await openCodeRequest(s, "reply-check", { message_id: saved.id }).catch(() => null);
      if (checked?.delivery) finishOpenCodeReply(sid, saved);
      if (!checked?.delivery || pendingOpenCodeReply(sid)) {
        setSendNote(sid, i18n("opencode.retryOriginal"), "bad");
        return;
      }
    }
    item = retry || { id: "msg_" + crypto.randomUUID().replaceAll("-", "").slice(0, 26), text,
      ...(images.length && { images }) };
    if (retry && retry.generation !== s.opencode_generation) {
      const checked = await openCodeRequest(s, "reply-check", { message_id: item.id });
      if (checked.delivery) {
        finishOpenCodeReply(sid, item);
        return;
      }
      const current = pendingOpenCodeReply(sid);
      if (current && current.id !== item.id) {
        setSendNote(sid, i18n("opencode.retryOriginal"), "bad");
        return;
      }
    }
    // A reload can lose the outcome of any request in flight. Legacy saved IDs carry the same risk.
    window.localStorage.setItem(openCodeReplyKey(sid), JSON.stringify({
      ...item, generation: s.opencode_generation, ambiguous: true,
    }));
    const result = await openCodeRequest(s, "reply", { message_id: item.id, text: item.text,
      ...(item.images?.length && { images: item.images }), ambiguous: !!retry });
    if (result.delivery) finishOpenCodeReply(sid, item);
    else setSendNote(sid, i18n("opencode.retryReply"), "bad");
  } catch (error) {
    if (item && !retry && error.status >= 400 && error.status < 500 &&
        forgetOpenCodeReply(sid, item)) {
      forgetRestoredReply(sid, item);
      if (!drafts.has(sid)) {
        drafts.set(sid, item.text);
        saveDrafts();
      }
    }
    setSendNote(sid, pendingOpenCodeReply(sid) ? i18n("opencode.retryReply")
      : i18n("active.notSent", { reason: error.message }), "bad");
  }
}

function reconcileOpenCode(sessions, known) {
  if (known) pruneOpenCodeStops(sessions.filter(s => s.opencode_running).map(s => s.session_id));
  if (known) {
    const observed = new Map(sessions.filter(s => s.opencode_pending_known === true)
      .map(s => [s.session_id, s.opencode_dialog]));
    for (const [id, form] of openCodeForms) {
      const dialog = observed.get(form.sid);
      // A permission can take precedence over a form on the same card.
      if (observed.has(form.sid) && dialog?.kind !== "permission" && dialog?.id !== id) openCodeForms.delete(id);
    }
  }
  for (const s of sessions) {
    const sid = s.session_id;
    if (!known || openCodeReplying.has(sid) || openCodeReplyChecks.has(sid)) continue;
    const item = pendingOpenCodeReply(sid);
    if (!item) continue;
    openCodeReplyChecks.add(sid);
    const delivered = s.queued?.some(entry => entry.id === item.id)
      ? Promise.resolve(true)
      : openCodeRequest(s, "reply-check", { message_id: item.id }).then(result => result.delivery);
    void delivered.then(knownDelivery => {
      if (knownDelivery) return withOpenCodeReplyLock(sid, () => finishOpenCodeReply(sid, item));
    }).catch(() => {}).finally(() => openCodeReplyChecks.delete(sid));
  }
}
