"""Служба автозапуска не принимает чужой процесс за панель.

Номер процесса панели записан в файл на накопителе, и перезагрузку роутера файл
переживает. Номера же при загрузке повторяются: в журнале с роутера панель
получала то 966, то 967 — через раз. Достаточно, чтобы прежний номер достался
другому процессу, и служба отвечала бы «уже запущена», не запуская панель, а
`stop` снимал бы чужой процесс. Теперь служба смотрит, что это за процесс.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "xkeen-ui" / "scripts" / "panel_init.sh"


def _function(name: str) -> str:
    text = TEMPLATE.read_text(encoding="utf-8")
    start = text.index(name + "() {")
    return text[start:text.index("\n}\n", start) + 3]


def _run(tmp_path: Path, body: str) -> subprocess.CompletedProcess:
    ui = tmp_path / "xkeen-ui"
    ui.mkdir(exist_ok=True)
    # «Панель» проверки — сценарий, который просто живёт: службе важна только
    # командная строка процесса.
    for name in ("run_server.py", "app.py", "other.sh"):
        (ui / name).write_bytes(b"sleep 30\n")
    script = tmp_path / "call.sh"
    script.write_bytes(
        "\n".join(
            [
                f'UI_DIR="{ui.as_posix()}"',
                'RUN_SERVER="$UI_DIR/run_server.py"',
                'APP_PY="$UI_DIR/app.py"',
                f'PID_FILE="{(tmp_path / "panel.pid").as_posix()}"',
                _function("panel_pid"),
                body,
                'kill "$started" 2>/dev/null || true',
                "",
            ]
        ).encode("utf-8")
    )
    return subprocess.run(["sh", script.as_posix()], capture_output=True, text=True, encoding="utf-8", timeout=60)


needs_proc = pytest.mark.skipif(not Path("/proc/self/cmdline").exists() and os.name != "nt", reason="нужен /proc")


@needs_proc
@pytest.mark.parametrize("target", ["run_server.py", "app.py"])
def test_the_panel_itself_is_recognised(tmp_path, target):
    proc = _run(
        tmp_path,
        f'sh "$UI_DIR/{target}" & started=$!; echo "$started" > "$PID_FILE"; sleep 1; '
        'found="$(panel_pid)" && echo "panel=$found started=$started" || echo "not-panel"',
    )

    assert "panel=" in proc.stdout, proc.stdout + proc.stderr
    found, started = proc.stdout.split("panel=", 1)[1].split()[0], proc.stdout.split("started=", 1)[1].split()[0]
    assert found == started


@needs_proc
def test_another_process_under_the_remembered_number_is_not_the_panel(tmp_path):
    proc = _run(
        tmp_path,
        'sh "$UI_DIR/other.sh" & started=$!; echo "$started" > "$PID_FILE"; sleep 1; '
        'found="$(panel_pid)" && echo "panel=$found" || echo "not-panel"',
    )

    assert "not-panel" in proc.stdout, proc.stdout + proc.stderr


def test_a_number_nobody_holds_is_not_the_panel(tmp_path):
    proc = _run(
        tmp_path,
        'sh "$UI_DIR/run_server.py" & started=$!; kill "$started"; wait "$started" 2>/dev/null; '
        'echo "$started" > "$PID_FILE"; found="$(panel_pid)" && echo "panel=$found" || echo "not-panel"',
    )

    assert "not-panel" in proc.stdout, proc.stdout + proc.stderr


@pytest.mark.parametrize("content", ["", "abc\n", "12 34\n", "-1\n"])
def test_a_damaged_file_is_not_the_panel(tmp_path, content):
    (tmp_path / "panel.pid").write_text(content, encoding="utf-8")

    proc = _run(tmp_path, 'started=""; found="$(panel_pid)" && echo "panel=$found" || echo "not-panel"')

    assert "not-panel" in proc.stdout, proc.stdout + proc.stderr


def test_no_file_means_no_panel(tmp_path):
    proc = _run(tmp_path, 'started=""; found="$(panel_pid)" && echo "panel=$found" || echo "not-panel"')

    assert "not-panel" in proc.stdout, proc.stdout + proc.stderr


def test_start_stop_and_status_all_ask_who_holds_the_number():
    text = TEMPLATE.read_text(encoding="utf-8")

    for name in ("start_service", "stop_service", "status_service"):
        body = _function(name)
        assert "panel_pid" in body, name
        # Голая проверка «номер занят» не отличает панель от чужого процесса.
        assert 'kill -0 "$(cat "$PID_FILE"' not in body, name
