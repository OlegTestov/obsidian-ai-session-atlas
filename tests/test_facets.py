"""Filter options come from the same domain and topic a card shows: manual, then model, then path rules."""
from __future__ import annotations

import os

from atlas import db, index, search, server
from tests.conftest import user_text

MANUAL, MODEL, RULES, NONE = (f"{d}{d}{d}{d}{d}{d}{d}{d}-0000-0000-0000-000000000000" for d in "1234")


def _classified(conn, sid, domain, topic):
    conn.execute("INSERT INTO classification (session_id, domain, topic, confidence, content_hash, "
                 "classifier_version, model, backend, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                 (sid, domain, topic, 0.5, "h", 1, "m", "b", "t"))


def _catalog(atlas_env, write_session):
    for sid in (MANUAL, MODEL, RULES, NONE):
        write_session("p", [user_text(f"работа {sid[:4]}")], session_id=sid)
    conn = db.connect(os.path.join(str(atlas_env["home"]), "atlas.sqlite3"))
    index.index_all(conn, root=str(atlas_env["projects"]))
    conn.execute("DELETE FROM session_domains")
    # The manual session: the model said one thing, the owner another.
    _classified(conn, MANUAL, "personal", "разное")
    conn.execute("INSERT INTO user_overrides(session_id, domain, topic, updated_at) VALUES (?,?,?,?)",
                 (MANUAL, "work", "Мой Проект", "t"))
    _classified(conn, MODEL, "work", "сборка")
    for domain in ("work", "personal"):                # two path rules match one session
        conn.execute("INSERT INTO session_domains(session_id, domain) VALUES (?,?)", (RULES, domain))
    conn.execute("DELETE FROM session_projects")
    for sid in (MANUAL, MODEL, RULES, NONE):
        conn.execute("INSERT INTO session_projects VALUES (?, 'Atlas', 'primary')", (sid,))
    conn.commit()
    return conn


def test_filter_options_match_what_the_cards_show(atlas_env, write_session):
    conn = _catalog(atlas_env, write_session)
    facets = server.Handler.__new__(server.Handler)._facets(conn)
    cards = [search.load_session(conn, sid) for sid in (MANUAL, MODEL, RULES, NONE)]
    assert facets["topics"] == sorted({c["topic"] for c in cards if c["topic"]}) == ["Мой Проект", "сборка"]
    assert facets["domains"] == sorted({d for c in cards for d in c["domains"]}) == ["personal", "work"]
    assert facets["topic_domains"] == {"Мой Проект": ["work"], "сборка": ["work"]}
    assert facets["project_domains"] == {"Atlas": ["personal", "work"]}     # the rule session adds both
