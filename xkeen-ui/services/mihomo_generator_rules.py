"""Rule-group filtering helpers extracted from ``mihomo_config_generator.py``."""

from __future__ import annotations

import re
from typing import List, Optional, Sequence, Set

from services.mihomo_generator_meta import (
    ALWAYS_ENABLED_RULE_IDS,
    RULE_GROUP_ID_TO_GROUP_NAMES,
    normalise_profile_name as _normalise_profile_name,
)


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


def _remove_proxy_groups_by_name(content: str, names_to_remove: Set[str]) -> str:
    """Remove proxy-groups list items by `name:` safely within the proxy-groups section."""
    if not names_to_remove:
        return content

    lines = content.splitlines()

    header_idx: Optional[int] = None
    for i, line in enumerate(lines):
        if line.strip() == "proxy-groups:" and (len(line) - len(line.lstrip()) == 0):
            header_idx = i
            break
    if header_idx is None:
        return content

    end_idx = len(lines)
    j = header_idx + 1
    while j < len(lines):
        stripped = lines[j].strip()
        if not stripped or stripped.startswith("#"):
            j += 1
            continue
        if (len(lines[j]) - len(lines[j].lstrip()) == 0) and not lines[j].lstrip().startswith("-"):
            end_idx = j
            break
        j += 1

    name_re = re.compile(r"^(\s*)- name:\s*(.+?)\s*$")

    out_lines: List[str] = []
    out_lines.extend(lines[: header_idx + 1])

    i = header_idx + 1
    while i < end_idx:
        match = name_re.match(lines[i])
        if not match:
            out_lines.append(lines[i])
            i += 1
            continue

        item_indent = match.group(1)
        item_name = match.group(2).strip()

        k = i + 1
        while k < end_idx:
            sibling = name_re.match(lines[k])
            if sibling and sibling.group(1) == item_indent:
                break
            if lines[k].strip() and (len(lines[k]) - len(lines[k].lstrip()) == 0) and not lines[k].lstrip().startswith("#"):
                break
            k += 1

        if item_name not in names_to_remove:
            out_lines.extend(lines[i:k])

        i = k

    out_lines.extend(lines[end_idx:])
    return "\n".join(out_lines)


def _apply_pkg_markers(content: str, enabled_set: set[str]) -> str:
    """Apply simple package markers embedded in templates."""
    if not content:
        return content

    begin_re = re.compile(r"^\s*#\s*@pkg\s+([A-Za-z0-9_\-]+)\s+begin\s*$")
    end_re = re.compile(r"^\s*#\s*@pkg\s+([A-Za-z0-9_\-]+)\s+end\s*$")

    lines = content.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        match = begin_re.match(lines[i])
        if not match:
            out.append(lines[i])
            i += 1
            continue

        pkg_id = match.group(1)
        j = i + 1
        while j < len(lines):
            match_end = end_re.match(lines[j])
            if match_end and match_end.group(1) == pkg_id:
                break
            j += 1

        if j >= len(lines):
            out.append(lines[i])
            i += 1
            continue

        if pkg_id in enabled_set:
            out.extend(lines[i + 1:j])
        i = j + 1

    return "\n".join(out)


def _cleanup_rules_section(content: str, enabled_set: set[str], profile: str | None = None) -> str:
    """Clean up `rules:` section after package filtering."""
    if not content:
        return content

    profile = _normalise_profile_name(profile)

    lines = content.splitlines()
    start_idx = None
    for i, line in enumerate(lines):
        if (len(line) - len(line.lstrip()) == 0) and line.strip() == "rules:":
            start_idx = i
            break
    if start_idx is None:
        return content

    end_idx = len(lines)
    for j in range(start_idx + 1, len(lines)):
        stripped = lines[j].strip()
        if not stripped or stripped.startswith("#"):
            continue
        if (len(lines[j]) - len(lines[j].lstrip()) == 0) and not lines[j].lstrip().startswith("-"):
            end_idx = j
            break

    body = lines[start_idx + 1:end_idx]

    def _is_rule_line(line: str) -> bool:
        return bool(line.lstrip().startswith("-"))

    def _drop_rule_line(line: str) -> bool:
        if not _is_rule_line(line):
            return False
        if profile == "router_zkeen":
            if "Twitch" not in enabled_set and ("gql.twitch.tv" in line or "usher.ttvnw.net" in line):
                return True
        return False

    filtered = [line.rstrip() for line in body if not _drop_rule_line(line)]

    if profile == "router_zkeen" and filtered:
        hdr_re = re.compile(r"^\s*#\s*---")
        compact: list[str] = []
        i = 0
        while i < len(filtered):
            line = filtered[i]
            if hdr_re.match(line):
                k = i + 1
                found_rule = False
                found_hdr = False
                while k < len(filtered):
                    stripped = filtered[k].strip()
                    if not stripped:
                        k += 1
                        continue
                    if hdr_re.match(filtered[k]):
                        found_hdr = True
                        break
                    if _is_rule_line(filtered[k]):
                        found_rule = True
                        break
                    k += 1
                if found_hdr and not found_rule:
                    i += 1
                    continue
            compact.append(line)
            i += 1
        filtered = compact

    blocks: list[list[str]] = []
    cur: list[str] = []
    for line in filtered:
        if not line.strip():
            if cur:
                blocks.append(cur)
                cur = []
            continue
        cur.append(line)
    if cur:
        blocks.append(cur)

    kept_blocks: list[list[str]] = []
    for block in blocks:
        if any(_is_rule_line(item) for item in block):
            kept_blocks.append(block)

    new_body: list[str] = []
    for block_index, block in enumerate(kept_blocks):
        if block_index > 0:
            new_body.append("")
        new_body.extend(block)

    indent = "  "
    for line in new_body:
        if line.strip():
            indent = line[:len(line) - len(line.lstrip())]
            break

    def _is_match_rule(line: str) -> bool:
        return line.strip().replace(" ", "").startswith("-MATCH,")

    if not any(_is_rule_line(item) and _is_match_rule(item) for item in new_body):
        if new_body and new_body[-1].strip():
            new_body.append("")
        new_body.append(f"{indent}- MATCH,DIRECT")

    while new_body and not new_body[0].strip():
        new_body.pop(0)
    while new_body and not new_body[-1].strip():
        new_body.pop()

    out = lines[:start_idx + 1] + new_body + lines[end_idx:]
    return "\n".join(out)


def apply_rule_group_filtering(content: str, enabled_ids: Sequence[str], profile: str | None = None) -> str:
    """Enable only selected rule-group packages, producing a clean config."""
    if not isinstance(enabled_ids, (list, tuple, set)):
        enabled_ids = []
    enabled_set: Set[str] = {str(x) for x in enabled_ids}

    enabled_set.update({"Blocked", "QUIC"})
    enabled_set.update(ALWAYS_ENABLED_RULE_IDS)

    result = content

    protected_group_names: Set[str] = set()
    for enabled_id in enabled_set:
        for group_name in RULE_GROUP_ID_TO_GROUP_NAMES.get(enabled_id, ()):
            if group_name:
                protected_group_names.add(group_name)

    providers_to_remove: Set[str] = set()
    proxy_groups_to_remove: Set[str] = set()

    for group_id, group_names in RULE_GROUP_ID_TO_GROUP_NAMES.items():
        if group_id in enabled_set:
            continue
        if not group_names:
            continue

        effective_group_names = [
            group_name for group_name in group_names
            if group_name and group_name not in protected_group_names
        ]
        if not effective_group_names:
            continue

        for group_name in effective_group_names:
            if group_name and "@" not in group_name:
                proxy_groups_to_remove.add(group_name)

        lines = result.splitlines()
        new_lines: List[str] = []
        for line in lines:
            stripped = line.lstrip()
            if not stripped.startswith("-"):
                new_lines.append(line)
                continue

            should_drop = False
            for group_name in effective_group_names:
                if ("," + group_name) in line:
                    for match in re.finditer(r"RULE-SET,([^,\)\s]+)", line):
                        providers_to_remove.add(match.group(1))
                    should_drop = True
                    break

            if not should_drop:
                new_lines.append(line)

        result = "\n".join(new_lines)

    if proxy_groups_to_remove:
        result = _remove_proxy_groups_by_name(result, proxy_groups_to_remove)

    for group_id, group_names in RULE_GROUP_ID_TO_GROUP_NAMES.items():
        if group_id in enabled_set:
            continue
        for group_name in group_names:
            if group_name and "@" in group_name:
                providers_to_remove.add(group_name)

    if providers_to_remove:
        protected_providers: Set[str] = set()
        for enabled_id in enabled_set:
            for group_name in RULE_GROUP_ID_TO_GROUP_NAMES.get(enabled_id, ()):
                if group_name and "@" in group_name:
                    protected_providers.add(group_name)

        for provider_name in providers_to_remove:
            if not provider_name or provider_name in protected_providers:
                continue
            pattern = re.compile(
                rf"(?m)^([ \t]*){re.escape(provider_name)}:[^\n]*\n(?:\1[ \t]+.*\n)*"
            )
            result = pattern.sub("", result)

    result = _apply_pkg_markers(result, enabled_set)
    result = _cleanup_rules_section(result, enabled_set, profile)
    result = re.sub(r"\n{3,}", "\n\n", result)

    header_comment = "# Enabled rule-group packages: " + (
        ", ".join(sorted(enabled_set)) if enabled_set else "<none>"
    ) + "\n"

    if result.startswith("# Enabled rule-group packages"):
        lines = result.splitlines()
        lines[0] = header_comment.rstrip("\n")
        result = "\n".join(lines)
    else:
        result = header_comment + result

    return result


__all__ = [
    "apply_rule_group_filtering",
]
