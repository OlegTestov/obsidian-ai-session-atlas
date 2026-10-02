"""Очередь сообщений, набранных во время работы Claude: по записям queue-operation."""
from __future__ import annotations

import json

from atlas import prompt_queue


def op(operation, content=None, ts="2026-09-27T10:00:00.000Z", **kw):
    rec = {"type": "queue-operation", "operation": operation, "timestamp": ts, "sessionId": "s"}
    if content is not None:
        rec["content"] = content
    rec.update(kw)
    return json.dumps(rec, ensure_ascii=False) + "\n"


def test_enqueued_message_waits_until_dequeued(tmp_path):
    path = tmp_path / "s.jsonl"
    path.write_text(op("enqueue", "после этого скажи HELLO", ts="2026-09-27T10:00:01.000Z"),
                    encoding="utf-8")
    assert prompt_queue.queued_messages(str(path)) == [
        {"text": "после этого скажи HELLO", "at": "2026-09-27T10:00:01.000Z"}]
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(op("dequeue"))
    assert prompt_queue.queued_messages(str(path)) == []


def test_fifo_and_system_notifications_are_hidden():
    records = [json.loads(line) for line in (
        op("enqueue", "<task-notification>\\n<task-id>b1</task-id>")
        + op("enqueue", '<agent-message from="a1">hand-back')
        + op("enqueue", "первое моё") + op("enqueue", "второе моё")
        + op("dequeue")).splitlines()]
    # Первым в очереди было уведомление — dequeue снял его, а не последнее моё сообщение.
    assert [q["text"] for q in prompt_queue.replay(records)] == ["первое моё", "второе моё"]
    records.append(json.loads(op("dequeue")))
    assert [q["text"] for q in prompt_queue.replay(records)] == ["первое моё", "второе моё"]
    records.append(json.loads(op("dequeue")))
    assert [q["text"] for q in prompt_queue.replay(records)] == ["второе моё"]


def test_remove_takes_the_matching_item_and_pop_all_clears():
    records = [json.loads(line) for line in (
        op("enqueue", "раз") + op("enqueue", "два") + op("remove", "два", reason="x")).splitlines()]
    assert [q["text"] for q in prompt_queue.replay(records)] == ["раз"]
    records += [json.loads(op("enqueue", "три")), json.loads(op("popAll", "раз\nтри"))]
    assert prompt_queue.replay(records) == []


def test_dequeue_on_empty_queue_is_harmless():
    records = [json.loads(op("dequeue")), json.loads(op("enqueue", "моё"))]
    assert [q["text"] for q in prompt_queue.replay(records)] == ["моё"]


def test_missing_file_and_no_marks(tmp_path):
    assert prompt_queue.queued_messages(str(tmp_path / "нет.jsonl")) == []
    path = tmp_path / "s.jsonl"
    path.write_text('{"type":"user"}\n', encoding="utf-8")
    assert prompt_queue.queued_messages(str(path)) == []
