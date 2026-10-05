"""Обрыв питания посреди установки модуля не должен оставлять панель наполовину заменённой.

Операцию ведёт отдельный процесс; если он погиб, доиграть откат некому, кроме
того, кто запускает панель: init-скрипт при загрузке роутера и установщик перед
раскладкой файлов. Оба зовут `module_transaction.py recover`. Без незавершённой
операции это одна проверка каталога в оболочке — Python не стартует, загрузка
роутера не замедляется.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
INSTALL = ROOT / "xkeen-ui" / "install.sh"
UNINSTALL = ROOT / "xkeen-ui" / "uninstall.sh"
BEGIN = "# >>> module-operation-recovery"
END = "# <<< module-operation-recovery"


def _source() -> str:
    return INSTALL.read_text(encoding="utf-8")


def _init_template(source: str) -> str:
    start = source.index('cat > "$INIT_SCRIPT" << \'EOF\'')
    return source[start:source.index("\nEOF\n", start)]


def _fragment(text: str) -> str:
    return text[text.index(BEGIN):text.index(END)]


def test_init_script_recovers_before_it_starts_the_panel() -> None:
    template = _init_template(_source())
    start_service = template[template.index("start_service() {"):]

    recovery = start_service.index(BEGIN)
    assert start_service.index('audit_boot "[start] target=$TARGET"') < recovery
    assert recovery < start_service.index('if [ -f "$PID_FILE" ] && kill -0')
    fragment = _fragment(start_service)
    assert '"$UI_DIR.module-transactions"' in fragment
    assert '"$UI_DIR/scripts/module_transaction.py" recover' in fragment
    assert '--panel-root "$UI_DIR" --state-dir "$UI_DIR"' in fragment
    # Сбой восстановления не должен помешать запуску панели.
    assert "non-fatal" in fragment
    assert "return 1" not in fragment and "exit " not in fragment


def test_init_script_does_not_wait_for_recovery_in_the_background() -> None:
    fragment = _fragment(_init_template(_source()))

    # Откат обязан закончиться до старта панели, иначе она поднимется на смеси версий.
    assert "&\n" not in fragment and not fragment.rstrip().endswith("&")


def test_installer_recovers_before_it_lays_out_the_profile() -> None:
    source = _source()
    installer_part = source[: source.index('cat > "$INIT_SCRIPT" << \'EOF\'')]

    recovery = installer_part.index('scripts/module_transaction.py" recover')
    assert recovery < installer_part.index('"$INSTALL_PROFILE_HELPER" apply')
    line = installer_part[installer_part.rindex("\n", 0, recovery):installer_part.index("\n", recovery)]
    assert '"$UI_DIR/scripts/module_transaction.py"' in line


def test_installer_drops_operation_leftovers_after_a_successful_start() -> None:
    source = _source()

    commit = source.index('"$INSTALL_PROFILE_HELPER" commit --transaction "$PROFILE_TRANSACTION"')
    cleanup = source.index('rm -rf "$UI_DIR.module-transactions"')
    assert commit < cleanup < source.index('log_install "[=] Итог установки:"')


def test_uninstall_removes_the_operation_directory() -> None:
    source = UNINSTALL.read_text(encoding="utf-8")

    assert 'rm -rf "$UI_DIR.module-transactions"' in source
    assert source.index('rm -rf "$UI_DIR"\n') < source.index('rm -rf "$UI_DIR.module-transactions"')


def _run_fragment(tmp_path: Path, *, with_operation: bool, with_script: bool, python_exit: int = 0) -> tuple[str, str]:
    sh = shutil.which("sh")
    if sh is None:
        pytest.skip("needs a POSIX shell")
    ui_dir = tmp_path / "xkeen-ui"
    (ui_dir / "scripts").mkdir(parents=True)
    if with_script:
        (ui_dir / "scripts" / "module_transaction.py").write_text("# runner\n", encoding="utf-8")
    transactions = tmp_path / "xkeen-ui.module-transactions"
    transactions.mkdir()
    if with_operation:
        (transactions / "20261005T000000Z-abcdef").mkdir()
    calls = tmp_path / "python-calls.log"
    boot = tmp_path / "boot.log"
    fake_python = tmp_path / "python3"
    fake_python.write_text(f'#!/bin/sh\necho "$@" >> "{calls.as_posix()}"\nexit {python_exit}\n', encoding="utf-8", newline="\n")
    fake_python.chmod(0o755)
    script = "\n".join(
        [
            "set -e",
            f'UI_DIR="{ui_dir.as_posix()}"',
            f'PYTHON_BIN="{fake_python.as_posix()}"',
            f'audit_boot() {{ echo "$1" >> "{boot.as_posix()}"; }}',
            _fragment(_init_template(_source())),
            "echo reached-the-start",
        ]
    )
    done = subprocess.run([sh, "-c", script], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert done.returncode == 0, done.stderr
    assert "reached-the-start" in done.stdout
    return (calls.read_text(encoding="utf-8") if calls.exists() else "", boot.read_text(encoding="utf-8") if boot.exists() else "")


def test_fragment_starts_no_python_without_an_unfinished_operation(tmp_path: Path) -> None:
    calls, boot = _run_fragment(tmp_path, with_operation=False, with_script=True)

    assert calls == ""
    assert boot == ""


def test_fragment_calls_recover_for_an_unfinished_operation(tmp_path: Path) -> None:
    calls, boot = _run_fragment(tmp_path, with_operation=True, with_script=True)

    assert "module_transaction.py recover --panel-root" in calls
    assert "--state-dir" in calls
    assert "unfinished module operation" in boot
    assert "non-fatal" not in boot


def test_fragment_survives_a_failing_recovery(tmp_path: Path) -> None:
    calls, boot = _run_fragment(tmp_path, with_operation=True, with_script=True, python_exit=1)

    assert "recover" in calls
    assert "non-fatal" in boot


def test_fragment_skips_recovery_when_the_runner_is_not_installed(tmp_path: Path) -> None:
    calls, _boot = _run_fragment(tmp_path, with_operation=True, with_script=False)

    assert calls == ""
