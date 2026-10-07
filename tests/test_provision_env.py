"""Приведение окружения панели — общая работа установщика и обновления.

Всё, что должно быть верным после любой смены версии и лежит вне каталога
панели (команды в /opt/bin, шаблоны, поправки совместимости), собрано в
`scripts/provision_env.sh`. Установщик вызывает эти функции между шагами своего
экрана; сами они о терминале не знают, чтобы ту же работу могло выполнять
обновление из панели.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "xkeen-ui" / "scripts" / "provision_env.sh"
INSTALLER = ROOT / "xkeen-ui" / "install.sh"
MOVED = (
    "same_ignoring_cr",
    "sync_bundled_template_dir",
    "cleanup_legacy_xray_templates",
)
WRAPPERS = {
    "sysmon": "sysmon_keenetic.sh",
    "entware-backup": "entware_backup.sh",
    "storage-dashboard": "storage_dashboard.sh",
    "device-locks": "device_lock_detector.sh",
    "memory-check": "memory_check.sh",
    "version-check": "version_check.sh",
    "backup-monitor": "backup_monitor.sh",
}


def _run(tmp_path: Path, body: str, **env: str) -> subprocess.CompletedProcess:
    """Выполнить функции общего скрипта так, как это делает установщик."""

    script = tmp_path / "call.sh"
    script.write_bytes(
        "\n".join(["set -e", f'. "{LIB.as_posix()}"', body, ""]).encode("utf-8")
    )
    return subprocess.run(
        ["sh", script.as_posix()],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHON_BIN": Path(sys.executable).as_posix(), **env},
    )


def _panel(tmp_path: Path, *tools: str) -> tuple[Path, Path]:
    ui, bin_dir = tmp_path / "xkeen-ui", tmp_path / "bin"
    (ui / "tools").mkdir(parents=True)
    bin_dir.mkdir()
    for name in tools:
        (ui / "tools" / name).write_text("#!/bin/sh\n", encoding="utf-8")
    return ui, bin_dir


# --- сам скрипт -----------------------------------------------------------------------


def test_the_script_is_valid_posix_shell():
    proc = subprocess.run(["sh", "-n", LIB.as_posix()], capture_output=True, text=True)

    assert proc.returncode == 0, proc.stderr


def test_the_script_never_touches_the_terminal():
    code = "\n".join(
        line for line in LIB.read_text(encoding="utf-8").splitlines() if not line.lstrip().startswith("#")
    )

    # Экран рисует тот, кто вызвал: установщик или никто (обновление из панели).
    assert not re.search(r"\bui_[a-z_]+\b", code)
    assert "/dev/tty" not in code
    assert ">&3" not in code and "INSTALL_UI_FD" not in code


def test_the_script_is_stored_with_unix_line_endings():
    assert b"\r" not in LIB.read_bytes()


def test_the_installer_takes_the_work_from_the_shared_script():
    installer = INSTALLER.read_text(encoding="utf-8")
    library = LIB.read_text(encoding="utf-8")

    assert '. "$PROVISION_LIB"' in installer
    for name in MOVED:
        # Один источник: определение живёт только в общем скрипте.
        assert f"{name}() {{" in library
        assert f"{name}() {{" not in installer
    for call in (
        "provision_command_wrappers",
        "provision_mihomo_templates",
        "provision_xray_dat_links",
        "provision_routing_compat",
    ):
        assert f"{call}() {{" in library
        assert re.search(rf"^\s*(if .*)?{call}\b", installer, flags=re.MULTILINE), call


# --- команды в /opt/bin ---------------------------------------------------------------


def test_every_panel_tool_gets_its_command(tmp_path):
    ui, bin_dir = _panel(tmp_path, *WRAPPERS.values())

    proc = _run(tmp_path, "provision_command_wrappers", UI_DIR=ui.as_posix(), XKEEN_UI_BIN_DIR=bin_dir.as_posix())

    assert proc.returncode == 0, proc.stderr
    for command, tool in WRAPPERS.items():
        text = (bin_dir / command).read_text(encoding="utf-8")
        assert text.startswith("#!/bin/sh\n")
        assert f'SCRIPT="{ui.as_posix()}/tools/{tool}"' in text
        assert text.rstrip().endswith('exec sh "$SCRIPT" "$@"')


def test_a_tool_that_is_not_installed_gets_no_command(tmp_path):
    ui, bin_dir = _panel(tmp_path, "sysmon_keenetic.sh")

    proc = _run(tmp_path, "provision_command_wrappers", UI_DIR=ui.as_posix(), XKEEN_UI_BIN_DIR=bin_dir.as_posix())

    assert proc.returncode == 0, proc.stderr
    assert sorted(path.name for path in bin_dir.iterdir()) == ["sysmon"]


def test_the_retired_io_monitor_is_removed(tmp_path):
    ui, bin_dir = _panel(tmp_path, "io_monitor.sh")
    (bin_dir / "io-monitor").write_text("old\n", encoding="utf-8")

    proc = _run(tmp_path, "provision_command_wrappers", UI_DIR=ui.as_posix(), XKEEN_UI_BIN_DIR=bin_dir.as_posix())

    assert proc.returncode == 0, proc.stderr
    assert not (bin_dir / "io-monitor").exists()
    assert not (ui / "tools" / "io_monitor.sh").exists()


# --- шаблоны --------------------------------------------------------------------------


def test_mihomo_templates_are_replaced_and_retired_ones_removed(tmp_path):
    source, target = tmp_path / "src", tmp_path / "mihomo-templates"
    source.mkdir()
    target.mkdir()
    for name in ("custom.yaml", "zkeen.yaml", "template.yaml"):
        (source / name).write_text(f"new {name}\n", encoding="utf-8")
    (target / "custom.yaml").write_text("old\n", encoding="utf-8")
    for retired in ("config_2.yaml", "umarcheh001.yaml", "hwid_subscription_template.yaml"):
        (target / retired).write_text("retired\n", encoding="utf-8")
    (target / "mine.yaml").write_text("user\n", encoding="utf-8")

    proc = _run(tmp_path, f'provision_mihomo_templates "{source.as_posix()}" "{target.as_posix()}"')

    assert proc.returncode == 0, proc.stderr
    assert sorted(path.name for path in target.iterdir()) == ["custom.yaml", "mine.yaml", "template.yaml", "zkeen.yaml"]
    assert (target / "custom.yaml").read_text(encoding="utf-8") == "new custom.yaml\n"
    assert (target / "mine.yaml").read_text(encoding="utf-8") == "user\n"


def test_a_changed_xray_template_keeps_a_copy_of_the_previous_one(tmp_path):
    source, target = tmp_path / "src", tmp_path / "routing"
    source.mkdir()
    target.mkdir()
    (source / "05_routing_base.jsonc").write_text("{ new }\n", encoding="utf-8")
    (target / "05_routing_base.jsonc").write_text("{ edited by user }\n", encoding="utf-8")

    proc = _run(tmp_path, f'sync_bundled_template_dir "{source.as_posix()}" "{target.as_posix()}" test')

    assert proc.returncode == 0, proc.stderr
    assert (target / "05_routing_base.jsonc").read_text(encoding="utf-8") == "{ new }\n"
    copies = [path for path in target.iterdir() if ".dist-" in path.name]
    assert [path.read_text(encoding="utf-8") for path in copies] == ["{ edited by user }\n"]


# --- совместимость --------------------------------------------------------------------


def test_the_list_missing_from_geosite_is_taken_out_of_routing(tmp_path):
    routing = tmp_path / "05_routing.json"
    routing.write_text(
        json.dumps({"routing": {"rules": [{"domain": ["ext:geosite_v2fly.dat:whatsapp-ads", "ext:geosite_v2fly.dat:google"]}]}}),
        encoding="utf-8",
    )

    proc = _run(tmp_path, f'provision_routing_compat "{routing.as_posix()}"')

    assert proc.returncode == 0, proc.stderr
    assert json.loads(routing.read_text(encoding="utf-8"))["routing"]["rules"][0]["domain"] == [
        "ext:geosite_v2fly.dat:google"
    ]


def test_routing_without_that_list_is_left_untouched(tmp_path):
    routing = tmp_path / "05_routing.json"
    body = '{"routing": {"rules": []}}'
    routing.write_text(body, encoding="utf-8")

    proc = _run(tmp_path, f'provision_routing_compat "{routing.as_posix()}"')

    assert proc.returncode == 0, proc.stderr
    assert routing.read_text(encoding="utf-8") == body


@pytest.mark.skipif(os.name == "nt", reason="символические ссылки проверяются на Linux")
def test_dat_files_are_linked_next_to_the_core(tmp_path):
    dat, sbin = tmp_path / "dat", tmp_path / "sbin"
    dat.mkdir()
    sbin.mkdir()
    (dat / "geosite_v2fly.dat").write_bytes(b"dat")
    (sbin / "geoip.dat").write_bytes(b"real file")
    (dat / "geoip.dat").write_bytes(b"other")

    proc = _run(tmp_path, f'provision_xray_dat_links "{dat.as_posix()}" "{sbin.as_posix()}"')

    assert proc.returncode == 0, proc.stderr
    assert (sbin / "geosite_v2fly.dat").is_symlink()
    # Настоящий файл рядом с ядром ссылкой не затирается.
    assert (sbin / "geoip.dat").read_bytes() == b"real file"
