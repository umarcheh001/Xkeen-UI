from __future__ import annotations


def test_missing_profile_defaults_to_auto_with_empty_fields():
    from services.subscription_request_profile import normalize_request_profile

    assert normalize_request_profile(None) == {
        "mode": "auto",
        "hwid": "",
        "user_agent": "",
        "device_os": "",
        "os_version": "",
        "device_model": "",
    }


def test_custom_profile_maps_supported_headers_and_omits_blanks():
    from services.subscription_request_profile import (
        normalize_request_profile,
        request_headers_for_profile,
    )

    profile = normalize_request_profile(
        {"mode": "custom", "hwid": "ABC", "user_agent": "Client/1"}
    )
    assert request_headers_for_profile(profile) == {
        "x-hwid": "ABC",
        "User-Agent": "Client/1",
    }


def test_invalid_mode_and_header_bytes_are_rejected_or_defaulted():
    from services.subscription_request_profile import normalize_request_profile

    normalized = normalize_request_profile({"mode": "other", "hwid": "bad\nvalue"})
    assert normalized["mode"] == "auto"
    assert normalized["hwid"] == ""


def test_detected_profile_uses_existing_mihomo_device_info_shape():
    from services.subscription_request_profile import detected_request_profile

    result = detected_request_profile(
        {
            "hwid": "ABC",
            "user_agent": "Mihomo/1",
            "headers": {
                "x-device-os": "Keenetic OS",
                "x-ver-os": "5.0",
                "x-device-model": "KN",
            },
        }
    )
    assert result == {
        "mode": "auto",
        "hwid": "ABC",
        "user_agent": "Mihomo/1",
        "device_os": "Keenetic OS",
        "os_version": "5.0",
        "device_model": "KN",
    }


def test_detected_xray_profile_uses_xray_user_agent(monkeypatch):
    import services.subscription_request_profile as profiles

    monkeypatch.setattr(profiles, "_detect_xray_version", lambda: "26.3.27")

    result = profiles.detected_xray_request_profile(
        {
            "hwid": "ABC",
            "user_agent": "ClashMeta/1; mihomo/1",
            "headers": {
                "x-device-os": "Keenetic OS",
                "x-ver-os": "5.0",
                "x-device-model": "KN",
            },
        }
    )

    assert result["user_agent"] == "Xray/26.3.27"
    assert result["hwid"] == "ABC"
    assert result["device_os"] == "Keenetic OS"


def test_detected_xray_profile_falls_back_to_xray_without_version(monkeypatch):
    import services.subscription_request_profile as profiles

    monkeypatch.setattr(profiles, "_detect_xray_version", lambda: None)

    assert profiles.detected_xray_request_profile({})["user_agent"] == "Xray"


def test_validate_custom_profile_rejects_control_characters_without_echoing_value():
    from services.subscription_request_profile import validate_request_profile

    try:
        validate_request_profile({"mode": "custom", "hwid": "secret\nInjected"})
    except ValueError as exc:
        assert str(exc) == "request_profile.hwid contains invalid HTTP header characters"
        assert "secret" not in str(exc)
    else:
        raise AssertionError("invalid custom profile was accepted")
