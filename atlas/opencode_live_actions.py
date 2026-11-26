"""Native Active card actions against the current session of a verified Atlas tab."""
from __future__ import annotations

import re
import sqlite3
from contextlib import suppress
from urllib.parse import urlencode

from . import agent_opencode as source, agents, opencode_service as service, opencode_tabs, uploads
from .messages import msg

REQUEST_ID = re.compile(r"(?:per|frm|msg)_[A-Za-z0-9]{26}")
OPERATIONS = ("permission", "form", "dismiss", "stop", "reply", "reply-check", "pickers", "command", "model")
PICKER_ID = re.compile(r"[A-Za-z0-9_.:@/+-]{1,180}")


def _client():
    return service.verified_client(source.data_home() / source.DATABASE)


class StaleGeneration(service.ServiceError):
    def __init__(self):
        super().__init__("live_stale", 409)
        self.args = (msg("opencode.live_generation_changed"),)


def _require_generation(client, body):
    if body.get("generation") != client.generation:
        raise StaleGeneration()
    if client.version != service.TESTED_VERSION:
        raise service.ServiceError("version_warning")


def _text(value):
    return value if isinstance(value, str) else ""


def _id(value, prefix):
    return isinstance(value, str) and value.startswith(prefix + "_") and REQUEST_ID.fullmatch(value)


def _require_tab(sid):
    if sid not in opencode_tabs.active_tabs():
        raise service.ServiceError("live_needs_tab")


def _fields(item):
    fields = item.get("fields")
    if not isinstance(fields, list):
        return None
    projected = []
    keys = set()
    for field in fields:
        if not isinstance(field, dict) or field.get("type") not in ("string", "multiselect"):
            return None
        key, options = field.get("key"), field.get("options", [])
        if not isinstance(key, str) or not key or key in keys or not isinstance(options, list):
            return None
        keys.add(key)
        options = [{"value": o["value"], "label": _text(o.get("label")) or o["value"],
                    "description": _text(o.get("description"))}
                   for o in options if isinstance(o, dict) and isinstance(o.get("value"), str)]
        projected.append({"key": key, "type": field["type"], "title": _text(field.get("title")) or key,
                          "description": _text(field.get("description")), "options": options,
                          "custom": field.get("custom") is True, "required": field.get("required") is True,
                          "minItems": field["minItems"] if type(field.get("minItems")) is int else None,
                          "maxItems": field["maxItems"] if type(field.get("maxItems")) is int else None})
    return projected


def project_pending(sid, kind, item):
    if not isinstance(item, dict) or item.get("sessionID") != sid or not _id(
            item.get("id"), "per" if kind == "permission" else "frm"):
        return None
    if kind == "permission":
        resources = item.get("resources")
        return {"id": item["id"], "kind": kind, "action": _text(item.get("action")),
                "resources": [s for s in resources if isinstance(s, str)] if isinstance(resources, list) else []}
    return {"id": item["id"], "kind": kind, "title": _text(item.get("title")), "fields": _fields(item)}


def valid_answer(fields, answer):
    if fields is None or not isinstance(answer, dict) or answer.keys() - {f["key"] for f in fields}:
        return False
    for field in fields:
        key = field["key"]
        if key not in answer:
            if field["required"]:
                return False
            continue
        chosen = answer[key]
        options = {option["value"] for option in field["options"]}
        if field["type"] == "string":
            if not isinstance(chosen, str) or (field["required"] and not chosen.strip()):
                return False
            if options and not field["custom"] and chosen not in options:
                return False
        else:
            if not isinstance(chosen, list) or any(not isinstance(value, str) or not value.strip()
                                                   for value in chosen):
                return False
            if ((field["required"] and not chosen)
                    or (field["minItems"] is not None and len(chosen) < field["minItems"])
                    or (field["maxItems"] is not None and len(chosen) > field["maxItems"])
                    or (not field["custom"] and set(chosen) - options)):
                return False
    return True


def _decision(client, sid, operation, body):
    kind = "permission" if operation == "permission" else "form"
    item_id = body.get("item_id")
    if not _id(item_id, "per" if kind == "permission" else "frm"):
        raise service.ServiceError("request_failed", 400)
    route = f"session/{sid}/{kind}/{item_id}"
    try:
        item = client.data(route)
        projected = project_pending(sid, kind, item)
        state = item.get("state") if projected else None
        form_settled = kind == "form" and (not isinstance(state, dict) or state.get("status") != "pending")
        if not projected or item.get("id") != item_id or form_settled:
            raise service.ServiceError("live_stale", 409)
        if operation == "dismiss":
            client.call("DELETE", route + "?" + urlencode({"message": msg("opencode.live_dismissed")}),
                        before_send=lambda: _require_tab(sid))
        elif kind == "permission":
            decision = body.get("decision")
            if decision not in ("once", "reject"):
                raise service.ServiceError("request_failed", 400)
            client.call("POST", route + "/reply", {"decision": decision}, before_send=lambda: _require_tab(sid))
        else:
            answer = body.get("answer")
            if not valid_answer(projected["fields"], answer):
                raise service.ServiceError("invalid_answer", 400)
            client.call("POST", route + "/reply", {"answer": answer}, before_send=lambda: _require_tab(sid))
    except service.ServiceError as exc:
        if exc.status in (404, 409):
            raise service.ServiceError("live_stale", 409) from None
        if operation == "form" and exc.status == 400:
            raise service.ServiceError("invalid_answer", 400) from None
        raise
    return {"ok": True}


def _delivered(client, sid, message_id):
    inbox = []
    inbox_error = None
    try:
        inbox = client.data(f"session/{sid}/inbox", expect=list)
    except service.ServiceError as exc:
        inbox_error = exc
    if any(isinstance(item, dict) and item.get("id") == message_id for item in inbox):
        return "queued"
    try:
        with source.open_readonly(source.data_home() / source.DATABASE, timeout=0.5) as db:
            delivered = db.execute("SELECT 1 FROM session_message WHERE id=? AND session_id=? AND type='user'",
                                   (message_id, sid)).fetchone()
        client.check_current()
    except (OSError, sqlite3.Error):
        raise service.ServiceError("request_failed") from None
    if delivered:
        return "delivered"
    if inbox_error:
        raise inbox_error
    return None


def _not_admitted(exc, sid):
    body = exc.error_body
    if not isinstance(body, dict) or not isinstance(body.get("message"), str):
        return False
    tag = body.get("_tag")
    return ((exc.status == 400 and tag == "InvalidRequestError" and body.get("kind") in ("Params", "Payload"))
            or (exc.status == 404 and tag == "SessionNotFoundError" and body.get("sessionID") == sid))


def _reply(sid, operation, body, *, client=None, before_send=None):
    message_id, text = body.get("message_id"), body.get("text")
    images = body.get("images", [])
    if not _id(message_id, "msg") or (operation == "reply" and (
            not isinstance(text, str) or (not text.strip() and not images) or len(text) > 100_000)):
        raise service.ServiceError("request_failed", 400)
    client = _client() if client is None else client
    if operation == "reply":
        _require_generation(client, body)
    try:
        known = _delivered(client, sid, message_id)
    except service.ServiceError:
        if operation == "reply":
            _require_tab(sid)
        raise
    if known or operation == "reply-check":
        return {"delivery": known}
    _require_tab(sid)

    def check_target():
        if before_send is not None:
            before_send()
        _require_tab(sid)
        client.check_verified_database()

    try:
        files = uploads.reply_files(images)
    except uploads.UploadError as exc:
        raise service.ServiceError("live_image_invalid", 400, reason=str(exc)) from None
    prompt = {"id": message_id, "text": text, "delivery": "queue"}
    if files:
        prompt["files"] = files
    try:
        result = client.call("POST", f"session/{sid}/prompt", prompt, before_send=check_target)
    except service.ServiceError as exc:
        if not exc.dispatched or _not_admitted(exc, sid):
            raise
    else:
        with suppress(service.ServiceError):
            admission = service._response_data(result, dict)
            if not body.get("ambiguous") and admission.get("id") == message_id and admission.get("sessionID") == sid:
                return {"delivery": "queued"}
    # After dispatch a lost admission response can hide a successful queue write.
    with suppress(service.ServiceError):
        return {"delivery": _delivered(_client(), sid, message_id)}
    return {"delivery": None}



def _picker_rows(client, kind, directory):
    query = urlencode({"location[directory]": directory})
    options = []
    for row in client.data(kind + "?" + query, expect=list):
        if not isinstance(row, dict):
            continue
        value = _text(row.get("name" if kind == "command" else "id"))
        if not PICKER_ID.fullmatch(value):
            continue
        name = " ".join(_text(row.get("name")).split())[:180] or value
        entry = {"id": value, "name": name}
        if kind == "model":
            provider = _text(row.get("providerID"))
            if not PICKER_ID.fullmatch(provider):
                continue
            entry["provider"] = provider
        else:
            entry["description"] = " ".join(_text(row.get("description")).split())[:240]
        options.append(entry)
    return options


def _picker_operation(client, sid, operation, body):
    directory = source.session_directory(sid)
    if not directory:
        raise service.ServiceError("session_missing")

    def check_location():
        _require_tab(sid)
        if source.session_directory(sid) != directory:
            raise service.ServiceError("live_stale", 409)
        client.check_verified_database()

    if operation == "pickers":
        rows = {kind + "s": _picker_rows(client, kind, directory) for kind in ("command", "skill", "model")}
        check_location()
        return rows

    options = _picker_rows(client, operation, directory)
    value = body.get("id")
    if operation == "command":
        text = body.get("text")
        found = any(item["id"] == value for item in options)
        if not found or not isinstance(text, str) or len(text) > 100_000:
            raise service.ServiceError("live_picker_unknown", 400)
        payload = {"name": value, "text": text}
    else:
        provider = body.get("provider")
        if not any(item["id"] == value and item["provider"] == provider for item in options):
            raise service.ServiceError("live_picker_unknown", 400)
        payload = {"model": {"id": value, "providerID": provider}}

    def check_idle():
        if sid in client.data("session/active"):
            raise service.ServiceError("live_picker_busy", 409)
        check_location()

    try:
        client.call("POST", f"session/{sid}/{operation}", payload, before_send=check_idle)
    except service.ServiceError as exc:
        if exc.dispatched and exc.status not in (400, 404):
            # Native command admission does not accept a caller-provided message ID.
            raise service.ServiceError("live_picker_uncertain", 409) from None
        raise
    return {"ok": True}


def run(operation, body):
    sid = body.get("session_id")
    if operation not in OPERATIONS or not agents.valid_id(agents.OPENCODE, sid):
        raise service.ServiceError("session_missing", 400)
    if operation in ("reply", "reply-check"):
        return _reply(sid, operation, body)
    _require_tab(sid)
    client = _client()
    _require_generation(client, body)
    if operation in ("pickers", "command", "model"):
        return _picker_operation(client, sid, operation, body)
    if operation == "stop":
        result = client.call("POST", f"session/{sid}/interrupt", before_send=lambda: _require_tab(sid))
        if not isinstance(result, dict) or type(result.get("interrupted")) is not bool:
            raise service.ServiceError("request_failed")
        return {"ok": True}
    return _decision(client, sid, operation, body)
