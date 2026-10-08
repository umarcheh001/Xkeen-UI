"""После удаления панели на роутере не остаётся ничего, что ей принадлежит.

Прежний `uninstall.sh` убирал каталог панели и службу, а команды в /opt/bin,
журналы, состояние обновлений, скачанный архив, копии прежних файлов и кэш
байткода оставались; включённая защита DNS оставалась настройкой роутера,
которую некому вернуть. Здесь скрипт запускается на слепке файловой системы
роутера: всё панельное должно исчезнуть, всё чужое — уцелеть, а данные
владельца — уйти или остаться по его выбору.
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

# Программа панели и всё служебное, что кладут установщик и работающая панель.
PANEL_FILES = {
    "opt/etc/xkeen-ui/app.py": "panel\n",
    "opt/etc/xkeen-ui/run_server.py": "panel\n",
    "opt/etc/xkeen-ui/uninstall.sh": "#!/bin/sh\n",
    "opt/etc/xkeen-ui/BUILD.json": "{}\n",
    "opt/etc/xkeen-ui/install-managed.json": '{"paths": ["app.py"]}\n',
    "opt/etc/xkeen-ui/install-profile.json": "{}\n",
    "opt/etc/xkeen-ui/module-installed.json": "{}\n",
    "opt/etc/xkeen-ui/module-ownership.json": "{}\n",
    "opt/etc/xkeen-ui/restart.log": "log\n",
    "opt/etc/xkeen-ui/services/module_registry.py": "panel\n",
    "opt/etc/xkeen-ui/services/__pycache__/module_registry.cpython-313.pyc": "pyc\n",
    "opt/etc/xkeen-ui/static/js/app.js": "panel\n",
    "opt/etc/xkeen-ui/static/js/app.js.gz": "panel\n",
    "opt/etc/xkeen-ui/templates/panel.html": "panel\n",
    "opt/etc/xkeen-ui/templates/routing/bundled.jsonc": "bundled routing\n",
    "opt/etc/xkeen-ui/opt/etc/xray/templates/routing/bundled.jsonc": "bundled routing\n",
    "opt/etc/xkeen-ui/module-operations/status.json": "{}\n",
    "opt/etc/xkeen-ui/module-catalog/catalog-cache.json": "{}\n",
    "opt/etc/xkeen-ui/bin/xk-geodat": "binary\n",
    "opt/etc/xkeen-ui/opt/etc/mihomo/templates/bundled.yaml": "bundled template\n",
    "opt/etc/xkeen-ui/opt/etc/mihomo/templates/edited.yaml": "bundled original\n",
    "opt/etc/xkeen-ui.module-transactions/20261008T000000Z-abc/operation.json": "{}\n",
    "opt/etc/xkeen-ui.profile-transaction-9490/quarantine/static/old.js": "old\n",
    "opt/etc/xkeen-profile-abcd/backup/app.py": "old\n",
    "opt/etc/xkeen-ui.previous-version/backup/files/app.py": "previous\n",
    "opt/etc/xkeen-ui.previous-version.old/previous.json": "{}\n",
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
    "opt/bin/version-check": "#!/bin/sh\necho a command of somebody else\n",
    "opt/var/log/messages": "syslog\n",
    "opt/var/log/xkeen.log": "xkeen\n",
    "opt/var/lib/opkg/status": "packages\n",
    "opt/var/backups/other/backup.tar.gz": "backup\n",
    "tmp/other/file": "tmp\n",
}
# Данные владельца: уходят при удалении начисто, остаются при «только панель».
OWNER_DATA = {
    "opt/etc/xkeen-ui/secret.key": "secret\n",
    "opt/etc/xkeen-ui/ui-settings.json": "{}\n",
    "opt/etc/xkeen-ui/modules.json": "{}\n",
    "opt/etc/xkeen-ui/var/subscriptions/state.json": "{}\n",
    "opt/etc/xkeen-ui/var/pip-installed-by-panel.txt": "flask\nwerkzeug\ngevent\n",
    "opt/etc/xkeen-ui/xray-jsonc/05_routing.json.jsonc": "// comments of the owner\n",
    "opt/etc/xkeen-ui/bin/happ-decrypt-universal.assets/keytable.json": "keys\n",
    "opt/etc/xkeen-ui/templates/routing/mine.jsonc": "the owner's routing template\n",
    "opt/var/lib/xkeen-ui/remotefs/state.json": "{}\n",
    "opt/var/trash/files/deleted.txt": "deleted by the owner\n",
    "opt/etc/xray/configs/backups/05_routing-20261001.json": "{}\n",
    "opt/etc/mihomo/backup/config-20261001.yaml": "backup\n",
}
# Подставной интерпретатор: записывает, с чем его звали, и отвечает заданным кодом.
FAKE_PYTHON = """#!/bin/sh
echo "$*" >> "{calls}"
case "$1" in
  *release_router_settings.py) exit {release_code} ;;
esac
exit 0
"""


def _lay(root: Path, files: dict[str, str]) -> None:
    for relative, content in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode("utf-8"))


class Router:
    def __init__(self, tmp_path: Path, *, env_file: str = "", release_code: int | None = None) -> None:
        self.root = tmp_path / "router"
        self.calls = tmp_path / "python-calls.txt"
        _lay(self.root, {**PANEL_FILES, **FOREIGN_FILES, **OWNER_DATA})
        init = self.root / "opt/etc/init.d/S99xkeen-ui-umarcheh001"
        init.write_bytes(PANEL_INIT.read_bytes())
        os.chmod(init, 0o755)
        if env_file:
            (self.root / "opt/etc/xkeen-ui/devtools.env").write_bytes(env_file.encode("utf-8"))
        self.python = tmp_path / "fake-python"
        self.python.write_bytes(
            FAKE_PYTHON.format(calls=self.calls.as_posix(), release_code=release_code or 0).encode("utf-8")
        )
        os.chmod(self.python, 0o755)
        if release_code is not None:
            _lay(self.root, {"opt/etc/xkeen-ui/scripts/release_router_settings.py": "# stands for the real one\n"})

    def uninstall(self, *args: str, stdin: str | None = None, **env: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["sh", UNINSTALL.as_posix(), *args],
            capture_output=True,
            input=None if stdin is None else stdin.encode("utf-8"),
            stdin=subprocess.DEVNULL if stdin is None else None,
            env={
                **os.environ,
                "XKEEN_UI_UNINSTALL_ROOT": self.root.as_posix(),
                "PYTHON_BIN": self.python.as_posix(),
                **env,
            },
        )

    def files(self) -> set[str]:
        return {path.relative_to(self.root).as_posix() for path in self.root.rglob("*") if path.is_file()}

    def folders(self) -> set[str]:
        return {path.relative_to(self.root).as_posix() for path in self.root.rglob("*") if path.is_dir()}

    def python_calls(self) -> list[str]:
        return self.calls.read_text(encoding="utf-8").splitlines() if self.calls.is_file() else []


def _text(proc: subprocess.CompletedProcess) -> str:
    return proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")


def test_the_script_is_valid_posix_shell():
    proc = subprocess.run(["sh", "-n", UNINSTALL.as_posix()], capture_output=True)

    assert proc.returncode == 0, _text(proc)


# --- начисто ----------------------------------------------------------------------------


def test_a_clean_removal_leaves_nothing_of_the_panel_and_touches_nothing_else(tmp_path):
    router = Router(tmp_path)

    proc = router.uninstall("--purge")

    assert proc.returncode == 0, _text(proc)
    assert router.files() == set(FOREIGN_FILES)
    for relative, content in FOREIGN_FILES.items():
        assert (router.root / relative).read_bytes() == content.encode("utf-8")


def test_a_clean_removal_leaves_no_empty_folder_of_the_panel(tmp_path):
    router = Router(tmp_path)

    router.uninstall("--purge")

    assert sorted(name for name in router.folders() if "xkeen-ui" in name or "xkeen-profile" in name) == []
    assert "opt/var/trash" not in router.folders()


def test_a_clean_removal_takes_the_python_libraries_the_panel_brought(tmp_path):
    router = Router(tmp_path)

    proc = router.uninstall("--purge")

    assert "-m pip uninstall -y flask gevent werkzeug" in router.python_calls()
    assert "flask gevent werkzeug" in _text(proc)


# --- только панель ----------------------------------------------------------------------


def test_removing_only_the_panel_keeps_the_owners_data(tmp_path):
    router = Router(tmp_path)

    proc = router.uninstall("--keep-data")

    assert proc.returncode == 0, _text(proc)
    assert router.files() == set(FOREIGN_FILES) | set(OWNER_DATA)
    assert not any("pip uninstall" in call for call in router.python_calls())


def test_what_was_kept_is_named(tmp_path):
    router = Router(tmp_path)

    output = _text(router.uninstall("--keep-data"))

    for kept in (
        "/opt/etc/xkeen-ui",
        "/opt/var/trash",
        "/opt/etc/xray/configs/backups",
        "/opt/etc/mihomo/backup",
        "/opt/var/lib/xkeen-ui/remotefs",
        "/opt/etc/mihomo/templates",
        "flask gevent werkzeug",
    ):
        assert kept in output, kept


def test_without_a_terminal_and_without_a_choice_the_data_stays(tmp_path):
    router = Router(tmp_path)

    router.uninstall()

    assert set(OWNER_DATA) <= router.files()
    assert "opt/etc/xkeen-ui/app.py" not in router.files()


# --- вопрос владельцу -------------------------------------------------------------------


@pytest.mark.parametrize(
    ("answers", "purged"),
    [("1\n", True), ("2\n", False), ("да\n1\n", True), ("x\ny\nz\n", False), ("", False)],
)
def test_the_owner_is_asked_what_to_remove(tmp_path, answers, purged):
    router = Router(tmp_path)

    proc = router.uninstall(stdin=answers, XKEEN_UI_UNINSTALL_ASK="1")

    assert proc.returncode == 0, _text(proc)
    assert "Что удалить?" in _text(proc)
    assert router.files() == (set(FOREIGN_FILES) if purged else set(FOREIGN_FILES) | set(OWNER_DATA))


def test_a_flag_answers_instead_of_the_owner(tmp_path):
    router = Router(tmp_path)

    proc = router.uninstall("--purge", stdin="2\n", XKEEN_UI_UNINSTALL_ASK="1")

    assert "Что удалить?" not in _text(proc)
    assert router.files() == set(FOREIGN_FILES)


# --- защита DNS -------------------------------------------------------------------------


def test_the_dns_protection_is_switched_off_before_anything_is_removed(tmp_path):
    router = Router(tmp_path, release_code=0)

    proc = router.uninstall("--purge")

    assert proc.returncode == 0, _text(proc)
    calls = router.python_calls()
    assert calls[0].endswith("opt/etc/xkeen-ui/scripts/release_router_settings.py")
    assert router.files() == set(FOREIGN_FILES)


def test_a_protection_that_cannot_be_switched_off_stops_the_removal(tmp_path):
    router = Router(tmp_path, release_code=1)
    before = router.files()

    proc = router.uninstall("--purge")

    assert proc.returncode == 1
    assert "--force" in _text(proc)
    assert router.files() == before


def test_force_removes_the_panel_anyway(tmp_path):
    router = Router(tmp_path, release_code=1)

    proc = router.uninstall("--purge", "--force")

    assert proc.returncode == 0, _text(proc)
    assert router.files() == set(FOREIGN_FILES)


def test_the_protection_is_released_with_the_settings_of_the_panel(tmp_path):
    router = Router(tmp_path, env_file='export XKEEN_XRAY_CONFIGS_DIR="/opt/etc/xray/other"\n', release_code=0)
    router.python.write_bytes(
        f'#!/bin/sh\necho "configs=$XKEEN_XRAY_CONFIGS_DIR" >> "{router.calls.as_posix()}"\nexit 0\n'.encode("utf-8")
    )

    router.uninstall("--purge")

    assert router.python_calls()[0] == "configs=/opt/etc/xray/other"


# --- перенесённые каталоги и чужое под знакомыми именами ---------------------------------


def test_folders_the_owner_moved_are_found_through_the_settings(tmp_path):
    env = (
        'export XKEEN_LOG_DIR="/opt/var/log"\n'
        "export XKEEN_UI_UPDATE_DIR=/opt/var/custom/xkeen-ui-update\n"
        "XKEEN_UI_BACKUP_DIR='/opt/var/custom/panel-copies'\n"
    )
    router = Router(tmp_path, env_file=env)
    _lay(
        router.root,
        {
            "opt/var/log/core.log": "panel\n",
            "opt/var/log/core.log.1": "panel\n",
            "opt/var/log/stderr.log": "panel\n",
            "opt/var/custom/xkeen-ui-update/status.json": "{}\n",
            "opt/var/custom/panel-copies/backup.tar.gz": "backup\n",
        },
    )

    output = _text(router.uninstall("--purge"))

    remaining = router.files()
    # Из общего каталога журналов ушли только файлы панели.
    assert not remaining & {"opt/var/log/core.log", "opt/var/log/core.log.1", "opt/var/log/stderr.log"}
    assert "opt/var/log/messages" in remaining
    assert "opt/var/custom/xkeen-ui-update/status.json" not in remaining
    # Каталог без имени панели целиком не стирается — о нём сказано владельцу.
    assert "opt/var/custom/panel-copies/backup.tar.gz" in remaining
    assert "/opt/var/custom/panel-copies" in output


def test_a_foreign_service_under_the_legacy_name_survives(tmp_path):
    router = Router(tmp_path)
    legacy = router.root / "opt/etc/init.d/S99xkeen-ui"
    legacy.write_bytes(b'#!/bin/sh\nUI_DIR="/opt/etc/another-panel"\n')

    router.uninstall("--purge")

    assert legacy.is_file()
    assert not (router.root / "opt/etc/init.d/S99xkeen-ui-umarcheh001").exists()


@pytest.mark.parametrize("flag", ["--purge", "--keep-data"])
def test_running_it_twice_is_harmless(tmp_path, flag):
    router = Router(tmp_path)
    router.uninstall(flag)

    again = router.uninstall(flag)

    assert again.returncode == 0, _text(again)
