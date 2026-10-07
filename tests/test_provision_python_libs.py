"""Библиотеки панели ставит общий скрипт, и недоступный Entware его не останавливает.

Раньше неудача `opkg update` была концом установки, хотя нужную библиотеку можно
взять и через pip: запасной путь в коде был, но до него не доходило. На роутере
с нестабильным зеркалом установить панель было нельзя.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "xkeen-ui" / "scripts" / "provision_env.sh"
INSTALLER = ROOT / "xkeen-ui" / "install.sh"

# Подставной python3: «импортирует» то, что перечислено в FAKE_MODULES и что
# «поставил» подставной же pip (он дописывает имена в FAKE_STATE).
FAKE_PYTHON = """#!/bin/sh
echo "$*" >> "$FAKE_PY_LOG"
if [ "$1" = "-c" ]; then
  module="${2#import }"
  case " $FAKE_MODULES $(cat "$FAKE_STATE" 2>/dev/null | tr '\\n' ' ') " in
    *" $module "*) exit 0 ;;
  esac
  exit 1
fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
  [ "$FAKE_PIP" = "broken" ] && exit 1
  shift 2
  case "$1" in
    --version) exit 0 ;;
    show) exit 1 ;;
    install)
      for arg in "$@"; do
        case "$arg" in
          flask|cryptography|pip|setuptools|wheel) echo "$arg" >> "$FAKE_STATE" ;;
          gevent*websocket) echo "geventwebsocket" >> "$FAKE_STATE" ;;
          gevent*) echo "gevent" >> "$FAKE_STATE" ;;
        esac
      done
      exit 0 ;;
  esac
fi
exit 0
"""
FAKE_OPKG = """#!/bin/sh
echo "$*" >> "$FAKE_OPKG_LOG"
[ "$FAKE_OPKG" = "dead" ] && exit 1
exit 0
"""


def _run(tmp_path: Path, body: str, *, modules: str, opkg: str = "ok", pip: str = "ok"):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, text in (("python3", FAKE_PYTHON), ("opkg", FAKE_OPKG)):
        path = bin_dir / name
        path.write_bytes(text.encode("utf-8"))
        os.chmod(path, 0o755)
    conf = tmp_path / "opkg.conf"
    conf.write_text("src/gz entware http://bin.entware.net/aarch64-k3.10\n", encoding="utf-8")
    script = tmp_path / "call.sh"
    script.write_bytes(
        "\n".join(
            [
                "set -e",
                f'PYTHON_BIN="{(bin_dir / "python3").as_posix()}"',
                'ARCH="aarch64"; WANT_GEVENT=1; GEVENT_PIP_SPEC="gevent<26"; GEVENT_PIN_REASON=""',
                f'. "{LIB.as_posix()}"',
                body,
                "",
            ]
        ).encode("utf-8")
    )
    env = {
        **os.environ,
        "PATH": bin_dir.as_posix() + os.pathsep + os.environ.get("PATH", ""),
        "FAKE_MODULES": modules,
        "FAKE_STATE": (tmp_path / "installed.txt").as_posix(),
        "FAKE_PY_LOG": (tmp_path / "python.log").as_posix(),
        "FAKE_OPKG_LOG": (tmp_path / "opkg.log").as_posix(),
        "FAKE_OPKG": opkg,
        "FAKE_PIP": pip,
        "XKEEN_OPKG_CONF": conf.as_posix(),
        "XKEEN_OPKG_UPDATE_TIMEOUT": "5",
        "TMPDIR": tmp_path.as_posix(),
    }
    proc = subprocess.run(["sh", script.as_posix()], capture_output=True, text=True, encoding="utf-8", env=env)

    def log(name: str) -> list[str]:
        path = tmp_path / name
        return path.read_text(encoding="utf-8").splitlines() if path.exists() else []

    return proc, log("python.log"), log("opkg.log")


STEPS = "provision_python_libs_check; provision_python_libs_install"
REPORT = '; echo "need=$NEED_FLASK$NEED_CRYPTOGRAPHY$NEED_GEVENT ws=$WS_VERDICT"'


def test_a_router_that_has_everything_is_left_alone(tmp_path):
    proc, python, opkg = _run(tmp_path, STEPS + REPORT, modules="flask cryptography gevent geventwebsocket")

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "need=000 ws=on" in proc.stdout
    assert opkg == []
    assert not [line for line in python if "pip install" in line]


def test_a_missing_library_comes_from_entware_first(tmp_path):
    proc, _python, opkg = _run(tmp_path, STEPS + REPORT, modules="flask gevent geventwebsocket")

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "need=010" in proc.stdout
    assert "update" in opkg
    assert "install python3-cryptography" in opkg


def test_an_unreachable_entware_does_not_stop_what_pip_can_bring(tmp_path):
    proc, python, opkg = _run(tmp_path, STEPS + REPORT, modules="flask gevent geventwebsocket", opkg="dead")

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert any("pip install" in line and line.rstrip().endswith("cryptography") for line in python)
    # Entware молчит: у него больше ничего не просят.
    assert [line for line in opkg if "install" in line] == []
    assert "ws=on" in proc.stdout


def test_without_entware_and_without_pip_the_reason_is_named(tmp_path):
    proc, _python, _opkg = _run(
        tmp_path,
        'provision_python_libs_check; provision_python_libs_install || echo "stopped: $PROVISION_ERROR"',
        modules="flask gevent geventwebsocket",
        opkg="dead",
        pip="broken",
    )

    assert "stopped: " in proc.stdout
    assert "Entware" in proc.stdout.split("stopped: ", 1)[1]


def test_the_installer_calls_the_shared_steps_and_owns_the_screen():
    installer = INSTALLER.read_text(encoding="utf-8")
    shared = LIB.read_text(encoding="utf-8")

    assert "provision_python_libs_check\n" in installer
    assert 'provision_python_libs_install || fail_install "${PROVISION_ERROR:-' in installer
    assert "pip_install_with_fallback() {" in shared and "pip_install_with_fallback() {" not in installer
    for name in ("provision_python_libs_check() {", "provision_python_libs_install() {"):
        assert name in shared
    # Ни один запрос списка пакетов не идёт мимо предела времени.
    for text in (installer, shared):
        assert '"$OPKG_BIN" update' not in text.replace('provision_run_limited "$_pu_limit" "$OPKG_BIN" update', "")
