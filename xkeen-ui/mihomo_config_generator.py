"""Server-side Mihomo config.yaml generator for XKeen UI (new state format).

This module takes a high-level `state` object coming from the web UI
(mihomo_generator.html) and turns it into a full Mihomo config.yaml
string, based on YAML templates and parser helpers from
`mihomo_server_core.py`.

Expected state structure (as produced by the new generator UI)
----------------------------------------------------------------
{
  "profile": "router_zkeen" | "router_custom" | ...,
  "template": "custom.yaml" | null,
  "subscriptions": ["https://...", "..."],
  "defaultGroups": ["Proxy-Selector", "GAMES"],
  "enabledRuleGroups": ["YouTube", "Ad-Filter", "Torrent", ...],
  "proxies": [
    {
      "kind": "vless",
      "name": "MyNode",
      "groups": ["Proxy-Selector"],
      "link": "vless://..."
    },
    {
      "kind": "wireguard",
      "name": "WG-01",
      "groups": [],
      "config": "[Interface]\n..."
    },
    {
      "kind": "yaml",
      "name": "CustomTrojan",
      "groups": ["Proxy-Selector"],
      "yaml": "- name: CustomTrojan\n  type: trojan\n  server: ..."
    }
  ]
}

Only the fields that are actually needed are required; the rest are optional.
The generator is deliberately tolerant and will just ignore unknown keys.
"""

from __future__ import annotations

from typing import Dict

from services.mihomo_generator_meta import (
    normalise_profile_name as _normalise_profile_name,
    select_template_filename as _select_template_filename,
    load_template_text as _load_template_text,
    get_profile_rule_presets,
)
from services.mihomo_generator_providers import (
    replace_provider_urls as _replace_provider_urls,
    filter_proxy_group_uses as _filter_proxy_group_uses,
    maybe_strip_example_vless as _maybe_strip_example_vless,
    ensure_empty_proxy_providers_map as _ensure_empty_proxy_providers_map,
)
from services.mihomo_generator_proxies import (
    insert_proxies_from_state as _insert_proxies_from_state,
)
from services.mihomo_generator_rules import (
    apply_rule_group_filtering as _apply_rule_group_filtering,
)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_router_config(state: Dict[str, Any]) -> str:
    """Build config.yaml for router profiles (router_zkeen / router_custom).

    Steps:
      1) choose YAML template by profile / state["template"];
      2) inject subscription URLs into proxy-providers section;
      3) filter optional groups & rules according to enabledRuleGroups;
      4) insert individual proxies using new parsing helpers.
    """
    profile = _normalise_profile_name(state.get("profile"))
    template_name = _select_template_filename(profile, state.get("template"))
    content = _load_template_text(template_name)

    # 1) subscriptions -> proxy-providers urls
    subs = state.get("subscriptions") or []
    if not isinstance(subs, list):
        subs = []
    subs = [str(x).strip() for x in subs if str(x).strip()]
    content = _replace_provider_urls(content, subs)
    content = _filter_proxy_group_uses(content, subs)
    content = _maybe_strip_example_vless(content, state, subs)
    if not subs:
        content = _ensure_empty_proxy_providers_map(content)

    # 2) rule-group packages
    enabled_ids = state.get("enabledRuleGroups") or []
    if not isinstance(enabled_ids, list):
        enabled_ids = []
    content = _apply_rule_group_filtering(content, enabled_ids, profile)

    # 3) insert proxies
    content = _insert_proxies_from_state(content, state)

    return content




def build_app_config(state: Dict[str, Any]) -> str:
    """Legacy fallback for potential 'app' profile.

    Currently we do not ship a dedicated template for app profile, so this
    simply delegates to build_router_config with 'router_custom' semantics.
    """
    # Force router_custom handling
    state = dict(state)  # shallow copy, do not mutate caller's dict
    state["profile"] = "router_custom"
    return build_router_config(state)


def build_full_config(state: Dict[str, Any]) -> str:
    """Main entry point used by xkeen_mihomo_service.

    Automatically chooses implementation based on state["profile"],
    but for now everything is routed through router-style config.
    """
    profile = _normalise_profile_name(state.get("profile"))
    if profile == "app":
        return build_app_config(state)
    # Everything else is router-style
    return build_router_config(state)


__all__ = [
    "build_full_config",
    "build_router_config",
    "build_app_config",
    "get_profile_rule_presets",
]
