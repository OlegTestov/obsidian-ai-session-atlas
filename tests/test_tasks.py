"""Задачи агента для карточки «Активных»: счёт, текущая, удалённые, порядок по номеру."""
from __future__ import annotations

import json

from atlas import tasks


def _task(folder, n, status, subject, active=""):
    (folder / f"{n}.json").write_text(json.dumps(
        {"id": str(n), "subject": subject, "activeForm": active, "status": status}), encoding="utf-8")


def test_progress_counts_done_and_names_what_runs(tmp_path):
    folder = tmp_path / "sid"
    folder.mkdir()
    _task(folder, 10, "pending", "десятая")
    _task(folder, 2, "in_progress", "вторая", "Делаю вторую")
    _task(folder, 1, "completed", "первая")
    _task(folder, 3, "deleted", "удалённая")
    (folder / "4.json").write_text("{битый", encoding="utf-8")
    p = tasks.progress("sid", root=str(tmp_path))
    assert (p["total"], p["done"]) == (3, 1)
    assert p["active"] == ["Делаю вторую"]
    assert [i["subject"] for i in p["items"]] == ["первая", "вторая", "десятая"]


def test_no_folder_or_only_deleted_means_no_tasks(tmp_path):
    assert tasks.progress("нет", root=str(tmp_path)) is None
    folder = tmp_path / "sid"
    folder.mkdir()
    _task(folder, 1, "deleted", "x")
    assert tasks.progress("sid", root=str(tmp_path)) is None


def test_active_without_active_form_falls_back_to_subject(tmp_path):
    folder = tmp_path / "sid"
    folder.mkdir()
    _task(folder, 1, "in_progress", "проверить MR")
    assert tasks.progress("sid", root=str(tmp_path))["active"] == ["проверить MR"]
