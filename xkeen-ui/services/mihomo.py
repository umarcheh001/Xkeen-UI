"""Mihomo-related service helpers (state parsing, profiles, etc.)."""

from __future__ import annotations

from typing import Any, Dict, List

from mihomo_server_core import (
    list_profiles as _mh_list_profiles,
    get_profile_content as _mh_get_profile_content,
    create_profile as _mh_create_profile,
    delete_profile as _mh_delete_profile,
    switch_active_profile as _mh_switch_active_profile,
)


# Fields in Mihomo UI state that must always be lists (or are normalized to []).
_STATE_LIST_FIELDS = (
    "subscriptions",
    "defaultGroups",
    "enabledRuleGroups",
    "proxies",
    "proxyGroups",
    "rules",
)


def parse_state_from_payload(payload: Any) -> Dict[str, Any]:
    """Validate and normalize Mihomo state payload from the UI.

    Supports both formats:

    1. New / simple format – plain state dict coming from router/app::

         {
           "profile": "router_zkeen",
           "subscriptions": [...],
           "proxies": [...],
           ...
         }

    2. Wrapped format from the new generator UI::

         {
           "state": {
             "profile": "...",
             ...
           },
           "configOverride": "..."
         }

       In this case only the ``state`` part is returned.

    The result is always a new dict with:

    * required non-empty ``profile`` (str, trimmed);
    * all list-like fields present and of type ``list`` (or ``[]`` if missing).
    """
    if not isinstance(payload, dict):
        raise ValueError("JSON body must be an object")

    # Extract "state" object if present (new UI), otherwise treat payload itself as state.
    if "state" in payload and isinstance(payload["state"], dict):
        state: Dict[str, Any] = dict(payload["state"])
    else:
        state = dict(payload)

    profile = state.get("profile")
    if not isinstance(profile, str) or not profile.strip():
        raise ValueError("state.profile is required and must be a non-empty string")
    state["profile"] = profile.strip()

    # Normalize list fields.
    for key in _STATE_LIST_FIELDS:
        value = state.get(key)
        if value is None:
            state[key] = []
        elif not isinstance(value, list):
            raise ValueError(f"state.{key} must be a list when provided")

    return state


# ---------- Profile helpers for API layer ----------


def list_profiles_for_api() -> List[Dict[str, Any]]:
    """Return Mihomo profiles as a JSON-serializable list for API responses."""
    profiles = _mh_list_profiles()
    return [
        {
            "name": p.name,
            "is_active": bool(getattr(p, "is_active", False)),
        }
        for p in profiles
    ]


def get_profile_content_for_api(name: str) -> str:
    """Return raw YAML text for the given Mihomo profile name."""
    return _mh_get_profile_content(name)


def create_profile_from_content(name: str, content: str) -> None:
    """Create a new Mihomo profile with the given YAML content.

    Any FileExistsError / other exceptions are intentionally propagated so that
    the HTTP layer can translate them into proper status codes.
    """
    _mh_create_profile(name, content)


def delete_profile_by_name(name: str) -> None:
    """Delete Mihomo profile by name.

    Propagates exceptions (e.g. RuntimeError when deleting active profile).
    """
    _mh_delete_profile(name)


def activate_profile(name: str) -> None:
    """Switch active Mihomo profile to *name*.

    Raises FileNotFoundError if the profile does not exist.
    """
    _mh_switch_active_profile(name)
