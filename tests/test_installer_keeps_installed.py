"""Установщик поверх панели сохраняет установленное, как и обновление из панели.

Без явно заданного профиля `install.sh` ставит то, что уже установлено (или то,
что владелец запросил и ещё не применил), и не трогает переключатели модулей:
выключенный модуль обновляется вместе со всеми и остаётся выключенным.
"""

from __future__ import annotations

import json
import shlex
import subprocess
import sys
from pathlib import Path

import pytest

from tests.test_install_terminal_ui import ROOT, _function, _shell, _text
from tests.test_installer_profiles import _module, _source


HELPER = ROOT / "xkeen-ui" / "scripts" / "module_profile_install.py"


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def _installed_full(tmp_path: Path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"
    helper.commit_profile(helper.apply_profile(src, dest, "full"))
    return helper, src, dest


def _switch_off(dest: Path, module_id: str) -> None:
    state = _read(dest / "modules.json")
    state["modules"][module_id]["enabled"] = False
    state["profile"] = "custom"
    _write(dest / "modules.json", state)


def _update(helper, src: Path, dest: Path) -> None:
    """То, что делает `install.sh` без явно заданного профиля."""

    current = helper.current_install(dest)
    helper.commit_profile(
        helper.apply_profile(
            src,
            dest,
            current["profile"],
            module_ids=current["module_ids"] if current["profile"] == "custom" else None,
            editor_variant=current["editor_variant"],
            keep_switches=True,
        )
    )


def test_current_install_is_what_lies_on_the_storage_not_the_switches(tmp_path):
    helper, _src, dest = _installed_full(tmp_path)
    _switch_off(dest, "tool.terminal")

    current = helper.current_install(dest)

    assert current["profile"] == "full"
    assert "tool.terminal" in current["module_ids"]
    assert current["editor_variant"] == "full"
    assert current["source"] == "installed"


def test_update_refreshes_a_switched_off_module_and_keeps_it_off(tmp_path):
    helper, src, dest = _installed_full(tmp_path)
    _switch_off(dest, "tool.terminal")
    (src / "static/js/pages/terminal.lazy.entry.js").write_text("terminal of the next release", encoding="utf-8")

    _update(helper, src, dest)

    assert (dest / "static/js/pages/terminal.lazy.entry.js").read_text(encoding="utf-8") == "terminal of the next release"
    state = _read(dest / "modules.json")
    assert state["modules"]["tool.terminal"]["enabled"] is False
    assert state["modules"]["tool.files"]["enabled"] is True
    assert state["profile"] == "custom"
    assert _read(dest / "module-installed.json")["modules"]["tool.terminal"] is True
    assert "tool.terminal" in _read(dest / "install-profile.json")["module_ids"]
    assert _read(dest / "install-profile.json")["profile"] == "full"


def test_update_keeps_the_editor_setting_over_the_installed_editor(tmp_path):
    helper, src, dest = _installed_full(tmp_path)
    state = _read(dest / "modules.json")
    state["editor"] = {"variant": "light"}  # настройка: файлы полного редактора остаются
    _write(dest / "modules.json", state)

    _update(helper, src, dest)

    assert _read(dest / "modules.json")["editor"] == {"variant": "light"}
    assert _read(dest / "install-profile.json")["editor_variant"] == "full"
    assert (dest / "static/monaco-editor/vs/editor.js").is_file()


def test_update_applies_a_pending_profile_request_and_forgets_it(tmp_path):
    helper, src, dest = _installed_full(tmp_path)
    state = _read(dest / "modules.json")
    state["profile"] = "xray-minimal"
    for module_id, item in state["modules"].items():
        item["enabled"] = module_id in ("core", "engine.xray", "tool.editor")
    state["physical_request"] = {
        "profile": "xray-minimal",
        "module_ids": ["core", "engine.xray", "tool.editor"],
        "editor_variant": "light",
    }
    _write(dest / "modules.json", state)

    current = helper.current_install(dest)
    _update(helper, src, dest)

    assert current["source"] == "request"
    assert current["profile"] == "xray-minimal"
    assert not (dest / "routes/mihomo.py").exists()
    assert not (dest / "static/monaco-editor/vs/editor.js").exists()
    assert "physical_request" not in _read(dest / "modules.json")
    assert _read(dest / "install-profile.json")["profile"] == "xray-minimal"


def test_a_set_that_matches_no_preset_is_kept_as_custom(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"
    helper.commit_profile(
        helper.apply_profile(src, dest, "custom", module_ids=["core", "tool.editor", "engine.xray", "tool.files"])
    )
    record = _read(dest / "install-profile.json")
    record["profile"] = "xray-minimal"  # название пресета, а лежит больше
    _write(dest / "install-profile.json", record)

    current = helper.current_install(dest)

    assert current["profile"] == "custom"
    assert current["module_ids"] == ["core", "engine.xray", "tool.editor", "tool.files"]


def test_an_install_without_a_record_has_no_current_profile(tmp_path):
    helper = _module()
    dest = tmp_path / "installed"
    dest.mkdir()
    (dest / "modules.json").write_text("{}", encoding="utf-8")

    assert helper.current_install(dest) is None
    assert helper.current_install(tmp_path / "missing") is None


def test_an_explicit_profile_still_sets_the_switches(tmp_path):
    helper, src, dest = _installed_full(tmp_path)
    _switch_off(dest, "engine.xray")

    helper.commit_profile(helper.apply_profile(src, dest, "xray-minimal"))

    state = _read(dest / "modules.json")
    assert state["profile"] == "xray-minimal"
    assert state["modules"]["engine.xray"]["enabled"] is True
    assert state["modules"]["engine.mihomo"]["enabled"] is False


def test_cli_prints_the_current_install_for_the_shell(tmp_path):
    _helper, _src, dest = _installed_full(tmp_path)
    _switch_off(dest, "tool.terminal")

    found = subprocess.run(
        [sys.executable, str(HELPER), "current", "--target", str(dest)], capture_output=True, text=True
    )
    missing = subprocess.run(
        [sys.executable, str(HELPER), "current", "--target", str(tmp_path / "missing")], capture_output=True, text=True
    )

    assert found.returncode == 0, found.stderr
    lines = dict(line.split("=", 1) for line in found.stdout.splitlines())
    assert lines["profile"] == "full"
    assert "tool.terminal" in lines["modules"].split(",")
    assert lines["variant"] == "full"
    assert missing.returncode == 1
    assert missing.stdout == ""


def test_cli_apply_accepts_the_update_options(tmp_path):
    _helper, src, dest = _installed_full(tmp_path)
    _switch_off(dest, "tool.terminal")

    applied = subprocess.run(
        [
            sys.executable, str(HELPER), "apply", "--source", str(src), "--target", str(dest),
            "--profile", "full", "--module-ids", "", "--transaction", str(tmp_path / "tx"),
            "--editor-variant", "full", "--keep-switches",
        ],
        capture_output=True,
        text=True,
    )

    assert applied.returncode == 0, applied.stderr
    assert _read(dest / "modules.json")["modules"]["tool.terminal"]["enabled"] is False


# --- сам install.sh ------------------------------------------------------------------


def test_installer_asks_the_helper_before_reading_the_switches():
    body = _function("choose_panel_profile")

    assert '"$INSTALL_PROFILE_HELPER" current --target "$UI_DIR"' in body
    assert body.index('current --target "$UI_DIR"') < body.index('"$UI_DIR/modules.json"')
    assert "PROFILE_KEEP_SWITCHES=1" in body


def test_installer_hands_the_update_options_to_the_helper():
    text = _text()
    call = text[text.index('"$INSTALL_PROFILE_HELPER" apply'):]
    call = call[: call.index("; then")]

    assert "$PROFILE_APPLY_OPTIONS" in call
    assert "--keep-switches" in text
    assert "--editor-variant" in text


def _choose(tmp_path: Path, dest: Path, extra_env: tuple[str, ...] = ()) -> dict[str, str]:
    script = "\n".join(
        (
            "set -e",
            f"SRC_DIR={shlex.quote((ROOT / 'xkeen-ui').as_posix())}",
            f"UI_DIR={shlex.quote(dest.as_posix())}",
            f"PYTHON_BIN={shlex.quote(Path(sys.executable).as_posix())}",
            'UI_DIM=""',
            'UI_RESET=""',
            "ui_line() { :; }",
            'fail_install() { printf "fail=%s\\n" "$1"; exit 1; }',
            *extra_env,
            _function("choose_panel_profile"),
            "choose_panel_profile",
            'printf "profile=%s\\n" "$PROFILE_CHOICE"',
            'printf "modules=%s\\n" "${XKEEN_UI_INSTALL_MODULES:-}"',
            'printf "options=%s\\n" "$PROFILE_APPLY_OPTIONS"',
        )
    )
    proc = subprocess.run([_shell(), "-c", script], capture_output=True, text=True, encoding="utf-8")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return dict(line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line)


def test_installer_without_a_chosen_profile_keeps_the_installed_set(tmp_path):
    _helper, _src, dest = _installed_full(tmp_path)
    _switch_off(dest, "tool.terminal")

    chosen = _choose(tmp_path, dest)

    assert chosen["profile"] == "full"
    assert "--keep-switches" in chosen["options"]
    assert "--editor-variant full" in chosen["options"]


def test_installer_passes_a_custom_set_as_the_module_list(tmp_path):
    helper = _module()
    src = _source(tmp_path)
    dest = tmp_path / "installed"
    helper.commit_profile(
        helper.apply_profile(src, dest, "custom", module_ids=["core", "tool.editor", "engine.xray", "tool.files"])
    )
    _switch_off(dest, "tool.files")

    chosen = _choose(tmp_path, dest)

    assert chosen["profile"] == "custom"
    assert chosen["modules"].split(",") == ["core", "engine.xray", "tool.editor", "tool.files"]


def test_installer_with_an_explicit_profile_does_what_it_is_told(tmp_path):
    _helper, _src, dest = _installed_full(tmp_path)

    chosen = _choose(tmp_path, dest, ("XKEEN_UI_INSTALL_PROFILE=xray-minimal",))

    assert chosen["profile"] == "xray-minimal"
    assert chosen["options"] == ""
