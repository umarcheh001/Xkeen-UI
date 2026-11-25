"""Move panel-owned nodes to file providers without changing routing targets."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


def provider_identity(config_path: str, sub_id: str) -> tuple[str, Path]:
    root = Path(config_path).absolute().parent
    digest = hashlib.sha256((os.path.realpath(config_path) + "\0" + sub_id).encode()).hexdigest()[:16]
    name = "xk-managed-" + digest
    directory = root / "proxy_providers" / "xkeen"
    # Do not follow a user-created provider-directory symlink outside Mihomo.
    if not directory.resolve().is_relative_to(root.resolve()):
        raise RuntimeError("managed_provider_path_outside_root")
    path = directory / (name + ".yaml")
    if not path.resolve().is_relative_to(root.resolve()):
        raise RuntimeError("managed_provider_path_outside_root")
    return name, path


def provider_payload(blocks: list[str]) -> str:
    return "proxies:\n" + "\n".join("  " + line for line in "\n\n".join(blocks).splitlines()) + "\n"


def owned_nodes_unchanged(content: str, managed_yaml: str) -> bool:
    """Permit unrelated editor changes only when all owned nodes match exactly."""
    try:
        import yaml

        remembered = yaml.safe_load(managed_yaml)
        current = yaml.safe_load(content)
        if not isinstance(remembered, list) or not remembered or not isinstance(current, dict):
            return False
        nodes = {proxy["name"]: proxy for proxy in (current.get("proxies") or [])}
        return all(nodes.get(proxy["name"]) == proxy for proxy in remembered)
    except (ImportError, ValueError, TypeError, KeyError):
        return False


def check_provider(content: str, provider: str, path: Path) -> str:
    import yaml

    spec = (yaml.safe_load(content).get("proxy-providers") or {}).get(provider)
    if not isinstance(spec, dict):
        raise RuntimeError("managed_provider_missing")
    if spec.get("type") == "file":
        configured = (path.parents[2] / str(spec.get("path") or "")).resolve()
        if configured != path.resolve():
            raise RuntimeError("managed_provider_path_changed")
        return content
    if spec.get("type") != "inline":
        raise RuntimeError("managed_provider_type_changed")
    # Restoring a self-contained backup materializes its snapshot as inline.
    tree = yaml.compose(content)
    section = next(v for k, v in tree.value if k.value == "proxy-providers")
    node = next(v for k, v in section.value if k.value == provider)
    spec = {k: v for k, v in spec.items() if k not in {"payload", "url"}}
    spec.update(type="file", path="./proxy_providers/xkeen/" + path.name, interval=0)
    replacement = json.dumps(spec, ensure_ascii=False) + "\n" + " " * node.end_mark.column
    return content[:node.start_mark.index] + replacement + content[node.end_mark.index:]


def migrate_config(content: str, names: list[str], provider: str, path: Path) -> str | None:
    """Return a small text patch, or None when routing cannot be preserved."""
    try:
        import yaml
    except ImportError:
        return None
    from services.mihomo_node_import import _insert_top_level_section, _normalise_patchable_section
    from services.mihomo_subscriptions import _remove_proxy_blocks

    config = yaml.safe_load(content)
    if not isinstance(config, dict) or not names:
        return None
    targets = set(names)
    proxies = config.get("proxies") or []
    if not isinstance(proxies, list) or {p.get("name") for p in proxies if isinstance(p, dict)}.intersection(targets) != targets:
        return None
    if provider in (config.get("proxy-providers") or {}) or provider in {p.get("name") for p in proxies if isinstance(p, dict)}:
        return None
    # A rule/listener/dialer that names an individual node cannot use a provider.
    def references(value):
        if isinstance(value, dict):
            return any(references(k) or references(v) for k, v in value.items())
        if isinstance(value, list):
            return any(references(v) for v in value)
        return isinstance(value, str) and bool(targets.intersection(part.strip() for part in value.split(",")))
    if references({k: v for k, v in config.items() if k not in {"proxies", "proxy-groups"}}):
        return None
    if references([{k: v for k, v in p.items() if k != "name"} for p in proxies if isinstance(p, dict)]):
        return None
    groups = config.get("proxy-groups") or []
    for group in groups:
        if not isinstance(group, dict) or group.get("name") == provider or group.get("include-all-proxies"):
            return None
        members = group.get("proxies") or []
        overlap = targets.intersection(members)
        if overlap and (overlap != targets or set(members[-len(targets):]) != targets):
            return None  # A subset must not silently become the whole subscription.

    tree = yaml.compose(content)
    group_node = next((v for k, v in tree.value if k.value == "proxy-groups"), None)
    edits = []
    if group_node is not None:
        for node, group in zip(group_node.value, groups):
            fields = {k.value: v for k, v in node.value}
            if not targets.intersection(group.get("proxies") or []):
                continue
            if node.flow_style or "proxies" not in fields or fields["proxies"].start_mark.index < node.start_mark.index:
                return None  # Do not rewrite an alias definition shared elsewhere.
            members = [name for name in group["proxies"] if name not in targets]
            key = next(k for k, v in node.value if k.value == "proxies")
            value = fields["proxies"]
            replacement = "proxies: " + json.dumps(members, ensure_ascii=False)
            if not value.flow_style:
                replacement += "\n" + " " * value.end_mark.column
            used = list(group.get("use") or [])
            if provider not in used:
                used.insert(0, provider)
            if "use" in fields:
                value = fields["use"]
                if value.start_mark.index < node.start_mark.index:
                    return None
                use_key = next(k for k, v in node.value if k.value == "use")
                edits.append((use_key.start_mark.index, value.end_mark.index, "use: " + json.dumps(used, ensure_ascii=False) + ("\n" + " " * value.end_mark.column if not value.flow_style else "")))
            else:
                replacement = "use: " + json.dumps(used, ensure_ascii=False) + "\n" + " " * key.start_mark.column + replacement
            edits.append((key.start_mark.index, fields["proxies"].end_mark.index, replacement))
    for start, end, replacement in sorted(edits, reverse=True):
        content = content[:start] + replacement + content[end:]
    content = _remove_proxy_blocks(content, names)
    if targets.intersection(p.get("name") for p in (yaml.safe_load(content).get("proxies") or [])):
        return None
    content = _normalise_patchable_section(content, "proxy-providers")
    relative = "./proxy_providers/xkeen/" + path.name
    content = _insert_top_level_section(content, "proxy-providers",
        f"  {provider}:\n    type: file\n    path: {json.dumps(relative)}\n    interval: 0\n")
    yaml.safe_load(content)
    return content


def remove_provider(content: str, provider: str) -> str:
    """Remove only a known provider and its group use references."""
    import yaml

    tree = yaml.compose(content)
    edits = []
    for key, value in tree.value:
        if key.value == "proxy-providers":
            for name, spec in value.value:
                if name.value == provider:
                    start = content.rfind("\n", 0, name.start_mark.index) + 1
                    edits.append((start, spec.end_mark.index, " " * spec.end_mark.column))
        elif key.value == "proxy-groups":
            for group in value.value:
                for name, members in group.value:
                    if name.value == "use" and isinstance(members, yaml.SequenceNode):
                        remaining = [item.value for item in members.value if item.value != provider]
                        if len(remaining) != len(members.value):
                            edits.append((members.start_mark.index, members.end_mark.index,
                                json.dumps(remaining, ensure_ascii=False) + ("\n" + " " * members.end_mark.column if not members.flow_style else "")))
    for start, end, replacement in sorted(edits, reverse=True):
        content = content[:start] + replacement + content[end:]
    return content


def freeze_for_backup(content: str, root: Path) -> str:
    """Embed managed provider nodes so a YAML backup is self-contained."""
    if "xk-managed-" not in content:
        return content
    import yaml

    config = yaml.safe_load(content) or {}
    tree = yaml.compose(content)
    node = next((v for k, v in tree.value if k.value == "proxy-providers"), None)
    if node is None:
        return content
    edits = []
    for key, value in node.value:
        spec = (config.get("proxy-providers") or {}).get(key.value, {})
        if not key.value.startswith("xk-managed-") or spec.get("type") != "file":
            continue
        path = (root / str(spec.get("path") or "")).resolve()
        managed_root = (root / "proxy_providers" / "xkeen").resolve()
        if not managed_root.is_relative_to(root.resolve()) or not path.is_relative_to(managed_root):
            raise RuntimeError("managed_provider_path_outside_root")
        proxies = (yaml.safe_load(path.read_text(encoding="utf-8")) or {}).get("proxies")
        if not isinstance(proxies, list) or not proxies:
            raise RuntimeError("managed_provider_backup_empty")
        frozen = {k: v for k, v in spec.items() if k not in {"type", "path", "interval"}}
        frozen.update(type="inline", payload=proxies)
        replacement = yaml.safe_dump(frozen, allow_unicode=True, default_flow_style=True, width=10**9).strip()
        edits.append((value.start_mark.index, value.end_mark.index, replacement + "\n" + " " * value.end_mark.column))
    for start, end, replacement in sorted(edits, reverse=True):
        content = content[:start] + replacement + content[end:]
    return content
