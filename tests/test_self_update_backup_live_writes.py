"""The pre-update backup must survive the panel writing into its own directory.

The panel keeps its state next to its code, so the directory being archived
changes while tar reads it (SQLite journals appear and vanish every minute).
GNU tar reports that with exit status 1 although the archive is complete; the
updater used to treat it as a failed backup and aborted the whole update.
"""

from __future__ import annotations

import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "xkeen-ui" / "scripts" / "update_xkeen_ui.sh"
SH = shutil.which("sh")

pytestmark = pytest.mark.skipif(SH is None, reason="нужен POSIX sh")

# Relative paths only: GNU tar reads "C:/..." as a remote host on Windows.
PRELUDE = """
UI_DIR="ui/xkeen-ui"
LOG_FILE="update.log"
log() { echo "$*"; }
"""


def _function(script: Path, name: str) -> str:
    text = script.read_text(encoding="utf-8")
    start = text.index(f"\n{name}() {{\n") + 1
    end = text.index("\n}\n", start) + 3
    return text[start:end]


def _run(tmp_path: Path, tar_stub: str = "") -> subprocess.CompletedProcess:
    ui = tmp_path / "ui" / "xkeen-ui"
    ui.mkdir(parents=True, exist_ok=True)
    (ui / "app.py").write_text("print('panel')\n", encoding="utf-8")
    (ui / "mihomo-traffic.sqlite3").write_bytes(b"db")
    (ui / "mihomo-traffic.sqlite3-wal").write_bytes(b"wal")
    (ui / "mihomo-traffic.sqlite3-shm").write_bytes(b"shm")
    code = PRELUDE + tar_stub + _function(RUNNER, "make_ui_backup")
    code += '\nmake_ui_backup "backup.tgz"\necho "rc=$?"\n'
    return subprocess.run(
        [SH, "-c", code], cwd=str(tmp_path), capture_output=True, text=True, encoding="utf-8"
    )


def _names(tmp_path: Path) -> set[str]:
    with tarfile.open(tmp_path / "backup.tgz") as archive:
        return {member.name for member in archive.getmembers()}


def test_backup_leaves_out_sqlite_side_files(tmp_path: Path) -> None:
    proc = _run(tmp_path)

    assert "rc=0" in proc.stdout, proc.stdout + proc.stderr
    names = _names(tmp_path)
    assert "xkeen-ui/app.py" in names
    assert "xkeen-ui/mihomo-traffic.sqlite3" in names
    assert not {name for name in names if name.endswith(("-wal", "-shm", "-journal"))}


def test_files_changed_during_archiving_do_not_fail_the_backup(tmp_path: Path) -> None:
    # What GNU tar does when the directory changes under it: a full archive, status 1.
    stub = 'tar() { command tar "$@"; [ "$1" = "-tzf" ] || return 1; }\n'

    proc = _run(tmp_path, stub)

    assert "rc=0" in proc.stdout, proc.stdout + proc.stderr
    assert "changed while being archived" in proc.stdout
    assert "xkeen-ui/app.py" in _names(tmp_path)


def test_broken_archive_with_the_same_status_still_fails(tmp_path: Path) -> None:
    # Status 1 from a tar that did not produce a readable archive is a real failure.
    stub = (
        'tar() { if [ "$1" = "-tzf" ]; then command tar "$@"; return $?; fi; '
        'printf broken > backup.tgz; return 1; }\n'
    )

    proc = _run(tmp_path, stub)

    assert "rc=1" in proc.stdout, proc.stdout + proc.stderr
    assert "changed while being archived" not in proc.stdout


def test_fatal_tar_status_still_fails(tmp_path: Path) -> None:
    stub = 'tar() { command tar "$@"; [ "$1" = "-tzf" ] || return 2; }\n'

    proc = _run(tmp_path, stub)

    assert "rc=2" in proc.stdout, proc.stdout + proc.stderr


def test_runner_reports_a_failed_backup_through_the_helper() -> None:
    text = RUNNER.read_text(encoding="utf-8")

    assert 'if make_ui_backup "$backup_file"; then' in text
    assert 'write_status "failed" "backup" "Backup failed" "backup failed"' in text
