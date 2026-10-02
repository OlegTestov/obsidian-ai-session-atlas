"""Текст плана для диалога: по пути с экрана, иначе по slug из транскрипта; за каталог — ни шагу."""
from __future__ import annotations

from atlas import plans
from tests.conftest import rec


def _setup(tmp_path):
    folder = tmp_path / "plans"
    folder.mkdir()
    (folder / "quiet-bentley.md").write_text("# План A", encoding="utf-8")
    (folder / "other.md").write_text("# План B", encoding="utf-8")
    (tmp_path / "secret.md").write_text("секрет", encoding="utf-8")
    transcript = tmp_path / "s.jsonl"
    transcript.write_text(rec(type="user", slug="old-slug") + rec(type="assistant", slug="quiet-bentley"),
                          encoding="utf-8")
    return str(folder), str(transcript)


def test_screen_path_first_then_slug(tmp_path):
    folder, transcript = _setup(tmp_path)
    assert plans.plan_text(transcript, "~/.claude/plans/other.md", folder)["text"] == "# План B"
    assert plans.plan_text(transcript, None, folder)["text"] == "# План A"     # последний slug


def test_paths_outside_the_plans_folder_are_ignored(tmp_path):
    folder, transcript = _setup(tmp_path)
    for bad in ("~/.claude/plans/../secret.md", "/etc/passwd", "~/secret.md", "~/.claude/plans/x/../../secret.md"):
        got = plans.plan_text(transcript, bad, folder)
        assert got["name"] == "quiet-bentley.md", bad


def test_no_plan_is_none(tmp_path):
    folder, _ = _setup(tmp_path)
    empty = tmp_path / "e.jsonl"
    empty.write_text(rec(type="user"), encoding="utf-8")
    assert plans.plan_text(str(empty), None, folder) is None
