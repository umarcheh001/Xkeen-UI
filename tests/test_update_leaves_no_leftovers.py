"""Обновление панели не должно оставлять за собой копий и временных каталогов.

Уборка 25.09.2026 на 45.1, 10.1 и 20.1 нашла два источника мусора:

- резервные копии встроенных шаблонов `*.dist-*`: 88–128 штук, но всего три
  разных версии. Локальный архив, собранный на Windows, везёт шаблоны с CRLF,
  релизный из CI — с LF. При смене источника установщик видел «изменённый»
  шаблон и откладывал копию, хотя отличались только переводы строк;
- каталоги `/tmp/xkeen-ui-update.*` по одному на каждое обновление: скрипт
  обновления снимал при выходе только блокировку. При сорвавшемся обновлении
  там остаётся и скачанный архив — в оперативной памяти роутера.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "xkeen-ui" / "install.sh"
RUNNER = ROOT / "xkeen-ui" / "scripts" / "update_xkeen_ui.sh"
SH = shutil.which("sh")

pytestmark = pytest.mark.skipif(SH is None, reason="нужен POSIX sh")


def _function(script: Path, name: str) -> str:
    text = script.read_text(encoding="utf-8")
    start = text.index(f"\n{name}() {{\n") + 1
    end = text.index("\n}\n", start) + 3
    return text[start:end]


def _sh(code: str, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run([SH, "-c", code], cwd=str(cwd), capture_output=True, text=True, encoding="utf-8")


# --- Шаблоны ----------------------------------------------------------------


def _sync(tmp_path: Path, bundled: bytes, installed: bytes | None) -> tuple[Path, list[Path], str]:
    src = tmp_path / "src"
    dest = tmp_path / "dest"
    src.mkdir()
    dest.mkdir()
    (src / "05_routing_base.jsonc").write_bytes(bundled)
    if installed is not None:
        (dest / "05_routing_base.jsonc").write_bytes(installed)
    code = _function(INSTALLER, "same_ignoring_cr") + _function(INSTALLER, "sync_bundled_template_dir")
    code += f'\nsync_bundled_template_dir "{src.as_posix()}" "{dest.as_posix()}" test\n'
    proc = _sh(code, tmp_path)
    assert proc.returncode == 0, proc.stderr
    return dest / "05_routing_base.jsonc", sorted(dest.glob("*.dist-*")), proc.stdout


LF = b'// base\n{\n  "rules": []\n}\n'
CRLF = LF.replace(b"\n", b"\r\n")


def test_line_endings_alone_do_not_make_a_backup(tmp_path: Path) -> None:
    target, backups, _out = _sync(tmp_path, bundled=LF, installed=CRLF)

    assert backups == []
    assert target.read_bytes() == LF, "the shipped copy still wins"


def test_real_change_is_still_backed_up(tmp_path: Path) -> None:
    edited = b'// base\n{\n  "rules": [{"outboundTag": "mine"}]\n}\n'

    target, backups, out = _sync(tmp_path, bundled=LF, installed=edited)

    assert len(backups) == 1
    assert backups[0].read_bytes() == edited
    assert target.read_bytes() == LF
    assert "backup:" in out


def test_identical_template_is_left_alone(tmp_path: Path) -> None:
    target, backups, out = _sync(tmp_path, bundled=LF, installed=LF)

    assert backups == []
    assert target.read_bytes() == LF
    assert "обновляю" not in out


def test_new_template_is_added(tmp_path: Path) -> None:
    target, backups, _out = _sync(tmp_path, bundled=LF, installed=None)

    assert backups == []
    assert target.read_bytes() == LF


# --- Временный каталог обновления --------------------------------------------


def _exit_with_cleanup(tmp_path: Path, work_dir: Path, owned: bool) -> subprocess.CompletedProcess:
    code = _function(RUNNER, "release_lock") + _function(RUNNER, "cleanup")
    code += f'\nLOCK_FILE="{(tmp_path / "update.lock").as_posix()}"\n'
    code += f'WORK_DIR="{work_dir.as_posix()}"\n'
    code += f'WORK_DIR_OWNED="{1 if owned else 0}"\n'
    code += "trap cleanup EXIT\nexit 7\n"
    return _sh(code, tmp_path)


def test_runner_removes_its_work_dir_on_exit(tmp_path: Path) -> None:
    work = tmp_path / "xkeen-ui-update.AbC123"
    work.mkdir()
    (work / "checksums").write_text("x  xkeen-ui-routing.tar.gz\n", encoding="utf-8")
    (work / "xkeen-ui-routing.tar.gz").write_bytes(b"\x1f\x8b" + b"\0" * 64)
    (tmp_path / "update.lock").write_text("{}", encoding="utf-8")

    proc = _exit_with_cleanup(tmp_path, work, owned=True)

    assert proc.returncode == 7, "cleanup must not mask the exit code"
    assert not work.exists()
    assert not (tmp_path / "update.lock").exists()


def test_runner_never_removes_a_dir_it_did_not_create(tmp_path: Path) -> None:
    foreign = tmp_path / "somewhere"
    foreign.mkdir()
    (foreign / "keep.txt").write_text("x", encoding="utf-8")

    _exit_with_cleanup(tmp_path, foreign, owned=False)

    assert (foreign / "keep.txt").exists()


def test_runner_marks_only_its_own_work_dir() -> None:
    text = RUNNER.read_text(encoding="utf-8")
    created = text.index('WORK_DIR="$(mktemp -d /tmp/xkeen-ui-update.XXXXXX')
    owned = text.index('WORK_DIR_OWNED="1"')
    assert created < owned < text.index('TARBALL="$WORK_DIR/$ASSET_NAME"')
