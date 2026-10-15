"""Status line context segment: used tokens, auto-compact point (or "off"), window."""
import json

import pytest

from atlas import statusline

SAMPLE = {"model": {"display_name": "Opus 5.5"},
          "context_window": {"context_window_size": 1000000,
                             "current_usage": {"input_tokens": 2, "output_tokens": 16,
                                               "cache_creation_input_tokens": 1029,
                                               "cache_read_input_tokens": 226217}}}


ENV = ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "DISABLE_AUTO_COMPACT", "DISABLE_COMPACT",
       "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE")


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    """Never read the real settings or the caller's env."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    for name in ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(statusline, "MANAGED_SETTINGS", str(tmp_path / "managed.json"))
    return tmp_path


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")


def user(tmp, content):
    write(tmp / "claude" / "settings.json", content)


def project(tmp, content, local=False):
    write(tmp / "proj" / ".claude" / ("settings.local.json" if local else "settings.json"), content)


def managed(tmp, content):
    write(tmp / "managed.json", content)


def payload(tmp=None, size=1000000, model=None, **usage):
    base = {"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
            "output_tokens": 0}
    data = {"context_window": {"context_window_size": size, "current_usage": dict(base, **usage)}}
    if model:
        data["model"] = {"id": model}
    if tmp is not None:
        data["workspace"] = {"project_dir": str(tmp / "proj"), "current_dir": "/nonexistent"}
    return data


def compact(data, lang="en"):
    """The middle part of the segment."""
    return statusline.context_segment(data, lang).split(" · ")[1]


def test_english_and_russian(isolated):
    user(isolated, {"autoCompactWindow": 500000})
    assert statusline.line(SAMPLE, "en") == "Opus 5.5 · context 227k · compact at ~467k · window 1M"
    assert statusline.line(SAMPLE, "ru") == "Opus 5.5 · контекст 227k · сжатие ~467k · окно 1M"


def test_no_setting_means_window_minus_buffer():
    assert compact(payload()) == "compact at ~967k"


def test_output_tokens_are_not_counted():
    assert statusline.context_segment(payload(input_tokens=100000, output_tokens=400000)).startswith(
        "context 100k ")


def test_missing_context_window_or_usage_omits_segment():
    assert statusline.line({"model": {"display_name": "M"}}) == "M"
    assert statusline.line({"model": {"display_name": "M"}, "context_window": {"context_window_size": 5}}) == "M"
    assert statusline.line({"model": {"display_name": "M"}, "context_window": {
        "context_window_size": 1000000, "current_usage": None}}) == "M"
    assert statusline.line({"context_window": "junk"}) == ""
    assert statusline.context_segment(payload(input_tokens="x")) == ""
    assert statusline.context_segment({"context_window": {"current_usage": {}}}) == ""


@pytest.mark.parametrize("name", ["DISABLE_AUTO_COMPACT", "DISABLE_COMPACT"])
@pytest.mark.parametrize("value", ["1", "true", "TRUE"])
def test_off_by_env(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    assert compact(payload()) == "compact off"
    assert compact(payload(), "ru") == "сжатие выкл"


def test_env_not_truthy_is_ignored(monkeypatch):
    monkeypatch.setenv("DISABLE_AUTO_COMPACT", "0")
    monkeypatch.setenv("DISABLE_COMPACT", "")
    assert compact(payload()) == "compact at ~967k"


def test_off_by_user_settings(isolated):
    user(isolated, {"autoCompactEnabled": False, "autoCompactWindow": 500000})
    assert compact(payload(isolated)) == "compact off"


def test_off_by_project_local_settings(isolated):
    user(isolated, {"autoCompactEnabled": True})
    project(isolated, {"autoCompactEnabled": False}, local=True)
    assert compact(payload(isolated)) == "compact off"


def test_enabled_true_is_not_off(isolated):
    user(isolated, {"autoCompactEnabled": True})
    assert compact(payload(isolated)) == "compact at ~967k"


def test_env_window_beats_model_settings_beats_top_level(isolated, monkeypatch):
    user(isolated, {"autoCompactWindow": 300000,
                    "modelSettings": {"opus": {"autoCompactWindow": 400000}}})
    assert compact(payload(isolated, model="opus")) == "compact at ~367k"
    assert compact(payload(isolated, model="other")) == "compact at ~267k"
    assert compact(payload(isolated)) == "compact at ~267k"
    monkeypatch.setenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "600000")
    assert compact(payload(isolated, model="opus")) == "compact at ~567k"


def test_model_setting_auto_falls_back_to_top_level(isolated):
    user(isolated, {"autoCompactWindow": 300000, "modelSettings": {"opus": {"autoCompactWindow": "auto"}}})
    assert compact(payload(isolated, model="opus")) == "compact at ~267k"


def test_precedence_local_over_project_over_user(isolated):
    user(isolated, {"autoCompactWindow": 300000})
    assert compact(payload(isolated)) == "compact at ~267k"
    project(isolated, {"autoCompactWindow": 400000})
    assert compact(payload(isolated)) == "compact at ~367k"
    project(isolated, {"autoCompactWindow": 500000}, local=True)
    assert compact(payload(isolated)) == "compact at ~467k"
    managed(isolated, {"autoCompactWindow": 600000})
    assert compact(payload(isolated)) == "compact at ~567k"


def test_keys_merge_across_files(isolated):
    user(isolated, {"autoCompactWindow": 300000})
    project(isolated, {"autoCompactEnabled": True}, local=True)
    assert compact(payload(isolated)) == "compact at ~267k"


def test_managed_off_beats_everything(isolated):
    project(isolated, {"autoCompactEnabled": True}, local=True)
    managed(isolated, {"autoCompactEnabled": False})
    assert compact(payload(isolated)) == "compact off"


def test_project_dir_falls_back_to_current_dir_then_cwd(isolated):
    project(isolated, {"autoCompactWindow": 400000})
    data = payload()
    data["workspace"] = {"current_dir": str(isolated / "proj")}
    assert compact(data) == "compact at ~367k"
    data = payload()
    data["cwd"] = str(isolated / "proj")
    assert compact(data) == "compact at ~367k"


@pytest.mark.parametrize("value", ["500k", "1e5", "-5", "12.5", "", "abc"])
def test_invalid_env_window_is_ignored(isolated, monkeypatch, value):
    user(isolated, {"autoCompactWindow": 300000})
    monkeypatch.setenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", value)
    assert compact(payload(isolated)) == "compact at ~267k"


def test_window_clamped(isolated, monkeypatch):
    user(isolated, {"autoCompactWindow": 50000})
    assert compact(payload(isolated)) == "compact at ~67k"
    user(isolated, {"autoCompactWindow": 5000000})
    assert compact(payload(isolated, size=2000000)) == "compact at ~967k"
    monkeypatch.setenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "99999")
    assert compact(payload(isolated)) == "compact at ~67k"


def test_window_capped_at_context_size(isolated):
    user(isolated, {"autoCompactWindow": 900000})
    assert compact(payload(isolated, size=200000)) == "compact at ~167k"


def test_200k_window_without_setting():
    assert statusline.context_segment(payload(size=200000, input_tokens=50000)) == (
        "context 50k · compact at ~167k · window 200k")


def test_pct_override_lowers_only(isolated, monkeypatch):
    user(isolated, {"autoCompactWindow": 500000})
    monkeypatch.setenv("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "50")
    assert compact(payload(isolated)) == "compact at ~250k"
    monkeypatch.setenv("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "95")
    assert compact(payload(isolated)) == "compact at ~467k"


@pytest.mark.parametrize("value", ["0", "101", "abc", "50%", "-3"])
def test_pct_override_out_of_range_is_ignored(monkeypatch, value):
    monkeypatch.setenv("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", value)
    assert compact(payload()) == "compact at ~967k"


@pytest.mark.parametrize("text", ["{not json", "[]", '"x"', "null", json.dumps({"modelSettings": []})])
def test_broken_files_are_skipped(isolated, text):
    user(isolated, {"autoCompactWindow": 300000})
    project(isolated, text)
    project(isolated, text, local=True)
    managed(isolated, text)
    assert compact(payload(isolated, model="m")) == "compact at ~267k"


def test_nothing_readable_falls_back_to_window(isolated):
    project(isolated, "[]")
    assert compact(payload(isolated)) == "compact at ~967k"


def test_number_formatting():
    assert statusline._tokens(228000) == "228k"
    assert statusline._tokens(227248) == "227k"
    assert statusline._tokens(999600) == "1M"
    assert statusline._tokens(1000000) == "1M"
    assert statusline._tokens(1500000) == "1.5M"
    assert "window 1.5M" in statusline.context_segment(payload(size=1500000))
