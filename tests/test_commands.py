"""Slash command suggestions: built-ins plus your skills and commands."""
from __future__ import annotations

from atlas import commands


def test_builtin_first_then_skills_and_commands(tmp_path):
    skills = tmp_path / ".claude" / "skills"
    (skills / "connect-chrome").mkdir(parents=True)
    (skills / "connect-chrome" / "SKILL.md").write_text(
        "---\nname: open-gstack-browser\ndescription: Launch GStack Browser\n---\nтело", encoding="utf-8")
    (skills / "_private").mkdir()
    (skills / "_private" / "SKILL.md").write_text("---\nname: x\n---\n", encoding="utf-8")
    (skills / "no-md").mkdir()
    cmds = tmp_path / ".claude" / "commands"
    cmds.mkdir(parents=True)
    (cmds / "distill.md").write_text("# Выжать сессию в память\nтекст", encoding="utf-8")
    (cmds / "goal.md").write_text("---\ndescription: чужая goal\n---\n", encoding="utf-8")
    out = commands.all_commands(str(tmp_path))
    names = [c["name"] for c in out]
    assert names[0] == "goal" and out[0]["kind"] == "builtin"
    # A skill is invoked by its folder name, not by the name field.
    chrome = next(c for c in out if c["name"] == "connect-chrome")
    assert chrome["kind"] == "skill" and chrome["description"] == "Launch GStack Browser"
    assert "open-gstack-browser" not in names and "_private" not in names and "no-md" not in names
    distill = next(c for c in out if c["name"] == "distill")
    assert distill["kind"] == "command" and distill["description"] == "Выжать сессию в память"
    assert names.count("goal") == 1, "a built-in is not duplicated by a command with the same name"


def test_long_description_is_cut(tmp_path):
    skill = tmp_path / ".claude" / "skills" / "long"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\ndescription: " + "слово " * 100 + "\n---\n", encoding="utf-8")
    desc = next(c for c in commands.all_commands(str(tmp_path)) if c["name"] == "long")["description"]
    assert len(desc) <= commands.DESC_CHARS and desc.endswith("…")


def test_missing_folders_give_only_builtins(tmp_path):
    assert [c["kind"] for c in commands.all_commands(str(tmp_path))] == ["builtin"] * len(commands.BUILTIN)


def test_everyday_builtins_are_offered(tmp_path):
    names = [c["name"] for c in commands.all_commands(str(tmp_path))]
    for must in ("goal", "effort", "model", "compact", "clear", "context", "loop", "rewind",
                 "usage", "mcp", "skills", "resume", "rename"):
        assert must in names, must
    assert names.index("effort") < len(commands.FREQUENT), "frequent ones come first in the suggestions"
    assert len(names) == len(set(names))


def _plugin(root, skills=(), commands=()):
    for name in skills:
        (root / "skills" / name).mkdir(parents=True)
        (root / "skills" / name / "SKILL.md").write_text(f"---\ndescription: скилл {name}\n---\n",
                                                          encoding="utf-8")
    for name in commands:
        (root / "commands").mkdir(parents=True, exist_ok=True)
        (root / "commands" / f"{name}.md").write_text(f"# команда {name}\n", encoding="utf-8")


def test_plugins_enabled_project_and_org_are_offered_as_plugin_colon_name(tmp_path):
    plugins = tmp_path / ".claude" / "plugins"
    on, off, proj = plugins / "cache" / "m" / "on" / "1", plugins / "cache" / "m" / "off" / "1", \
        plugins / "cache" / "o" / "proj" / "1"
    _plugin(on, skills=["deploy"], commands=["status"])
    _plugin(off, skills=["hidden"])
    _plugin(proj, skills=["notes"])
    org = plugins / "synced" / "x_y" / "diag"
    _plugin(org, skills=["check-md"])
    (org / ".claude-plugin").mkdir(parents=True)
    (org / ".claude-plugin" / "plugin.json").write_text('{"name": "platform-diagnostics"}', encoding="utf-8")
    import json as _json
    (plugins / "installed_plugins.json").write_text(_json.dumps({"plugins": {
        "on@m": [{"scope": "user", "installPath": str(on)}],
        "off@m": [{"scope": "user", "installPath": str(off)}],
        "proj@o": [{"scope": "project", "installPath": str(proj), "projectPath": "/v"}],
    }}), encoding="utf-8")
    (tmp_path / ".claude" / "settings.json").write_text('{"enabledPlugins": {"on@m": true}}',
                                                        encoding="utf-8")
    names = {c["name"]: c for c in commands.all_commands(str(tmp_path))}
    assert {"on:deploy", "on:status", "proj:notes", "platform-diagnostics:check-md"} <= set(names)
    assert "off:hidden" not in names, "a disabled plugin is not suggested"
    assert names["on:deploy"]["kind"] == "plugin" and names["on:deploy"]["description"] == "скилл deploy"


def test_frequent_first_then_alphabetical(tmp_path):
    _plugin(tmp_path / ".claude", skills=["zeta", "Alpha"])
    names = [c["name"] for c in commands.all_commands(str(tmp_path))]
    assert names[:len(commands.FREQUENT)] == list(commands.FREQUENT)
    assert "clear" not in commands.FREQUENT and "usage" in commands.FREQUENT
    rest = names[len(commands.FREQUENT):]
    assert rest == sorted(rest, key=str.lower)
