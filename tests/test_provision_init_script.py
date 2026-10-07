"""Служба автозапуска панели — отдельный файл, а не текст внутри установщика.

От этого скрипта зависит, поднимется ли панель после перезагрузки роутера.
Пока он был зашит в `install.sh`, обновление из панели не могло его заменить:
правки запуска доходили только до тех, кто переустанавливал панель. Теперь
текст лежит в `scripts/panel_init.sh`, а ставит его общий скрипт — подставляет
порт и заменяет прежнюю службу одним переименованием.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "xkeen-ui" / "scripts" / "provision_env.sh"
TEMPLATE = ROOT / "xkeen-ui" / "scripts" / "panel_init.sh"
INSTALLER = ROOT / "xkeen-ui" / "install.sh"


def _run(tmp_path: Path, template: Path, target: Path, port: str = "8091") -> subprocess.CompletedProcess:
    script = tmp_path / "call.sh"
    script.write_bytes(
        "\n".join(
            [
                "set -e",
                f'. "{LIB.as_posix()}"',
                f'provision_init_script "{template.as_posix()}" "{target.as_posix()}" "{port}"',
                "",
            ]
        ).encode("utf-8")
    )
    return subprocess.run(["sh", script.as_posix()], capture_output=True, text=True, encoding="utf-8")


def test_the_service_text_is_a_valid_shell_script_with_unix_line_endings():
    proc = subprocess.run(["sh", "-n", TEMPLATE.as_posix()], capture_output=True, text=True)

    assert proc.returncode == 0, proc.stderr
    assert b"\r" not in TEMPLATE.read_bytes()
    assert TEMPLATE.read_text(encoding="utf-8").startswith("#!/bin/sh\n")


def test_the_service_keeps_everything_it_did_inside_the_installer():
    text = TEMPLATE.read_text(encoding="utf-8")

    for piece in (
        'XKEEN_UI_INIT_OWNER="umarcheh001/Xkeen-UI"',
        'PANEL_PORT="__XKEEN_UI_PORT__"',
        "warm_bytecode_cache() {",
        "start_service() {",
        "stop_service() {",
        "status_service() {",
        "# >>> module-operation-recovery",
        'export XKEEN_UI_PORT="${XKEEN_UI_PORT:-$PANEL_PORT}"',
    ):
        assert piece in text, piece


def test_the_installed_service_carries_the_port_of_the_panel(tmp_path):
    target = tmp_path / "init.d" / "S99xkeen-ui-umarcheh001"
    target.parent.mkdir()

    proc = _run(tmp_path, TEMPLATE, target, "8091")

    assert proc.returncode == 0, proc.stderr
    text = target.read_text(encoding="utf-8")
    assert 'PANEL_PORT="8091"' in text
    assert "__XKEEN_UI_PORT__" not in text
    assert text.replace('PANEL_PORT="8091"', 'PANEL_PORT="__XKEEN_UI_PORT__"') == TEMPLATE.read_text(encoding="utf-8")
    assert sorted(path.name for path in target.parent.iterdir()) == [target.name]
    if os.name != "nt":
        assert os.access(target, os.X_OK)


def test_a_service_that_cannot_be_built_leaves_the_previous_one_in_place(tmp_path):
    target = tmp_path / "S99xkeen-ui-umarcheh001"
    target.write_text("#!/bin/sh\n# previous service\n", encoding="utf-8")

    proc = _run(tmp_path, tmp_path / "no-such-template.sh", target)

    # Без службы панель не переживёт перезагрузку роутера: это не тот сбой,
    # который можно проглотить, и прежний скрипт при нём должен уцелеть.
    assert proc.returncode != 0
    assert target.read_text(encoding="utf-8") == "#!/bin/sh\n# previous service\n"
    assert sorted(path.name for path in tmp_path.iterdir() if path.name.startswith("S99")) == [target.name]


def test_the_installer_no_longer_carries_the_service_text():
    installer = INSTALLER.read_text(encoding="utf-8")

    assert 'cat > "$INIT_SCRIPT"' not in installer
    assert "start_service() {" not in installer
    assert 'provision_init_script "$SRC_DIR/scripts/panel_init.sh" "$INIT_SCRIPT" "$PANEL_PORT"' in installer
