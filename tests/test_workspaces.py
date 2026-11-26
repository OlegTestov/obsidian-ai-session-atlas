from concurrent.futures import ThreadPoolExecutor

import pytest

from atlas import workspaces


def board(name="Project", columns=5, rows=5, slots=None, key="project"):
    return {"id": key, "name": name, "columns": columns, "rows": rows,
            "slots": slots if slots is not None else [None] * (columns * rows)}


@pytest.fixture(autouse=True)
def workspace_home(monkeypatch, tmp_path):
    monkeypatch.setenv("ATLAS_HOME", str(tmp_path))


def test_workspace_layout_survives_reload():
    assert workspaces.read() == {"revision": 0, "boards": []}
    roomy = board(name="  Мой проект  ")
    roomy["slots"][24] = "ses_ArbitrarySession"
    saved = workspaces.save(0, [roomy, board("One", 1, 1, key="one")])
    assert saved["revision"] == 1
    assert saved["boards"][0]["name"] == "Мой проект"
    assert saved["boards"][0]["slots"][24] == "ses_ArbitrarySession"
    assert workspaces.read() == saved


@pytest.mark.parametrize("boards", [
    [board(columns=6)], [board(rows=0)], [board(columns=True)], [board(slots=[])], [board(name="  ")],
    [board(), board()],
    [board(columns=1, rows=1, slots=["session"]), board(columns=1, rows=1, slots=["session"], key="other")],
])
def test_invalid_workspace_data_leaves_the_previous_snapshot(boards):
    prior = workspaces.save(0, [board()])
    with pytest.raises(ValueError):
        workspaces.save(prior["revision"], boards)
    assert workspaces.read() == prior


def test_simultaneous_workspace_edits_cannot_overwrite_one_another():
    def create(name):
        try:
            return workspaces.save(0, [board(name)])
        except workspaces.Conflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        successful = [result for result in pool.map(create, ["First", "Second"]) if result]
    assert len(successful) == 1
    assert workspaces.read() == successful[0]
