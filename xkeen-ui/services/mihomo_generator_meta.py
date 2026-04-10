"""Metadata and template lookup helpers for Mihomo config generation."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set

from services.mihomo_runtime import MIHOMO_ROOT


HERE = Path(__file__).resolve().parents[1]

DEFAULT_TEMPLATES_DIR = (MIHOMO_ROOT / "templates").resolve()
DEVEL_TEMPLATES_DIR = (HERE / "opt" / "etc" / "mihomo" / "templates").resolve()

if DEFAULT_TEMPLATES_DIR.is_dir():
    TEMPLATES_DIR = DEFAULT_TEMPLATES_DIR
elif DEVEL_TEMPLATES_DIR.is_dir():
    TEMPLATES_DIR = DEVEL_TEMPLATES_DIR
else:
    TEMPLATES_DIR = DEFAULT_TEMPLATES_DIR


DEFAULT_TEMPLATES: Dict[str, str] = {
    "router_zkeen": "zkeen.yaml",
    "router": "custom.yaml",
    "router_custom": "custom.yaml",
    "app": "custom.yaml",
}


ROUTER_PROVIDER_NAMES: List[str] = [
    "proxy-sub",
    "proxy-sub-2",
    "proxy-sub-3",
    "proxy-sub-4",
    "proxy-sub-5",
]


def provider_name_for_index(idx: int) -> str:
    if idx <= 0:
        return "proxy-sub"
    return f"proxy-sub-{idx + 1}"


RULE_GROUP_ID_TO_GROUP_NAMES: Dict[str, Sequence[str]] = {
    "Blocked": ("Заблок. сервисы", "refilter@domain"),
    "YouTube": ("YouTube", "youtube@domain"),
    "Discord": ("Discord", "discord@classical"),
    "Twitch": ("Twitch", "twitch@domain"),
    "Reddit": ("Reddit", "reddit@domain"),
    "Spotify": ("Spotify", "spotify@domain"),
    "Steam": ("Steam", "steam@domain"),
    "Telegram": ("Telegram", "telegram@domain", "telegram@ipcidr", "telegram@ip"),
    "Meta": ("Meta", "meta@domain", "meta@ipcidr"),
    "Twitter": ("Twitter", "twitter@domain"),
    "CDN": (
        "CDN",
        "akamai@domain",
        "akamai@ipcidr",
        "amazon@domain",
        "amazon@ipcidr",
        "cloudflare@domain",
        "cloudflare@ipcidr",
        "cdn77@ipcidr",
        "digitalocean@domain",
        "digitalocean@ipcidr",
        "fastly@domain",
        "fastly@ipcidr",
        "gcore@ipcidr",
        "hetzner@domain",
        "hetzner@ipcidr",
        "oracle@domain",
        "oracle@ipcidr",
        "ovh@ipcidr",
        "scaleway@ipcidr",
        "vultr@ipcidr",
    ),
    "Google": ("Google", "google@domain", "google@ipcidr"),
    "GitHub": ("GitHub", "github@domain"),
    "AI": ("AI", "category-ai@domain"),
    "QUIC": ("QUIC",),
}


ALWAYS_ENABLED_RULE_IDS: Set[str] = set()
ZKEEN_ONLY_RULE_IDS: Set[str] = set()


def normalise_profile_name(profile: str | None) -> str:
    if not profile:
        return "router_zkeen"
    profile = str(profile).strip().lower()
    if profile in {"router", "router_zkeen", "router-zkeen"}:
        return "router_zkeen"
    if profile in {"router_custom", "router-custom", "custom"}:
        return "router_custom"
    if profile == "app":
        return "app"
    if "router" in profile:
        return "router_custom"
    return profile


def select_template_filename(profile: str, explicit_template: Optional[str]) -> str:
    if explicit_template:
        return explicit_template
    return DEFAULT_TEMPLATES.get(profile, "custom.yaml")


def load_template_text(filename: str) -> str:
    path = TEMPLATES_DIR / filename
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise FileNotFoundError(f"Template file not found: {path}")


def get_profile_rule_presets(profile: str | None) -> Dict[str, Any]:
    norm = normalise_profile_name(profile)

    ui_candidate_ids: List[str] = [
        gid for gid in RULE_GROUP_ID_TO_GROUP_NAMES.keys()
        if gid not in {"Blocked", "QUIC"} and gid not in ALWAYS_ENABLED_RULE_IDS
    ]

    if norm in {"router_zkeen", "router_custom"}:
        available: Sequence[str] = ui_candidate_ids
    else:
        available = [gid for gid in ui_candidate_ids if gid not in ZKEEN_ONLY_RULE_IDS]

    if norm == "router_custom":
        enabled: Sequence[str] = []
    else:
        enabled = available

    return {
        "profile": norm,
        "availableRuleGroups": list(available),
        "enabledRuleGroups": list(enabled),
    }


__all__ = [
    "TEMPLATES_DIR",
    "DEFAULT_TEMPLATES",
    "ROUTER_PROVIDER_NAMES",
    "RULE_GROUP_ID_TO_GROUP_NAMES",
    "ALWAYS_ENABLED_RULE_IDS",
    "ZKEEN_ONLY_RULE_IDS",
    "provider_name_for_index",
    "normalise_profile_name",
    "select_template_filename",
    "load_template_text",
    "get_profile_rule_presets",
]
