"""Байткод панели должен готовиться фоном, а не за счёт первого посетителя.

Кэш байткода лежит в PYTHONPYCACHEPREFIX — то есть в /tmp, а это tmpfs в ОЗУ,
и перезагрузка роутера стирает его целиком. Из-за ленивых импортов часть
компиляции приходится не на старт службы, а на первый запрос человека: панель
открывается заметно медленнее обычного. Замер на 45.1 (ARMv8, 226 модулей):
2,92 с вхолодную против 0,23 с с готовым кэшем; на слабых роутерах кратно
больше.

Поэтому init-скрипт после успешного запуска догоняет компиляцию фоном, пока
страницу ещё никто не открыл. Прогрев обязан быть необязательным: он ускоряет,
но не имеет права помешать запуску панели.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

INSTALLER = Path("xkeen-ui/install.sh")
SH = shutil.which("sh") or shutil.which("bash")


def _installer_text() -> str:
    return INSTALLER.read_text(encoding="utf-8")


def _warm_function() -> str:
    text = _installer_text()
    body = text.split("warm_bytecode_cache() {", 1)[1]
    return "warm_bytecode_cache() {" + body.split("\n}\n", 1)[0] + "\n}\n"


def _run_warmup(
    ui_dir: Path, cache_dir: Path, python_bin: str, wait: bool = True
) -> subprocess.CompletedProcess:
    script = "\n".join(
        [
            "audit_boot() { :; }",
            f'PYTHON_BIN="{python_bin}"',
            f'UI_DIR="{ui_dir.as_posix()}"',
            f'PYTHONPYCACHEPREFIX="{cache_dir.as_posix()}"',
            "export PYTHONPYCACHEPREFIX",
            _warm_function(),
            "warm_bytecode_cache",
            # Прогрев уходит в фон; обычно тест дожидается его вместо
            # роутера, но проверке фоновости ждать как раз нельзя.
            "wait" if wait else ":",
            'echo "exit=$?"',
        ]
    )
    return subprocess.run([SH, "-c", script], capture_output=True, text=True, timeout=120)


@pytest.fixture()
def panel_tree(tmp_path: Path) -> Path:
    ui_dir = tmp_path / "xkeen-ui"
    (ui_dir / "routes").mkdir(parents=True)
    (ui_dir / "app_factory.py").write_text("VALUE = 1\n", encoding="utf-8")
    (ui_dir / "routes" / "ui_assets.py").write_text("def helper():\n    return 2\n", encoding="utf-8")
    return ui_dir


@pytest.mark.skipif(not SH, reason="POSIX-оболочка недоступна")
def test_warmup_compiles_the_panel_into_the_cache(panel_tree: Path, tmp_path: Path) -> None:
    cache_dir = tmp_path / "pycache"

    result = _run_warmup(panel_tree, cache_dir, sys.executable)

    assert result.returncode == 0, result.stderr
    # Считать .pyc бессмысленно: python кладёт в префикс и свои модули
    # (argparse и прочие) даже когда компилировать нечего. Ищем файлы панели.
    names = {path.name.split(".", 1)[0] for path in cache_dir.rglob("*.pyc")}
    assert {"app_factory", "ui_assets"} <= names, sorted(names)


@pytest.mark.skipif(not SH, reason="POSIX-оболочка недоступна")
def test_warmup_survives_a_missing_interpreter(panel_tree: Path, tmp_path: Path) -> None:
    """Прогрев — ускорение, а не условие запуска: его провал ничего не ломает."""

    cache_dir = tmp_path / "pycache"

    result = _run_warmup(panel_tree, cache_dir, "/nonexistent/python3")

    assert result.returncode == 0, result.stderr
    assert "exit=0" in result.stdout


@pytest.mark.skipif(not SH, reason="POSIX-оболочка недоступна")
def test_warmup_does_not_delay_the_start(panel_tree: Path, tmp_path: Path) -> None:
    """Компиляция обязана уйти в фон: старт службы её не дожидается."""

    slow_python = tmp_path / "slow-python"
    slow_python.write_text("#!/bin/sh\nsleep 5\n", encoding="utf-8", newline="\n")
    slow_python.chmod(0o755)

    started = time.monotonic()
    _run_warmup(panel_tree, tmp_path / "pycache", slow_python.as_posix(), wait=False)
    elapsed = time.monotonic() - started

    assert elapsed < 2.5, f"прогрев задержал старт на {elapsed:.1f} с"


def test_warmup_runs_only_after_the_panel_is_confirmed_alive() -> None:
    """Сначала панель, потом прогрев: иначе компиляция конкурирует со стартом."""

    text = _installer_text()
    start = text.index("start_service() {")
    body = text[start : text.index("\nstop_service() {", start)]

    alive_check = body.index('if kill -0 "$CHILD_PID"')
    warm_call = body.index("warm_bytecode_cache")
    ok_return = body.index("    return 0", alive_check)

    assert alive_check < warm_call < ok_return


def test_warmup_yields_cpu_to_the_panel() -> None:
    """Одноядерный роутер: прогрев не должен спорить за процессор с панелью."""

    assert "nice" in _warm_function()
