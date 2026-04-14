from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import tarfile
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_SRC = REPO_ROOT / "xkeen-ui" / "tools" / "backup_monitor.sh"
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


def _strip_terminal_noise(text: str) -> str:
    return ANSI_RE.sub("", text).replace("\r", "")


def _write_archive(archive_path: Path) -> None:
    payload_dir = archive_path.parent / "payload"
    (payload_dir / "bin").mkdir(parents=True, exist_ok=True)
    (payload_dir / "bin" / "busybox").write_text("ok\n", encoding="utf-8")

    with tarfile.open(archive_path, "w:gz") as tar:
        tar.add(payload_dir / "bin", arcname="./bin")
        tar.add(payload_dir / "bin" / "busybox", arcname="./bin/busybox")


def _run_backup_monitor(
    tmp_path: Path,
    args: list[str],
    *,
    scan_roots: list[Path] | None = None,
) -> str:
    tools_dir = tmp_path / "tools"
    state_dir = tmp_path / "state"
    tools_dir.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True)

    script_dst = tools_dir / "backup_monitor.sh"
    script_dst.write_text(SCRIPT_SRC.read_text(encoding="utf-8"), encoding="utf-8")
    script_dst.chmod(script_dst.stat().st_mode | stat.S_IEXEC)

    env = os.environ.copy()
    env["XKEEN_UI_STATE_DIR"] = _to_sh_path(state_dir)
    if scan_roots:
        env["XKEEN_BACKUP_MONITOR_PATHS"] = ";".join(_to_sh_path(path) for path in scan_roots)

    result = subprocess.run(
        [SH_PATH, str(script_dst), *args],
        cwd=str(tmp_path),
        env=env,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    return _strip_terminal_noise(result.stdout)


SH_PATH = _find_sh()
pytestmark = pytest.mark.skipif(not SH_PATH, reason="POSIX shell is not available")


def test_backup_monitor_uses_found_archive_when_state_is_missing(tmp_path: Path) -> None:
    mount_dir = tmp_path / "mnt-a"
    mount_dir.mkdir()
    archive = mount_dir / "aarch64_entware_backup_2026-03-07_15-22.tar.gz"
    _write_archive(archive)

    output = _run_backup_monitor(tmp_path, ["--status"], scan_roots=[mount_dir])

    assert "Нет данных о бэкапе" not in output
    assert "Статус бэкапа" in output
    assert "Найден бэкап" in output
    assert archive.name in output
    assert "архив валиден" in output


def test_backup_monitor_list_honors_explicit_directory(tmp_path: Path) -> None:
    first_dir = tmp_path / "mnt-a"
    second_dir = tmp_path / "mnt-b"
    first_dir.mkdir()
    second_dir.mkdir()

    first_archive = first_dir / "mips_entware_backup_2026-03-07_15-22.tar.gz"
    second_archive = second_dir / "mips_entware_backup_2026-03-08_11-40.tar.gz"
    _write_archive(first_archive)
    _write_archive(second_archive)

    output = _run_backup_monitor(
        tmp_path,
        ["--list", _to_sh_path(first_dir)],
        scan_roots=[second_dir],
    )

    assert first_archive.name in output
    assert second_archive.name not in output
    assert "Всего: 1 бэкап(ов)" in output


def test_backup_monitor_scans_opt_backups_for_legacy_entware_names(tmp_path: Path) -> None:
    opt_root = tmp_path / "opt"
    backups_dir = opt_root / "backups"
    backups_dir.mkdir(parents=True)

    archive = backups_dir / "entware_backup_10-04-2026_03-13-00.tar.gz"
    _write_archive(archive)

    output = _run_backup_monitor(tmp_path, ["--list"], scan_roots=[opt_root])

    assert archive.name in output
    assert "Entware архив" in output
    assert "Всего: 1 бэкап(ов)" in output


def test_backup_monitor_lists_config_backup_directories(tmp_path: Path) -> None:
    opt_root = tmp_path / "opt"
    backups_dir = opt_root / "backups"
    config_dir = backups_dir / "11-Apr-26_02-39_configs_xray"
    (config_dir / "configs").mkdir(parents=True)
    (config_dir / "configs" / "05_routing.json").write_text('{"routing":"ok"}\n', encoding="utf-8")

    output = _run_backup_monitor(tmp_path, ["--status"], scan_roots=[opt_root])

    assert "Нет данных о бэкапе" not in output
    assert config_dir.name in output
    assert "Xray конфиг-бэкап" in output
    assert "каталог доступен" in output
