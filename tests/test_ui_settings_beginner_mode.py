from services import ui_settings


def test_ui_settings_default_beginner_mode_is_enabled(tmp_path):
    loaded = ui_settings.load_settings(ui_state_dir=str(tmp_path))
    assert loaded["editor"]["beginnerModeEnabled"] is True


def test_ui_settings_persists_editor_beginner_mode_toggle(tmp_path):
    saved = ui_settings.save_settings(
        {"editor": {"beginnerModeEnabled": True}},
        ui_state_dir=str(tmp_path),
    )

    assert saved["editor"]["beginnerModeEnabled"] is True

    loaded = ui_settings.load_settings(ui_state_dir=str(tmp_path))
    assert loaded["editor"]["beginnerModeEnabled"] is True

    patched, report = ui_settings.patch_settings(
        {"editor": {"beginnerModeEnabled": False}},
        ui_state_dir=str(tmp_path),
    )

    assert report["errors"] == []
    assert patched["editor"]["beginnerModeEnabled"] is False


def test_ui_settings_rejects_invalid_editor_beginner_mode_toggle(tmp_path):
    saved = ui_settings.save_settings(
        {"editor": {"beginnerModeEnabled": True}},
        ui_state_dir=str(tmp_path),
    )
    assert saved["editor"]["beginnerModeEnabled"] is True

    try:
        ui_settings.patch_settings(
            {"editor": {"beginnerModeEnabled": "yes please"}},
            ui_state_dir=str(tmp_path),
        )
    except ui_settings.UISettingsValidationError as exc:
        assert exc.errors == [{"path": "editor.beginnerModeEnabled", "error": "must be boolean"}]
    else:
        raise AssertionError("invalid beginnerModeEnabled patch should be rejected")

    loaded = ui_settings.load_settings(ui_state_dir=str(tmp_path))
    assert loaded["editor"]["beginnerModeEnabled"] is True


def test_ui_settings_save_warns_on_invalid_beginner_mode_then_keeps_default(tmp_path):
    saved = ui_settings.save_settings(
        {"editor": {"beginnerModeEnabled": "nope"}},
        ui_state_dir=str(tmp_path),
    )

    assert saved["editor"]["beginnerModeEnabled"] is True
