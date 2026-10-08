"""Скрипт удаления панели доезжает до роутера и обновляется вместе с ней.

`uninstall.sh` не принадлежит ни одному модулю: в пакеты модулей он попасть не
должен. Но раскладка по карте владения кладёт только то, что в карте есть, и
после модульной установки файла, который README велит запускать, в панели не
оказывалось. Его кладёт установщик и освежает обновление из панели.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from services.module_transactions.executor import run_operation
from services.module_transactions.extract import read_panel_member
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_panel_update_plan
from services.panel_package_contract import validate_panel_archive
from tests.support.module_tx import ARCHITECTURE, file_bytes, make_panel, make_release


ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "xkeen-ui" / "scripts" / "provision_env.sh"
INSTALLER = ROOT / "xkeen-ui" / "install.sh"
NEW = "2.11.0"


def _shell(tmp_path: Path, body: str) -> subprocess.CompletedProcess:
    script = tmp_path / "call.sh"
    script.write_bytes("\n".join(["set -e", f'. "{LIB.as_posix()}"', body, ""]).encode("utf-8"))
    return subprocess.run(
        ["sh", script.as_posix()],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHON_BIN": Path(sys.executable).as_posix()},
    )


# --- установщик ---------------------------------------------------------------------


def test_the_installer_lays_the_uninstall_script(tmp_path):
    source, target = tmp_path / "src" / "uninstall.sh", tmp_path / "panel" / "uninstall.sh"
    source.parent.mkdir()
    target.parent.mkdir()
    source.write_bytes(b"#!/bin/sh\necho new\n")
    target.write_bytes(b"#!/bin/sh\necho old\n")

    proc = _shell(tmp_path, f'provision_uninstall_script "{source.as_posix()}" "{target.as_posix()}"')

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert target.read_bytes() == b"#!/bin/sh\necho new\n"
    assert sorted(path.name for path in target.parent.iterdir()) == ["uninstall.sh"]


def test_a_package_without_the_script_leaves_the_installed_one(tmp_path):
    target = tmp_path / "panel" / "uninstall.sh"
    target.parent.mkdir()
    target.write_bytes(b"#!/bin/sh\necho old\n")

    proc = _shell(tmp_path, f'provision_uninstall_script "{(tmp_path / "none.sh").as_posix()}" "{target.as_posix()}"')

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert target.read_bytes() == b"#!/bin/sh\necho old\n"


def test_the_installer_takes_the_script_from_its_own_package():
    installer = INSTALLER.read_text(encoding="utf-8")

    assert 'provision_uninstall_script "$SRC_DIR/uninstall.sh" "$UI_DIR/uninstall.sh"' in installer


# --- обновление из панели ---------------------------------------------------------------


def _update_plan(tmp_path: Path, panel, release):
    archive = tmp_path / "checked" / "panel.tar.gz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(release.panel)
    return build_panel_update_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_archive=validate_panel_archive(archive, release.catalog["panel"], platform_architecture=ARCHITECTURE),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )


def _run(panel, plan, release, *, healthy=lambda _phase: True) -> str:
    journal = Journal.create(panel.root, plan, "uninstall-script-operation", extra={})
    return run_operation(
        journal,
        state_dir=panel.state,
        client=release.client(panel.state, core_version=plan.source_version),
        architecture=ARCHITECTURE,
        restart=lambda: None,
        wait_healthy=healthy,
    )


def test_the_release_archive_carries_the_script_outside_of_any_module(tmp_path):
    release = make_release(version=NEW)
    archive = tmp_path / "panel.tar.gz"
    archive.write_bytes(release.panel)

    checked = validate_panel_archive(archive, release.catalog["panel"], platform_architecture=ARCHITECTURE)

    assert "uninstall.sh" in checked["payload_files"]
    assert all("uninstall.sh" not in paths for paths in checked["ownership"]["modules"].values())
    assert read_panel_member(archive, "uninstall.sh", max_bytes=1 << 20) == file_bytes("uninstall.sh", NEW)


def test_an_update_lays_the_uninstall_script_of_the_release(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    release = make_release(version=NEW)
    assert not (panel.root / "uninstall.sh").exists()

    assert _run(panel, _update_plan(tmp_path, panel, release), release) == "committed"

    assert (panel.root / "uninstall.sh").read_bytes() == file_bytes("uninstall.sh", NEW)


def test_a_rolled_back_update_puts_the_previous_script_back(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    (panel.root / "uninstall.sh").write_bytes(b"#!/bin/sh\necho previous\n")
    release = make_release(version=NEW)

    result = _run(panel, _update_plan(tmp_path, panel, release), release, healthy=lambda phase: phase == "rollback")

    assert result == "rolled_back"
    assert (panel.root / "uninstall.sh").read_bytes() == b"#!/bin/sh\necho previous\n"


def test_the_script_is_not_counted_among_managed_files(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    release = make_release(version=NEW)

    assert _run(panel, _update_plan(tmp_path, panel, release), release) == "committed"

    assert "uninstall.sh" not in panel.read_json("install-managed.json")["paths"]


def test_a_member_larger_than_the_limit_is_not_read(tmp_path):
    release = make_release(version=NEW)
    archive = tmp_path / "panel.tar.gz"
    archive.write_bytes(release.panel)

    assert read_panel_member(archive, "uninstall.sh", max_bytes=3) is None
    assert read_panel_member(archive, "no-such-file", max_bytes=1 << 20) is None
