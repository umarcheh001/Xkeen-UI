"""Пакеты Entware для файлового менеджера и системного монитора ставит общий скрипт.

Эти два шага жили только в установщике, и обновление из панели до них не
доходило: модуль файлового менеджера, появившийся после обновления, оставался
без `lftp`. Теперь шаги общие: установщик зовёт их между строками своего экрана,
обновление из панели — командой `prepare`.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "xkeen-ui" / "scripts" / "provision_env.sh"
INSTALLER = ROOT / "xkeen-ui" / "install.sh"

# Подставной opkg: «ставит» пакет, создавая одноимённую команду рядом с собой.
FAKE_OPKG = """#!/bin/sh
echo "$*" >> "$FAKE_OPKG_LOG"
case "$FAKE_OPKG:$1" in
  dead:*) exit 1 ;;
  no-install:install) exit 1 ;;
  empty-install:install) exit 0 ;;
  ok:install)
    shift
    for package in "$@"; do
      printf '#!/bin/sh\\nexit 0\\n' > "$FAKE_BIN/$package"
      chmod +x "$FAKE_BIN/$package"
    done
    exit 0 ;;
esac
exit 0
"""


def _run(tmp_path: Path, body: str, *, opkg: str | None = "ok", have: tuple[str, ...] = ()):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    if opkg is not None:
        (bin_dir / "opkg").write_bytes(FAKE_OPKG.encode("utf-8"))
        os.chmod(bin_dir / "opkg", 0o755)
    for name in have:
        (bin_dir / name).write_bytes(b"#!/bin/sh\nexit 0\n")
        os.chmod(bin_dir / name, 0o755)
    conf = tmp_path / "opkg.conf"
    conf.write_text("src/gz entware http://bin.entware.net/aarch64-k3.10\n", encoding="utf-8")
    script = tmp_path / "call.sh"
    script.write_bytes("\n".join(["set -e", f'. "{LIB.as_posix()}"', body, ""]).encode("utf-8"))
    log = tmp_path / "opkg.log"
    proc = subprocess.run(
        ["sh", script.as_posix()],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        env={
            **os.environ,
            # Только подставные команды и то, без чего оболочка не работает:
            # настоящий lftp или df этой машины исказили бы проверку.
            "PATH": bin_dir.as_posix() + os.pathsep + "/usr/bin" + os.pathsep + "/bin",
            "FAKE_BIN": bin_dir.as_posix(),
            "FAKE_OPKG": opkg or "",
            "FAKE_OPKG_LOG": log.as_posix(),
            "XKEEN_OPKG_CONF": conf.as_posix(),
            "XKEEN_OPKG_UPDATE_TIMEOUT": "5",
            "XKEEN_OPKG_FALLBACK": "0",
            "TMPDIR": tmp_path.as_posix(),
        },
    )
    calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
    return proc, calls


FILE_MANAGER = 'provision_file_manager && echo "ready" || echo "stopped: $PROVISION_ERROR"'


def test_a_router_that_has_lftp_is_left_alone(tmp_path):
    proc, calls = _run(tmp_path, FILE_MANAGER, have=("lftp",))

    assert "ready" in proc.stdout, proc.stdout + proc.stderr
    assert calls == []


def test_a_missing_lftp_comes_from_entware(tmp_path):
    proc, calls = _run(tmp_path, FILE_MANAGER)

    assert "ready" in proc.stdout, proc.stdout + proc.stderr
    assert calls == ["update", "install lftp"]


def test_without_entware_the_reason_is_named(tmp_path):
    proc, _calls = _run(tmp_path, FILE_MANAGER, opkg=None)

    assert "stopped: " in proc.stdout, proc.stdout + proc.stderr
    assert "Entware" in proc.stdout.split("stopped: ", 1)[1]


def test_a_package_source_that_does_not_answer_is_named(tmp_path):
    proc, calls = _run(tmp_path, FILE_MANAGER, opkg="dead")

    assert "stopped: " in proc.stdout, proc.stdout + proc.stderr
    assert "install lftp" not in calls


def test_a_package_that_did_not_install_is_named(tmp_path):
    proc, _calls = _run(tmp_path, FILE_MANAGER, opkg="no-install")

    assert "stopped: " in proc.stdout, proc.stdout + proc.stderr
    assert "lftp" in proc.stdout.split("stopped: ", 1)[1]


def test_an_install_that_reported_success_but_brought_nothing_is_not_believed(tmp_path):
    proc, _calls = _run(tmp_path, FILE_MANAGER, opkg="empty-install")

    assert "stopped: " in proc.stdout, proc.stdout + proc.stderr


def test_monitor_utilities_never_stop_the_work(tmp_path):
    # Монитор умеет работать и без них: ни отсутствие Entware, ни отказ
    # источника пакетов не повод останавливать установку или обновление.
    for case, opkg in (("none", None), ("dead", "dead"), ("no-install", "no-install")):
        folder = tmp_path / case
        folder.mkdir()
        proc, _calls = _run(folder, 'provision_sysmon_utils; echo "went on"', opkg=opkg)

        assert proc.returncode == 0, case + proc.stdout + proc.stderr
        assert "went on" in proc.stdout, case


def test_the_installer_and_the_update_share_the_two_steps():
    installer = INSTALLER.read_text(encoding="utf-8")
    shared = LIB.read_text(encoding="utf-8")

    for name in ("provision_file_manager", "provision_sysmon_utils"):
        assert name + "() {" in shared
        assert name + "() {" not in installer
        assert name in installer
    # В `prepare`, а не в `apply`: у `apply` короткий предел времени, и его сбой
    # откатывает обновление, а источник пакетов может отвечать долго.
    prepare = shared[shared.index("provision_cmd_prepare() {"):]
    prepare = prepare[: prepare.index("\n}\n")]
    assert "provision_file_manager" in prepare and "provision_sysmon_utils" in prepare
    apply = shared[shared.index("provision_cmd_apply() {"):]
    apply = apply[: apply.index("\n}\n")]
    assert "provision_file_manager" not in apply and "provision_sysmon_utils" not in apply
    # Пакеты ставятся в одном месте — в общем скрипте.
    assert "opkg install lftp" not in installer.replace("provision_opkg install lftp", "")
    assert "provision_opkg install lftp" not in installer
