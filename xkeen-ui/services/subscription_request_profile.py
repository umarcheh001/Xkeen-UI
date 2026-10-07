"""Shared request profile normalization for subscription providers."""

from __future__ import annotations

from collections.abc import Mapping
import os
import re
import subprocess
from typing import Any


REQUEST_PROFILE_MODES = ("auto", "custom", "disabled")
REQUEST_PROFILE_FIELDS = (
    "hwid",
    "user_agent",
    "device_os",
    "os_version",
    "device_model",
)
_HWID_MAX_LEN = 128
_OTHER_FIELD_MAX_LEN = 256

_HEADER_NAMES = {
    "hwid": "x-hwid",
    "user_agent": "User-Agent",
    "device_os": "x-device-os",
    "os_version": "x-ver-os",
    "device_model": "x-device-model",
}


def _detect_xray_version() -> str | None:
    """Return the installed Xray version, when the local binary is available."""

    binaries = ("/opt/sbin/xray", "/opt/bin/xray", "xray")
    for binary in binaries:
        if os.path.isabs(binary) and not os.path.exists(binary):
            continue
        for flag in ("version", "-version"):
            try:
                completed = subprocess.run(
                    [binary, flag],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    timeout=2.5,
                    check=False,
                )
            except Exception:
                continue
            output = (completed.stdout or "").strip()
            if not output:
                continue
            match = re.search(r"\b(?:v)?([0-9]+\.[0-9]+(?:\.[0-9]+)?)\b", output)
            if match:
                return match.group(1)
    return None


def _safe_header_value(value: Any, *, limit: int) -> str:
    text = str(value or "").strip()
    if not text or len(text) > limit:
        return ""
    if any(ord(char) < 32 or ord(char) == 127 or ord(char) > 126 for char in text):
        return ""
    return text


def normalize_request_profile(
    raw: Any,
    *,
    detected: Mapping[str, Any] | None = None,
) -> dict[str, str]:
    """Return a safe, complete request profile suitable for persisted state."""

    source = raw if isinstance(raw, Mapping) else {}
    mode = str(source.get("mode") or "auto").strip().lower()
    if mode not in REQUEST_PROFILE_MODES:
        mode = "auto"

    detected_profile = detected_request_profile(detected) if detected is not None else {}
    profile: dict[str, str] = {"mode": mode}
    for field in REQUEST_PROFILE_FIELDS:
        value = source.get(field, "")
        if value in (None, "") and mode == "custom" and detected_profile:
            value = ""
        profile[field] = _safe_header_value(
            value,
            limit=_HWID_MAX_LEN if field == "hwid" else _OTHER_FIELD_MAX_LEN,
        )
    return profile


def validate_request_profile(raw: Any) -> dict[str, str]:
    """Validate a user payload before persistence or a network request."""

    source = raw if isinstance(raw, Mapping) else {}
    mode = str(source.get("mode") or "auto").strip().lower()
    if mode not in REQUEST_PROFILE_MODES:
        raise ValueError("request_profile.mode must be auto, custom, or disabled")
    for field in REQUEST_PROFILE_FIELDS:
        value = str(source.get(field) or "").strip()
        limit = _HWID_MAX_LEN if field == "hwid" else _OTHER_FIELD_MAX_LEN
        if len(value) > limit:
            raise ValueError(f"request_profile.{field} is too long")
        if any(ord(char) < 32 or ord(char) == 127 or ord(char) > 126 for char in value):
            raise ValueError(f"request_profile.{field} contains invalid HTTP header characters")
    return normalize_request_profile(source)


def detected_request_profile(device_info: Mapping[str, Any] | None = None) -> dict[str, str]:
    """Map the existing Mihomo device-info response to the shared profile."""

    info: Mapping[str, Any]
    if device_info is None:
        try:
            from services.mihomo_hwid_sub import get_device_info

            info = get_device_info()
        except Exception:
            info = {}
    else:
        info = device_info
    headers = info.get("headers") if isinstance(info.get("headers"), Mapping) else {}
    lower_headers = {str(key).strip().lower(): value for key, value in headers.items()}
    raw = {
        "mode": "auto",
        "hwid": info.get("hwid") or headers.get("x-hwid") or lower_headers.get("x-hwid"),
        "user_agent": info.get("user_agent") or headers.get("User-Agent") or lower_headers.get("user-agent"),
        "device_os": lower_headers.get("x-device-os"),
        "os_version": lower_headers.get("x-ver-os"),
        "device_model": lower_headers.get("x-device-model"),
    }
    return normalize_request_profile(raw)


def detected_xray_request_profile(device_info: Mapping[str, Any] | None = None) -> dict[str, str]:
    """Map router device data to an Xray-specific automatic request profile."""

    profile = detected_request_profile(device_info)
    version = _detect_xray_version()
    profile["user_agent"] = f"Xray/{version}" if version else "Xray"
    return profile


def request_headers_for_profile(
    profile: Mapping[str, Any] | None,
    *,
    detected: Mapping[str, Any] | None = None,
) -> dict[str, str]:
    """Build supported HTTP headers from a normalized or raw profile."""

    normalized = normalize_request_profile(profile, detected=detected)
    return {
        _HEADER_NAMES[field]: normalized[field]
        for field in REQUEST_PROFILE_FIELDS
        if normalized[field]
    }


def profile_fields_from_headers(headers: Mapping[str, Any] | None) -> dict[str, str]:
    """Convert supported request headers into profile field names."""

    source = headers if isinstance(headers, Mapping) else {}
    lower = {str(key).strip().lower(): value for key, value in source.items()}
    return normalize_request_profile(
        {
            "mode": "auto",
            "hwid": lower.get("x-hwid"),
            "user_agent": lower.get("user-agent"),
            "device_os": lower.get("x-device-os"),
            "os_version": lower.get("x-ver-os"),
            "device_model": lower.get("x-device-model"),
        }
    )
