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


def _sync_templates(tmp_path: Path, source: Path, target: Path) -> None:
    proc = _run(tmp_path, f'sync_bundled_template_dir "{source.as_posix()}" "{target.as_posix()}" test')
    assert proc.returncode == 0, proc.stderr


def _copies(target: Path) -> list[str]:
    return sorted(path.name for path in target.iterdir() if ".dist-" in path.name)


def test_an_untouched_template_is_replaced_without_a_copy(tmp_path):
    source, target = tmp_path / "src", tmp_path / "routing"
    source.mkdir()
    target.mkdir()
    (source / "05_routing_base.jsonc").write_text("{ v1 }\n", encoding="utf-8")
    _sync_templates(tmp_path, source, target)

    # The next release changes the template; the owner never opened it.
    (source / "05_routing_base.jsonc").write_text("{ v2 }\n", encoding="utf-8")
    _sync_templates(tmp_path, source, target)

    assert (target / "05_routing_base.jsonc").read_text(encoding="utf-8") == "{ v2 }\n"
    assert _copies(target) == []


def test_a_template_edited_after_install_still_keeps_a_copy(tmp_path):
    source, target = tmp_path / "src", tmp_path / "routing"
    source.mkdir()
    target.mkdir()
    (source / "05_routing_base.jsonc").write_text("{ v1 }\n", encoding="utf-8")
    _sync_templates(tmp_path, source, target)
    (target / "05_routing_base.jsonc").write_text("{ v1 edited }\n", encoding="utf-8")

    (source / "05_routing_base.jsonc").write_text("{ v2 }\n", encoding="utf-8")
    _sync_templates(tmp_path, source, target)

    copies = _copies(target)
    assert len(copies) == 1
    assert (target / copies[0]).read_text(encoding="utf-8") == "{ v1 edited }\n"


def test_a_crlf_copy_of_the_installed_template_counts_as_untouched(tmp_path):
    source, target = tmp_path / "src", tmp_path / "routing"
    source.mkdir()
    target.mkdir()
    (source / "05_routing_base.jsonc").write_bytes(b"{ v1 }\r\n")
    _sync_templates(tmp_path, source, target)

    (source / "05_routing_base.jsonc").write_text("{ v2 }\n", encoding="utf-8")
    (target / "05_routing_base.jsonc").write_bytes(b"{ v1 }\n")
    _sync_templates(tmp_path, source, target)

    assert _copies(target) == []


def test_piled_up_copies_are_thinned_without_losing_a_distinct_edit(tmp_path):
    source, target = tmp_path / "src", tmp_path / "routing"
    source.mkdir()
    target.mkdir()
    (source / "05_routing_base.jsonc").write_text("{ shipped }\n", encoding="utf-8")
    (source / "07_other.jsonc").write_text("{ other }\n", encoding="utf-8")
    (target / "05_routing_base.jsonc").write_text("{ shipped }\n", encoding="utf-8")
    (target / "07_other.jsonc").write_text("{ other }\n", encoding="utf-8")
    # What years of updates left behind: the same two bodies over and over
    # (CRLF and LF builds), one copy equal to today's template, and edits.
    piled = {
        "20260610-133506": "{ a }\n",
        "20260611-131423": "{ a }\r\n",
        "20260616-124130": "{ a }\n",
        "20260618-164617": "{ shipped }\n",
        "20260707-144913": "{ edit 1 }\n",
        "20260708-153326": "{ edit 2 }\n",
        "20260724-141505": "{ edit 3 }\n",
        "20260811-142731": "{ edit 4 }\n",
    }
    for stamp, body in piled.items():
        (target / f"05_routing_base.jsonc.dist-{stamp}").write_bytes(body.encode("utf-8"))
    (target / "07_other.jsonc.dist-20260610-133506").write_text("{ old other }\n", encoding="utf-8")
    (target / "mine.jsonc").write_text("{ mine }\n", encoding="utf-8")

    _sync_templates(tmp_path, source, target)

    assert _copies(target) == [
        "05_routing_base.jsonc.dist-20260708-153326",
        "05_routing_base.jsonc.dist-20260724-141505",
        "05_routing_base.jsonc.dist-20260811-142731",
        "07_other.jsonc.dist-20260610-133506",
    ]
    assert (target / "mine.jsonc").read_text(encoding="utf-8") == "{ mine }\n"


def test_identical_copies_keep_the_newest_one(tmp_path):
    source, target = tmp_path / "src", tmp_path / "routing"
    source.mkdir()
    target.mkdir()
    (source / "05_routing_base.jsonc").write_text("{ shipped }\n", encoding="utf-8")
    (target / "05_routing_base.jsonc").write_text("{ shipped }\n", encoding="utf-8")
    for stamp, body in (("20260610-133506", b"{ a }\n"), ("20260611-131423", b"{ a }\r\n")):
        (target / f"05_routing_base.jsonc.dist-{stamp}").write_bytes(body)

    _sync_templates(tmp_path, source, target)

    assert _copies(target) == ["05_routing_base.jsonc.dist-20260611-131423"]


# --- байткод в каталоге панели ----------------------------------------------------------


def _tree_with_bytecode(tmp_path: Path) -> Path:
    ui = tmp_path / "xkeen-ui"
    for package in ("", "services", "services/routing"):
        folder = ui / package
        (folder / "__pycache__").mkdir(parents=True)
        (folder / "__pycache__" / "mod.cpython-313.pyc").write_bytes(b"old")
        (folder / "mod.py").write_text("x = 1\n", encoding="utf-8")
    (ui / "secret.key").write_text("key\n", encoding="utf-8")
    return ui


def test_bytecode_left_in_the_panel_tree_by_old_versions_is_removed(tmp_path):
    ui = _tree_with_bytecode(tmp_path)
    cache = tmp_path / "tmp" / "xkeen-ui-pycache"
    (cache / "opt").mkdir(parents=True)
    (cache / "opt" / "kept.pyc").write_bytes(b"live")

    proc = _run(tmp_path, f'provision_drop_tree_bytecode "{ui.as_posix()}" "{cache.as_posix()}"')

    assert proc.returncode == 0, proc.stderr
    assert sorted(p.relative_to(ui).as_posix() for p in ui.rglob("*")) == [
        "mod.py",
        "secret.key",
        "services",
        "services/mod.py",
        "services/routing",
        "services/routing/mod.py",
    ]
    assert (cache / "opt" / "kept.pyc").read_bytes() == b"live"


def test_bytecode_is_kept_when_the_cache_itself_lives_in_the_panel_tree(tmp_path):
    ui = _tree_with_bytecode(tmp_path)

    proc = _run(tmp_path, f'provision_drop_tree_bytecode "{ui.as_posix()}" "{(ui / "cache").as_posix()}"')

    assert proc.returncode == 0, proc.stderr
    assert len(list(ui.rglob("__pycache__"))) == 3


def test_bytecode_is_kept_when_no_cache_prefix_is_in_use(tmp_path):
    ui = _tree_with_bytecode(tmp_path)

    proc = _run(tmp_path, f'provision_drop_tree_bytecode "{ui.as_posix()}" ""')

    assert proc.returncode == 0, proc.stderr
    assert len(list(ui.rglob("__pycache__"))) == 3


def test_install_and_panel_update_both_drop_tree_bytecode():
    installer = INSTALLER.read_text(encoding="utf-8")
    library = LIB.read_text(encoding="utf-8")
    apply_body = library.split("provision_cmd_apply() {", 1)[1].split("\n}\n", 1)[0]

    assert "provision_drop_tree_bytecode() {" in library
    assert "provision_drop_tree_bytecode" in apply_body
    assert re.search(r"^provision_drop_tree_bytecode\b", installer, re.MULTILINE)


# --- байткод в библиотеках Python ----------------------------------------------------------


def _libs_with_bytecode(tmp_path: Path) -> Path:
    site = tmp_path / "lib" / "python3.13" / "site-packages"
    for package in ("pip", "pip/_internal"):
        (site / package / "__pycache__").mkdir(parents=True)
        (site / package / "__pycache__" / "mod.cpython-313.pyc").write_bytes(b"old")
        (site / package / "mod.py").write_text("x = 1\n", encoding="utf-8")
    # пакеты Entware кладут .pyc без исходника: это сам код библиотеки, а не кэш
    (site / "yaml").mkdir()
    (site / "yaml" / "__init__.pyc").write_bytes(b"code")
    (tmp_path / "lib" / "python3.13" / "__pycache__").mkdir()
    (tmp_path / "lib" / "python3.13" / "__pycache__" / "os.cpython-313.pyc").write_bytes(b"std")
    return tmp_path / "lib"


def test_bytecode_of_python_libraries_is_removed_and_their_code_is_kept(tmp_path):
    lib = _libs_with_bytecode(tmp_path)
    cache = tmp_path / "tmp" / "xkeen-ui-pycache"

    proc = _run(tmp_path, f'provision_drop_libs_bytecode "{lib.as_posix()}" "{cache.as_posix()}"')

    assert proc.returncode == 0, proc.stderr
    site = lib / "python3.13" / "site-packages"
    assert not list(site.rglob("__pycache__"))
    assert (site / "yaml" / "__init__.pyc").read_bytes() == b"code"
    assert (site / "pip" / "mod.py").is_file()
    assert (lib / "python3.13" / "__pycache__" / "os.cpython-313.pyc").is_file()


def test_bytecode_of_python_libraries_is_kept_without_a_cache_prefix(tmp_path):
    lib = _libs_with_bytecode(tmp_path)

    proc = _run(tmp_path, f'provision_drop_libs_bytecode "{lib.as_posix()}" ""')

    assert proc.returncode == 0, proc.stderr
    assert len(list((lib / "python3.13" / "site-packages").rglob("__pycache__"))) == 2


def test_missing_python_libraries_are_not_an_error(tmp_path):
    proc = _run(tmp_path, f'provision_drop_libs_bytecode "{(tmp_path / "nope").as_posix()}" "/tmp/cache"')

    assert proc.returncode == 0, proc.stderr


def test_install_and_panel_update_both_drop_library_bytecode():
    installer = INSTALLER.read_text(encoding="utf-8")
    library = LIB.read_text(encoding="utf-8")
    apply_body = library.split("provision_cmd_apply() {", 1)[1].split("\n}\n", 1)[0]

    assert "provision_drop_libs_bytecode() {" in library
    assert "provision_drop_libs_bytecode" in apply_body
    assert re.search(r"^provision_drop_libs_bytecode\b", installer, re.MULTILINE)


# --- база учёта трафика Mihomo ----------------------------------------------------------


def test_idle_mihomo_traffic_database_is_removed(tmp_path):
    # Сборки конца сентября копили её и там, где Mihomo никогда не ставился.
    ui = tmp_path / "xkeen-ui"
    ui.mkdir()
    for name in ("mihomo-traffic.sqlite3", "mihomo-traffic.sqlite3-wal", "mihomo-traffic.sqlite3-shm"):
        (ui / name).write_bytes(b"db")
    (ui / "secret.key").write_text("key\n", encoding="utf-8")

    proc = _run(tmp_path, f'provision_drop_idle_mihomo_traffic "{ui.as_posix()}"')

    assert proc.returncode == 0, proc.stderr
    assert sorted(p.name for p in ui.iterdir()) == ["secret.key"]


def test_mihomo_traffic_database_is_dropped_only_without_the_module():
    installer = INSTALLER.read_text(encoding="utf-8")
    library = LIB.read_text(encoding="utf-8")
    apply_body = library.split("provision_cmd_apply() {", 1)[1].split("\n}\n", 1)[0]

    assert re.search(
        r"if ! provision_has_module engine\.mihomo; then\n\s+provision_drop_idle_mihomo_traffic ", apply_body
    )
    assert re.search(
        r"^if ! profile_has_module engine\.mihomo; then\n\s+provision_drop_idle_mihomo_traffic ", installer, re.MULTILINE
    )


# --- следы снятого самообновлятора ------------------------------------------------------


def test_files_of_the_retired_updater_are_removed_and_the_live_ones_stay(tmp_path):
    # update.log и status.json писал самообновлятор, снятый 11.10.2026; замок
    # и кэш архива в той же папке — живые, ими пользуется обновление из окна модулей.
    update = tmp_path / "update"
    (update / "panel-archive").mkdir(parents=True)
    for name in ("update.log", "update.log.1", "status.json", "lock", "lock.guard"):
        (update / name).write_text("x\n", encoding="utf-8")
    (update / "panel-archive" / "a.tar.gz").write_bytes(b"gz")

    proc = _run(tmp_path, f'provision_drop_retired_updater_files "{update.as_posix()}"')

    assert proc.returncode == 0, proc.stderr
    assert sorted(p.name for p in update.iterdir()) == ["lock", "lock.guard", "panel-archive"]
    assert (update / "panel-archive" / "a.tar.gz").is_file()


def test_retired_updater_files_are_dropped_on_install_and_on_update():
    installer = INSTALLER.read_text(encoding="utf-8")
    library = LIB.read_text(encoding="utf-8")
    apply_body = library.split("provision_cmd_apply() {", 1)[1].split("\n}\n", 1)[0]
    wanted = r'provision_drop_retired_updater_files "\$\{XKEEN_UI_UPDATE_DIR:-/opt/var/lib/xkeen-ui/update\}"'

    assert re.search(wanted, apply_body)
    assert re.search(r"^" + wanted, installer, re.MULTILINE)


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
