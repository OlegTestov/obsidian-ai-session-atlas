"""Cleanup mutations must execute their behavior tests, not only bundle inspection."""
import sys

import pytest

from tools import mutations


def test_runtime_mutations_include_indexer_cleanup():
    assert "tests/js/indexer-cleanup.test.mjs" in mutations.js_tests("obsidian-plugin/src/runtime.js")


@pytest.mark.parametrize("needle", ["still-owned", "another catalog"])
@pytest.mark.parametrize("flags", [[], ["--js"]])
def test_cleanup_mutations_select_node_runner(monkeypatch, needle, flags):
    calls = []

    def node(path, name):
        calls.append((path, name))
        return 1  # the selected behavior test detects the injected mutation

    def python():
        pytest.fail("JavaScript mutation selected the Python suite")

    monkeypatch.setattr(sys, "argv", ["mutations.py", *flags, "--only", needle])
    monkeypatch.setattr(mutations, "run_node", node)
    monkeypatch.setattr(mutations, "run_python", python)
    monkeypatch.setattr(mutations, "mutate", lambda _path, _old, _new, run: run() != 0)
    assert mutations.main() == 0
    assert len(calls) == 1 and calls[0][0] == "obsidian-plugin/src/runtime.js"
    assert calls[0][1] in mutations.SELECTOR_MUTATIONS


def test_empty_language_selection_is_not_reported_as_success(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["mutations.py", "--python", "--only", "still-owned"])
    monkeypatch.setattr(mutations, "mutate", lambda *_args: pytest.fail("empty selection ran a mutation"))
    assert mutations.main() == 1
    assert "No mutations match" in capsys.readouterr().out


@pytest.mark.parametrize("name", sorted(mutations.SELECTOR_MUTATIONS))
def test_selector_mutations_never_run_real_process_cleanup(monkeypatch, name):
    calls = []
    monkeypatch.setattr(mutations, "_run", lambda cmd: calls.append(cmd) or 1)
    assert mutations.run_node("obsidian-plugin/src/runtime.js", name) == 1
    assert calls[0][-2:] == ["--test-name-pattern=cleanup selects only", "tests/js/indexer-cleanup.test.mjs"]
    assert "tests/js/bundle.test.mjs" not in calls[0]
