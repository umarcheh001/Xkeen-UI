"""Перед удалением панель возвращает роутеру то, что держит вне своих файлов.

Включённая защита DNS — это настройка прошивки и управляемый кусок конфига
ядра. `uninstall.sh` зовёт `scripts/release_router_settings.py`, а тот — тот же
код, которым панель снимает защиту перед остановкой службы. Здесь же: запись о
том, какие библиотеки Python поставила сама панель, — по ней чистое удаление
убирает только своё.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "xkeen-ui" / "scripts" / "release_router_settings.py"
LIB = ROOT / "xkeen-ui" / "scripts" / "provision_env.sh"
UNINSTALL = ROOT / "xkeen-ui" / "uninstall.sh"


@pytest.fixture
def script(monkeypatch):
    spec = importlib.util.spec_from_file_location("release_router_settings_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "_ui_state_dir", lambda: "/state")
    monkeypatch.setattr(module, "_xray_paths", lambda _state: ("/configs", "/configs/05_routing.json"))
    monkeypatch.setattr(module, "_mihomo_config_file", lambda: "/mihomo/config.yaml")
    monkeypatch.setattr(module, "_restart_xkeen", lambda _state: "restart")
    return module


def test_the_protection_is_released_the_way_the_panel_does_it(script):
    calls, lines = [], []

    def release(**kwargs):
        calls.append(kwargs)
        return {"released": True, "owner": "dns-over-vless", "label": "DNS-over-VLESS (Xray)"}

    assert script.release_dns_protection(release=release, out=lines.append) == 0

    assert calls == [
        {
            "expected_owner": "",
            "configs_dir": "/configs",
            "routing_file": "/configs/05_routing.json",
            "ui_state_dir": "/state",
            "mihomo_config_file": "/mihomo/config.yaml",
            "restart_xkeen": "restart",
        }
    ]
    assert "DNS-over-VLESS (Xray)" in lines[-1]


def test_nothing_to_release_is_not_a_failure(script):
    lines = []

    code = script.release_dns_protection(
        release=lambda **_kwargs: {"released": False, "already_inactive": True}, out=lines.append
    )

    assert code == 0
    assert lines == ["[*] Защита DNS не включена."]


def test_a_protection_that_stays_on_is_reported_with_its_reason(script):
    lines = []

    def release(**_kwargs):
        raise RuntimeError("Защищённый DNS остался активен; остановка xkeen отменена.")

    assert script.release_dns_protection(release=release, out=lines.append) == 1
    assert lines[-1].startswith("[!] ")
    assert "остался активен" in lines[-1]


def test_the_script_uses_the_release_of_the_service_stop():
    source = SCRIPT.read_text(encoding="utf-8")

    assert "from services.dns_service_lifecycle import release_for_service_stop" in source


def test_the_uninstaller_calls_the_script_after_the_panel_is_stopped():
    source = UNINSTALL.read_text(encoding="utf-8")

    stop = source.index('"$ACTIVE_INIT_SCRIPT" stop')
    release = source.index('"$PYTHON_BIN" "$RELEASE_SCRIPT"')
    remove = source.index('remove_tree "$UI_DIR"\n')
    assert stop < release < remove


# --- что из Python поставила панель -------------------------------------------------------


FAKE_PYTHON = """#!/bin/sh
# Отвечает на `-m pip list` содержимым файла, как это сделал бы pip.
cat "{listing}"
"""
FAKE_OPKG = """#!/bin/sh
echo "python3-cryptography - 46.0.5-1"
echo "python3-cffi - 1.17.1-1"
echo "lftp - 4.9.2-1"
"""


def _record(tmp_path: Path, before: str, after: str, *, existing: str | None = None) -> str:
    listing = tmp_path / "pip-list.txt"
    record = tmp_path / "panel" / "var" / "pip-installed-by-panel.txt"
    if existing is not None:
        record.parent.mkdir(parents=True)
        record.write_bytes(existing.encode("utf-8"))
    tools = tmp_path / "tools"
    tools.mkdir()
    python, opkg = tools / "python3", tools / "opkg"
    python.write_bytes(FAKE_PYTHON.format(listing=listing.as_posix()).encode("utf-8"))
    opkg.write_bytes(FAKE_OPKG.encode("utf-8"))
    for tool in (python, opkg):
        os.chmod(tool, 0o755)
    call = tmp_path / "call.sh"
    call.write_bytes(
        "\n".join(
            [
                "set -e",
                f'. "{LIB.as_posix()}"',
                f'printf "%s" "$BEFORE" > "{listing.as_posix()}"',
                "provision_pip_record_begin",
                f'printf "%s" "$AFTER" > "{listing.as_posix()}"',
                "provision_pip_record_end",
                "",
            ]
        ).encode("utf-8")
    )
    proc = subprocess.run(
        ["sh", call.as_posix()],
        capture_output=True,
        env={
            **os.environ,
            "PATH": tools.as_posix() + os.pathsep + os.environ.get("PATH", ""),
            "PYTHON_BIN": python.as_posix(),
            "UI_DIR": (tmp_path / "panel").as_posix(),
            "TMPDIR": tmp_path.as_posix(),
            "BEFORE": before,
            "AFTER": after,
        },
    )
    assert proc.returncode == 0, proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
    return record.read_text(encoding="utf-8") if record.is_file() else ""


def test_only_what_the_panel_brought_is_recorded(tmp_path):
    recorded = _record(
        tmp_path,
        before="pip==24.0\nrequests==2.32.0\n",
        after="pip==25.0\nrequests==2.32.0\nFlask==3.1.0\nWerkzeug==3.1.0\nzope.event==5.0\ngevent_websocket==0.10.1\n",
    )

    assert recorded.split() == ["flask", "gevent-websocket", "werkzeug", "zope.event"]


def test_what_entware_brought_is_not_the_panels(tmp_path):
    recorded = _record(
        tmp_path,
        before="",
        after="pip==25.0\nsetuptools==75.0\nwheel==0.45\ncryptography==46.0.5\ncffi==1.17.1\nflask==3.1.0\n",
    )

    # pip со спутниками и cryptography с cffi пришли пакетами Entware.
    assert recorded.split() == ["flask"]


def test_nothing_new_writes_nothing(tmp_path):
    assert _record(tmp_path, before="flask==3.1.0\n", after="flask==3.1.0\n") == ""


def test_a_later_install_adds_to_the_record(tmp_path):
    recorded = _record(
        tmp_path, before="flask==3.1.0\n", after="flask==3.1.0\ngevent==25.9.1\n", existing="flask\n"
    )

    assert recorded.split() == ["flask", "gevent"]
