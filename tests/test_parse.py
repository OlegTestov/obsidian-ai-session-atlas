"""Что попадает в индекс и что не попадает никогда."""
from __future__ import annotations

from atlas import config
from atlas.parse import COMPACT_PREFIX, parse_file
from tests.conftest import (assistant_text, assistant_tool, image_block, rec,
                            tool_result, user_text)


def test_tool_result_and_image_never_reach_the_index(write_session):
    path = write_session("p", [
        user_text("почини деплой"),
        assistant_tool("Bash", {"command": "npm run deploy"}),
        tool_result("SEKRETTOOLOUTPUT" * 10),
        image_block(),
    ])
    f = parse_file(path, "s1")
    blob = "\n".join(f.user_text + f.assistant_text + f.commands + f.paths + f.summaries)
    assert "SEKRETTOOLOUTPUT" not in blob
    assert "SEKRETBASE64PAYLOAD" not in blob
    assert f.commands == ["npm run deploy"]


def test_non_text_block_is_rejected_by_type_even_if_it_carries_a_text_field(write_session):
    """Защита — проверка типа блока, а не то, что у tool_result просто нет поля text."""
    path = write_session("p", [
        rec(type="user", timestamp="2026-09-01T10:00:00.000Z", cwd="/Users/u/Code/demo",
            entrypoint="cli",
            message={"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "text": "SEKRETLEAK"}]}),
    ])
    f = parse_file(path, "s1b")
    assert "SEKRETLEAK" not in "\n".join(f.user_text + f.summaries)
    assert f.human_turns == 0


def test_compaction_summary_is_not_a_human_prompt(write_session):
    path = write_session("p", [
        rec(type="user", timestamp="2026-09-01T10:00:00.000Z", cwd="/Users/u/Code/demo",
            entrypoint="cli",
            message={"role": "user", "content": COMPACT_PREFIX + " … Summary: делали X"}),
        user_text("продолжай"),
    ])
    f = parse_file(path, "s2")
    assert f.human_turns == 1                     # сводка не считается ходом человека
    assert f.user_text == ["продолжай"]
    assert f.summaries and "делали X" in f.summaries[0]


def test_sidechain_text_kept_separately(write_session):
    path = write_session("p", [
        user_text("задача"),
        assistant_text("ответ агента-сабагента", ts="2026-09-01T10:05:00.000Z"),
    ])
    lines = open(path, encoding="utf-8").read().splitlines(keepends=True)
    side = lines[1].replace('"type": "assistant"', '"type": "assistant", "isSidechain": true')
    open(path, "w", encoding="utf-8").write(lines[0] + side)
    f = parse_file(path, "s3")
    assert f.assistant_text == []
    assert f.subagent_text and f.subagent_turns == 1


def test_incomplete_last_line_is_left_for_the_next_pass(write_session, tmp_path):
    path = write_session("p", [user_text("первая")])
    with open(path, "a", encoding="utf-8") as fh:
        fh.write('{"type":"user","message":{"content":[{"type":"text","text":"хвост')
    f = parse_file(path, "s4")
    assert f.user_text == ["первая"]
    assert f.bad_lines == 0                       # недописанная строка не «битая», а незавершённая
    assert f.complete_bytes < len(open(path, "rb").read())


def test_file_paths_come_from_file_tools_only(write_session):
    path = write_session("p", [
        assistant_tool("Edit", {"file_path": "/Users/u/Code/demo/app.py"}),
        assistant_tool("WebFetch", {"url": "https://example.com/secret"}),
    ])
    f = parse_file(path, "s5")
    assert f.paths == ["/Users/u/Code/demo/app.py"]


def test_ticket_regex_matches_alternatives_not_literal_pipes():
    TICKET_RE = config.ticket_re()          # префиксы — из тестового профиля
    assert TICKET_RE.findall("правим ABC-1548 и XYZ-3133") == ["ABC-1548", "XYZ-3133"]
    assert TICKET_RE.findall("ABC|XYZ-12") == ["XYZ-12"]   # литеральная черта не матчится целиком
    assert TICKET_RE.findall("QQQ-1548") == []
    assert TICKET_RE.findall("префикс ABC-1 в тексте") == []   # обрывок, не тикет
    assert TICKET_RE.findall("ABC-12") == ["ABC-12"]
    assert TICKET_RE.findall("AABC-1548") == []            # граница слова работает


def test_manual_title_beats_ai_title(write_session):
    path = write_session("p", [
        rec(type="ai-title", aiTitle="Авто-заголовок", sessionId="s6"),
        rec(type="custom-title", customTitle="Мой заголовок", sessionId="s6"),
        user_text("привет"),
    ])
    f = parse_file(path, "s6")
    assert (f.title, f.title_source) == ("Мой заголовок", "manual")


def test_slash_command_prompt_is_made_readable():
    """В карточке «последний запрос» не должен быть сырой обёрткой слэш-команды."""
    from atlas.parse import readable_prompt
    raw = ("<command-message>loop</command-message>\n<command-name>/loop</command-name>\n"
           "<command-args>30m Фаза 3, реалтайм XYZ</command-args>")
    assert readable_prompt(raw) == "/loop 30m Фаза 3, реалтайм XYZ"
    assert readable_prompt("обычный запрос") == "обычный запрос"


def test_slash_command_is_unwrapped_when_the_transcript_is_parsed(write_session):
    """Проверяем не саму функцию, а что разбор её действительно применяет."""
    path = write_session("p", [user_text(
        "<command-message>loop</command-message>\n<command-name>/loop</command-name>\n"
        "<command-args>30m проверить DAG</command-args>")])
    f = parse_file(path, "sc1")
    assert f.user_text == ["/loop 30m проверить DAG"]
    assert "<command-name>" not in f.user_text[0]


def test_no_ticket_prefixes_means_no_tickets(tmp_path):
    from tests.conftest import write_config
    import os
    write_config(os.environ["ATLAS_HOME"], {"ticket_prefixes": []})
    assert config.ticket_re() is None
    write_config(os.environ["ATLAS_HOME"], {"ticket_prefixes": ["OPS", "bad prefix", "a|b"]})
    assert config.ticket_re().findall("OPS-12 и a|b-12, bad prefix-12") == ["OPS-12"]
