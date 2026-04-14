from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_SRC = REPO_ROOT / "xkeen-ui" / "tools" / "entware_backup.sh"
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _find_sh() -> str | None:
    candidates = [
        shutil.which("sh"),
        r"C:\Program Files\Git\bin\sh.exe",
        r"C:\Program Files\Git\usr\bin\sh.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return str(candidate)
    return None


def _to_sh_path(path: Path) -> str:
    resolved = path.resolve()
    text = resolved.as_posix()
    if len(text) >= 3 and text[1:3] == ":/":
        return f"/{text[0].lower()}{text[2:]}"
    return text


def _write_exec(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def _strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text).replace("\r", "")


SH_PATH = _find_sh()
pytestmark = pytest.mark.skipif(not SH_PATH, reason="POSIX shell is not available")


def test_entware_backup_uses_local_backup_dir_when_rci_is_unavailable(tmp_path: Path) -> None:
    opt_dir = tmp_path / "opt"
    tmp_dir = tmp_path / "tmp"
    local_backup_dir = tmp_path / "opt-backups"
    bin_dir = tmp_path / "bin"

    for rel in ("bin", "etc", "lib", "sbin", "usr", "var"):
        (opt_dir / rel).mkdir(parents=True)
    (opt_dir / "etc" / "settings.conf").write_text("ok\n", encoding="utf-8")
    (opt_dir / "bin" / "busybox").write_text("ok\n", encoding="utf-8")
    (opt_dir / "lib" / "libc.so").write_text("ok\n", encoding="utf-8")
    tmp_dir.mkdir()
    local_backup_dir.mkdir()
    bin_dir.mkdir()

    script_text = SCRIPT_SRC.read_text(encoding="utf-8")
    script_text = script_text.replace('TMP_DIR="/tmp"', f'TMP_DIR="{_to_sh_path(tmp_dir)}"')
    script_text = script_text.replace('OPT_DIR="/opt"', f'OPT_DIR="{_to_sh_path(opt_dir)}"')
    script_text = script_text.replace(
        'LOCAL_BACKUP_DIR="${XKEEN_LOCAL_BACKUP_DIR:-/opt/backups}"',
        f'LOCAL_BACKUP_DIR="${{XKEEN_LOCAL_BACKUP_DIR:-{_to_sh_path(local_backup_dir)}}}"',
    )
    script_text = script_text.replace('STORAGE_DIR="/storage"', 'STORAGE_DIR="/definitely-missing-storage"')

    script_dst = tmp_path / "entware_backup.sh"
    script_dst.write_text(script_text, encoding="utf-8")
    script_dst.chmod(script_dst.stat().st_mode | stat.S_IEXEC)

    _write_exec(
        bin_dir / "curl",
        "#!/bin/sh\n"
        "exit 1\n",
    )
    _write_exec(
        bin_dir / "opkg",
        "#!/bin/sh\n"
        "case \"$1\" in\n"
        "  list-installed)\n"
        "    printf '%s\\n' 'tar - 1.0'\n"
        "    printf '%s\\n' 'libacl - 1.0'\n"
        "    ;;\n"
        "  print-architecture)\n"
        "    printf '%s\\n' 'aarch64-3'\n"
        "    ;;\n"
        "esac\n"
        "exit 0\n",
    )

    env = os.environ.copy()
    env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")
    env["XKEEN_UI_STATE_DIR"] = _to_sh_path(tmp_path / "state")

    result = subprocess.run(
        [SH_PATH, str(script_dst)],
        cwd=str(tmp_path),
        env=env,
        input="1\n",
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    output = _strip_ansi(result.stdout + result.stderr)

    assert result.returncode == 0, output
    assert "Не удалось получить список накопителей" not in output
    assert "Локальная папка бэкапов" in output
    assert "Бэкап успешно сохранён" in output
    assert list(local_backup_dir.glob("*entware_backup*.tar.gz"))
