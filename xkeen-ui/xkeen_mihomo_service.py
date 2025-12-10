"""High-level glue layer between:
  * mihomo_config_generator.py  – builds config.yaml from UI state;
  * mihomo_server_core.py       – profiles, backups, save & restart, parsers.

This module is intended to be called from the XKeen UI backend (Flask)
to perform one-shot actions like:
  - generate config from state;
  - generate + save into active profile;
  - generate + save + restart mihomo and get log.
"""

from __future__ import annotations

from typing import Any, Dict, Tuple

from mihomo_config_generator import build_full_config, get_profile_rule_presets
from mihomo_server_core import (
    ensure_mihomo_layout,
    get_active_profile_name,
    save_config,
    restart_mihomo_and_get_log,
)


def generate_config_from_state(state: Dict[str, Any]) -> str:
    """Return full mihomo config.yaml text for given UI state (no disk I/O).

    Thin wrapper around :func:`build_full_config` from mihomo_config_generator.
    The *state* argument is expected to be the normalized dict that the
    frontend sends for the new generator (profile, subscriptions, proxies, ...).
    """
    return build_full_config(state)


def generate_and_save_config(state: Dict[str, Any]) -> Tuple[str, str]:
    """Generate config from state and save it into the active profile.

    Returns:
        (config_yaml, active_profile_name)

    A backup is created automatically by :func:`save_config`
    (see :mod:`mihomo_server_core`).
    """
    cfg = build_full_config(state)
    ensure_mihomo_layout()
    save_config(cfg)
    active_profile = get_active_profile_name()
    return cfg, active_profile


def generate_save_and_restart(payload: Dict[str, Any]) -> Tuple[str, str]:
    """Generate config, save it and restart mihomo via xkeen.

    The *payload* parameter is intentionally a bit more generic than just
    ``state`` to support both the old and the new UI flows:

      1. **Old behaviour (backwards compatible)**

         ``payload`` is the plain state dict::

             {
               "profile": "router_zkeen",
               "subscriptions": [...],
               ...
             }

         In this case the config is always generated via ``build_full_config``.

      2. **New generator UI with manual override**

         ``payload`` is an extended object coming directly from the new
         ``mihomo_generator.html`` page::

             {
               "state": { ... очищенное состояние UI ... },
               "configOverride": "raw YAML from editor (optional)"
             }

         If ``configOverride`` is a non-empty string, it is used *as is* as
         the final config.yaml (manual edit in the web editor wins).
         Otherwise the config is generated from ``payload["state"]`` using
         :func:`build_full_config`.

    Returns:
        (config_yaml, restart_log)
    """
    # Detect whether we were given a plain state dict (old API) or an extended
    # payload (new API with manual override support).
    if "profile" in payload and "state" not in payload and "configOverride" not in payload:
        state: Dict[str, Any] = payload
        override = ""
    else:
        # New-style payload: { "state": {...}, "configOverride": "..." }
        state = payload.get("state") or {}
        if not isinstance(state, dict):
            raise ValueError("payload.state must be an object when provided")
        override = str(payload.get("configOverride") or "")

    # Normalise override (strip trailing newlines to avoid extra blank lines,
    # but keep inner whitespace exactly as the user typed it).
    override = override.rstrip("\n")

    if override.strip():
        cfg = override
    else:
        cfg = build_full_config(state)

    ensure_mihomo_layout()
    log = restart_mihomo_and_get_log(cfg)
    return cfg, log




def generate_preview(payload: Dict[str, Any]) -> str:
    """Generate mihomo config.yaml for preview only.

    This uses the same ``build_full_config`` pipeline as
    :func:`generate_save_and_restart`, but does **not** save anything
    to disk and does **not** restart mihomo. It is safe to call on
    every UI change.
    """
    # Support both bare state and new-style {"state": {...}} payloads.
    if "profile" in payload and "state" not in payload and "configOverride" not in payload:
        state: Dict[str, Any] = payload  # type: ignore[assignment]
    else:
        state_obj = payload.get("state") or {}
        if not isinstance(state_obj, dict):
            raise ValueError("payload.state must be an object when provided")
        state = state_obj  # type: ignore[assignment]

    return build_full_config(state)


def get_profile_defaults(profile: str | None) -> Dict[str, Any]:
    """Expose profile-specific default rule presets for the frontend.

    This is a thin wrapper around :func:`get_profile_rule_presets` from
    :mod:`mihomo_config_generator` so that the Flask app does not need
    to know the internal details of how presets are computed.
    """
    return get_profile_rule_presets(profile)


__all__ = [
    "generate_config_from_state",
    "generate_and_save_config",
    "generate_save_and_restart",
    "generate_preview",
    "get_profile_defaults",
]
