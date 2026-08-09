"""Versioned, allow-list based DTO normalizers for the Mihomo Clash API.

Raw Mihomo responses must not become the public Xkeen UI contract.  These
helpers keep only the fields needed by the operator workspace and tolerate
optional fields across Mihomo versions.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from services.mihomo_clash_target import MihomoClashDiscovery


MIHOMO_CLASH_SCHEMA_VERSION = 1
MAX_GROUPS = 256
MAX_GROUP_NODES = 1024
MAX_CONNECTION_ROWS = 250
MAX_DELAY_RESULTS = 1024
MIHOMO_CLASH_CAPABILITY_KEYS = (
    "status",
    "proxy_groups",
    "proxy_select",
    "proxy_delay",
    "connections_snapshot",
    "connections_stream",
    "connection_disconnect",
)


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any, limit: int = 512) -> str:
    if value is None:
        return ""
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return ""
    text = str(value).replace("\x00", "").strip()
    return text[: max(0, int(limit))]


def _optional_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _nonnegative_int(value: Any, default: int = 0) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return int(default)
    return max(0, number)


def _string_list(value: Any, *, limit: int = 256, item_limit: int = 256) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    result: list[str] = []
    for item in value[: max(0, int(limit))]:
        text = _text(item, item_limit)
        if text:
            result.append(text)
    return result


def _last_delay(proxy: Mapping[str, Any]) -> int | None:
    history = proxy.get("history")
    if not isinstance(history, Sequence) or isinstance(history, (str, bytes, bytearray)):
        return None
    for entry in reversed(history):
        item = _mapping(entry)
        if "delay" not in item:
            continue
        try:
            delay = int(item.get("delay"))
        except (TypeError, ValueError, OverflowError):
            continue
        return max(0, delay)
    return None


def build_mihomo_clash_status_dto(
    discovery: MihomoClashDiscovery,
    *,
    version_payload: Any = None,
    config_payload: Any = None,
    capabilities: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the safe status DTO; config secrets and unknown fields are dropped."""

    version = _mapping(version_payload)
    config = _mapping(config_payload)
    tun = _mapping(config.get("tun"))
    capability_values = _mapping(capabilities)
    return {
        "schema_version": MIHOMO_CLASH_SCHEMA_VERSION,
        "api": discovery.public_dict(),
        "core": {
            "version": _text(version.get("version"), 96),
            "meta": _optional_bool(version.get("meta")),
        },
        "runtime": {
            "mode": _text(config.get("mode"), 32).lower(),
            "log_level": _text(config.get("log-level"), 32).lower(),
            "allow_lan": _optional_bool(config.get("allow-lan")),
            "ipv6": _optional_bool(config.get("ipv6")),
            "tun_enabled": _optional_bool(tun.get("enable")),
        },
        "capabilities": {
            key: _optional_bool(capability_values.get(key))
            for key in MIHOMO_CLASH_CAPABILITY_KEYS
        },
    }


def _provider_index(
    providers_payload: Any,
) -> tuple[list[dict[str, Any]], dict[str, list[str]], dict[str, Mapping[str, Any]]]:
    providers_raw = _mapping(_mapping(providers_payload).get("providers"))
    summaries: list[dict[str, Any]] = []
    membership: dict[str, list[str]] = {}
    provider_nodes: dict[str, Mapping[str, Any]] = {}

    for raw_name, raw_provider in list(providers_raw.items())[:MAX_GROUPS]:
        provider = _mapping(raw_provider)
        name = _text(provider.get("name") or raw_name, 256)
        if not name:
            continue
        proxies = provider.get("proxies")
        proxy_items = (
            list(proxies[:MAX_GROUP_NODES])
            if isinstance(proxies, Sequence) and not isinstance(proxies, (str, bytes, bytearray))
            else []
        )
        for raw_proxy in proxy_items:
            proxy = _mapping(raw_proxy)
            proxy_name = _text(proxy.get("name"), 256)
            if proxy_name:
                provider_names = membership.setdefault(proxy_name, [])
                if name not in provider_names:
                    provider_names.append(name)
                provider_nodes.setdefault(proxy_name, proxy)
        summaries.append(
            {
                "name": name,
                "type": _text(provider.get("type"), 64),
                "vehicle_type": _text(provider.get("vehicleType"), 64),
                "updated_at": _text(provider.get("updatedAt"), 96),
                "node_count": len(proxy_items),
            }
        )
    return summaries, membership, provider_nodes


def _node_dto(
    name: str,
    raw: Mapping[str, Any],
    provider_hints: Sequence[str] = (),
) -> dict[str, Any]:
    explicit_provider = _text(raw.get("provider-name"), 256)
    providers = _string_list(provider_hints, limit=32, item_limit=256)
    if explicit_provider and explicit_provider not in providers:
        providers.insert(0, explicit_provider)
    provider = explicit_provider or (providers[0] if len(providers) == 1 else "")
    return {
        "name": _text(raw.get("name") or name, 256),
        "type": _text(raw.get("type"), 64),
        "alive": _optional_bool(raw.get("alive")),
        "udp": _optional_bool(raw.get("udp")),
        "xudp": _optional_bool(raw.get("xudp")),
        "provider": provider,
        "provider_candidates": providers,
        "provider_ambiguous": not explicit_provider and len(providers) > 1,
        "delay_ms": _last_delay(raw),
    }


def build_mihomo_clash_proxy_groups_dto(
    proxies_payload: Any,
    providers_payload: Any = None,
) -> dict[str, Any]:
    """Normalize groups and provider summaries while retaining operator order."""

    proxies = _mapping(_mapping(proxies_payload).get("proxies"))
    providers, membership, provider_nodes = _provider_index(providers_payload)
    global_entry = _mapping(proxies.get("GLOBAL"))
    preferred = _string_list(global_entry.get("all"), limit=MAX_GROUPS + 1)

    candidate_names: list[str] = []
    for name in preferred:
        item = _mapping(proxies.get(name))
        if item.get("all") is not None and name not in candidate_names:
            candidate_names.append(name)
    for raw_name, raw_proxy in proxies.items():
        name = _text(raw_name, 256)
        item = _mapping(raw_proxy)
        if name != "GLOBAL" and item.get("all") is not None and name not in candidate_names:
            candidate_names.append(name)
        if len(candidate_names) > MAX_GROUPS:
            break
    groups_truncated = len(candidate_names) > MAX_GROUPS
    group_names = candidate_names[:MAX_GROUPS]

    groups: list[dict[str, Any]] = []
    for name in group_names[:MAX_GROUPS]:
        group = _mapping(proxies.get(name))
        candidate_node_names = _string_list(group.get("all"), limit=MAX_GROUP_NODES + 1)
        nodes_truncated = len(candidate_node_names) > MAX_GROUP_NODES
        node_names = candidate_node_names[:MAX_GROUP_NODES]
        nodes: list[dict[str, Any]] = []
        for node_name in node_names:
            raw_node = _mapping(proxies.get(node_name)) or provider_nodes.get(node_name, {})
            nodes.append(_node_dto(node_name, raw_node, membership.get(node_name, [])))

        group_type = _text(group.get("type"), 64)
        selectable = group_type.lower() in {"selector", "select", "urltest", "fallback", "smart"}
        groups.append(
            {
                "name": name,
                "type": group_type,
                "now": _text(group.get("now"), 256),
                "fixed": _text(group.get("fixed"), 256),
                "alive": _optional_bool(group.get("alive")),
                "hidden": bool(group.get("hidden")) if isinstance(group.get("hidden"), bool) else False,
                "selectable": selectable,
                "node_count": len(node_names),
                "nodes_truncated": nodes_truncated,
                "nodes": nodes,
            }
        )

    return {
        "schema_version": MIHOMO_CLASH_SCHEMA_VERSION,
        "groups": groups,
        "providers": providers,
        "truncated": groups_truncated,
    }


def build_mihomo_clash_delay_dto(
    delay_payload: Any,
    *,
    scope: str,
    name: str,
    preset: str,
) -> dict[str, Any]:
    """Normalize single-proxy and group delay responses into one bounded shape."""

    payload = _mapping(delay_payload)
    normalized_scope = _text(scope, 16).lower()
    results: list[dict[str, Any]] = []
    truncated = False

    if normalized_scope in {"proxy", "provider-proxy"}:
        raw_items = [(name, payload.get("delay"))]
    else:
        candidates = list(payload.items())
        truncated = len(candidates) > MAX_DELAY_RESULTS
        raw_items = candidates[:MAX_DELAY_RESULTS]

    for raw_name, raw_delay in raw_items:
        result_name = _text(raw_name, 256)
        if not result_name or isinstance(raw_delay, bool):
            continue
        try:
            delay_ms = int(raw_delay)
        except (TypeError, ValueError, OverflowError):
            continue
        if delay_ms < 0:
            continue
        results.append({"name": result_name, "delay_ms": delay_ms})

    return {
        "schema_version": MIHOMO_CLASH_SCHEMA_VERSION,
        "scope": normalized_scope,
        "name": _text(name, 256),
        "preset": _text(preset, 32),
        "results": results,
        "truncated": truncated,
    }


def _device_name(device_map: Mapping[str, Any], source_ip: str) -> str:
    raw = device_map.get(source_ip)
    if isinstance(raw, Mapping):
        return _text(raw.get("name"), 96)
    return _text(raw, 96)


def _connection_dto(raw_connection: Any, device_map: Mapping[str, Any]) -> dict[str, Any] | None:
    connection = _mapping(raw_connection)
    connection_id = _text(connection.get("id"), 160)
    if not connection_id:
        return None
    metadata = _mapping(connection.get("metadata"))
    source_ip = _text(metadata.get("sourceIP"), 64)
    return {
        "id": connection_id,
        "metadata": {
            "network": _text(metadata.get("network"), 24).lower(),
            "type": _text(metadata.get("type"), 48),
            "source_ip": source_ip,
            "source_port": _text(metadata.get("sourcePort"), 16),
            "source_name": _device_name(device_map, source_ip),
            "destination_ip": _text(metadata.get("destinationIP"), 64),
            "destination_port": _text(metadata.get("destinationPort"), 16),
            "host": _text(metadata.get("host"), 512),
            "sniff_host": _text(metadata.get("sniffHost"), 512),
            "inbound_name": _text(metadata.get("inboundName"), 128),
            "inbound_user": _text(metadata.get("inboundUser"), 128),
            "process": _text(metadata.get("process"), 256),
        },
        "upload": _nonnegative_int(connection.get("upload")),
        "download": _nonnegative_int(connection.get("download")),
        "start": _text(connection.get("start"), 96),
        "chains": _string_list(connection.get("chains"), limit=32, item_limit=256),
        "provider_chains": _string_list(connection.get("providerChains"), limit=32, item_limit=256),
        "rule": _text(connection.get("rule"), 96),
        "rule_payload": _text(connection.get("rulePayload"), 1024),
    }


def build_mihomo_clash_connections_dto(
    connections_payload: Any,
    *,
    device_map: Mapping[str, Any] | None = None,
    max_rows: int = MAX_CONNECTION_ROWS,
) -> dict[str, Any]:
    """Normalize a bounded connection snapshot for browser consumption."""

    payload = _mapping(connections_payload)
    raw_connections = payload.get("connections")
    source = (
        list(raw_connections)
        if isinstance(raw_connections, Sequence) and not isinstance(raw_connections, (str, bytes, bytearray))
        else []
    )
    limit = max(1, min(1000, int(max_rows)))
    devices = device_map if isinstance(device_map, Mapping) else {}
    rows: list[dict[str, Any]] = []
    for raw in source[:limit]:
        item = _connection_dto(raw, devices)
        if item is not None:
            rows.append(item)

    return {
        "schema_version": MIHOMO_CLASH_SCHEMA_VERSION,
        "download_total": _nonnegative_int(payload.get("downloadTotal")),
        "upload_total": _nonnegative_int(payload.get("uploadTotal")),
        "memory": _nonnegative_int(payload.get("memory")),
        "total_connections": len(source),
        "truncated": len(source) > limit,
        "connections": rows,
    }


__all__ = [
    "MAX_CONNECTION_ROWS",
    "MAX_DELAY_RESULTS",
    "MAX_GROUPS",
    "MAX_GROUP_NODES",
    "MIHOMO_CLASH_CAPABILITY_KEYS",
    "MIHOMO_CLASH_SCHEMA_VERSION",
    "build_mihomo_clash_connections_dto",
    "build_mihomo_clash_delay_dto",
    "build_mihomo_clash_proxy_groups_dto",
    "build_mihomo_clash_status_dto",
]
