from services import ui_settings


def test_ui_settings_default_expert_mode_is_disabled(tmp_path):
    loaded = ui_settings.load_settings(ui_state_dir=str(tmp_path))
    assert loaded["editor"]["expertModeEnabled"] is False


def test_ui_settings_persists_editor_expert_mode_toggle(tmp_path):
    saved = ui_settings.save_settings(
        {"editor": {"expertModeEnabled": True}},
        ui_state_dir=str(tmp_path),
    )

    assert saved["editor"]["expertModeEnabled"] is True

    loaded = ui_settings.load_settings(ui_state_dir=str(tmp_path))
    assert loaded["editor"]["expertModeEnabled"] is True

    patched, report = ui_settings.patch_settings(
        {"editor": {"expertModeEnabled": False}},
        ui_state_dir=str(tmp_path),
    )

    assert report["errors"] == []
    assert patched["editor"]["expertModeEnabled"] is False


def test_ui_settings_rejects_invalid_editor_expert_mode_toggle(tmp_path):
    saved = ui_settings.save_settings(
        {"editor": {"expertModeEnabled": True}},
        ui_state_dir=str(tmp_path),
    )
    assert saved["editor"]["expertModeEnabled"] is True

    try:
        ui_settings.patch_settings(
            {"editor": {"expertModeEnabled": "full blast"}},
            ui_state_dir=str(tmp_path),
        )
    except ui_settings.UISettingsValidationError as exc:
        assert exc.errors == [{"path": "editor.expertModeEnabled", "error": "must be boolean"}]
    else:
        raise AssertionError("invalid expertModeEnabled patch should be rejected")

    loaded = ui_settings.load_settings(ui_state_dir=str(tmp_path))
    assert loaded["editor"]["expertModeEnabled"] is True


def test_ui_settings_save_warns_on_invalid_expert_mode_then_keeps_default(tmp_path):
    saved = ui_settings.save_settings(
        {"editor": {"expertModeEnabled": "nope"}},
        ui_state_dir=str(tmp_path),
    )

    assert saved["editor"]["expertModeEnabled"] is False
