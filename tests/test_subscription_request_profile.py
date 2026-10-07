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
