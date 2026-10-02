"""Запросы к модели: язык и домены из настроек, выдержка — данные, а не инструкции."""
from __future__ import annotations

import os

from atlas import classify, db, enrich, index, prompts
from tests.conftest import write_config


def test_classify_prompt_lists_domains_from_settings_safely():
    write_config(os.environ["ATLAS_HOME"], {"domains": [{"id": "work", "description": "job {not a field}"},
                                                       {"id": "home", "description": ""}]})
    text = prompts.classify("en").format(context="C", registry="R", signal="S")
    assert "strictly one of: work | home" in text and "job {not a field}" in text and "- **home**" in text


def test_no_domains_means_domain_is_left_empty():
    write_config(os.environ["ATLAS_HOME"], {"domains": []})
    assert classify._verdict({"domain": "anything", "topic": "x", "confidence": 0.9})["domain"] is None
    write_config(os.environ["ATLAS_HOME"], {})
    try:
        classify._verdict({"domain": "anything", "topic": "x"})
        assert False, "домен вне списка принят"
    except ValueError:
        pass


def test_handoff_sections_follow_the_language():
    for lg in ("ru", "en"):
        write_config(os.environ["ATLAS_HOME"], {"language": lg})
        text = "\n".join(f"{s}\nx" for s in prompts.HANDOFF_SECTIONS[lg])
        assert enrich._validate_handoff(text)
        for s in prompts.HANDOFF_SECTIONS[lg]:
            assert s in prompts.handoff()
    assert prompts.resume("/h.md", "en").startswith("Read /h.md")


def test_changed_settings_rebuild_the_index(atlas_env, write_session):
    from tests.conftest import user_text
    notes = os.path.join(os.path.expanduser("~"), "Notes", "Work")
    write_session("p", [user_text("заметки", cwd=notes)])
    conn = db.connect()
    index.ensure_indexed(conn, root=str(atlas_env["projects"]))
    index.index_all(conn, root=str(atlas_env["projects"]))
    assert [r[0] for r in conn.execute("SELECT domain FROM session_domains")] == ["work"]
    write_config(os.environ["ATLAS_HOME"], {"vault_domain_rules": [["Work", "personal"]]})
    assert index.ensure_indexed(conn, root=str(atlas_env["projects"])) is not None
    assert [r[0] for r in conn.execute("SELECT domain FROM session_domains")] == ["personal"]
