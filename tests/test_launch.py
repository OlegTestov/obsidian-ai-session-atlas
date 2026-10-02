"""Новая сессия из «Активных»: папка только из списка, запрос экранирован для шелла."""
from __future__ import annotations

import os
import shlex
import tempfile

import pytest

from atlas import db, index, launch
from tests.conftest import user_text


@pytest.fixture
def home(tmp_path, monkeypatch):
    fake = tmp_path / "home"
    (fake / "Code" / "alpha").mkdir(parents=True)
    (fake / "Code" / ".hidden").mkdir()
    monkeypatch.setattr(launch, "_home", lambda: str(fake))
    monkeypatch.setenv("HOME", str(fake))          # «~» в настройках — тоже сюда
    return fake


def _indexed(atlas_env, write_session, cwd):
    write_session("p", [user_text("работаю тут", cwd=cwd, ts="2026-09-27T10:00:00.000Z")])
    conn = db.connect()
    index.index_all(conn, root=str(atlas_env["projects"]))
    return conn


def test_recent_folders_first_then_code(atlas_env, write_session, home, tmp_path):
    work = tmp_path / "home" / "work" / "app"
    work.mkdir(parents=True)
    conn = _indexed(atlas_env, write_session, str(work))
    dirs = launch.workdirs(conn)
    assert dirs[0]["path"] == str(work) and dirs[0]["recent"] and dirs[0]["label"] == "~/work/app"
    paths = [d["path"] for d in dirs]
    assert str(home / "Code" / "alpha") in paths
    assert not any(p.endswith(".hidden") for p in paths)


def test_temp_and_missing_folders_are_not_offered(atlas_env, write_session, home, tmp_path):
    scratch = tmp_path / "sess" / "scratchpad"
    scratch.mkdir(parents=True)
    in_tmp = tempfile.mkdtemp(dir="/tmp")
    try:
        for cwd in (str(scratch), in_tmp, "/Users/nobody/gone"):
            conn = _indexed(atlas_env, write_session, cwd)
            assert cwd not in [d["path"] for d in launch.workdirs(conn)], cwd
    finally:
        os.rmdir(in_tmp)


def test_labels_are_short(home):
    vault = os.path.join(str(home), "Notes")
    assert launch.label(vault) == "vault (Obsidian)"
    assert launch.label(vault + "/Work/Agent Rooms") == "vault/Work/Agent Rooms"
    assert launch.label(str(home / "Code" / "alpha")) == "~/Code/alpha"
    assert launch.label("/opt/x") == "/opt/x"


def test_hidden_folders_are_not_offered(atlas_env, write_session, home):
    hidden = home / "proj" / ".obsidian" / "plugins"
    hidden.mkdir(parents=True)
    conn = _indexed(atlas_env, write_session, str(hidden))
    assert str(hidden) not in [d["path"] for d in launch.workdirs(conn)]


def test_folder_outside_the_list_is_refused(atlas_env, write_session, home):
    conn = _indexed(atlas_env, write_session, str(home / "Code" / "alpha"))
    with pytest.raises(launch.LaunchError):
        launch.new_session(conn, "/etc", "привет")
    with pytest.raises(launch.LaunchError):
        launch.new_session(conn, str(home / "Code" / "alpha") + "/..", "привет")


def test_command_quotes_prompt_and_path(atlas_env, write_session, home):
    alpha = str(home / "Code" / "alpha")
    conn = _indexed(atlas_env, write_session, alpha)
    out = launch.new_session(conn, alpha, "почини 'кавычки'; rm -rf ~ && $(whoami)\nвторая строка")
    words = shlex.split(out["command"].split(" && ", 1)[1])
    assert out["command"].startswith(f"cd {shlex.quote(alpha)} && ")
    assert words[:3] == ["claude", "--session-id", out["session_id"]]
    assert words[3] == "почини 'кавычки'; rm -rf ~ && $(whoami)\nвторая строка"
    assert len(words) == 4
    assert out["title"] == "почини 'кавычки'; rm -rf ~ && $(whoami)"


def test_prompt_that_looks_like_a_flag_stays_a_prompt(atlas_env, write_session, home):
    alpha = str(home / "Code" / "alpha")
    conn = _indexed(atlas_env, write_session, alpha)
    words = shlex.split(launch.new_session(conn, alpha, "--dangerously-skip-permissions")["command"]
                        .split(" && ", 1)[1])
    assert words[3] == " --dangerously-skip-permissions" and not words[3].startswith("-")


def test_empty_prompt_starts_a_bare_session(atlas_env, write_session, home):
    alpha = str(home / "Code" / "alpha")
    conn = _indexed(atlas_env, write_session, alpha)
    out = launch.new_session(conn, alpha, "   ")
    assert shlex.split(out["command"].split(" && ", 1)[1]) == ["claude", "--session-id", out["session_id"]]
    assert out["title"] == "~/Code/alpha"
