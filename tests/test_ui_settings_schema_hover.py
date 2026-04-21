from services import ui_settings


def test_ui_settings_persists_editor_schema_hover_toggle(tmp_path):
    saved = ui_settings.save_settings(
        {"editor": {"schemaHoverEnabled": False}},
        ui_state_dir=str(tmp_path),
    )

    assert saved["editor"]["schemaHoverEnabled"] is False

    loaded = ui_settings.load_settings(ui_state_dir=str(tmp_path))
    assert loaded["editor"]["schemaHoverEnabled"] is False

    patched, report = ui_settings.patch_settings(
        {"editor": {"schemaHoverEnabled": True}},
        ui_state_dir=str(tmp_path),
    )

    assert report["errors"] == []
    assert patched["editor"]["schemaHoverEnabled"] is True


def test_ui_settings_rejects_invalid_editor_schema_hover_toggle(tmp_path):
    saved = ui_settings.save_settings(
        {"editor": {"schemaHoverEnabled": True}},
        ui_state_dir=str(tmp_path),
    )
    assert saved["editor"]["schemaHoverEnabled"] is True

    try:
        ui_settings.patch_settings(
            {"editor": {"schemaHoverEnabled": "nope"}},
            ui_state_dir=str(tmp_path),
        )
    except ui_settings.UISettingsValidationError as exc:
        assert exc.errors == [{"path": "editor.schemaHoverEnabled", "error": "must be boolean"}]
    else:
        raise AssertionError("invalid schemaHoverEnabled patch should be rejected")

    loaded = ui_settings.load_settings(ui_state_dir=str(tmp_path))
    assert loaded["editor"]["schemaHoverEnabled"] is True
