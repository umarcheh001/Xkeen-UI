"""Журнал загрузки службы называет вызывающего и время от включения роутера.

На роутере службу при каждой загрузке зовут дважды с разницей в секунду, и по
журналу нельзя было понять кто: поле `caller=` всегда оставалось пустым, потому
что `ps` из BusyBox не знает ключа `-o`. Даты тоже не помогали: до синхронизации
времени часы роутера стоят на старой дате, и записи загрузки датированы раньше
предыдущих. Теперь вызывающий читается из `/proc`, а рядом с датой стоит время
от включения — оно от часов не зависит.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "xkeen-ui" / "scripts" / "panel_init.sh"


def _function(name: str) -> str:
    text = TEMPLATE.read_text(encoding="utf-8")
    start = text.index(name + "() {")
    return text[start:text.index("\n}\n", start) + 3]


def _assignment(name: str) -> str:
    # Переменные объявлены в шапке службы, вне функций: без них функция,
    # вырезанная из файла, молча работает с пустым значением.
    for line in TEMPLATE.read_text(encoding="utf-8").splitlines():
        if line.startswith(name + "="):
            return line
    raise AssertionError(f"{name} не объявлена в {TEMPLATE.name}")


def _sh(script: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["sh", script.as_posix()], capture_output=True, text=True, encoding="utf-8", timeout=60)


def _has_proc() -> bool:
    probe = subprocess.run(
        ["sh", "-c", '[ -r "/proc/$PPID/cmdline" ] && [ -r /proc/uptime ]'], capture_output=True, timeout=60
    )
    return probe.returncode == 0


needs_proc = pytest.mark.skipif(not _has_proc(), reason="нужен /proc")


@needs_proc
def test_caller_is_read_from_proc(tmp_path):
    inner = tmp_path / "inner.sh"
    inner.write_bytes((_function("caller_name") + '\necho "caller=[$(caller_name)]"\n').encode("utf-8"))
    # Вторая команда после вызова нужна, чтобы оболочка не заменила себя
    # дочерним процессом: тогда родителем оказался бы уже не этот сценарий.
    outer = tmp_path / "boot-caller-marker.sh"
    outer.write_bytes(f'sh "{inner.as_posix()}"\necho done\n'.encode("utf-8"))

    proc = _sh(outer)

    caller = proc.stdout.split("caller=[", 1)[1].split("]", 1)[0]
    assert "boot-caller-marker.sh" in caller, proc.stdout + proc.stderr
    assert caller == caller.strip() and "\n" not in caller


@needs_proc
def test_multiline_caller_stays_on_one_line(tmp_path):
    inner = tmp_path / "inner.sh"
    inner.write_bytes((_function("caller_name") + '\necho "caller=[$(caller_name)]"\n').encode("utf-8"))

    proc = subprocess.run(
        ["sh", "-c", f'echo first-line\nsh "{inner.as_posix()}"\necho done'],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )

    caller = proc.stdout.split("caller=[", 1)[1].split("]", 1)[0]
    assert "first-line" in caller and "\n" not in caller, proc.stdout + proc.stderr


def test_caller_does_not_rely_on_ps_columns():
    text = TEMPLATE.read_text(encoding="utf-8")

    # `ps -o` в BusyBox отсутствует: команда молча печатала пустую строку.
    assert "ps -o" not in text
    assert "caller=$(caller_name)" in _function("start_service")


@needs_proc
def test_every_line_carries_uptime(tmp_path):
    log = tmp_path / "boot.log"
    script = tmp_path / "call.sh"
    script.write_bytes(
        "\n".join(
            [
                f'BOOT_LOG="{log.as_posix()}"',
                _assignment("UPTIME_FILE"),
                _function("boot_uptime"),
                _function("audit_boot"),
                'audit_boot "[start] first"',
                'audit_boot "[start] second"',
                "",
            ]
        ).encode("utf-8")
    )

    proc = _sh(script)

    lines = log.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2, proc.stdout + proc.stderr
    for line, tail in zip(lines, ("[start] first", "[start] second")):
        assert re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d up=\d+s " + re.escape(tail), line), line


def test_line_survives_without_uptime(tmp_path):
    log = tmp_path / "boot.log"
    script = tmp_path / "call.sh"
    script.write_bytes(
        "\n".join(
            [
                f'BOOT_LOG="{log.as_posix()}"',
                f'UPTIME_FILE="{(tmp_path / "absent").as_posix()}"',
                _function("boot_uptime"),
                _function("audit_boot"),
                'audit_boot "[start] first"',
                "",
            ]
        ).encode("utf-8")
    )

    proc = _sh(script)

    line = log.read_text(encoding="utf-8").strip()
    assert re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[start\] first", line), line + proc.stderr
