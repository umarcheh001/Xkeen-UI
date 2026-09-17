from __future__ import annotations

import json

import pytest

from services import ui_settings


def test_scroll_settings_default_to_both_enabled(tmp_path):
    loaded = ui_settings.load_settings(ui_state_dir=str(tmp_path))

    assert loaded["layout"] == {
        "pageScrollEnabled": True,
        "workspaceScrollEnabled": True,
    }


@pytest.mark.parametrize("disabled_key", ["pageScrollEnabled", "workspaceScrollEnabled"])
def test_scroll_settings_allow_either_surface_to_be_disabled(tmp_path, disabled_key):
    patched, report = ui_settings.patch_settings(
        {"layout": {disabled_key: False}},
        ui_state_dir=str(tmp_path),
    )

    assert report == {"warnings": [], "errors": []}
    assert patched["layout"][disabled_key] is False
    assert any(patched["layout"].values())


def test_scroll_settings_reject_disabling_both_surfaces(tmp_path):
    ui_settings.patch_settings(
        {"layout": {"pageScrollEnabled": False}},
        ui_state_dir=str(tmp_path),
    )

    with pytest.raises(ui_settings.UISettingsValidationError) as exc_info:
        ui_settings.patch_settings(
            {"layout": {"workspaceScrollEnabled": False}},
            ui_state_dir=str(tmp_path),
        )

    assert exc_info.value.errors == [
        {"path": "layout", "error": "at least one scroll mode must be enabled"}
    ]
    assert ui_settings.load_settings(ui_state_dir=str(tmp_path))["layout"] == {
        "pageScrollEnabled": False,
        "workspaceScrollEnabled": True,
    }


def test_invalid_file_recovers_to_page_scrolling(tmp_path):
    path = tmp_path / "ui-settings.json"
    path.write_text(
        json.dumps(
            {
                "schemaVersion": ui_settings.SCHEMA_VERSION,
                "layout": {
                    "pageScrollEnabled": False,
                    "workspaceScrollEnabled": False,
                },
            }
        ),
        encoding="utf-8",
    )

    loaded = ui_settings.load_settings(ui_state_dir=str(tmp_path))

    assert loaded["layout"] == {
        "pageScrollEnabled": True,
        "workspaceScrollEnabled": False,
    }
