"""Codex reply-box suggestions: its own slash commands, skills typed as `$name`, the /model picker."""
from __future__ import annotations

import json
import os
import urllib.request

from atlas import codex_commands, commands, messages


def _skill(root, name, description):
    (root / name).mkdir(parents=True)
    (root / name / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {description}\n---\nbody\n",
                                          encoding="utf-8")


def test_codex_builtins_then_skills_with_the_dollar_sign(tmp_path):
    _skill(tmp_path / ".codex" / "skills", "page-design", "Design a page")
    _skill(tmp_path / ".agents" / "skills", "qa", "Test a web app")
    _skill(tmp_path / ".agents" / "skills", "page-design", "a second copy, hidden by the first")
    (tmp_path / ".codex" / "skills" / ".system").mkdir()
    out = codex_commands.all_commands(str(tmp_path))
    names = [c["name"] for c in out]
    assert names[:4] == ["model", "goal", "compact", "plan"]
    skills = [c for c in out if c["kind"] == "skill"]
    assert [(c["name"], c["sigil"], c["description"]) for c in skills] == [
        ("page-design", "$", "Design a page"), ("qa", "$", "Test a web app")]
    assert all("sigil" not in c for c in out if c["kind"] == "builtin")
    assert len(names) == len(set(names)) and ".system" not in names


def test_nested_and_system_skills_by_their_declared_names(tmp_path):
    # gstack keeps its skills one level down; Codex's own sit in .system; a name: in SKILL.md wins.
    _skill(tmp_path / ".agents" / "skills" / "gstack", "browse", "Headless browser")
    _skill(tmp_path / ".codex" / "skills" / ".system", "imagegen", "Make images")
    deep = tmp_path / ".agents" / "skills" / "tools" / "x"
    deep.mkdir(parents=True)
    (deep / "SKILL.md").write_text("---\nname: x-renamed\ndescription: d\n---\n", encoding="utf-8")
    names = [c["name"] for c in codex_commands.skills(str(tmp_path))]
    assert sorted(names) == ["browse", "imagegen", "x-renamed"]


def test_skills_come_from_codex_own_list_when_a_session_has_it(tmp_path):
    _skill(tmp_path / ".agents" / "skills", "only-on-disk", "not offered by Codex")
    listed = ("<skills_instructions>\n## Skills\n### Available skills\n"
              "- browse: Headless browser for QA (file: r1/gstack/browse/SKILL.md)\n"
              "- figma:figma-use: Use Figma (file: r3/figma-use/SKILL.md)\n"
              "- figma:figma-use: Use Figma (file: r11/figma-use/SKILL.md)\n"
              "- imagegen: Make images (file: r2/imagegen/SKILL.md)\n### How to use skills\n- Discovery: x\n")
    day = tmp_path / ".codex" / "sessions" / "2026" / "11" / "14"
    day.mkdir(parents=True)
    record = {"timestamp": "t", "type": "response_item", "payload": {"type": "message", "role": "developer",
              "content": [{"type": "input_text", "text": listed}]}}
    (day / "rollout-2026-11-14T10-00-00-019e0000-0000-7000-8000-000000000001.jsonl").write_text(
        '{"type":"session_meta","payload":{}}\n' + json.dumps(record) + "\n", encoding="utf-8")
    skills = codex_commands.skills(str(tmp_path))
    assert [(c["name"], c["description"]) for c in skills] == [
        ("browse", "Headless browser for QA"), ("figma:figma-use", "Use Figma"), ("imagegen", "Make images")]


def test_codex_list_is_read_past_records_that_only_name_it(tmp_path):
    # As codex-cli 0.167 writes a rollout (anonymised): session_meta's base instructions and an earlier
    # developer instruction both say "Available skills" without listing any; a user message quoting a
    # list is not Codex's; the list itself comes in a later developer message.
    def rec(kind, payload):
        return json.dumps({"timestamp": "2026-11-14T10:00:00.000Z", "type": kind, "payload": payload}) + "\n"

    def message(role, text):
        content = [{"type": "input_text", "text": text}]
        return rec("response_item", {"type": "message", "role": role, "content": content})
    lines = [
        rec("session_meta", {"id": "019e0000-0000-7000-8000-000000000001", "base_instructions": {
            "text": "When a skill is relevant, see the Available skills list below.\n"
                    "- not: a skill (file: x/SKILL.md)"}}),
        message("developer", "<permissions instructions>sandbox</permissions instructions>"),
        message("developer", "<skills_instructions>Pick from Available skills only when asked.</skills_instructions>"),
        message("user", "### Available skills\n- quoted: from a user (file: r1/quoted/SKILL.md)"),
        message("developer", "<skills_instructions>\n## Skills\n### Available skills\n"
                             "- browse: Headless browser (file: r1/gstack/browse/SKILL.md)\n"
                             "- imagegen: Make images (file: r2/imagegen/SKILL.md)\n### How to use skills\n"),
    ]
    day = tmp_path / ".codex" / "sessions" / "2026" / "11" / "14"
    day.mkdir(parents=True)
    (day / "rollout-2026-11-14T10-00-00-019e0000-0000-7000-8000-000000000001.jsonl").write_text(
        "".join(lines), encoding="utf-8")
    assert [c["name"] for c in codex_commands.skills(str(tmp_path))] == ["browse", "imagegen"]


def test_a_linked_skill_folder_is_listed(tmp_path):
    _skill(tmp_path / "elsewhere", "page-design", "Design a page")
    (tmp_path / ".agents" / "skills").mkdir(parents=True)
    os.symlink(tmp_path / "elsewhere" / "page-design", tmp_path / ".agents" / "skills" / "page-design")
    assert [c["name"] for c in codex_commands.skills(str(tmp_path))] == ["page-design"]


def test_only_codex_commands_and_never_claude_ones(tmp_path):
    names = {c["name"] for c in codex_commands.all_commands(str(tmp_path))}
    for must in ("model", "goal", "compact", "status", "usage", "review", "diff", "new", "resume",
                 "fork", "rename", "side", "mcp", "init"):
        assert must in names, must
    # Claude Code's own: codex-cli 0.167 lists none of them when "/" is typed.
    assert not names & {"effort", "context", "loop", "rewind", "cost"}
    rest = [c["name"] for c in codex_commands.all_commands(str(tmp_path))[codex_commands.FREQUENT:]]
    assert rest == sorted(rest)


def test_descriptions_follow_the_page_language(tmp_path):
    with messages.use_lang("ru"):
        ru = codex_commands.all_commands(str(tmp_path))[0]["description"]
    with messages.use_lang("en"):
        en = codex_commands.all_commands(str(tmp_path))[0]["description"]
    assert en == "pick the model and reasoning effort" and ru == "выбрать модель и глубину рассуждений"
    for name, en, ru in codex_commands.BUILTIN:
        assert en and ru and en[0].islower() and len(en) <= 60 and len(ru) <= 60, name


def test_models_are_the_listed_ones_with_their_efforts(tmp_path):
    (tmp_path / ".codex").mkdir()
    (tmp_path / ".codex" / "models_cache.json").write_text(json.dumps({"models": [
        {"slug": "gpt-6.1-sol", "display_name": "GPT-6.1-Sol", "visibility": "list",
         "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}]},
        {"slug": "codex-auto-review", "display_name": "Codex Auto Review", "visibility": "hide",
         "supported_reasoning_levels": [{"effort": "low"}]},
        {"slug": "gpt-6-luna", "visibility": "list"}]}), encoding="utf-8")
    assert codex_commands.models(str(tmp_path)) == [
        {"slug": "gpt-6.1-sol", "name": "GPT-6.1-Sol", "efforts": ["low", "high"]},
        {"slug": "gpt-6-luna", "name": "gpt-6-luna", "efforts": []}]


def test_no_cache_means_no_models(tmp_path):
    assert codex_commands.models(str(tmp_path)) == []
    (tmp_path / ".codex").mkdir()
    (tmp_path / ".codex" / "models_cache.json").write_text("{not json", encoding="utf-8")
    assert codex_commands.models(str(tmp_path)) == []


def test_api_lists_commands_per_agent(live_server, monkeypatch, tmp_path):
    codex_home = os.environ["ATLAS_CODEX_HOME"]
    os.makedirs(os.path.join(codex_home, "skills", "demo"))
    with open(os.path.join(codex_home, "skills", "demo", "SKILL.md"), "w", encoding="utf-8") as fh:
        fh.write("---\ndescription: a demo skill\n---\n")
    with open(os.path.join(codex_home, "models_cache.json"), "w", encoding="utf-8") as fh:
        json.dump({"models": [{"slug": "gpt-6-luna", "display_name": "GPT-6-Luna", "visibility": "list",
                               "supported_reasoning_levels": [{"effort": "medium"}]}]}, fh)
    monkeypatch.setenv("HOME", str(tmp_path))            # no real ~/.agents/skills
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / ".claude"))
    base, _ = live_server

    def get(path):
        req = urllib.request.Request(base + path, headers={"X-Atlas-Lang": "en"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    codex = get("/api/commands?agent=codex")
    assert codex["commands"][0]["name"] == "model"
    assert {"name": "demo", "kind": "skill", "sigil": "$", "description": "a demo skill"} in codex["commands"]
    assert codex["models"] == [{"slug": "gpt-6-luna", "name": "GPT-6-Luna", "efforts": ["medium"]}]
    claude = get("/api/commands")
    assert "models" not in claude and claude["commands"][0]["name"] == commands.FREQUENT[0]
    assert "effort" in {c["name"] for c in claude["commands"]}
