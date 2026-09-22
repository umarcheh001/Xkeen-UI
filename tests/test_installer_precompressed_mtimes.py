"""После копирования файлов .gz не должен выглядеть старше своего исходника.

На роутерах без rsync install.sh копирует дерево через `cp -r`, а он времена не
сохраняет и ставит время копирования. Крупный файл успевает пересечь границу
секунды, его .gz получает отметку на секунду раньше — и отдача, сверяющая mtime,
считает сжатую копию устаревшей. Молча теряется сжатие самых тяжёлых файлов.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

INSTALLER = Path("xkeen-ui/install.sh")


def _align_source() -> str:
    text = INSTALLER.read_text(encoding="utf-8")
    body = text.split("align_precompressed_mtimes() {", 1)[1]
    block = body.split('"$PYTHON_BIN" - <<\'PY\'', 1)[1]
    return block.split("\nPY\n", 1)[0]


def _run_align(static_dir: Path) -> str:
    env = dict(os.environ)
    env["PRECOMPRESSED_STATIC_DIR"] = str(static_dir)
    proc = subprocess.run(
        [sys.executable, "-"],
        input=_align_source().encode("utf-8"),
        capture_output=True,
        env=env,
    )
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    return proc.stdout.decode("utf-8", "replace")


def test_block_is_ascii_only() -> None:
    """Блок исполняется как `python3 -`: не-UTF-8 локаль сломает кириллицу."""

    assert all(ord(ch) < 128 for ch in _align_source())


def test_gz_older_than_source_is_pulled_forward(tmp_path: Path) -> None:
    static = tmp_path / "static"
    (static / "sub").mkdir(parents=True)

    src = static / "styles.css"
    src.write_text("a{}", encoding="utf-8")
    gz = static / "styles.css.gz"
    gz.write_bytes(b"\x1f\x8b")

    base = 1_700_000_000
    os.utime(src, (base, base))
    os.utime(gz, (base - 1, base - 1))

    nested_src = static / "sub" / "app.js"
    nested_src.write_text("x", encoding="utf-8")
    nested_gz = static / "sub" / "app.js.gz"
    nested_gz.write_bytes(b"\x1f\x8b")
    os.utime(nested_src, (base, base))
    os.utime(nested_gz, (base - 7, base - 7))

    _run_align(static)

    assert gz.stat().st_mtime >= src.stat().st_mtime
    assert nested_gz.stat().st_mtime >= nested_src.stat().st_mtime


def test_orphan_gz_and_missing_dir_are_survivable(tmp_path: Path) -> None:
    static = tmp_path / "static"
    static.mkdir()
    orphan = static / "gone.js.gz"
    orphan.write_bytes(b"\x1f\x8b")
    before = orphan.stat().st_mtime

    _run_align(static)
    assert orphan.exists()
    assert orphan.stat().st_mtime == before

    _run_align(tmp_path / "no-such-dir")
