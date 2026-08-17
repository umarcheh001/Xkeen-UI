from services import ui_settings


def test_ui_settings_defaults_mihomo_timeout_hiding_to_disabled(tmp_path):
    loaded = ui_settings.load_settings(ui_state_dir=str(tmp_path))

    assert loaded["mihomo"] == {
        "hideUnavailable": False,
        "consecutiveTimeouts": 3,
        "proxySortOrder": "config",
        "collapsedGroups": {},
        "latencyPreset": "auto",
    }


def test_ui_settings_persists_mihomo_timeout_hiding_preferences(tmp_path):
    saved = ui_settings.save_settings(
        {"mihomo": {"hideUnavailable": True, "consecutiveTimeouts": 7}},
        ui_state_dir=str(tmp_path),
    )

    assert saved["mihomo"] == {
        "hideUnavailable": True,
        "consecutiveTimeouts": 7,
        "proxySortOrder": "config",
        "collapsedGroups": {},
        "latencyPreset": "auto",
    }
    assert ui_settings.load_settings(ui_state_dir=str(tmp_path))["mihomo"] == saved["mihomo"]

    patched, report = ui_settings.patch_settings(
        {"mihomo": {"hideUnavailable": False, "consecutiveTimeouts": 1}},
        ui_state_dir=str(tmp_path),
    )

    assert report["errors"] == []
    assert patched["mihomo"] == {
        "hideUnavailable": False,
        "consecutiveTimeouts": 1,
        "proxySortOrder": "config",
        "collapsedGroups": {},
        "latencyPreset": "auto",
    }


def test_ui_settings_rejects_invalid_mihomo_timeout_hiding_preferences(tmp_path):
    ui_settings.save_settings(
        {"mihomo": {"hideUnavailable": True, "consecutiveTimeouts": 4}},
        ui_state_dir=str(tmp_path),
    )

    for patch, expected in (
        (
            {"mihomo": {"hideUnavailable": "yes"}},
            [{"path": "mihomo.hideUnavailable", "error": "must be boolean"}],
        ),
        (
            {"mihomo": {"consecutiveTimeouts": 0}},
            [{"path": "mihomo.consecutiveTimeouts", "error": "must be int 1..10"}],
        ),
        (
            {"mihomo": {"consecutiveTimeouts": 11}},
            [{"path": "mihomo.consecutiveTimeouts", "error": "must be int 1..10"}],
        ),
    ):
        try:
            ui_settings.patch_settings(patch, ui_state_dir=str(tmp_path))
        except ui_settings.UISettingsValidationError as exc:
            assert exc.errors == expected
        else:
            raise AssertionError("invalid Mihomo timeout-hiding patch should be rejected")

    assert ui_settings.load_settings(ui_state_dir=str(tmp_path))["mihomo"] == {
        "hideUnavailable": True,
        "consecutiveTimeouts": 4,
        "proxySortOrder": "config",
        "collapsedGroups": {},
        "latencyPreset": "auto",
    }


def test_ui_settings_does_not_persist_mihomo_timeout_history(tmp_path):
    saved = ui_settings.save_settings(
        {
            "mihomo": {
                "hideUnavailable": True,
                "consecutiveTimeouts": 3,
                "timeoutCounts": {"provider-one\u0000node-a": 3},
                "delayHistory": [{"delay_ms": 0}],
            }
        },
        ui_state_dir=str(tmp_path),
    )

    assert saved["mihomo"] == {
        "hideUnavailable": True,
        "consecutiveTimeouts": 3,
        "proxySortOrder": "config",
        "collapsedGroups": {},
        "latencyPreset": "auto",
    }


def test_ui_settings_persists_bounded_mihomo_workspace_preferences(tmp_path):
    patched, report = ui_settings.patch_settings(
        {
            "mihomo": {
                "proxySortOrder": "delay",
                "collapsedGroups": {"AUTO": True, "Fallback": False},
                "latencyPreset": "cloudflare",
            }
        },
        ui_state_dir=str(tmp_path),
    )

    assert report["errors"] == []
    assert patched["mihomo"]["proxySortOrder"] == "delay"
    assert patched["mihomo"]["collapsedGroups"] == {"AUTO": True, "Fallback": False}
    assert patched["mihomo"]["latencyPreset"] == "cloudflare"


def test_ui_settings_rejects_arbitrary_latency_url_and_invalid_workspace_state(tmp_path):
    invalid = (
        ({"mihomo": {"latencyPreset": "https://router/private"}}, "mihomo.latencyPreset"),
        ({"mihomo": {"proxySortOrder": "random"}}, "mihomo.proxySortOrder"),
        ({"mihomo": {"collapsedGroups": []}}, "mihomo.collapsedGroups"),
    )
    for patch, path in invalid:
        try:
            ui_settings.patch_settings(patch, ui_state_dir=str(tmp_path))
        except ui_settings.UISettingsValidationError as exc:
            assert exc.errors[0]["path"] == path
        else:
            raise AssertionError("invalid Mihomo workspace setting should be rejected")
