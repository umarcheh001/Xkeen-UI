"""Кэш байткода на флешке не должен переживать аварийную остановку (04.11.2026).

Кэш перенесён из tmpfs на /opt: после перезагрузки панель не компилирует себя
заново. Но прежде каждая перезагрузка давала чистый кэш, а теперь файл `.pyc`,
оборванный пропажей питания, остался бы навсегда: Python не пропускает битый
байткод, импорт падает, и панель не поднимается до переустановки.

Поэтому `stop` оставляет в кэше метку чистой остановки, а `start` её снимает.
Нет метки при запуске — прошлая остановка была аварийной, и кэш стирается
целиком. Обычная перезагрузка роутера проходит через `stop` (opkg initrc), так
что кэш её переживает. Заодно запуск убирает прежний кэш из /tmp: после
обновления без перезагрузки он держал оперативную память.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

INIT = Path("xkeen-ui/scripts/panel_init.sh")
SH = shutil.which("sh") or shutil.which("bash")

pytestmark = pytest.mark.skipif(not SH, reason="POSIX-оболочка недоступна")


def _function(name: str) -> str:
    text = INIT.read_text(encoding="utf-8")
    body = text.split(f"{name}() {{", 1)[1]
    return f"{name}() {{" + body.split("\n}\n", 1)[0] + "\n}\n"


def _run(cache: Path, legacy: Path, call: str) -> subprocess.CompletedProcess:
    script = "\n".join(
        [
            'audit_boot() { echo "audit: $*"; }',
            f'PYTHONPYCACHEPREFIX="{cache.as_posix()}"',
            f'LEGACY_PYCACHE="{legacy.as_posix()}"',
            _function("drop_bytecode_after_crash"),
            _function("mark_clean_stop"),
            call,
        ]
    )
    return subprocess.run([SH, "-c", script], capture_output=True, text=True, timeout=60)


@pytest.fixture()
def tmp_path(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("b")


def _filled(path: Path) -> Path:
    (path / "opt" / "etc").mkdir(parents=True)
    (path / "opt" / "etc" / "app.cpython-311.pyc").write_bytes(b"\x00" * 32)
    return path


def test_a_cache_without_the_clean_stop_mark_is_dropped(tmp_path: Path) -> None:
    cache = _filled(tmp_path / "xkeen-ui-pycache")
    out = _run(cache, tmp_path / "legacy", "drop_bytecode_after_crash")
    assert out.returncode == 0, out.stderr
    assert cache.is_dir()
    assert list(cache.iterdir()) == []
    assert "bytecode cache dropped" in out.stdout


def test_a_cache_after_a_clean_stop_is_kept_and_the_mark_is_taken(tmp_path: Path) -> None:
    cache = _filled(tmp_path / "xkeen-ui-pycache")
    (cache / ".clean-stop").write_bytes(b"")
    out = _run(cache, tmp_path / "legacy", "drop_bytecode_after_crash")
    assert out.returncode == 0, out.stderr
    assert (cache / "opt" / "etc" / "app.cpython-311.pyc").is_file()
    # the mark serves one start: a crash of the running panel must drop the cache again
    assert not (cache / ".clean-stop").exists()
    assert "dropped" not in out.stdout


def test_stop_leaves_the_mark_for_the_next_start(tmp_path: Path) -> None:
    cache = _filled(tmp_path / "xkeen-ui-pycache")
    out = _run(cache, tmp_path / "legacy", "mark_clean_stop\ndrop_bytecode_after_crash")
    assert out.returncode == 0, out.stderr
    assert (cache / "opt" / "etc" / "app.cpython-311.pyc").is_file()


def test_stop_without_a_cache_creates_nothing(tmp_path: Path) -> None:
    cache = tmp_path / "xkeen-ui-pycache"
    out = _run(cache, tmp_path / "legacy", "mark_clean_stop")
    assert out.returncode == 0, out.stderr
    assert not cache.exists()


def test_an_empty_cache_is_not_reported(tmp_path: Path) -> None:
    cache = tmp_path / "xkeen-ui-pycache"
    cache.mkdir()
    out = _run(cache, tmp_path / "legacy", "drop_bytecode_after_crash")
    assert out.returncode == 0, out.stderr
    assert "dropped" not in out.stdout


def test_a_foreign_cache_directory_is_never_removed(tmp_path: Path) -> None:
    # XKEEN_UI_PYTHONPYCACHEPREFIX may point anywhere: only the panel's own directory is wiped
    cache = _filled(tmp_path / "shared-cache")
    out = _run(cache, tmp_path / "legacy", "drop_bytecode_after_crash")
    assert out.returncode == 0, out.stderr
    assert (cache / "opt" / "etc" / "app.cpython-311.pyc").is_file()


def test_the_old_cache_in_tmp_is_removed(tmp_path: Path) -> None:
    cache = tmp_path / "xkeen-ui-pycache"
    cache.mkdir()
    (cache / ".clean-stop").write_bytes(b"")
    legacy = _filled(tmp_path / "legacy")
    out = _run(cache, legacy, "drop_bytecode_after_crash")
    assert out.returncode == 0, out.stderr
    assert not legacy.exists()


def test_the_cache_in_tmp_itself_is_not_removed_as_legacy(tmp_path: Path) -> None:
    # /opt unwritable: the cache lives in /tmp and is the legacy path at once
    cache = tmp_path / "xkeen-ui-pycache"
    cache.mkdir()
    (cache / ".clean-stop").write_bytes(b"")
    (cache / "x.pyc").write_bytes(b"\x00")
    out = _run(cache, cache, "drop_bytecode_after_crash")
    assert out.returncode == 0, out.stderr
    assert (cache / "x.pyc").is_file()


def test_the_start_drops_the_cache_only_once_the_panel_is_known_not_running() -> None:
    # The service is called twice in a row at boot: the second call must not wipe the
    # cache of the panel the first one started.
    text = INIT.read_text(encoding="utf-8")
    start = text.split("start_service() {", 1)[1].split("\n}\n", 1)[0]
    assert start.index("Сервис уже запущен") < start.index("drop_bytecode_after_crash")
    assert start.index("drop_bytecode_after_crash") < start.index('nohup "$PYTHON_BIN" "$TARGET"')
    stop = text.split("stop_service() {", 1)[1].split("\n}\n", 1)[0]
    assert stop.rstrip().endswith("mark_clean_stop")
