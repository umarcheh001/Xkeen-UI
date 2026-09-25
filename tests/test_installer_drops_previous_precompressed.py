"""Сжатые копии прежней установки не должны пережить обновление.

Релизный архив мог прийти без .gz, а на роутере без rsync `cp -r` ничего не
удаляет: старые .gz остаются рядом с новыми исходниками. Затем шаг выравнивания
mtime делает их «свежими», сторож отдачи их пропускает, и браузер получает
прежний JS при новом шаблоне. Так 25.09.2026 на 45.1 окно подписок обновилось
наполовину: устаревшими были 242 из 370 пар.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

INSTALLER = Path("xkeen-ui/install.sh")
FUNC = "drop_previous_precompressed"


def _installer_text() -> str:
    return INSTALLER.read_text(encoding="utf-8")


def _drop_source() -> str:
    body = _installer_text().split(f"{FUNC}() {{", 1)[1]
    block = body.split('"$PYTHON_BIN" - <<\'PY\'', 1)[1]
    return block.split("\nPY\n", 1)[0]


def _run_drop(static_dir: Path) -> str:
    env = dict(os.environ)
    env["PRECOMPRESSED_STATIC_DIR"] = str(static_dir)
    proc = subprocess.run(
        [sys.executable, "-"],
        input=_drop_source().encode("utf-8"),
        capture_output=True,
        env=env,
    )
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    return proc.stdout.decode("utf-8", "replace")


def test_block_is_ascii_only() -> None:
    assert all(ord(ch) < 128 for ch in _drop_source())


def test_drop_runs_before_copy_and_align() -> None:
    text = _installer_text()
    call = f'{FUNC} "$UI_DIR/static"'
    assert call in text
    drop_at = text.index(call)
    assert drop_at < text.index('rsync -a "$SRC_DIR"/ "$UI_DIR"/')
    assert drop_at < text.index('cp -r "$SRC_DIR"/* "$UI_DIR"/')
    assert drop_at < text.index('align_precompressed_mtimes "$UI_DIR/static"')


def test_every_gz_under_static_is_removed(tmp_path: Path) -> None:
    static = tmp_path / "static"
    (static / "js" / "features").mkdir(parents=True)

    src = static / "js" / "features" / "outbounds.js"
    src.write_text("new", encoding="utf-8")
    stale = static / "js" / "features" / "outbounds.js.gz"
    stale.write_bytes(b"\x1f\x8bold")
    orphan = static / "gone.css.gz"
    orphan.write_bytes(b"\x1f\x8b")
    keep = static / "styles.css"
    keep.write_text("a{}", encoding="utf-8")

    out = _run_drop(static)

    assert not stale.exists()
    assert not orphan.exists()
    assert src.read_text(encoding="utf-8") == "new"
    assert keep.exists()
    assert "dropped=2" in out


def test_missing_dir_is_survivable(tmp_path: Path) -> None:
    _run_drop(tmp_path / "no-such-dir")
