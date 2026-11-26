"""Session feed: turns split by your messages, tools as short lines."""
from __future__ import annotations

import json
import re

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


def test_image_only_prompt_starts_a_conversation_turn():
    image = rec(type="user", timestamp="2026-09-27T10:01:00.000Z",
                message={"role": "user", "content": [{"type": "image"}]})
    [turn] = feed.build(records(image + assistant_text("вижу изображение")))
    assert (turn["prompt"], turn["images"], turn["reply"]) == ("", 1, "вижу изображение")


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
    got = feed.feed_page(str(path), 5)["turns"]
    assert [t["prompt"] for t in got] == [f"запрос {i}" for i in range(25, 30)]
    assert feed.feed_page(str(path), 100)["turns"][0]["prompt"] == "запрос 10"     # no more than MAX_TURNS
    assert feed.feed_page(str(tmp_path / "нет.jsonl")) == {"turns": [], "has_more": False}


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


def _timeless_file(tmp_path, n):
    """n turns; turn 2 and the last one have an empty timestamp (the user records carry a uuid)."""
    text = ""
    for i in range(n):
        ts = "" if i in (2, n - 1) else f"2026-09-27T10:{i:02d}:00.000Z"
        text += user_text(f"запрос {i}", ts=ts, uuid=f"u-{i}")
        text += assistant_text(f"ответ {i}", ts=f"2026-09-27T10:{i:02d}:30.000Z")
    path = tmp_path / "s.jsonl"
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_turns_have_a_stable_id(tmp_path):
    path = _timeless_file(tmp_path, 5)
    assert [t["id"] for t in feed.feed_page(path, 20)["turns"]] == [f"u-{i}" for i in range(5)]


def test_feed_since_id_starts_at_that_turn_inclusive_and_keeps_turns_without_time(tmp_path):
    path = _timeless_file(tmp_path, 30)
    got = feed.feed_page(path, 20, since_id="u-27")
    assert [t["prompt"] for t in got["turns"]] == ["запрос 27", "запрос 28", "запрос 29"]   # 29 has no prompt_at
    assert "reset" not in got
    only_last = feed.feed_page(path, 20, since_id="u-29")["turns"]
    assert [t["prompt"] for t in only_last] == ["запрос 29"]


def test_feed_since_id_that_is_gone_resets_to_the_last_page(tmp_path):
    path = _timeless_file(tmp_path, 30)
    got = feed.feed_page(path, 5, since_id="u-missing")
    assert got["reset"] is True and [t["id"] for t in got["turns"]] == [f"u-{i}" for i in range(25, 30)]


def test_feed_since_time_keeps_a_later_turn_without_time(tmp_path):
    path = _timeless_file(tmp_path, 30)
    got = feed.feed_page(path, 20, since="2026-09-27T10:27:00.000Z")["turns"]
    assert [t["prompt"] for t in got] == ["запрос 27", "запрос 28", "запрос 29"]


def test_feed_before_id_pages_back_through_turns_without_time(tmp_path, monkeypatch):
    monkeypatch.setattr(feed, "FIRST_WINDOW", 2048)
    path = _timeless_file(tmp_path, 30)
    page = feed.feed_page(path, 2, before_id="u-3")
    assert [t["id"] for t in page["turns"]] == ["u-1", "u-2"] and page["has_more"] is True
    page = feed.feed_page(path, 2, before_id="u-1")
    assert [t["id"] for t in page["turns"]] == ["u-0"] and page["has_more"] is False
    assert feed.feed_page(path, 2, before_id="u-nope") == {"turns": [], "has_more": False}


def test_live_merge_has_no_duplicate_or_gap_at_the_boundary(tmp_path):
    """The client keeps older pages + a live tail; a refresh replaces the last turn and appends newer ones."""
    path = _timeless_file(tmp_path, 30)
    last = feed.feed_page(path, 20)["turns"]
    live = last[:]
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(user_text("запрос 30", ts="2026-09-27T10:30:00.000Z", uuid="u-30"))
        fh.write(assistant_text("ответ 30", ts="2026-09-27T10:30:30.000Z"))
    fresh = feed.feed_page(path, 20, since_id=live[-1]["id"])["turns"]
    live = live[:-1] + fresh
    assert [t["id"] for t in live] == [f"u-{i}" for i in range(10, 31)]


def _same_time_file(tmp_path):
    """Three prompts at the same millisecond without a uuid (Codex records carry none)."""
    text = ""
    for i in range(3):
        text += user_text(f"запрос {i}", ts="2026-09-27T10:00:00.000Z")
        text += assistant_text(f"ответ {i}", ts=f"2026-09-27T10:00:0{i + 1}.000Z")
    path = tmp_path / "s.jsonl"
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_turns_with_the_same_time_get_distinct_ids(tmp_path):
    path = _same_time_file(tmp_path)
    ids = [t["id"] for t in feed.feed_page(path, 20)["turns"]]
    assert len(set(ids)) == 3
    assert all(re.fullmatch(r"2026-09-27T10:00:00\.000Z:[0-9a-f]{8}", i) for i in ids)


def test_only_an_identical_time_and_text_gets_a_repeat_suffix():
    text = (user_text("same", ts="2026-09-27T10:00:00.000Z") + user_text("same", ts="2026-09-27T10:00:00.000Z")
            + user_text("other", ts="2026-09-27T10:00:00.000Z"))
    ids = [t["id"] for t in feed.build(records(text))]
    assert ids[1] == ids[0] + "#2" and "#" not in ids[0] and "#" not in ids[2]


def test_a_record_uuid_is_the_id():
    turns = feed.build(records(user_text("x", ts="2026-09-27T10:00:00.000Z", uuid="u-1")))
    assert turns[0]["id"] == "u-1"


def test_since_id_and_before_id_find_the_repeated_turn_they_name(tmp_path):
    path = _same_time_file(tmp_path)
    second = feed.feed_page(path, 20)["turns"][1]["id"]
    assert [t["prompt"] for t in feed.feed_page(path, 20, since_id=second)["turns"]] == ["запрос 1", "запрос 2"]
    assert [t["prompt"] for t in feed.feed_page(path, 20, before_id=second)["turns"]] == ["запрос 0"]


def test_ids_do_not_depend_on_the_read_window(tmp_path):
    """A window that drops the first of two turns with the same time still resolves the second one's id."""
    ts = "2026-09-27T10:00:00.000Z"
    text = (user_text("first", ts=ts) + assistant_text("x" * (feed.FIRST_WINDOW + 1000), ts=ts)
            + user_text("second", ts=ts) + assistant_text("done", ts="2026-09-27T10:00:05.000Z"))
    path = tmp_path / "s.jsonl"
    path.write_text(text, encoding="utf-8")
    whole = feed.build(records(text))
    assert len(whole) == 2
    windowed = feed.build(feed._window(str(path), len(text.encode()), feed.FIRST_WINDOW))   # drops the first turn
    assert [t["prompt"] for t in windowed] == ["second"]
    assert windowed[0]["id"] == whole[1]["id"]
    got = feed.feed_page(str(path), 20, since_id=windowed[0]["id"])
    assert "reset" not in got and [t["prompt"] for t in got["turns"]] == ["second"]


def test_the_server_accepts_the_turn_id_forms():
    from atlas import server
    assert server.TURN_ID.fullmatch("2026-09-27T10:00:00.000Z:0a1b2c3d")
    assert server.TURN_ID.fullmatch("2026-09-27T10:00:00.000Z:0a1b2c3d#12")
    assert server.TURN_ID.fullmatch("5f0c9c2e-1111-2222-3333-444455556666")
    assert not server.TURN_ID.fullmatch("a" * 81) and not server.TURN_ID.fullmatch("a b")
