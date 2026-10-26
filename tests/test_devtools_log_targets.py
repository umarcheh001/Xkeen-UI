from __future__ import annotations

from pathlib import Path

from services.devtools import logs


def _targets(tmp_path, monkeypatch):
    log_dir = tmp_path / "var" / "log" / "xkeen-ui"
    log_dir.mkdir(parents=True)
    monkeypatch.setenv("XKEEN_UI_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("XKEEN_LOG_DIR", str(log_dir))
    from services import logging_setup

    monkeypatch.setattr(logging_setup, "get_paths", lambda *_a, **_k: (
        str(log_dir / "core.log"), str(log_dir / "access.log"), str(log_dir / "ws.log"),
    ))
    return {item["name"]: item for item in logs.list_logs()}, log_dir


def test_updates_target_points_to_history(tmp_path, monkeypatch):
    listed, _ = _targets(tmp_path, monkeypatch)

    assert "update" not in listed
    updates = listed["updates"]
    assert Path(updates["path"]) == tmp_path / "state" / "module-operations" / "history.jsonl"
    assert updates["exists"] is False


def test_install_logs_are_listed_and_old_notes_are_not(tmp_path, monkeypatch):
    listed, log_dir = _targets(tmp_path, monkeypatch)

    assert "xkeen-ui" not in listed
    assert Path(listed["install"]["path"]) == log_dir.parent / "xkeen-ui-install.log"
    assert Path(listed["install-previous"]["path"]) == log_dir.parent / "xkeen-ui-install.log.previous"
