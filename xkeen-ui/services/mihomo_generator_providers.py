"""Provider wiring helpers extracted from ``mihomo_config_generator.py``.

These helpers keep subscription-based provider expansion / cleanup isolated
from the higher-level generator flow, so the main generator module can focus on
pipeline orchestration.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Sequence, Set

from services.mihomo_generator_meta import (
    ROUTER_PROVIDER_NAMES,
    provider_name_for_index as _provider_name_for_index,
)


def replace_provider_urls(content: str, subscriptions: Sequence[str]) -> str:
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
        # We still strip provider stubs later via ensure_empty_proxy_providers_map
        # to keep templates clean.
        active_providers = set()

    # We rewrite ONLY bundled provider stubs (first 5) and strip the unused ones.
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
            for provider_name in ROUTER_PROVIDER_NAMES:
                if stripped.startswith(provider_name + ":"):
                    matched_provider = provider_name
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

    # Append missing providers into proxy-providers section.
    #
    # Historically templates shipped with 5 stub providers, but newer templates
    # may ship with fewer stubs (e.g. only proxy-sub). If the user enters more
    # subscriptions than the template contains, we must append the missing
    # provider blocks so that all subscriptions are honored.
    if subs_clean:
        needed_provider_names = [_provider_name_for_index(i) for i in range(len(subs_clean))]
        missing = [provider_name for provider_name in needed_provider_names if provider_name not in found_providers]
        if missing:
            rendered = append_extra_provider_blocks(rendered, provider_to_url, missing)

    return rendered


def append_extra_provider_blocks(
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
        stripped = lines[j].strip()
        if not stripped or stripped.startswith("#"):
            j += 1
            continue
        if not lines[j].startswith(" "):
            end_idx = j
            break
        j += 1

    # Determine already-present providers to avoid duplicates.
    present: Set[str] = set()
    for line in lines[header_idx + 1 : end_idx]:
        match = re.match(r"^([A-Za-z0-9_.-]+):\s*$", line.strip())
        if match:
            present.add(match.group(1))

    blocks: List[str] = []
    for provider_name in provider_names:
        if provider_name in present:
            continue
        url = str(provider_to_url.get(provider_name) or "").strip()
        if not url:
            continue
        blocks.extend(
            [
                f"  {provider_name}:",
                "    type: http",
                f'    url: "{url}"  # set by generator',
                f"    path: ./proxy_providers/{provider_name}.yaml",
                "    interval: 3600",
                "    health-check:",
                "      enable: true",
                '      url: "http://www.gstatic.com/generate_204"',
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


def filter_proxy_group_uses(content: str, subscriptions: Sequence[str]) -> str:
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
    subs_clean = [str(x).strip() for x in (subscriptions or []) if str(x).strip()]
    active_providers: List[str] = [
        _provider_name_for_index(i) for i in range(len(subs_clean))
    ]

    lines = content.splitlines()
    out_lines: List[str] = []

    in_use_block = False
    use_indent: Optional[int] = None

    def flush_use_block() -> None:
        if active_providers and use_indent is not None:
            for provider_name in active_providers:
                out_lines.append(" " * (use_indent + 2) + f"- {provider_name}")

    for line in lines:
        stripped = line.lstrip()
        indent = len(line) - len(stripped)

        if not in_use_block:
            if stripped.startswith("use:"):
                in_use_block = True
                use_indent = indent
                if active_providers:
                    out_lines.append(" " * indent + "use:")
                continue

            out_lines.append(line)
            continue

        if stripped and indent <= (use_indent or 0) and not stripped.startswith("#"):
            if active_providers:
                flush_use_block()
            in_use_block = False
            use_indent = None
            out_lines.append(line)
            continue

        # Still inside original use block: skip original provider entries / comments.
        continue

    if in_use_block and active_providers:
        flush_use_block()

    return "\n".join(out_lines)


def maybe_strip_example_vless(content: str, state: Dict[str, Any], subscriptions: Sequence[str]) -> str:
    """Drop the hardcoded 'Example VLESS' proxy when it is no longer needed."""
    subs_clean = [str(x).strip() for x in (subscriptions or []) if str(x).strip()]
    has_subs = bool(subs_clean)

    proxies = state.get("proxies") or []
    has_user_proxies = False
    if isinstance(proxies, list):
        for proxy in proxies:
            if not isinstance(proxy, dict):
                continue
            if str(proxy.get("link") or proxy.get("config") or proxy.get("yaml") or "").strip():
                has_user_proxies = True
                break

    if not (has_subs or has_user_proxies):
        return content

    pattern = re.compile(
        r"(?m)^([ \t]*)- name:\s*Example VLESS\b[\s\S]*?(?=^\1- |\Z)"
    )
    return pattern.sub("", content)


def ensure_empty_proxy_providers_map(content: str) -> str:
    """If proxy-providers block has no children, turn it into `proxy-providers: {}`."""
    lines = content.splitlines()
    for i, line in enumerate(lines):
        if line.strip() == "proxy-providers:":
            j = i + 1
            has_child = False
            while j < len(lines):
                stripped = lines[j].strip()
                if not stripped or stripped.startswith("#"):
                    j += 1
                    continue
                if lines[j].startswith(" "):
                    has_child = True
                break
            if not has_child:
                lines[i] = lines[i].rstrip() + " {}"
            break
    return "\n".join(lines)


__all__ = [
    "replace_provider_urls",
    "append_extra_provider_blocks",
    "filter_proxy_group_uses",
    "maybe_strip_example_vless",
    "ensure_empty_proxy_providers_map",
]
