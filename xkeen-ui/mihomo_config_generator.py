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
    parse_proxy_uri,
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
    "router_zkeen": "zkeen.yaml",
    "router": "custom.yaml",          # backward compatible profile name
    "router_custom": "custom.yaml",
    "app": "custom.yaml",             # legacy / fallback
}

# Provider names in both templates, in desired order (first 5 stubs exist in templates).
#
# NOTE: The generator UI historically supported only 5 subscriptions.
# Newer versions allow passing more than 5 URLs – extra providers are
# auto-appended to the resulting config.
ROUTER_PROVIDER_NAMES: List[str] = [
    "proxy-sub",
    "proxy-sub-2",
    "proxy-sub-3",
    "proxy-sub-4",
    "proxy-sub-5",
]


def _provider_name_for_index(idx: int) -> str:
    """Return provider name for a subscription index (0-based).

    Pattern matches bundled templates:
      0 -> proxy-sub
      1 -> proxy-sub-2
      2 -> proxy-sub-3
      ...
    """
    if idx <= 0:
        return "proxy-sub"
    return f"proxy-sub-{idx + 1}"


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

    # Дополнительные группы для профиля ZKeen (GEOIP/GEOSITE и Ru-Traffic)
    "RuTraffic": ("Ru-Traffic", "ru-ips@ipcidr"),
    "DigitalOcean": ("DigitalOcean",),
    "Gcore": ("Gcore",),
    "Hetzner": ("Hetzner",),
    "Linode": ("Linode",),
    "Oracle": ("Oracle",),
    "Ovh": ("Ovh", "OVH"),
    "Vultr": ("Vultr",),
    "Colocrossing": ("Colocrossing",),
    "Contabo": ("Contabo",),
    "Mega": ("Mega",),
    "Scaleway": ("Scaleway",),
    "DOMAINS": ("DOMAINS",),
    "OTHER": ("OTHER",),
    "POLITIC": ("POLITIC",),

}






# Rule-group IDs that must always remain enabled in all profiles.
# These correspond to the core ZKeen domain lists (DOMAINS/OTHER/POLITIC)
# that are part of the base skeleton and should not be toggled via the UI.
ALWAYS_ENABLED_RULE_IDS: Set[str] = {
    "DOMAINS",
    "OTHER",
    "POLITIC",
}



# IDs of rule packages that are specific to the ZKeen router profile only.
# These correspond to additional GEOIP/GEOSITE and Ru-Traffic related groups
# which are not available for generic/custom router profiles.
ZKEEN_ONLY_RULE_IDS: Set[str] = {
    "RuTraffic",
    "DigitalOcean",
    "Gcore",
    "Hetzner",
    "Linode",
    "Oracle",
    "Ovh",
    "Vultr",
    "Colocrossing",
    "Contabo",
    "Mega",
    "Scaleway",
    "DOMAINS",
    "OTHER",
    "POLITIC",
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

    * If there are N subscription URLs, provider stubs from the template are
      kept for the first 5 subscriptions (``proxy-sub``, ``proxy-sub-2``, ...)
      and their ``url:`` fields are overwritten.

      If there are **more than 5** subscriptions, extra providers are appended
      to the generated config automatically.

    This keeps the generated config "clean": no dummy placeholders leak
    into the final YAML if the user did not configure them explicitly.
    """
    lines = content.splitlines()

    # Normalise subscription list (keep order, drop empties).
    subs_clean: List[str] = [str(x).strip() for x in (subscriptions or []) if str(x).strip()]

    # Map provider -> URL for *all* subscriptions (unlimited)
    provider_to_url: Dict[str, str] = {
        _provider_name_for_index(i): url
        for i, url in enumerate(subs_clean)
    }
    active_providers: Set[str] = set(provider_to_url.keys())

    # Fast path: nothing to inject
    if not provider_to_url:
        # We still strip provider stubs later via _ensure_empty_proxy_providers_map
        # to keep templates clean.
        active_providers = set()

    # We rewrite ONLY bundled provider stubs (first 5) and strip the unused ones.
    bundled_providers = set(ROUTER_PROVIDER_NAMES)

    new_lines: List[str] = []
    current_provider: Optional[str] = None
    current_indent: Optional[int] = None
    keep_block: bool = True
    buffer: List[str] = []
    seen_url_for_provider: Set[str] = set()
    found_providers: Set[str] = set()

    def flush_buffer() -> None:
        if buffer and keep_block:
            new_lines.extend(buffer)

    for line in lines:
        stripped = line.lstrip()
        indent = len(line) - len(stripped)

        # Detect leaving a provider block
        if current_provider is not None:
            if stripped and indent <= (current_indent or 0) and not stripped.startswith("#"):
                flush_buffer()
                buffer = []
                current_provider = None
                current_indent = None
                keep_block = True

        # Detect provider header lines (only bundled stubs)
        if current_provider is None:
            matched_provider = None
            for pn in ROUTER_PROVIDER_NAMES:
                if stripped.startswith(pn + ":"):
                    matched_provider = pn
                    break

            if matched_provider is not None:
                current_provider = matched_provider
                current_indent = indent
                found_providers.add(matched_provider)
                # Keep only active providers; otherwise drop stub
                keep_block = matched_provider in active_providers
                buffer = [line]
                continue

            # Normal line outside provider blocks
            new_lines.append(line)
            continue

        # Inside provider block – rewrite first url: for active providers
        if (
            keep_block
            and stripped.startswith("url:")
            and current_provider in provider_to_url
            and current_provider not in seen_url_for_provider
        ):
            url = provider_to_url[current_provider]
            buffer.append(" " * indent + f'url: "{url}"  # set by generator')
            seen_url_for_provider.add(current_provider)
        else:
            buffer.append(line)

    # Flush last provider block if file ended
    if current_provider is not None:
        flush_buffer()

    rendered = "\n".join(new_lines)

    # Append extra providers (subscription #6+) into proxy-providers section.
    extra_provider_names = [
        _provider_name_for_index(i)
        for i in range(len(subs_clean))
        if _provider_name_for_index(i) not in bundled_providers
    ]

    if extra_provider_names:
        rendered = _append_extra_provider_blocks(rendered, provider_to_url, extra_provider_names)

    return rendered


def _append_extra_provider_blocks(
    content: str,
    provider_to_url: Dict[str, str],
    provider_names: Sequence[str],
) -> str:
    """Append new `proxy-providers` blocks for providers not present in template.

    Bundled templates ship with 5 stub providers. When the user gives more
    than 5 subscription URLs we generate additional provider blocks, so the
    config still works without modifying templates.
    """
    if not provider_names:
        return content

    lines = content.splitlines()

    # Find `proxy-providers:` header (top-level)
    header_idx: Optional[int] = None
    for i, line in enumerate(lines):
        if line.strip() == "proxy-providers:" and (len(line) - len(line.lstrip()) == 0):
            header_idx = i
            break

    if header_idx is None:
        return content

    # Find end of proxy-providers section: first meaningful line at indent 0
    end_idx = len(lines)
    j = header_idx + 1
    while j < len(lines):
        s = lines[j].strip()
        if not s or s.startswith("#"):
            j += 1
            continue
        if not lines[j].startswith(" "):
            end_idx = j
            break
        j += 1

    # Determine already-present providers to avoid duplicates.
    present: Set[str] = set()
    for ln in lines[header_idx + 1 : end_idx]:
        st = ln.strip()
        m = re.match(r"^([A-Za-z0-9_.-]+):\s*$", st)
        if m:
            present.add(m.group(1))

    blocks: List[str] = []
    for pn in provider_names:
        if pn in present:
            continue
        url = str(provider_to_url.get(pn) or "").strip()
        if not url:
            continue
        blocks.extend(
            [
                f"  {pn}:",
                "    type: http",
                f"    url: \"{url}\"  # set by generator",
                f"    path: ./proxy_providers/{pn}.yaml",
                "    interval: 3600",
                "    health-check:",
                "      enable: true",
                "      url: \"http://www.gstatic.com/generate_204\"",
                "      interval: 300",
                "      timeout: 8000",
                "      lazy: true",
                "      expected-status: 204",
                "    override:",
                "      tfo: true",
                "      mptcp: true",
                "      udp: true",
                "",
            ]
        )

    if not blocks:
        return content

    new_lines = lines[:end_idx] + blocks + lines[end_idx:]
    return "\n".join(new_lines)



def _filter_proxy_group_uses(content: str, subscriptions: Sequence[str]) -> str:
    """Adjust `use:` lists in proxy-groups based on active subscriptions.

    * If there are no non-empty subscription URLs, all `use:` blocks are
      removed entirely (the template providers are not referenced).
    * If there are N active subscriptions, `use:` lists are rewritten to
      contain only the provider names that correspond to those subscriptions
      (proxy-sub, proxy-sub-2, proxy-sub-3, ...). This supports more than 5
      subscriptions when extra providers were auto-appended.

    This ensures that template stubs do not leak into the final config when
    the user has not configured any subscriptions.
    """
    # Build list of active provider names (based on non-empty URLs).
    subs_clean = [str(x).strip() for x in (subscriptions or []) if str(x).strip()]
    active_providers: List[str] = [
        _provider_name_for_index(i) for i in range(len(subs_clean))
    ]

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
                    out_lines.append(" " * indent + "use:")
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





def _ensure_empty_proxy_providers_map(content: str) -> str:
    """If proxy-providers block has no children, turn it into `proxy-providers: {}`.

    Some templates contain a bare `proxy-providers:` section that expects
    subscription-based providers to be injected. When the user does not
    configure any subscriptions, all providers are removed, and Mihomo
    requires this section to be an empty mapping instead of a bare key.
    """
    lines = content.splitlines()
    for i, line in enumerate(lines):
        if line.strip() == "proxy-providers:":
            # Look ahead to see if there is any non-empty, non-comment child line.
            j = i + 1
            has_child = False
            while j < len(lines):
                stripped = lines[j].strip()
                # Skip blank lines and comments.
                if not stripped or stripped.startswith("#"):
                    j += 1
                    continue
                # If the next meaningful line starts with indentation,
                # we treat it as a child of proxy-providers.
                if lines[j].startswith(" "):
                    has_child = True
                break
            if not has_child:
                lines[i] = lines[i].rstrip() + " {}"
            break
    return "\n".join(lines)



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

    # Базовая группа блокировок, QUIC и некоторые вспомогательные списки
    # (DOMAINS/OTHER/POLITIC) должны всегда присутствовать в конфиге, даже если
    # явный список enabledRuleGroups пуст или пользователь их не выбирал.
    enabled_set.update({"Blocked", "QUIC"})
    enabled_set.update(ALWAYS_ENABLED_RULE_IDS)

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
    # В некоторых профилях (например, router_zkeen) часть пакетов объявляет
    # только rule-providers и нигде не используется в RULE-SET строках.
    # Для выключенных пакетов такие провайдеры тоже нужно убрать из базового
    # скелета, иначе они всегда будут торчать в rule-providers даже при
    # пустом списке выбранных групп.
    for gid, group_names in RULE_GROUP_ID_TO_GROUP_NAMES.items():
        if gid in enabled_set:
            continue
        for gname in group_names:
            if gname and "@" in gname:
                providers_to_remove.add(gname)

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


def _ensure_leading_dash_for_yaml_block(yaml_block: str) -> str:
    """Ensure a proxy YAML snippet starts with a list item dash."""
    if not yaml_block:
        return ""

    text = yaml_block.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.splitlines()

    # Trim leading/trailing blank lines.
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        return ""

    def _first_content_index(items: List[str]) -> Optional[int]:
        for idx, line in enumerate(items):
            stripped = line.lstrip()
            if not stripped or stripped.startswith("#"):
                continue
            return idx
        return None

    content_idx = _first_content_index(lines)
    if content_idx is None:
        return ""

    # Strip a "proxies:" header if user pasted it.
    if re.match(r"^proxies\s*:\s*$", lines[content_idx].lstrip()):
        lines = lines[:content_idx] + lines[content_idx + 1 :]
        while content_idx < len(lines) and not lines[content_idx].strip():
            lines.pop(content_idx)
        content_idx = _first_content_index(lines)
        if content_idx is None:
            return ""

    # Remove common leading indentation from meaningful lines.
    min_indent: Optional[int] = None
    for line in lines:
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(stripped)
        if min_indent is None or indent < min_indent:
            min_indent = indent
    if min_indent:
        lines = [line[min_indent:] if len(line) >= min_indent else "" for line in lines]

    content_idx = _first_content_index(lines)
    if content_idx is None:
        return ""

    stripped = lines[content_idx].lstrip()
    if stripped.startswith("-"):
        # Fix "-name" -> "- name" for common typo.
        if len(stripped) > 1 and not stripped[1].isspace():
            indent = len(lines[content_idx]) - len(stripped)
            lines[content_idx] = (" " * indent) + "- " + stripped[1:]
        return "\n".join(lines)

    indent = len(lines[content_idx]) - len(stripped)
    lines[content_idx] = (" " * indent) + "- " + stripped
    for i in range(content_idx + 1, len(lines)):
        lines[i] = (" " * (indent + 2)) + lines[i]
    return "\n".join(lines)




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

    # Optional: collect non-fatal warnings for UI preview.
    collect_warn = bool(state.get("_xk_collect_warnings"))
    _warnings = state.get("_xk_warnings") if collect_warn else None
    if collect_warn and not isinstance(_warnings, list):
        _warnings = []
        state["_xk_warnings"] = _warnings

    def _warn(msg: str):
        if not collect_warn:
            return
        try:
            if _warnings is None:
                return
            if len(_warnings) >= 30:
                return
            s = str(msg).strip()
            if not s:
                return
            _warnings.append(s)
        except Exception:
            pass

    # Optional: sort proxies by 'priority' (lower = higher). Keep stable order for ties.
    def _prio_key(pair):
        _idx, _item = pair
        try:
            v = _item.get("priority")
            if v is None:
                return (10**9, _idx)
            v = int(str(v).strip())
            return (v, _idx)
        except Exception:
            return (10**9, _idx)

    sorted_pairs = sorted(list(enumerate(proxies, 1)), key=_prio_key)

    for idx, item in sorted_pairs:
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
            if kind in {"auto", "vless", "trojan", "vmess", "ss", "hysteria2"}:
                link = str(item.get("link") or "").strip()
                if not link:
                    _warn(f"Прокси {name or f'proxy#{idx}'}: пустая ссылка")
                    continue

                # kind is UI hint; actual scheme is auto-detected.
                # This allows users to paste any supported URI even if they chose the wrong type.
                try:
                    res = parse_proxy_uri(link, custom_name=name)
                except Exception:
                    # Backward compatibility: older configs might still rely on vless-only parser
                    res = parse_vless(link, custom_name=name)

                proxy_name = res.name
                proxy_yaml = res.yaml

            elif kind == "wireguard":
                conf = str(item.get("config") or "").strip()
                if not conf:
                    _warn(f"Прокси {name or f'proxy#{idx}'}: пустой WireGuard-конфиг")
                    continue
                res = parse_wireguard(conf, custom_name=name)
                proxy_name = res.name
                proxy_yaml = res.yaml

            elif kind == "yaml":
                yaml_block = str(item.get("yaml") or "").strip()
                if not yaml_block:
                    _warn(f"Прокси {name or f'proxy#{idx}'}: пустой YAML-блок")
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
                _warn(f"Прокси {name or f'proxy#{idx}'}: неизвестный тип '{kind}'")
                # Unknown kind – ignore silently; UI should not send this.
                continue

            cfg = apply_proxy_insert(cfg, proxy_yaml, proxy_name, groups)

        except Exception as exc:
            # Let the rest of proxies still be applied; individual bad entries
            # just do not make it into the resulting config.
            try:
                label = name or f"proxy#{idx}"
                _warn(f"Прокси {label}: ошибка добавления ({kind}): {exc}")
            except Exception:
                pass
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
    if not subs:
        content = _ensure_empty_proxy_providers_map(content)

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



def get_profile_rule_presets(profile: str | None) -> Dict[str, Any]:
    """Return profile-specific rule-group presets for the Mihomo generator UI.

    This exposes two lists for the selected profile:

    * ``availableRuleGroups`` – which optional rule packages are even
      meaningful for this profile and should be shown as checkboxes.
    * ``enabledRuleGroups`` – which of those packages should be enabled
      by default when the user selects the profile in the UI.

    Mandatory packages (``"Blocked"``, ``"QUIC"``) are always enforced
    server-side and therefore never exposed to the UI.
    """
    # Normalise profile name exactly the same way as the main generator.
    norm = _normalise_profile_name(profile)

    # All rule IDs that are meaningful for the UI (everything except the
    # mandatory packages which are always enabled internally).
    ui_candidate_ids: List[str] = [
        gid for gid in RULE_GROUP_ID_TO_GROUP_NAMES.keys()
        if gid not in {"Blocked", "QUIC"} and gid not in ALWAYS_ENABLED_RULE_IDS
    ]

    # Available packages depend on the profile. ZKeen and router_custom
    # profiles expose the full set, while simpler router profiles hide the
    # ZKeen-only extras (GEOIP/GEOSITE helpers, Ru-Traffic, etc.).
    if norm in {"router_zkeen", "router_custom"}:
        available: Sequence[str] = ui_candidate_ids
    else:
        available = [
            gid for gid in ui_candidate_ids
            if gid not in ZKEEN_ONLY_RULE_IDS
        ]

    # Profile-specific defaults. For more "advanced" profiles like
    # router_custom we keep everything unchecked so that the user explicitly
    # opts in. Simpler profiles enable all available packages by default.
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
    "build_full_config",
    "build_router_config",
    "build_app_config",
    "get_profile_rule_presets",
]
