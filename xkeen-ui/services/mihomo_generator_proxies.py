"""Manual proxy injection helpers extracted from ``mihomo_config_generator.py``."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Set

from mihomo_server_core import (
    _yaml_list,
    _yaml_str,
    parse_proxy_uri,
    parse_vless,
    parse_wireguard,
)
from services.mihomo_proxy_config import apply_proxy_insert


def ensure_leading_dash_for_yaml_block(yaml_block: str) -> str:
    """Ensure a proxy YAML snippet starts with a list item dash."""
    if not yaml_block:
        return ""

    text = yaml_block.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.splitlines()

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

    if re.match(r"^proxies\s*:\s*$", lines[content_idx].lstrip()):
        lines = lines[:content_idx] + lines[content_idx + 1 :]
        while content_idx < len(lines) and not lines[content_idx].strip():
            lines.pop(content_idx)
        content_idx = _first_content_index(lines)
        if content_idx is None:
            return ""

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
        if len(stripped) > 1 and not stripped[1].isspace():
            indent = len(lines[content_idx]) - len(stripped)
            lines[content_idx] = (" " * indent) + "- " + stripped[1:]
        return "\n".join(lines)

    indent = len(lines[content_idx]) - len(stripped)
    lines[content_idx] = (" " * indent) + "- " + stripped
    for i in range(content_idx + 1, len(lines)):
        lines[i] = (" " * (indent + 2)) + lines[i]
    return "\n".join(lines)


def _proxy_tags_list(value: Any) -> List[str]:
    if isinstance(value, (list, tuple, set)):
        raw = [str(x or "").strip() for x in value]
    else:
        raw = re.split(r"[,;]+", str(value or "").strip()) if str(value or "").strip() else []
    out: List[str] = []
    seen: Set[str] = set()
    for item in raw:
        if not item or item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def append_proxy_meta_yaml(proxy_yaml: str, item: Dict[str, Any]) -> str:
    """Attach generator metadata fields (icon/tags) to proxy YAML when present."""
    if not isinstance(item, dict):
        return proxy_yaml

    icon = str(item.get("icon") or "").strip()
    tags = _proxy_tags_list(item.get("tags"))
    if not icon and not tags:
        return proxy_yaml

    lines = proxy_yaml.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    if not lines:
        return proxy_yaml

    has_icon = any(re.match(r"^\s*icon\s*:", line) for line in lines[1:])
    has_tags = any(re.match(r"^\s*tags\s*:", line) for line in lines[1:])

    extra: List[str] = []
    if icon and not has_icon:
        extra.append(f"  icon: {_yaml_str(icon)}")
    if tags and not has_tags:
        extra.append(f"  tags: {_yaml_list(tags)}")
    if not extra:
        return proxy_yaml

    out_lines = [lines[0]] + extra + lines[1:]
    return "\n".join(out_lines).rstrip("\n") + "\n"


def normalise_proxy_name_for_check(name: Any) -> str:
    return str(name or "").strip().strip('"').strip("'")


def insert_proxies_from_state(content: str, state: Dict[str, Any]) -> str:
    """Use parse_vless / parse_wireguard / raw YAML to inject proxies into config."""
    proxies = state.get("proxies") or []
    if not isinstance(proxies, list) or not proxies:
        return content

    default_groups = state.get("defaultGroups") or []
    if not isinstance(default_groups, list):
        default_groups = []
    default_groups = [str(group).strip() for group in default_groups if str(group).strip()]
    if not default_groups:
        default_groups = ["Заблок. сервисы"]

    cfg = content

    collect_warn = bool(state.get("_xk_collect_warnings"))
    warnings = state.get("_xk_warnings") if collect_warn else None
    if collect_warn and not isinstance(warnings, list):
        warnings = []
        state["_xk_warnings"] = warnings

    def _warn(msg: str) -> None:
        if not collect_warn:
            return
        try:
            if warnings is None:
                return
            if len(warnings) >= 30:
                return
            text = str(msg).strip()
            if not text:
                return
            warnings.append(text)
        except Exception:
            pass

    def _prio_key(pair):
        idx, item = pair
        try:
            value = item.get("priority")
            if value is None:
                return (10**9, idx)
            value = int(str(value).strip())
            return (value, idx)
        except Exception:
            return (10**9, idx)

    sorted_pairs = sorted(list(enumerate(proxies, 1)), key=_prio_key)
    seen_proxy_names: Set[str] = set()

    for idx, item in sorted_pairs:
        if not isinstance(item, dict):
            continue

        kind = str(item.get("kind") or "vless").lower()
        name = str(item["name"]).strip() if item.get("name") else None

        groups_raw = item.get("groups")
        if isinstance(groups_raw, list):
            groups = [str(group).strip() for group in groups_raw if str(group).strip()]
        else:
            groups = list(default_groups)

        if not groups:
            groups = ["Заблок. сервисы"]

        try:
            if kind in {"auto", "vless", "trojan", "vmess", "ss", "hysteria2"}:
                link = str(item.get("link") or "").strip()
                if not link:
                    _warn(f"Прокси {name or f'proxy#{idx}'}: пустая ссылка")
                    continue

                try:
                    res = parse_proxy_uri(link, custom_name=name)
                except Exception:
                    res = parse_vless(link, custom_name=name)

                proxy_name = res.name
                proxy_yaml = append_proxy_meta_yaml(res.yaml, item)

            elif kind == "wireguard":
                conf = str(item.get("config") or "").strip()
                if not conf:
                    _warn(f"Прокси {name or f'proxy#{idx}'}: пустой WireGuard-конфиг")
                    continue
                res = parse_wireguard(conf, custom_name=name)
                proxy_name = res.name
                proxy_yaml = append_proxy_meta_yaml(res.yaml, item)

            elif kind == "yaml":
                yaml_block = str(item.get("yaml") or "").strip()
                if not yaml_block:
                    _warn(f"Прокси {name or f'proxy#{idx}'}: пустой YAML-блок")
                    continue
                yaml_block = ensure_leading_dash_for_yaml_block(yaml_block)

                match = re.search(r"-\s*name:\s*([^\n]+)", yaml_block)
                if name:
                    proxy_name = name
                    if match:
                        yaml_block = re.sub(
                            r"(-\s*name:\s*)([^\n]+)",
                            r"\1" + proxy_name,
                            yaml_block,
                            count=1,
                        )
                    else:
                        lines = yaml_block.splitlines()
                        if lines:
                            first = lines[0]
                            indent = len(first) - len(first.lstrip())
                            lines.insert(1, " " * (indent + 2) + f"name: {proxy_name}")
                            yaml_block = "\n".join(lines)
                else:
                    if match:
                        proxy_name = match.group(1).strip()
                    else:
                        proxy_name = f"Custom-{idx}"
                        lines = yaml_block.splitlines()
                        if lines:
                            first = lines[0]
                            indent = len(first) - len(first.lstrip())
                            lines.insert(1, " " * (indent + 2) + f"name: {proxy_name}")
                            yaml_block = "\n".join(lines)

                proxy_yaml = append_proxy_meta_yaml(yaml_block, item)

            else:
                _warn(f"Прокси {name or f'proxy#{idx}'}: неизвестный тип '{kind}'")
                continue

            proxy_name_norm = normalise_proxy_name_for_check(proxy_name)
            if proxy_name_norm in seen_proxy_names:
                raise ValueError(
                    f"Дублирующееся имя узла '{proxy_name_norm}'. У каждого узла должно быть уникальное имя."
                )
            seen_proxy_names.add(proxy_name_norm)

            cfg = apply_proxy_insert(cfg, proxy_yaml, proxy_name_norm, groups)

        except Exception as exc:
            if isinstance(exc, ValueError) and "Дублирующееся имя узла" in str(exc):
                raise

            try:
                label = name or f"proxy#{idx}"
                _warn(f"Прокси {label}: ошибка добавления ({kind}): {exc}")
            except Exception:
                pass
            continue

    return cfg


__all__ = [
    "ensure_leading_dash_for_yaml_block",
    "append_proxy_meta_yaml",
    "normalise_proxy_name_for_check",
    "insert_proxies_from_state",
]
