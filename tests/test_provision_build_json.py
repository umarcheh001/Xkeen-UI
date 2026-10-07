"""После установки панель знает, какая сборка на самом деле стоит.

Штамп сборки лежит в `BUILD.json` архива. Раскладка профиля этот файл не кладёт
(он не принадлежит ни одному модулю), а установщик читал штамп из уже
установленной панели — и после установки новой сборки панель продолжала
называть себя прежней версией. Штамп берётся из архива, а то, что выбрал
владелец (репозиторий и канал обновлений), — из установленной панели.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "xkeen-ui" / "scripts" / "provision_env.sh"
INSTALLER = ROOT / "xkeen-ui" / "install.sh"

INSTALLED = {
    "repo": "someone/fork",
    "channel": "beta",
    "version": "2.9.2a",
    "commit": "9" * 40,
    "base_commit": "9999999",
    "dirty": False,
    "tree_sha256": "a" * 64,
    "built_utc": "2026-10-02T21:19:34Z",
    "source": "install.sh",
    "artifact": None,
}
PACKAGED = {
    "version": "63018f67",
    "base_commit": "63018f67",
    "commit": "6" * 40,
    "dirty": False,
    "tree_sha256": "b" * 64,
    "release_date": "2026-10-07T17:15:22Z",
    "update_url": "",
}


def _run(tmp_path: Path, packaged: dict | None, installed: dict | None, **env: str) -> dict:
    stamp, target = tmp_path / "package" / "BUILD.json", tmp_path / "panel" / "BUILD.json"
    stamp.parent.mkdir()
    target.parent.mkdir()
    if packaged is not None:
        stamp.write_text(json.dumps(packaged, indent=2), encoding="utf-8")
    if installed is not None:
        target.write_text(json.dumps(installed, indent=2), encoding="utf-8")
    script = tmp_path / "call.sh"
    script.write_bytes(
        "\n".join(
            ["set -e", f'. "{LIB.as_posix()}"', f'provision_build_json "{stamp.as_posix()}" "{target.as_posix()}"', ""]
        ).encode("utf-8")
    )
    clean = {key: value for key, value in os.environ.items() if not key.startswith("XKEEN_UI_")}
    proc = subprocess.run(
        ["sh", script.as_posix()], capture_output=True, text=True, encoding="utf-8", env={**clean, **env}
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(target.read_text(encoding="utf-8"))


def test_the_installed_panel_reports_the_build_that_was_installed(tmp_path):
    written = _run(tmp_path, PACKAGED, INSTALLED)

    assert written["version"] == "63018f67"
    assert written["commit"] == "6" * 40
    assert written["base_commit"] == "63018f67"
    assert written["tree_sha256"] == "b" * 64
    assert written["dirty"] is False
    assert written["source"] == "install.sh"
    assert written["built_utc"].endswith("Z")


def test_the_owners_repository_and_channel_survive_the_install(tmp_path):
    written = _run(tmp_path, PACKAGED, INSTALLED)

    assert (written["repo"], written["channel"]) == ("someone/fork", "beta")


def test_a_first_install_gets_the_stamp_and_the_defaults(tmp_path):
    written = _run(tmp_path, PACKAGED, None)

    assert written["version"] == "63018f67"
    assert (written["repo"], written["channel"]) == ("umarcheh001/Xkeen-UI", "stable")


def test_a_package_without_a_stamp_keeps_what_the_panel_knew(tmp_path):
    written = _run(tmp_path, None, INSTALLED)

    assert written["version"] == "2.9.2a"
    assert written["tree_sha256"] == "a" * 64


def test_a_dirty_build_does_not_claim_a_commit(tmp_path):
    written = _run(tmp_path, {**PACKAGED, "version": "63018f67-dirty", "commit": None, "dirty": True}, INSTALLED)

    assert written["version"] == "63018f67-dirty"
    assert written["dirty"] is True
    # Коммит прежней сборки новой не принадлежит.
    assert written["commit"] is None


def test_the_release_can_name_itself_through_the_environment(tmp_path):
    written = _run(
        tmp_path, PACKAGED, INSTALLED,
        XKEEN_UI_VERSION="2.11.0", XKEEN_UI_COMMIT="c" * 40, XKEEN_UI_UPDATE_CHANNEL="stable",
    )

    assert (written["version"], written["commit"], written["channel"]) == ("2.11.0", "c" * 40, "stable")


def test_the_installer_takes_the_stamp_from_its_own_package():
    installer = INSTALLER.read_text(encoding="utf-8")

    assert 'provision_build_json "$SRC_DIR/BUILD.json" "$UI_DIR/BUILD.json"' in installer
    assert "extract_json_field() {" not in installer
