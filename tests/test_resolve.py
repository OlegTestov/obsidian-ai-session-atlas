"""Rules for projects, paths, session kind and sensitivity."""
from __future__ import annotations

import os

from atlas import resolve
from tests.conftest import NOTES

HOME = resolve.HOME
VAULT = NOTES


def test_scratchpad_never_becomes_a_project():
    p = f"/private/tmp/claude-501/-Users-x-vault/{'a'*8}-1111-2222-3333-444444444444/scratchpad/llm1548"
    ws = resolve.classify_path(p)
    assert ws.kind == "scratchpad"
    assert ws.project_id is None


def test_scratchpad_session_takes_the_project_of_the_files_it_edited():
    projects, kind = resolve.resolve_projects(
        cwds=["/private/tmp/claude-501/-Users-x-vault/"
              "aaaaaaaa-1111-2222-3333-444444444444/scratchpad"],
        file_paths=[os.path.join(HOME, "Code/session-atlas/atlas/parse.py")],
    )
    assert kind == "scratchpad"
    assert projects == [("session-atlas", "primary")]


def test_path_comparison_is_by_component_not_prefix():
    assert resolve.classify_path(os.path.join(HOME, "Code/demo")).project_id == "demo"
    assert resolve.classify_path(os.path.join(HOME, "Code-old/demo")).project_id is None


def test_container_dirs_do_not_become_projects():
    ws = resolve.classify_path(os.path.join(HOME, "Code/MCPs/telegram-mcp"))
    assert ws.project_id == "telegram-mcp"


def test_relative_path_resolves_against_cwd_at_that_record():
    resolved = resolve.normalize("sol/core.py", cwd_at_record="/Users/u/Code/demo")
    assert resolved == "/Users/u/Code/demo/sol/core.py"


def test_tmp_symlink_is_normalized_without_touching_disk():
    assert resolve.normalize("/tmp/x/y").startswith("/private/tmp/")


def test_vault_area_maps_to_canonical_domain():
    assert resolve.resolve_domains([os.path.join(VAULT, "Work/Tasks")], []) == ["work"]
    assert resolve.resolve_domains([os.path.join(VAULT, "Business/Projects")], []) == ["business"]


def test_sensitivity_defaults_to_unclassified_which_blocks_egress():
    assert resolve.resolve_sensitivity(["/Users/u/Code/demo"], []) == resolve.UNCLASSIFIED


def test_personal_and_accounting_are_sensitive():
    assert resolve.resolve_sensitivity([os.path.join(VAULT, "Personal/Health")], []) == "sensitive"
    assert resolve.resolve_sensitivity([], [os.path.join(VAULT, "Finance/Q2.md")]) == "sensitive"


def test_sensitivity_checks_the_whole_cwd_history():
    """The session started in a harmless folder but later touched Personal, so it is sensitive."""
    cwds = ["/Users/u/Code/demo", os.path.join(VAULT, "Personal/Health")]
    assert resolve.resolve_sensitivity(cwds, []) == "sensitive"


def test_headless_run_without_human_prompts_is_automation():
    assert resolve.session_kind("sdk-cli", 0) == "automation"
    assert resolve.session_kind("sdk-cli", 5) == "automation"   # the writer has a "prompt", but it is machine-made
    assert resolve.session_kind("cli", 0) == "automation"
    assert resolve.session_kind("cli", 3) == "interactive"


def test_desktop_and_ide_sessions_are_interactive():
    """A human sits behind Claude Desktop, so it is not a background run."""
    assert resolve.session_kind("claude-desktop", 4) == "interactive"
    assert resolve.session_kind("ide", 2) == "interactive"


def test_title_falls_back_in_order():
    assert resolve.fallback_title("Готовый", [], None, [], "abcdef12")[0] == "Готовый"
    assert resolve.fallback_title(None, ["первый промпт"], None, [], "abcdef12") == (
        "первый промпт", "first-prompt")
    assert resolve.fallback_title(None, [], None, [], "abcdef1234")[0] == "abcdef12"


def test_file_at_the_workspace_root_is_not_a_project():
    """Transcripts contain ~/Code/chat-with-alert-RESTORE.md, which is a file, not a project."""
    assert resolve.classify_path(os.path.join(HOME, "Code/notes.md")).project_id is None
    assert resolve.classify_path(os.path.join(HOME, "Code/.DS_Store")).project_id is None
    assert resolve.classify_path(os.path.join(HOME, "Code/demo/notes.md")).project_id == "demo"


def test_automation_title_takes_only_the_first_line():
    long_task = "You are maintaining an Obsidian vault.\nRead CLAUDE.md first.\nThen do X."
    title, source = resolve.fallback_title(None, [long_task], None, [], "abcdef12")
    assert title == "You are maintaining an Obsidian vault."
    assert source == "first-prompt"


def test_compaction_summary_never_becomes_the_title():
    title, source = resolve.fallback_title(
        "This session is being continued from a previous conversation…",
        ["почини деплой"], None, [], "abcdef12")
    assert title == "почини деплой" and source == "first-prompt"


def test_settings_decide_projects_domains_and_sensitivity(monkeypatch, tmp_path):
    """Everything personal lives in settings: another person, another vault, other rules."""
    import os as _os

    from tests.conftest import write_config
    write_config(_os.environ["ATLAS_HOME"], {
        "vaults": [{"path": "~/Brain", "id": "brain"}], "workspace_roots": ["~/dev"],
        "vault_domain_rules": [["Jobs", "work"]], "sensitive": {"vault_areas": ["Med"], "projects": []}})
    brain = os.path.join(HOME, "Brain")
    assert resolve.classify_path(os.path.join(brain, "Jobs/a.md")).project_id == "brain"
    assert resolve.classify_path(os.path.join(HOME, "dev/app/x.py")).project_id == "app"
    assert resolve.classify_path(os.path.join(HOME, "Code/app/x.py")).project_id is None
    assert resolve.resolve_domains([os.path.join(brain, "Jobs")], []) == ["work"]
    assert resolve.resolve_sensitivity([os.path.join(brain, "Med/x")], []) == "sensitive"


def test_without_settings_nothing_personal_is_assumed(tmp_path):
    import os as _os

    from atlas import config
    _os.remove(_os.path.join(_os.environ["ATLAS_HOME"], "config.json"))
    config.reset()
    assert config.vaults() == [] and config.ticket_re() is None and config.get("llm_enabled") is False
    assert resolve.classify_path(os.path.join(HOME, "Code/app")).project_id == "app"   # default roots
    assert resolve.resolve_sensitivity([os.path.join(HOME, "Notes/Personal")], []) == resolve.UNCLASSIFIED


def test_project_domain_rules_keep_their_own_keys():
    """The "project → domain" map is empty by default; user keys must not get lost."""
    assert resolve.resolve_domains([], [os.path.join(HOME, ".claude/skills/x/SKILL.md")]) == ["tools"]
