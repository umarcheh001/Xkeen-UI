"""Dismissing the hint persists independently of diagnostic tariffs."""

import pytest

from services.ui_settings import DEFAULTS, UISettingsValidationError, _sanitize_full, load_settings, patch_settings


def test_hint_default_is_not_dismissed(tmp_path):
    assert DEFAULTS["diagnostics"]["initrc_hint_dismissed"] is False
    assert load_settings(str(tmp_path))["diagnostics"]["initrc_hint_dismissed"] is False


@pytest.mark.parametrize("together", [True, False])
def test_hint_and_tariff_survive_updates_and_reload(tmp_path, together):
    tariffs = {"ISP": {"up_mbps": 50, "down_mbps": 100}}
    patch_settings({"diagnostics": {"tariffs": tariffs, **({"initrc_hint_dismissed": True} if together else {})}}, str(tmp_path))
    if not together:
        patch_settings({"diagnostics": {"initrc_hint_dismissed": True}}, str(tmp_path))
    settings = load_settings(str(tmp_path))["diagnostics"]
    assert settings == {"tariffs": tariffs, "initrc_hint_dismissed": True}
    patch_settings({"diagnostics": {"tariffs": {"ISP": {"down_mbps": 200}}}}, str(tmp_path))
    assert load_settings(str(tmp_path))["diagnostics"]["initrc_hint_dismissed"] is True
    patch_settings({"diagnostics": {"initrc_hint_dismissed": False}}, str(tmp_path))
    assert load_settings(str(tmp_path))["diagnostics"] == {"tariffs": {"ISP": {"up_mbps": 50, "down_mbps": 200}}, "initrc_hint_dismissed": False}


@pytest.mark.parametrize("bad", ["false", "true", 1, 0, None, {}, []])
def test_hint_requires_boolean(tmp_path, bad):
    with pytest.raises(UISettingsValidationError):
        patch_settings({"diagnostics": {"initrc_hint_dismissed": bad}}, str(tmp_path))
    clean, report = _sanitize_full({"diagnostics": {"initrc_hint_dismissed": bad, "stray": True}})
    assert clean["diagnostics"]["initrc_hint_dismissed"] is False
    assert "stray" not in clean["diagnostics"]
    assert report.warnings
