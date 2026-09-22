"""Уборка static/frontend-build при установке не должна выносить нужные файлы.

Блок уборки вшит в install.sh как heredoc, поэтому тест достаёт его оттуда и
исполняет на временном дереве — так проверяется настоящее поведение, а не
совпадение строк в скрипте.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

INSTALLER = Path("xkeen-ui/install.sh")


def _cleanup_source() -> str:
    text = INSTALLER.read_text(encoding="utf-8")
    body = text.split("cleanup_frontend_build_dir() {", 1)[1]
    block = body.split('"$PYTHON_BIN" - <<\'PY\'', 1)[1]
    return block.split("\nPY\n", 1)[0]


def _run_cleanup(build_dir: Path) -> str:
    env = dict(os.environ)
    env["FRONTEND_BUILD_DIR"] = str(build_dir)
    env["FRONTEND_BUILD_BRIDGE_MANIFEST"] = str(build_dir / ".vite" / "manifest.json")
    env["FRONTEND_BUILD_RAW_MANIFEST"] = str(build_dir / ".vite" / "manifest.build.json")
    # Байты, а не text=True: иначе исходник уедет в кодировке локали, и на
    # Windows блок не разберётся ещё до того, как начнёт работать.
    proc = subprocess.run(
        [sys.executable, "-"],
        input=_cleanup_source().encode("utf-8"),
        capture_output=True,
        env=env,
    )
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    return proc.stdout.decode("utf-8", "replace")


@pytest.fixture()
def build_dir(tmp_path: Path) -> Path:
    root = tmp_path / "frontend-build"
    (root / "assets").mkdir(parents=True)
    (root / ".vite").mkdir()

    (root / "assets" / "panel-abc123.js").write_text("export const a = 1;\n", encoding="utf-8")
    (root / "assets" / "panel-abc123.css").write_text(".a{color:red}\n", encoding="utf-8")
    (root / "assets" / "lazy-def456.js").write_text("export const b = 2;\n", encoding="utf-8")

    manifest = {
        "js/pages/panel.entry.js": {
            "file": "assets/panel-abc123.js",
            "css": ["assets/panel-abc123.css"],
            "dynamicImports": ["assets/lazy-def456.js"],
        }
    }
    (root / ".vite" / "manifest.build.json").write_text(
        json.dumps(manifest), encoding="utf-8"
    )
    return root


def test_cleanup_removes_stale_files(build_dir: Path) -> None:
    stale = build_dir / "assets" / "old-zzz999.js"
    stale.write_text("gone\n", encoding="utf-8")

    _run_cleanup(build_dir)

    assert not stale.exists()
    assert (build_dir / "assets" / "panel-abc123.js").is_file()


def test_cleanup_keeps_precompressed_siblings(build_dir: Path) -> None:
    """`.gz` рядом с нужным файлом — часть сборки, а не мусор.

    Ни один vite-манифест про `.gz` не знает, поэтому без явного разрешения
    уборка сносит всё предсжатие бандла, и панель отдаёт его несжатым.
    """

    packed = []
    for name in ("panel-abc123.js", "panel-abc123.css", "lazy-def456.js"):
        gz = build_dir / "assets" / (name + ".gz")
        gz.write_bytes(b"\x1f\x8b\x08\x00packed")
        packed.append(gz)

    _run_cleanup(build_dir)

    survived = [gz.name for gz in packed if gz.exists()]
    assert survived == [gz.name for gz in packed]


def test_cleanup_still_removes_orphan_gz(build_dir: Path) -> None:
    """`.gz` без своего исходника — такой же мусор от прошлой сборки."""

    orphan = build_dir / "assets" / "old-zzz999.js.gz"
    orphan.write_bytes(b"\x1f\x8b\x08\x00stale")

    _run_cleanup(build_dir)

    assert not orphan.exists()
