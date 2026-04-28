from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_SRC = REPO_ROOT / "xkeen-ui" / "tools" / "device_lock_detector.sh"
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


def test_device_lock_detector_deduplicates_alias_mounts_and_pids(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    mounts_file = tmp_path / "mounts.txt"
    script_dst = tmp_path / "device_lock_detector.sh"
    primary_mount = tmp_path / "tmp" / "mnt" / "disk-a"
    alias_mount = tmp_path / "opt"

    for path in (bin_dir, primary_mount, alias_mount):
        path.mkdir(parents=True, exist_ok=True)

    script_dst.write_text(SCRIPT_SRC.read_text(encoding="utf-8"), encoding="utf-8")
    script_dst.chmod(script_dst.stat().st_mode | stat.S_IEXEC)

    mounts_file.write_text(
        "\n".join(
            [
                f"/dev/sda3 {_to_sh_path(primary_mount)} ext4 rw 0 0",
                f"/dev/sda3 {_to_sh_path(alias_mount)} ext4 rw 0 0",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    _write_exec(
        bin_dir / "fuser",
        "#!/bin/sh\n"
        "case \"$1\" in\n"
        "  -m)\n"
        "    printf '%s\\n' '1 1'\n"
        "    ;;\n"
        "  *)\n"
        "    printf '%s\\n' '1'\n"
        "    ;;\n"
        "esac\n"
        "exit 0\n",
    )

    env = os.environ.copy()
    env["PATH"] = str(bin_dir) + os.pathsep + env.get("PATH", "")
    env["XKEEN_PROC_MOUNTS_FILE"] = _to_sh_path(mounts_file)

    result = subprocess.run(
        [SH_PATH, str(script_dst)],
        cwd=str(tmp_path),
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    output = _strip_ansi(result.stdout + result.stderr)

    assert result.returncode == 0, output
    assert output.count("sda3 (") == 1
    assert _to_sh_path(primary_mount) in output
    assert _to_sh_path(alias_mount) in output
    assert len(re.findall(r"PID\s+1\b", output)) == 1
