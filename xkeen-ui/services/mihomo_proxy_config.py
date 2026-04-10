"""Pure-text Mihomo proxy / proxy-group config mutation helpers."""

from __future__ import annotations

import re
from typing import Iterable, List, Optional, Tuple


def insert_proxy_into_groups(content: str, proxy_name: str, target_groups: Iterable[str]) -> str:
    """Insert proxy_name into proxies: list of selected proxy-groups."""
    groups_set = {group.strip() for group in target_groups if group.strip()}
    if not groups_set:
        return content

    def _inject_into_inline_proxies(line: str) -> str:
        stripped = line.lstrip()
        indent = line[: len(line) - len(stripped)]
        prefix = "proxies:"
        rest = stripped[len(prefix):].lstrip()
        if not (rest.startswith("[") and rest.endswith("]")):
            return line
        inner = rest[1:-1].strip()
        items = [item.strip() for item in inner.split(",")] if inner else []

        def _norm(value: str) -> str:
            return value.strip().strip('"').strip("'")

        existing = {_norm(item) for item in items if item}
        if _norm(proxy_name) in existing:
            return line

        new_item = proxy_name
        if not (new_item.startswith('"') or new_item.startswith("'")):
            if re.search(r"[\s,]", new_item):
                new_item = f'"{new_item}"'

        items.append(new_item)
        new_inner = ", ".join(items)
        return f"{indent}proxies: [{new_inner}]"

    lines = content.splitlines()
    out: List[str] = []
    in_groups = False
    current_group: Optional[str] = None
    in_proxies_list = False

    for idx, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith("proxy-groups:"):
            in_groups = True
            current_group = None
            in_proxies_list = False
            out.append(line)
            continue

        if in_groups and stripped.startswith("- name:"):
            current_group = stripped.split(":", 1)[1].strip().strip('"').strip("'")
            in_proxies_list = False
            out.append(line)
            continue

        if in_groups and stripped.startswith("proxies:"):
            if "[" in stripped and "]" in stripped and current_group in groups_set:
                out.append(_inject_into_inline_proxies(line))
                continue
            in_proxies_list = True
            out.append(line)
            continue

        if in_groups and in_proxies_list:
            if stripped.startswith("- name:") or (stripped and not line.startswith(" " * 4)):
                if current_group in groups_set:
                    _inject_proxy_before_leave(out, proxy_name)
                in_proxies_list = False

        out.append(line)

        if in_groups and in_proxies_list:
            if idx + 1 == len(lines) or lines[idx + 1].lstrip().startswith("- name:"):
                if current_group in groups_set:
                    _inject_proxy_before_leave(out, proxy_name)
                in_proxies_list = False

    content_after_first = "\n".join(out) + "\n"

    lines2 = content_after_first.splitlines()
    out2: List[str] = []
    in_groups = False
    current_group = None
    group_has_proxies = False
    group_has_include_all = False
    group_include_indent = ""

    def flush_group_if_needed() -> None:
        nonlocal out2, group_has_proxies, group_has_include_all, group_include_indent
        if not in_groups or not current_group:
            return
        if current_group not in groups_set:
            return
        if group_has_proxies:
            return
        if not group_has_include_all:
            return
        indent = group_include_indent or "    "
        out2.append(f"{indent}proxies:")
        out2.append(f"{indent}  - {_quote_proxy_list_item(proxy_name)}")

    for line in lines2:
        stripped = line.lstrip()
        if stripped.startswith("proxy-groups:"):
            if in_groups and current_group is not None:
                flush_group_if_needed()
            in_groups = True
            current_group = None
            group_has_proxies = False
            group_has_include_all = False
            group_include_indent = ""
            out2.append(line)
            continue

        if in_groups and stripped.startswith("- name:"):
            if current_group is not None:
                flush_group_if_needed()
            current_group = stripped.split(":", 1)[1].strip().strip('"').strip("'")
            group_has_proxies = False
            group_has_include_all = False
            group_include_indent = ""
            out2.append(line)
            continue

        if in_groups and "include-all:" in stripped:
            group_has_include_all = True
            group_include_indent = line[: len(line) - len(stripped)]
            out2.append(line)
            continue

        if in_groups and stripped.startswith("proxies:"):
            group_has_proxies = True
            out2.append(line)
            continue

        if in_groups and stripped and not line.startswith("  ") and not stripped.startswith("proxy-groups:"):
            flush_group_if_needed()
            in_groups = False
            current_group = None
            group_has_proxies = False
            group_has_include_all = False
            group_include_indent = ""
            out2.append(line)
            continue

        out2.append(line)

    if in_groups and current_group is not None:
        flush_group_if_needed()

    return "\n".join(out2) + "\n"


def _quote_proxy_list_item(proxy_name: str) -> str:
    value = str(proxy_name or "").strip()
    if value.startswith('"') or value.startswith("'"):
        return value
    return f'"{value}"'


def _proxy_list_item_name(line: str) -> Optional[str]:
    match = re.match(r"^\s*-\s*(.+?)\s*$", str(line or ""))
    if not match:
        return None
    raw = match.group(1).strip()
    if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
        return raw[1:-1]
    if raw.startswith("'") and raw.endswith("'") and len(raw) >= 2:
        return raw[1:-1]
    return raw


def _inject_proxy_before_leave(out_lines: List[str], proxy_name: str) -> None:
    """Append '- proxy_name' to the current proxies: list if not there yet."""
    if not out_lines:
        return

    target = str(proxy_name or "").strip().strip('"').strip("'")
    if not target:
        return

    indent = "      "
    for line in reversed(out_lines):
        stripped = line.strip()
        if stripped.startswith("- name:"):
            break
        if stripped.startswith("-"):
            indent = line[: len(line) - len(line.lstrip())]
            break

    for line in reversed(out_lines):
        stripped = line.strip()
        if stripped.startswith("- name:"):
            break
        existing = _proxy_list_item_name(line)
        if existing is not None and existing.strip().strip('"').strip("'") == target:
            return

    out_lines.append(f"{indent}- {_quote_proxy_list_item(target)}")


def _strip_yaml_inline_comment(raw: str) -> str:
    text = str(raw or "")
    if not text:
        return text
    in_single = False
    in_double = False
    escaped = False
    for idx, ch in enumerate(text):
        if in_double:
            if escaped:
                escaped = False
                continue
            if ch == "\\":
                escaped = True
                continue
            if ch == '"':
                in_double = False
            continue
        if in_single:
            if ch == "'":
                in_single = False
            continue
        if ch == '"':
            in_double = True
            continue
        if ch == "'":
            in_single = True
            continue
        if ch == "#":
            return text[:idx].rstrip()
    return text.rstrip()


def _normalize_yaml_scalar(raw: str) -> str:
    text = _strip_yaml_inline_comment(str(raw or "").strip()).strip()
    if len(text) >= 2 and ((text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'"))):
        return text[1:-1]
    return text


def _quote_yaml_name(value: str) -> str:
    text = str(value or "")
    text = text.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{text}"'


def replace_proxy_in_config(content: str, proxy_name: str, new_proxy_yaml: str) -> Tuple[str, bool]:
    """Replace a proxy block inside top-level `proxies:` section."""
    if not isinstance(content, str):
        content = str(content or "")
    if not isinstance(new_proxy_yaml, str):
        new_proxy_yaml = str(new_proxy_yaml or "")

    proxy_name = (proxy_name or "").strip()
    if not proxy_name:
        out0 = content.replace("\r\n", "\n").replace("\r", "\n")
        return (out0 if out0.endswith("\n") else out0 + "\n"), False

    content_n = content.replace("\r\n", "\n").replace("\r", "\n")
    new_yaml_n = new_proxy_yaml.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")
    lines = content_n.splitlines()

    proxies_idx = None
    for i, line in enumerate(lines):
        if line.strip() == "proxies:" and (len(line) - len(line.lstrip()) == 0):
            proxies_idx = i
            break

    if proxies_idx is None:
        return (content_n if content_n.endswith("\n") else content_n + "\n"), False

    end_idx = len(lines)
    for j in range(proxies_idx + 1, len(lines)):
        line = lines[j]
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if (len(line) - len(line.lstrip()) == 0) and not line.lstrip().startswith("-"):
            end_idx = j
            break

    name_line_re = re.compile(r"^(\s*)-\s+name:\s*(.+?)\s*$")
    item_indent_str = "  "
    item_indent_len = 2
    for j in range(proxies_idx + 1, end_idx):
        match = name_line_re.match(lines[j])
        if match:
            item_indent_str = match.group(1)
            item_indent_len = len(item_indent_str)
            break

    def _clean_name(raw: str) -> str:
        return _normalize_yaml_scalar(raw)

    target_start = None
    target_end = None

    for j in range(proxies_idx + 1, end_idx):
        match = name_line_re.match(lines[j])
        if not match:
            continue
        indent = match.group(1)
        if len(indent) != item_indent_len:
            continue
        found = _clean_name(match.group(2))
        if found == proxy_name:
            target_start = j
            for k in range(j + 1, end_idx):
                match2 = name_line_re.match(lines[k])
                if match2 and len(match2.group(1)) == item_indent_len:
                    target_end = k
                    break
            if target_end is None:
                target_end = end_idx
            break

    if target_start is None:
        return (content_n if content_n.endswith("\n") else content_n + "\n"), False

    new_lines = new_yaml_n.splitlines()
    if not new_lines or not new_lines[0].lstrip().startswith("- name:"):
        return (content_n if content_n.endswith("\n") else content_n + "\n"), False

    indented_block = [item_indent_str + line for line in new_lines]
    out_lines = lines[:target_start] + indented_block + lines[target_end:]
    out = "\n".join(out_lines).rstrip("\n") + "\n"
    return out, True


def replace_proxy_block(content: str, target_name: str, new_yaml_block: str) -> str:
    """Backwards-compatible wrapper (returns only text)."""
    out, _changed = replace_proxy_in_config(content, target_name, new_yaml_block)
    return out


def _rename_inline_group_proxies(line: str, old_name: str, new_name: str) -> str:
    match = re.match(r"^(\s*proxies\s*:\s*\[)(.*?)(\]\s*(#.*)?)$", str(line or ""))
    if not match:
        return line
    inner = (match.group(2) or "").strip()
    if not inner:
        return line

    items = [item.strip() for item in inner.split(",")]
    changed = False
    new_items: List[str] = []
    for item in items:
        if _normalize_yaml_scalar(item) == old_name:
            new_items.append(_quote_proxy_list_item(new_name))
            changed = True
        else:
            new_items.append(item)

    if not changed:
        return line
    return f"{match.group(1)}{', '.join(new_items)}{match.group(3)}"


def rename_proxy_in_config(content: str, old_name: str, new_name: str) -> str:
    """Rename proxy and update its usages inside `proxy-groups:` only."""
    if not isinstance(content, str):
        content = str(content or "")

    old_name = str(old_name or "").strip()
    new_name = str(new_name or "").strip()
    if not old_name or not new_name or old_name == new_name:
        return content

    content_n = content.replace("\r\n", "\n").replace("\r", "\n")
    had_trailing_nl = content_n.endswith("\n")
    lines = content_n.splitlines()

    out: List[str] = []
    in_proxies = False
    in_groups = False
    in_group_proxies_list = False
    proxies_list_indent = -1

    for line in lines:
        stripped = line.lstrip()
        indent_len = len(line) - len(stripped)

        if indent_len == 0 and stripped.startswith("proxies:"):
            in_proxies = True
            in_groups = False
            in_group_proxies_list = False
            proxies_list_indent = -1
            out.append(line)
            continue

        if indent_len == 0 and stripped.startswith("proxy-groups:"):
            in_groups = True
            in_proxies = False
            in_group_proxies_list = False
            proxies_list_indent = -1
            out.append(line)
            continue

        if indent_len == 0 and stripped and not stripped.startswith("#"):
            in_proxies = False
            in_groups = False
            in_group_proxies_list = False
            proxies_list_indent = -1

        if in_proxies:
            match = re.match(r"^(\s*)-\s+name:\s*(.+?)(\s*(#.*)?)$", line)
            if match and _normalize_yaml_scalar(match.group(2)) == old_name:
                comment = match.group(3) if match.group(4) else ""
                out.append(f"{match.group(1)}- name: {_quote_yaml_name(new_name)}{comment}")
                continue

        if in_groups:
            if in_group_proxies_list and stripped and not stripped.startswith("#") and indent_len <= proxies_list_indent:
                in_group_proxies_list = False
                proxies_list_indent = -1

            if stripped.startswith("proxies:"):
                if "[" in stripped and "]" in stripped:
                    out.append(_rename_inline_group_proxies(line, old_name, new_name))
                else:
                    in_group_proxies_list = True
                    proxies_list_indent = indent_len
                    out.append(line)
                continue

            if in_group_proxies_list:
                match = re.match(r"^(\s*)-\s*(.+?)\s*$", line)
                if match and len(match.group(1)) > proxies_list_indent:
                    if _normalize_yaml_scalar(match.group(2)) == old_name:
                        out.append(f"{match.group(1)}- {_quote_proxy_list_item(new_name)}")
                        continue

        out.append(line)

    out_text = "\n".join(out)
    return out_text + ("\n" if had_trailing_nl else "")


def apply_proxy_insert(
    content: str,
    proxy_yaml_block: str,
    proxy_name: str,
    target_groups: Iterable[str],
) -> str:
    """High-level helper to insert proxy YAML and register it in proxy-groups."""
    content = content.replace("\r\n", "\n")
    proxy_yaml_block = proxy_yaml_block.replace("\r\n", "\n")

    content = re.sub(
        r"^(proxies\s*:)\s*(?:\[\]|\{\}|null|~)?\s*(#.*)?$",
        lambda match: f"proxies:{(' ' + match.group(2).strip()) if match.group(2) else ''}",
        content,
        flags=re.M,
    )

    yaml_block_lines = [
        line.rstrip("\n")
        for line in proxy_yaml_block.splitlines()
        if line.strip()
    ]
    if not yaml_block_lines:
        return content

    lines = content.splitlines()
    inserted = False

    for idx, line in enumerate(lines):
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if stripped == "proxies:" and indent == 0:
            base_indent = line[: len(line) - len(stripped)]

            section_end = len(lines)
            for j in range(idx + 1, len(lines)):
                candidate = lines[j]
                candidate_stripped = candidate.lstrip()
                candidate_indent = len(candidate) - len(candidate_stripped)
                if candidate_indent == 0 and candidate_stripped and not candidate_stripped.startswith("#") and not candidate_stripped.startswith("-"):
                    section_end = j
                    break

            insert_at = section_end
            while insert_at > idx + 1 and not lines[insert_at - 1].strip():
                insert_at -= 1
            while insert_at > idx + 1 and lines[insert_at - 1].lstrip().startswith("#"):
                insert_at -= 1

            block_lines = [f"{base_indent}  {block_line}" for block_line in yaml_block_lines]
            lines[insert_at:insert_at] = block_lines
            inserted = True
            break

    if not inserted:
        markers = (
            "подключение с использованием подписки",
            "подписки",
        )
        for idx, line in enumerate(lines):
            lower = line.lower()

            if "пример vless" in lower:
                continue

            if any(marker in lower for marker in markers):
                insert_at = idx
                prev = insert_at - 1
                if prev >= 0:
                    prev_line = lines[prev]
                    if prev_line.strip().startswith("#") and "Пример VLESS" not in prev_line:
                        insert_at = prev

                lines.insert(insert_at, "proxies:")
                for rel_i, block_line in enumerate(yaml_block_lines):
                    lines.insert(insert_at + 1 + rel_i, f"  {block_line}")

                spacer_index = insert_at + 1 + len(yaml_block_lines)
                if spacer_index < len(lines) and lines[spacer_index].strip().startswith("#"):
                    lines.insert(spacer_index, "")

                inserted = True
                break

    if not inserted:
        lines.append("proxies:")
        for block_line in yaml_block_lines:
            lines.append(f"  {block_line}")

    new_content = "\n".join(lines) + "\n"
    return insert_proxy_into_groups(new_content, proxy_name, target_groups)


apply_insert = apply_proxy_insert


__all__ = [
    "insert_proxy_into_groups",
    "replace_proxy_block",
    "replace_proxy_in_config",
    "rename_proxy_in_config",
    "apply_proxy_insert",
    "apply_insert",
]
