"""Folder field of "+ Session": typed text resolved and checked, subfolder suggestions, the route."""
from __future__ import annotations

import json
import os
import shlex
import tempfile
import urllib.error
import urllib.request

import pytest

from atlas import config, db, folders, launch


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A made-up home with the test profile's vault (~/Notes, id "vault") and a few folders."""
    fake = tmp_path / "home"
    for d in ("Notes/Work/Agent Rooms", "Notes/Personal", "Code/alpha/src", "Code/Alpine", "Code/beta",
              "Code/.hidden", "Code/zalpha"):
        (fake / d).mkdir(parents=True)
    (fake / "Code" / "alpha.txt").write_text("not a folder")
    (fake / "Code" / "notes.md").write_text("x")
    monkeypatch.setenv("HOME", str(fake))
    config.reset()
    return fake


def test_the_field_forms_resolve_to_one_path(home):
    vault = str(home / "Notes")
    assert folders.resolve("vault") == vault
    assert folders.resolve("vault/Work/Agent Rooms") == vault + "/Work/Agent Rooms"
    assert folders.resolve("~") == str(home)
    assert folders.resolve("~/Code/alpha/") == str(home / "Code" / "alpha")
    assert folders.resolve(f"  {home}/Code//alpha  ") == str(home / "Code" / "alpha")
    assert folders.field_text(vault) == "vault"
    assert folders.field_text(vault + "/Work") == "vault/Work"
    assert folders.field_text(str(home / "Code")) == "~/Code"
    assert folders.field_text(str(home)) == "~"
    assert folders.field_text("/opt/x") == "/opt/x"


@pytest.mark.parametrize("text", ["", "   ", None, 5, ["~"], "Code/alpha", "~other/x", "vaultx/Work",
                                  "~/Code/alpha/../beta", "vault/../Code", "~/..", "/etc/\x00x",
                                  "~/Code/al\npha", "/" + "a" * 5000])
def test_anything_else_is_refused(home, text):
    with pytest.raises(folders.FolderError):
        folders.resolve(text)


def test_check_wants_an_existing_directory(home):
    assert folders.check("~/Code/alpha") == str(home / "Code" / "alpha")
    with pytest.raises(folders.FolderError, match=r"alpha\.txt"):
        folders.check("~/Code/alpha.txt")
    with pytest.raises(folders.FolderError, match="gone"):
        folders.check("~/Code/gone")
    scratch = tempfile.mkdtemp(dir="/tmp")
    try:
        with pytest.raises(folders.FolderError):
            folders.check(scratch)
    finally:
        os.rmdir(scratch)


def test_subfolders_are_directories_only_without_hidden_ones(home):
    names = [d["name"] for d in folders.subfolders(str(home / "Code"))]
    assert names == ["alpha", "Alpine", "beta", "zalpha"]
    # Name start first (any case), then the name containing it.
    assert [d["name"] for d in folders.subfolders(str(home / "Code"), "AL")] == ["alpha", "Alpine", "zalpha"]
    item = folders.subfolders(str(home / "Code"), "beta")[0]
    assert item == {"name": "beta", "path": str(home / "Code" / "beta"), "text": "~/Code/beta"}
    assert folders.subfolders(str(home / "Code" / "alpha.txt")) == []
    assert folders.subfolders(str(home / "missing")) == []


def test_suggest_lists_siblings_then_children_after_a_slash(home):
    out = folders.suggest("~/Code/al")
    assert [d["text"] for d in out["dirs"]] == ["~/Code/alpha", "~/Code/Alpine", "~/Code/zalpha"]
    assert out["folder"] is None and out["error"]           # not a folder yet: only a hint
    out = folders.suggest("~/Code/alpha")
    assert out["folder"] == {"path": str(home / "Code" / "alpha"), "text": "~/Code/alpha"} and not out["error"]
    assert [d["text"] for d in folders.suggest("~/Code/alpha/")["dirs"]] == ["~/Code/alpha/src"]
    # A root lists what is inside it: the vault, home.
    assert [d["text"] for d in folders.suggest("vault")["dirs"]] == ["vault/Personal", "vault/Work"]
    assert "~/Code" in [d["text"] for d in folders.suggest("~")["dirs"]]
    # The first letters of a vault name are the vault being typed.
    out = folders.suggest("va")
    assert out["dirs"] == [{"name": "vault", "path": str(home / "Notes"), "text": "vault"}] and not out["error"]


def test_suggest_explains_what_is_wrong(home):
    assert folders.suggest("")["error"] is None and folders.suggest("")["dirs"] == []
    for text in ("Code/alpha", "~/Code/alpha/..", "~/Code/alpha.txt"):
        out = folders.suggest(text)
        assert out["error"] and out["folder"] is None, text
    assert folders.suggest("~/Code/alpha/../")["dirs"] == []
    assert folders.suggest(["x"]) == {"text": "", "folder": None, "error": None, "dirs": []}


def test_roots_are_the_vaults_then_home(home):
    assert folders.roots() == [{"kind": "vault", "path": str(home / "Notes"), "text": "vault"},
                               {"kind": "home", "path": str(home), "text": "~"}]


def test_a_new_session_starts_in_a_typed_folder(atlas_env, home):
    conn = db.connect()
    out = launch.new_session(conn, "vault", "привет")
    assert out["cwd"] == str(home / "Notes")
    assert out["command"].startswith(f"cd {shlex.quote(str(home / 'Notes'))} && claude ")
    assert launch.new_session(conn, f"{home}/Code/beta/", "")["cwd"] == str(home / "Code" / "beta")
    for bad in ("~/Code/alpha.txt", "~/Code/gone", "Code/beta", "~/Code/alpha/..", None):
        with pytest.raises(launch.LaunchError):
            launch.new_session(conn, bad, "привет")


def _post(base, token, route, body, lang="en"):
    req = urllib.request.Request(f"{base}{route}", data=json.dumps(body).encode(),
                                 headers={"Origin": base, "X-Atlas-Token": token, "X-Atlas-Lang": lang,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def test_folders_route_needs_the_page_token(atlas_env, home, live_server):
    base, token = live_server
    out = _post(base, token, "/api/folders", {"text": "~/Code/b"})
    assert [d["text"] for d in out["dirs"]] == ["~/Code/beta"]
    assert _post(base, token, "/api/folders", {"text": "~/nowhere/x"}, lang="ru")["error"].startswith("такой папки нет")
    with pytest.raises(urllib.error.HTTPError) as err:
        _post(base, "wrong", "/api/folders", {"text": "~"})
    assert err.value.code == 403


def test_workdirs_route_carries_field_text_and_quick_picks(atlas_env, home, live_server):
    base, _ = live_server
    with urllib.request.urlopen(f"{base}/api/workdirs", timeout=20) as r:
        out = json.loads(r.read())
    assert out["roots"][-1] == {"kind": "home", "path": str(home), "text": "~"}
    alpha = next(w for w in out["workdirs"] if w["path"] == str(home / "Code" / "alpha"))
    assert alpha["text"] == "~/Code/alpha"


def test_new_session_route_explains_a_bad_folder(atlas_env, home, live_server):
    base, token = live_server
    with pytest.raises(urllib.error.HTTPError) as err:
        _post(base, token, "/api/new-session", {"cwd": "~/Code/alpha.txt", "prompt": "x"})
    assert err.value.code == 400 and "alpha.txt" in json.loads(err.value.read())["error"]
