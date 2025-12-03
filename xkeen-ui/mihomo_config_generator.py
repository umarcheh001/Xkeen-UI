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

import os
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

from mihomo_server_core import (
    MIHOMO_ROOT,
    parse_vless,
    parse_wireguard,
    apply_proxy_insert,
)


# ---------------------------------------------------------------------------
# Template lookup
# ---------------------------------------------------------------------------

HERE = Path(__file__).resolve().parent

# In router environment: /opt/etc/mihomo/templates
# In development / tests: ./opt/etc/mihomo/templates relative to this file.
DEFAULT_TEMPLATES_DIR = (MIHOMO_ROOT / "templates").resolve()
DEVEL_TEMPLATES_DIR = (HERE / "opt" / "etc" / "mihomo" / "templates").resolve()

if DEFAULT_TEMPLATES_DIR.is_dir():
    TEMPLATES_DIR = DEFAULT_TEMPLATES_DIR
elif DEVEL_TEMPLATES_DIR.is_dir():
    TEMPLATES_DIR = DEVEL_TEMPLATES_DIR
else:
    # Fallback – still use the router path, even if it does not exist yet.
    TEMPLATES_DIR = DEFAULT_TEMPLATES_DIR


# Map "profile" + optional explicit template to actual filename.
# Сейчас используется один общий шаблон custom.yaml для всех профилей.
DEFAULT_TEMPLATES: Dict[str, str] = {
    "router_zkeen": "custom.yaml",
    "router": "custom.yaml",          # backward compatible profile name
    "router_custom": "custom.yaml",
    "app": "custom.yaml",             # legacy / fallback
}

# Provider names in both templates, in desired order.
ROUTER_PROVIDER_NAMES: List[str] = [
    "my-vless-sub",
    "second-sub",
    "third-sub",
    "fourth-sub",
    "fifth-sub",
]


# Mapping from UI rule-group IDs to actual group names in templates.
# If some ID has no mapping for a particular template, it is simply ignored.
RULE_GROUP_ID_TO_GROUP_NAMES: Dict[str, Sequence[str]] = {
    # Базовая группа с заблокированными сервисами и основным списком доменов
    "Blocked": ("Заблок. сервисы", "refilter@domain"),

    # Контентные сервисы
    "YouTube": ("YouTube", "youtube@domain"),
    "Discord": ("Discord", "discord@classical"),
    "Twitch": ("Twitch", "twitch@domain"),
    "Twitter": ("Twitter", "twitter@domain"),
    "Reddit": ("Reddit", "reddit@domain"),
    "Spotify": ("Spotify", "spotify@domain"),
    "Steam": ("Steam", "steam@domain"),
    "Telegram": ("Telegram", "telegram@domain", "telegram@ipcidr"),

    # Крупные сети / CDN / облака
    "Meta": ("Meta", "meta@domain", "meta@ipcidr"),
    "Amazon": ("Amazon", "amazon@domain", "amazon@ipcidr"),
    "Cloudflare": ("Cloudflare", "cloudflare@domain", "cloudflare@ipcidr"),
    "Fastly": ("Fastly", "fastly@ipcidr"),
    "CDN77": ("CDN77", "cdn77@ipcidr"),
    "Akamai": ("Akamai", "akamai@ipcidr"),

    # Общие сервисы
    "Google": ("Google", "google@domain"),
    "GitHub": ("GitHub", "github@domain"),
    "AI": ("AI", "category-ai@domain"),

    # Специальная группа для QUIC-трафика
    "QUIC": ("QUIC",),
}



# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalise_profile_name(profile: str | None) -> str:
    if not profile:
        return "router_zkeen"
    profile = str(profile).strip().lower()
    if profile in {"router", "router_zkeen", "router-zkeen"}:
        return "router_zkeen"
    if profile in {"router_custom", "router-custom", "custom"}:
        return "router_custom"
    if profile == "app":
        return "app"
    # Default to router_custom for unknown but router-ish names
    if "router" in profile:
        return "router_custom"
    return profile


def _select_template_filename(profile: str, explicit_template: Optional[str]) -> str:
    """Return template filename to use, not path."""
    if explicit_template:
        return explicit_template
    return DEFAULT_TEMPLATES.get(profile, "custom.yaml")


def _load_template_text(filename: str) -> str:
    path = TEMPLATES_DIR / filename
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        # Better to raise a clear error – caller can show it to the user.
        raise FileNotFoundError(f"Template file not found: {path}")


def _replace_provider_urls(content: str, subscriptions: Sequence[str]) -> str:
    """Inject subscription URLs into proxy-providers and hide unused providers.

    Behaviour:

    * If the user did not specify any subscription URLs, all concrete
      proxy-provider blocks (my-vless-sub, second-sub, ...) are removed
      from the config, leaving only the header ``proxy-providers:`` and
      surrounding comments from the template.

    * If there are N subscription URLs, only the first N providers from
      :data:`ROUTER_PROVIDER_NAMES` are kept, with their ``url:`` fields
      overwritten. Remaining provider stubs are stripped out completely.

    This keeps the generated config "clean": no dummy placeholders leak
    into the final YAML if the user did not configure them explicitly.
    """
    lines = content.splitlines()

    # Map provider -> subscription URL (only non-empty URLs)
    provider_to_url: Dict[str, str] = {}
    for idx, url in enumerate(subscriptions or []):
        if idx >= len(ROUTER_PROVIDER_NAMES):
            break
        url = str(url).strip()
        if not url:
            continue
        provider_to_url[ROUTER_PROVIDER_NAMES[idx]] = url

    active_providers = set(provider_to_url.keys())

    new_lines: List[str] = []
    current_provider: Optional[str] = None
    current_indent: Optional[int] = None
    keep_block: bool = True
    buffer: List[str] = []
    seen_url_for_provider: Set[str] = set()

    def flush_buffer():
        if buffer and keep_block:
            new_lines.extend(buffer)

    for line in lines:
        stripped = line.lstrip()
        indent = len(line) - len(stripped)

        # Detect leaving a provider block
        if current_provider is not None:
            if stripped and indent <= (current_indent or 0) and not stripped.startswith("#"):
                # Block ended – flush / drop it depending on keep_block
                flush_buffer()
                buffer = []
                current_provider = None
                current_indent = None
                keep_block = True  # default for next blocks

        # If we are not currently inside a provider block, check if this
        # line starts one of the known providers.
        if current_provider is None:
            matched_provider = None
            for pn in ROUTER_PROVIDER_NAMES:
                if stripped.startswith(pn + ":"):
                    matched_provider = pn
                    break

            if matched_provider is not None:
                current_provider = matched_provider
                current_indent = indent
                keep_block = (
                    not active_providers  # no subs -> drop all providers
                    and False             # explicit
                ) or (matched_provider in active_providers)
                buffer = [line]
                continue

            # Normal line outside provider blocks – keep as is.
            new_lines.append(line)
            continue

        # We are inside a provider block
        # Optionally rewrite the first ``url:`` for active providers.
        if keep_block and stripped.startswith("url:") and current_provider in provider_to_url and current_provider not in seen_url_for_provider:
            url = provider_to_url[current_provider]
            buffer.append(" " * indent + f'url: "{url}"  # set by generator')
            seen_url_for_provider.add(current_provider)
        else:
            buffer.append(line)

    # Flush last provider block if still open
    if current_provider is not None:
        flush_buffer()

    return "\n".join(new_lines)



def _filter_proxy_group_uses(content: str, subscriptions: Sequence[str]) -> str:
    """Adjust `use:` lists in proxy-groups based on active subscriptions.

    * If there are no non-empty subscription URLs, all `use:` blocks that
      reference my-vless-sub / second-sub / ... are removed entirely.
    * If there are N active subscriptions, `use:` lists are rewritten to
      contain only the first N providers from ROUTER_PROVIDER_NAMES in order.

    This ensures that template stubs do not leak into the final config when
    the user has not configured any subscriptions.
    """
    # Build list of active provider names (based on non-empty URLs).
    active_providers: List[str] = []
    for idx, url in enumerate(subscriptions or []):
        if idx >= len(ROUTER_PROVIDER_NAMES):
            break
        if str(url).strip():
            active_providers.append(ROUTER_PROVIDER_NAMES[idx])

    lines = content.splitlines()
    out_lines: List[str] = []

    in_use_block = False
    use_indent: Optional[int] = None
    buffer: List[str] = []

    def flush_use_block():
        # When leaving a use: block, emit rewritten provider list if any.
        if active_providers:
            for prov in active_providers:
                out_lines.append(" " * (use_indent + 2) + f"- {prov}")

    for line in lines:
        stripped = line.lstrip()
        indent = len(line) - len(stripped)

        if not in_use_block:
            if stripped.startswith("use:"):
                # Start of a use: block under some proxy-group
                in_use_block = True
                use_indent = indent
                # Always keep the 'use:' line itself if we have active providers.
                if active_providers:
                    out_lines.append(line)
                # If no active providers – we skip the whole block, including 'use:'.
                continue

            out_lines.append(line)
            continue

        # We are inside a use: block. Determine whether we've left it.
        if stripped and indent <= (use_indent or 0) and not stripped.startswith("#"):
            # Leaving the block.
            if active_providers:
                flush_use_block()
            in_use_block = False
            use_indent = None
            # Process current line normally as outside block.
            out_lines.append(line)
            continue

        # Still inside original use block: skip original provider entries / comments.
        # (We don't copy them; we only emit rewritten ones on exit.)
        continue

    # If file ended while still in a use: block, flush it.
    if in_use_block and active_providers:
        flush_use_block()

    return "\n".join(out_lines)


def _maybe_strip_example_vless(content: str, state: Dict[str, Any], subscriptions: Sequence[str]) -> str:
    """Drop the hardcoded 'Example VLESS' proxy when it is no longer needed.

    Logic:
      * If there is at least one non-empty subscription URL OR
        at least one user-defined proxy in state["proxies"],
        we remove the Example VLESS proxy entry from the Proxy-Selector group.

      * If there are no subscriptions and no custom proxies, the example
        is kept as a hint in the template.
    """
    # Determine whether we have any real subscriptions.
    subs_clean = [str(x).strip() for x in (subscriptions or []) if str(x).strip()]
    has_subs = bool(subs_clean)

    # Determine whether user has provided any explicit proxies.
    proxies = state.get("proxies") or []
    has_user_proxies = False
    if isinstance(proxies, list):
        for p in proxies:
            if not isinstance(p, dict):
                continue
            if str(p.get("link") or p.get("config") or p.get("yaml") or "").strip():
                has_user_proxies = True
                break

    if not (has_subs or has_user_proxies):
        return content

    # Remove the Example VLESS proxy block inside 'proxies:' list.
    # We look for a list item starting with '- name: Example VLESS' and remove
    # it together with all following indented lines until the next sibling item.
    pattern = re.compile(
        r"(?m)^([ \t]*)- name:\s*Example VLESS\b[\s\S]*?(?=^\1- |\Z)"
    )
    return pattern.sub("", content)




def _comment_block(block: str) -> str:
    """Comment every non-empty line in a block."""
    commented_lines: List[str] = []
    for line in block.splitlines():
        if line.strip():
            indent = len(line) - len(line.lstrip())
            commented_lines.append(line[:indent] + "# " + line[indent:])
        else:
            commented_lines.append(line)
    return "\n".join(commented_lines)


def _apply_rule_group_filtering(content: str, enabled_ids: Sequence[str]) -> str:
    """Enable only selected rule-group packages, producing a *clean* config.

    Semantics (router profiles):

    * ``enabled_ids`` is a list of UI rule-group IDs (e.g. ``["AKAMAI", "YouTube"]``).
    * If the list is empty or missing, we treat this as "no optional packages"
      and strip **all** known optional groups / rules / related rule-providers
      from the template, leaving only the base skeleton.
    * For every known rule-group ID (see ``RULE_GROUP_ID_TO_GROUP_NAMES``):

        - If the ID is in ``enabled_ids`` – all its groups / rules remain as-is.
        - If the ID is **not** in ``enabled_ids`` – we remove:

            * ``proxy-groups`` entries with matching ``name: <GroupName>``;
            * all ``rules`` lines that route into these groups
              (``- RULE-SET,<provider>,<GroupName>`` or more complex
               ``- OR,((RULE-SET,prov1),(RULE-SET,prov2)),<GroupName>``);
            * the corresponding ``rule-providers`` blocks that are only used
              by those removed rules.

    The goal is to avoid commented-out garbage in the generated config:
    disabled packages are *removed*, not commented.
    """
    # Normalise the enabled ID list.
    if not isinstance(enabled_ids, (list, tuple, set)):
        enabled_ids = []
    enabled_set: Set[str] = {str(x) for x in enabled_ids}

    # Базовая группа блокировок и QUIC должны всегда присутствовать в конфиге,
    # даже если явный список enabledRuleGroups пуст или пользователь их не выбирал.
    enabled_set.update({"Blocked", "QUIC"})

    result = content

    # Build a set of *group names* that belong to at least one enabled ID.
    # Это важно, чтобы логические пакеты вроде "Social" не выпиливали
    # группы Discord/Telegram, если те включены отдельно.
    protected_group_names: Set[str] = set()
    for eid in enabled_set:
        for gname in RULE_GROUP_ID_TO_GROUP_NAMES.get(eid, ()):
            if gname:
                protected_group_names.add(gname)

    # We'll remember which rule-providers became unused because their RULE-SET
    # rules were removed for disabled packages.
    providers_to_remove: Set[str] = set()

    # Process each known UI rule-group ID.
    for group_id, group_names in RULE_GROUP_ID_TO_GROUP_NAMES.items():
        # If this package is enabled – leave everything as-is.
        if group_id in enabled_set:
            continue

        # Packages that are "logical" only (no actual group names) are ignored.
        if not group_names:
            continue

        # Compute group names that are really controlled by this *disabled* ID:
        # we must not touch names that are "protected" by some enabled ID.
        effective_group_names = [
            g for g in group_names
            if g and g not in protected_group_names
        ]
        if not effective_group_names:
            continue

        # 1) Drop proxy-group blocks for these group names.
        for group_name in effective_group_names:
            # Block:
            #   - name: AKAMAI
            #     type: select
            #     ...
            # (up to the next "- name:" at same level or EOF)
            pattern = re.compile(
                rf"(?m)^([ \t]*)- name:\s*{re.escape(group_name)}\b.*?(?=^[ \t]*- name:|\Z)",
                re.S,
            )
            result = pattern.sub("", result)

        # 2) Remove rules that send traffic into these groups,
        #    and collect provider names from RULE-SET lines.
        lines = result.splitlines()
        new_lines: List[str] = []
        for line in lines:
            stripped = line.lstrip()
            if not stripped.startswith("-"):
                new_lines.append(line)
                continue

            # Check if this rule targets any of the disabled group names.
            should_drop = False
            for group_name in effective_group_names:
                if ("," + group_name) in line:
                    # For any RULE-SET occurrences on this line (including inside OR),
                    # remember the provider names so we can later drop their
                    # rule-providers.
                    for mm in re.finditer(r"RULE-SET,([^,\)\s]+)", line):
                        providers_to_remove.add(mm.group(1))
                    should_drop = True
                    break

            if not should_drop:
                new_lines.append(line)

        result = "\n".join(new_lines)

    # 3) Remove rule-providers that became unused for disabled packages.
    if providers_to_remove:
        # Providers that correspond to enabled rule-group packages must
        # always stay in the config, even if they appear in some mixed
        # RULE-SET lines. We treat any RULE_GROUP_ID_TO_GROUP_NAMES entry
        # that looks like "name@something" as a rule-provider key.
        protected_providers: Set[str] = set()
        for eid in enabled_set:
            for gname in RULE_GROUP_ID_TO_GROUP_NAMES.get(eid, ()):
                if gname and "@" in gname:
                    protected_providers.add(gname)

        for prov_name in providers_to_remove:
            if not prov_name or prov_name in protected_providers:
                continue
            # Match a block:
            #   prov_name:
            #     type: http
            #     ...
            # (indented lines that follow)
            pattern = re.compile(
                rf"(?m)^([ \t]*){re.escape(prov_name)}:[^\n]*\n(?:\1[ \t]+.*\n)*"
            )
            result = pattern.sub("", result)

    # 4) Clean up excessive blank lines to keep config readable.
    result = re.sub(r"\n{3,}", "\n\n", result)

    # 5) Annotate enabled IDs at the very top, for debugging.
    header_comment = "# Enabled rule-group packages: " + (
        ", ".join(sorted(enabled_set)) if enabled_set else "<none>"
    ) + "\n"

    if result.startswith("# Enabled rule-group packages"):
        # Replace existing header if any.
        lines2 = result.splitlines()
        lines2[0] = header_comment.rstrip("\n")
        result = "\n".join(lines2)
    else:
        result = header_comment + result

    return result
def _insert_proxies_from_state(content: str, state: Dict[str, Any]) -> str:
    """Use parse_vless / parse_wireguard / raw YAML to inject proxies into config."""
    proxies = state.get("proxies") or []
    if not isinstance(proxies, list) or not proxies:
        return content

    default_groups = state.get("defaultGroups") or []
    if not isinstance(default_groups, list):
        default_groups = []
    default_groups = [str(g).strip() for g in default_groups if str(g).strip()]
    # If user did not specify any default groups, fall back to the main router
    # group so that manually added proxies always belong to at least one group.
    if not default_groups:
        default_groups = ["Заблок. сервисы"]

    cfg = content
    for idx, item in enumerate(proxies, 1):
        if not isinstance(item, dict):
            continue

        kind = str(item.get("kind") or "vless").lower()
        name = str(item["name"]).strip() if item.get("name") else None

        groups_raw = item.get("groups")
        if isinstance(groups_raw, list):
            groups = [str(g).strip() for g in groups_raw if str(g).strip()]
        else:
            # copy defaults so per-proxy adjustments do not mutate shared list
            groups = list(default_groups)

        # Final safety net: a proxy must belong to at least one group.
        # By default, attach it to "Заблок. сервисы".
        if not groups:
            groups = ["Заблок. сервисы"]

        try:
            if kind == "vless":
                link = str(item.get("link") or "").strip()
                if not link:
                    continue
                res = parse_vless(link, custom_name=name)
                proxy_name = res.name
                proxy_yaml = res.yaml

            elif kind == "wireguard":
                conf = str(item.get("config") or "").strip()
                if not conf:
                    continue
                res = parse_wireguard(conf, custom_name=name)
                proxy_name = res.name
                proxy_yaml = res.yaml

            elif kind == "yaml":
                yaml_block = str(item.get("yaml") or "").strip()
                if not yaml_block:
                    continue
                yaml_block = _ensure_leading_dash_for_yaml_block(yaml_block)

                # Determine proxy name
                m = re.search(r"-\s*name:\s*([^\n]+)", yaml_block)
                if name:
                    proxy_name = name
                    if m:
                        # Replace existing name with custom one
                        yaml_block = re.sub(
                            r"(-\s*name:\s*)([^\n]+)",
                            r"\1" + proxy_name,
                            yaml_block,
                            count=1,
                        )
                    else:
                        # Insert name as second line
                        lines = yaml_block.splitlines()
                        if lines:
                            first = lines[0]
                            indent = len(first) - len(first.lstrip())
                            lines.insert(1, " " * (indent + 2) + f"name: {proxy_name}")
                            yaml_block = "\n".join(lines)
                else:
                    if m:
                        proxy_name = m.group(1).strip()
                    else:
                        proxy_name = f"Custom-{idx}"
                        lines = yaml_block.splitlines()
                        if lines:
                            first = lines[0]
                            indent = len(first) - len(first.lstrip())
                            lines.insert(1, " " * (indent + 2) + f"name: {proxy_name}")
                            yaml_block = "\n".join(lines)

                proxy_yaml = yaml_block

            else:
                # Unknown kind – ignore silently; UI should not send this.
                continue

            cfg = apply_proxy_insert(cfg, proxy_yaml, proxy_name, groups)

        except Exception:
            # Let the rest of proxies still be applied; individual bad entries
            # just do not make it into the resulting config.
            continue

    return cfg


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

    # 2) rule-group packages
    enabled_ids = state.get("enabledRuleGroups") or []
    if not isinstance(enabled_ids, list):
        enabled_ids = []
    content = _apply_rule_group_filtering(content, enabled_ids)

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
]
