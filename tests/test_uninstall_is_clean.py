"""После удаления панели на роутере не остаётся ничего, что ей принадлежит.

Прежний `uninstall.sh` убирал каталог панели и службу, а команды в /opt/bin,
журналы, состояние обновлений, скачанный архив, копии прежних файлов и кэш
байткода оставались. Здесь скрипт запускается на слепке файловой системы
роутера: всё панельное должно исчезнуть, всё чужое — уцелеть.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
UNINSTALL = ROOT / "xkeen-ui" / "uninstall.sh"
PANEL_INIT = ROOT / "xkeen-ui" / "scripts" / "panel_init.sh"
WRAPPER = '#!/bin/sh\nSCRIPT="/opt/etc/xkeen-ui/tools/{script}"\nexec sh "$SCRIPT" "$@"\n'

# Всё, что кладут установщик и работающая панель.
PANEL_FILES = {
    "opt/etc/xkeen-ui/app.py": "panel\n",
    "opt/etc/xkeen-ui/uninstall.sh": "#!/bin/sh\n",
    "opt/etc/xkeen-ui/secret.key": "secret\n",
    "opt/etc/xkeen-ui/bin/xk-geodat": "binary\n",
    "opt/etc/xkeen-ui/opt/etc/mihomo/templates/bundled.yaml": "bundled template\n",
    "opt/etc/xkeen-ui/opt/etc/mihomo/templates/edited.yaml": "bundled original\n",
    "opt/etc/xkeen-ui.module-transactions/20261008T000000Z-abc/operation.json": "{}\n",
    "opt/etc/xkeen-ui.profile-transaction-9490/quarantine/static/old.js": "old\n",
    "opt/etc/xkeen-profile-abcd/backup/app.py": "old\n",
    "opt/etc/mihomo/templates/bundled.yaml": "bundled template\n",
    "opt/bin/sysmon": WRAPPER.format(script="sysmon_keenetic.sh"),
    "opt/bin/entware-backup": WRAPPER.format(script="entware_backup.sh"),
    "opt/bin/backup-monitor": WRAPPER.format(script="backup_monitor.sh"),
    "opt/var/run/xkeen-ui.pid": "424242\n",
    "opt/var/log/xkeen-ui/core.log": "log\n",
    "opt/var/log/xkeen-ui/update/update.log": "log\n",
    "opt/var/log/xkeen-ui.log": "log\n",
    "opt/var/log/xkeen-ui-boot.log": "log\n",
    "opt/var/log/xkeen-ui-install.log": "log\n",
    "opt/var/log/xkeen-ui-install.log.prev": "log\n",
    "opt/var/lib/xkeen-ui/update/status.json": "{}\n",
    "opt/var/lib/xkeen-ui/update/lock": "{}\n",
    "opt/var/lib/xkeen-ui/update/panel-archive/abc.tar.gz": "archive\n",
    "opt/var/lib/xkeen-ui/remotefs/state.json": "{}\n",
    "opt/var/backups/xkeen-ui/backup-1.tar.gz": "backup\n",
    "tmp/xkeen-ui-pycache/opt/etc/xkeen-ui/app.cpython-313.pyc": "pyc\n",
    "tmp/xkeen-ui-update-777/archive.tar.gz": "archive\n",
    "tmp/xkeen-ui-backups/backup.tar.gz": "backup\n",
    "tmp/xkeen-ui-remotefs/state.json": "{}\n",
}
# То, чем пользуются Xray, Mihomo, роутер и сам владелец.
FOREIGN_FILES = {
    "opt/etc/xray/configs/05_routing.json": "{}\n",
    "opt/etc/xray/dat/geosite_v2fly.dat": "dat\n",
    "opt/etc/mihomo/config.yaml": "mixed-port: 7890\n",
    "opt/etc/mihomo/profiles/mine.yaml": "profile\n",
    "opt/etc/mihomo/templates/edited.yaml": "edited by the owner\n",
    "opt/etc/mihomo/templates/mine.yaml": "the owner's own template\n",
    "opt/etc/init.d/S05xkeen": "#!/bin/sh\n",
    "opt/etc/init.d/S99other": '#!/bin/sh\nUI_DIR="/opt/etc/other"\n',
    "opt/bin/python3": "python\n",
    "opt/bin/version-check": "#!/bin/sh\necho a command of somebody else\n",
    "opt/var/log/messages": "syslog\n",
    "opt/var/log/xkeen.log": "xkeen\n",
    "opt/var/lib/opkg/status": "packages\n",
    "opt/var/backups/other/backup.tar.gz": "backup\n",
    "tmp/other/file": "tmp\n",
}
# Данные владельца, собранные панелью: остаются, пока не попросят убрать.
OWNER_DATA = {
    "opt/var/trash/files/deleted.txt": "deleted by the owner\n",
    "opt/etc/xray/configs/backups/05_routing-20261001.json": "{}\n",
}


def _lay(root: Path, files: dict[str, str]) -> None:
    for relative, content in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode("utf-8"))


def _router(tmp_path: Path, *, env_file: str = "") -> Path:
    root = tmp_path / "router"
    _lay(root, {**PANEL_FILES, **FOREIGN_FILES, **OWNER_DATA})
    init = root / "opt/etc/init.d/S99xkeen-ui-umarcheh001"
    init.write_bytes(PANEL_INIT.read_bytes())
    os.chmod(init, 0o755)
    if env_file:
        (root / "opt/etc/xkeen-ui/devtools.env").write_bytes(env_file.encode("utf-8"))
    return root


def _uninstall(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["sh", UNINSTALL.as_posix(), *args],
        capture_output=True,
        env={**os.environ, "XKEEN_UI_UNINSTALL_ROOT": root.as_posix()},
    )


def _remaining(root: Path) -> set[str]:
    return {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}


def _remaining_dirs(root: Path) -> set[str]:
    return {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_dir()}


def test_the_script_is_valid_posix_shell():
    proc = subprocess.run(["sh", "-n", UNINSTALL.as_posix()], capture_output=True)

    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")


def test_nothing_of_the_panel_is_left_and_nothing_else_is_touched(tmp_path):
    root = _router(tmp_path)

    proc = _uninstall(root)

    assert proc.returncode == 0, proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
    assert _remaining(root) == set(FOREIGN_FILES) | set(OWNER_DATA)
    for content_check in FOREIGN_FILES:
        assert (root / content_check).read_bytes() == FOREIGN_FILES[content_check].encode("utf-8")


def test_no_empty_folder_of_the_panel_is_left_either(tmp_path):
    root = _router(tmp_path)

    _uninstall(root)

    leftovers = sorted(name for name in _remaining_dirs(root) if "xkeen-ui" in name or "xkeen-profile" in name)
    assert leftovers == []


def test_the_owner_is_told_what_was_kept(tmp_path):
    root = _router(tmp_path)

    output = _uninstall(root).stdout.decode("utf-8", "replace")

    assert "/opt/var/trash" in output
    assert "/opt/etc/xray/configs/backups" in output
    assert "/opt/etc/mihomo/templates" in output


def test_purge_removes_the_data_the_panel_gathered(tmp_path):
    root = _router(tmp_path)

    proc = _uninstall(root, "--purge")

    assert proc.returncode == 0
    assert _remaining(root) == set(FOREIGN_FILES)


def test_folders_the_owner_moved_are_found_through_the_settings(tmp_path):
    env = (
        'export XKEEN_LOG_DIR="/opt/var/log"\n'
        "export XKEEN_UI_UPDATE_DIR=/opt/var/custom/xkeen-ui-update\n"
        "XKEEN_UI_BACKUP_DIR='/opt/var/custom/panel-copies'\n"
    )
    root = _router(tmp_path, env_file=env)
    _lay(
        root,
        {
            "opt/var/log/core.log": "panel\n",
            "opt/var/log/core.log.1": "panel\n",
            "opt/var/log/stderr.log": "panel\n",
            "opt/var/custom/xkeen-ui-update/status.json": "{}\n",
            "opt/var/custom/panel-copies/backup.tar.gz": "backup\n",
        },
    )

    proc = _uninstall(root)
    output = proc.stdout.decode("utf-8", "replace")

    remaining = _remaining(root)
    # Из общего каталога журналов ушли только файлы панели.
    assert not remaining & {"opt/var/log/core.log", "opt/var/log/core.log.1", "opt/var/log/stderr.log"}
    assert "opt/var/log/messages" in remaining
    assert "opt/var/custom/xkeen-ui-update/status.json" not in remaining
    # Каталог без имени панели целиком не стирается — о нём сказано владельцу.
    assert "opt/var/custom/panel-copies/backup.tar.gz" in remaining
    assert "/opt/var/custom/panel-copies" in output


def test_a_foreign_service_under_the_legacy_name_survives(tmp_path):
    root = _router(tmp_path)
    legacy = root / "opt/etc/init.d/S99xkeen-ui"
    legacy.write_bytes(b'#!/bin/sh\nUI_DIR="/opt/etc/another-panel"\n')

    _uninstall(root)

    assert legacy.is_file()
    assert not (root / "opt/etc/init.d/S99xkeen-ui-umarcheh001").exists()


@pytest.mark.parametrize("flag", ["--purge", ""])
def test_running_it_twice_is_harmless(tmp_path, flag):
    root = _router(tmp_path)
    args = (flag,) if flag else ()
    _uninstall(root, *args)

    again = _uninstall(root, *args)

    assert again.returncode == 0
