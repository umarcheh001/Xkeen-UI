"""Команда перезапуска самой панели: служба панели, а не XKeen."""

from __future__ import annotations

from pathlib import Path

import pytest

from services import panel_service


OURS = '#!/bin/sh\nXKEEN_UI_INIT_OWNER="umarcheh001/Xkeen-UI"\n'


def _script(path: Path, body: str = OURS) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)
    return str(path)


@pytest.fixture
def init_dir(tmp_path, monkeypatch) -> Path:
    directory = tmp_path / "init.d"
    monkeypatch.delenv("XKEEN_UI_INIT_SCRIPT", raising=False)
    monkeypatch.setattr(panel_service, "PANEL_INIT_SCRIPT_DEFAULT", str(directory / "S99xkeen-ui-umarcheh001"))
    monkeypatch.setattr(panel_service, "PANEL_INIT_SCRIPT_LEGACY", str(directory / "S99xkeen-ui"))
    return directory


def test_restart_command_is_the_panel_service_script(init_dir):
    script = _script(init_dir / "S99xkeen-ui-umarcheh001")

    assert panel_service.resolve_panel_init_script() == script
    assert panel_service.panel_restart_command() == [script, "restart"]


def test_legacy_script_is_used_only_when_it_is_ours(init_dir):
    foreign = _script(init_dir / "S99xkeen-ui", "#!/bin/sh\n# another panel\n")

    assert panel_service.resolve_panel_init_script() is None

    Path(foreign).write_text(
        '#!/bin/sh\nUI_DIR="/opt/etc/xkeen-ui"\nRUN_SERVER="$UI_DIR/run_server.py"\n', encoding="utf-8"
    )

    assert panel_service.resolve_panel_init_script() == foreign


def test_explicit_override_wins(init_dir, monkeypatch):
    _script(init_dir / "S99xkeen-ui-umarcheh001")
    custom = _script(init_dir / "custom-control", "#!/bin/sh\n")
    monkeypatch.setenv("XKEEN_UI_INIT_SCRIPT", custom)

    assert panel_service.panel_restart_command() == [custom, "restart"]


def test_without_a_service_script_there_is_no_restart_command(init_dir):
    assert panel_service.resolve_panel_init_script() is None
    assert panel_service.panel_restart_command() == []
    assert panel_service.restart_panel("test") is False


def test_restart_panel_runs_the_service_script_detached(init_dir, monkeypatch):
    script = _script(init_dir / "S99xkeen-ui-umarcheh001")
    calls: list[tuple[list[str], dict]] = []
    monkeypatch.setattr(panel_service.subprocess, "Popen", lambda command, **options: calls.append((command, options)))

    assert panel_service.restart_panel("module-lifecycle") is True

    assert [command for command, _options in calls] == [[script, "restart"]]
    options = calls[0][1]
    # Перезапуск убивает панель: процесс, который его ведёт, не должен уйти вместе с ней.
    assert options.get("start_new_session") is True or options.get("creationflags")


def test_restart_panel_reports_a_script_that_cannot_be_started(init_dir, monkeypatch):
    _script(init_dir / "S99xkeen-ui-umarcheh001")

    def refuse(_command, **_options):
        raise OSError("cannot execute")

    monkeypatch.setattr(panel_service.subprocess, "Popen", refuse)

    assert panel_service.restart_panel("module-lifecycle") is False


def test_devtools_service_control_uses_the_same_script(init_dir):
    from services.devtools import ui_service

    script = _script(init_dir / "S99xkeen-ui-umarcheh001")

    assert ui_service._resolve_ui_init_script() == script
