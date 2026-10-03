"""Session feed: turns split by your messages, tools as short lines."""
from __future__ import annotations

import json

from atlas import feed, messages
from tests.conftest import assistant_text, rec, user_text


def tool(name, args, ts="2026-09-27T10:01:00.000Z"):
    return rec(type="assistant", timestamp=ts,
               message={"role": "assistant", "content": [
                   {"type": "tool_use", "id": "t", "name": name, "input": args}]})


def records(text):
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def test_turns_split_on_your_prompts_and_collect_tools_and_reply():
    text = (assistant_text("хвост прошлого хода", ts="2026-09-27T09:59:00.000Z")
            + user_text("почини тесты", ts="2026-09-27T10:00:00.000Z")
            + tool("Read", {"file_path": "/x/a.py"}) + tool("Read", {"file_path": "/x/b.py"})
            + tool("Edit", {"file_path": "/x/a.py"}) + tool("Edit", {"file_path": "/x/a.py"})
            + assistant_text("смотрю, что падает", ts="2026-09-27T10:02:00.000Z")
            + tool("Bash", {"command": "pytest -q", "description": "Run tests"})
            + assistant_text("готово", ts="2026-09-27T10:05:00.000Z")
            + user_text("теперь закоммить", ts="2026-09-27T10:10:00.000Z")
            + tool("mcp__gitlab__create_merge_request", {}))
    with messages.use_lang("ru"):
        turns = feed.build(records(text))
    assert [t["prompt"] for t in turns] == ["почини тесты", "теперь закоммить"]
    steps = {s["kind"]: s for s in turns[0]["steps"]}
    assert steps["read"]["text"] == "прочитал 2 файла"
    assert steps["edit"]["text"] == "правил 1 файл" and steps["edit"]["detail"] == ["a.py"]
    assert steps["bash"]["text"] == "1 команда" and steps["bash"]["detail"] == ["Run tests"]
    assert [s["kind"] for s in turns[0]["steps"]] == ["read", "edit", "bash"]
    assert turns[0]["reply"] == "готово" and turns[0]["reply_at"] == "2026-09-27T10:05:00.000Z"
    assert turns[1]["reply"] is None
    assert turns[1]["steps"] == [{"kind": "mcp", "text": "gitlab: 1",
                                  "detail": ["create_merge_request"]}]
    en = {s["kind"]: s["text"] for s in feed.build(records(text))[0]["steps"]}   # without the header
    assert en == {"read": "read 2 files", "edit": "edited 1 file", "bash": "1 command"}


def test_notifications_and_interrupts_are_not_turns():
    text = (user_text("сделай отчёт", ts="2026-09-27T10:00:00.000Z")
            + user_text("<task-notification> done </task-notification>", ts="2026-09-27T10:01:00.000Z")
            + user_text("[Request interrupted by user]", ts="2026-09-27T10:02:00.000Z"))
    turns = feed.build(records(text))
    assert len(turns) == 1 and turns[0]["interrupted"] is True


def test_long_reply_keeps_the_end():
    body = "\n".join(f"строка {i}" for i in range(2000))
    turns = feed.build(records(user_text("длинно") + assistant_text(body)))
    assert turns[0]["reply_len"] == len(body)
    assert turns[0]["reply"].endswith("строка 1999") and len(turns[0]["reply"]) <= feed.REPLY_CHARS


def test_plurals():
    assert [feed.plural(n, "файл", "файла", "файлов") for n in (1, 2, 5, 11, 21, 22, 112)] == \
        ["файл", "файла", "файлов", "файлов", "файл", "файла", "файлов"]


def test_feed_reads_only_as_much_tail_as_needed(tmp_path, monkeypatch):
    path = tmp_path / "s.jsonl"
    filler = assistant_text("x" * 2000)
    parts = []
    for i in range(30):
        parts.append(user_text(f"запрос {i}", ts=f"2026-09-27T10:{i:02d}:00.000Z"))
        parts.extend([filler] * 20)
    path.write_text("".join(parts), encoding="utf-8")
    monkeypatch.setattr(feed, "FIRST_WINDOW", 8 * 1024)
    got = feed.feed(str(path), 5)
    assert [t["prompt"] for t in got] == [f"запрос {i}" for i in range(25, 30)]
    assert feed.feed(str(path), 100)[0]["prompt"] == "запрос 10"     # no more than MAX_TURNS
    assert feed.feed(str(tmp_path / "нет.jsonl")) == []


def _session_file(tmp_path, n, pad=0):
    """n turns: prompt and reply, a minute apart; pad is long text so the file overflows the first window."""
    text = ""
    for i in range(n):
        ts = f"2026-09-27T{10 + i // 60:02d}:{i % 60:02d}:00.000Z"
        text += user_text(f"запрос {i}" + " x" * pad, ts=ts)
        text += assistant_text(f"ответ {i}", ts=ts.replace(":00.000Z", ":30.000Z"))
    path = tmp_path / "s.jsonl"
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_feed_pages_from_the_end_back_to_the_start(tmp_path):
    path = _session_file(tmp_path, 45)
    last = feed.feed_page(path, 20)
    assert last["turns"][0]["prompt"] == "запрос 25" and last["has_more"] is True
    page = feed.feed_page(path, 20, before=last["turns"][0]["prompt_at"])
    assert page["turns"][0]["prompt"] == "запрос 5" and page["turns"][-1]["prompt"] == "запрос 24"
    first = feed.feed_page(path, 20, before=page["turns"][0]["prompt_at"])
    assert [t["prompt"] for t in first["turns"]] == [f"запрос {i}" for i in range(5)]
    assert first["has_more"] is False


def test_feed_since_returns_everything_from_the_anchor(tmp_path):
    path = _session_file(tmp_path, 30)
    anchor = feed.feed_page(path, 20)["turns"][0]["prompt_at"]      # "запрос 10"
    live = feed.feed_page(path, 20, since=anchor)["turns"]
    assert live[0]["prompt"] == "запрос 10" and live[-1]["prompt"] == "запрос 29" and len(live) == 20


def test_feed_pages_reach_the_start_of_a_file_bigger_than_the_window(tmp_path, monkeypatch):
    monkeypatch.setattr(feed, "FIRST_WINDOW", 4096)
    monkeypatch.setattr(feed, "MAX_WINDOW", 8192)        # the first chunk hits the window limit
    path = _session_file(tmp_path, 60, pad=60)
    last = feed.feed_page(path, 20)
    assert last["has_more"] is True
    seen = [t["prompt"].split()[1] for t in last["turns"]]
    before = last["turns"][0]["prompt_at"]
    while True:
        page = feed.feed_page(path, 20, before=before)
        if not page["turns"]:
            break
        seen = [t["prompt"].split()[1] for t in page["turns"]] + seen
        before = page["turns"][0]["prompt_at"]
        if not page["has_more"]:
            break
    assert seen == [str(i) for i in range(60)]          # each turn exactly once, back to the start


def test_card_history_is_the_conversation_tail_and_cached(tmp_path, monkeypatch):
    path = _session_file(tmp_path, 8)
    tail = feed.messages_tail(path, 5)
    assert [(m["role"], m["text"]) for m in tail] == [
        ("claude", "ответ 5"), ("you", "запрос 6"), ("claude", "ответ 6"), ("you", "запрос 7"),
        ("claude", "ответ 7")]
    calls = []
    real = feed.feed
    monkeypatch.setattr(feed, "feed", lambda *a, **k: calls.append(1) or real(*a, **k))
    assert feed.messages_tail(path, 5) == tail and calls == []      # file unchanged — served from cache
