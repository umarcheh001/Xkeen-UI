"""Versioned, allow-list based DTO normalizers for the Mihomo Clash API.

Raw Mihomo responses must not become the public Xkeen UI contract.  These
helpers keep only the fields needed by the operator workspace and tolerate
optional fields across Mihomo versions.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from services.mihomo_clash_target import MihomoClashDiscovery
from services.xray_device_names import normalize_ip


MIHOMO_CLASH_SCHEMA_VERSION = 1
MAX_GROUPS = 256
MAX_GROUP_NODES = 1024
MAX_CONNECTION_ROWS = 250
MAX_DELAY_RESULTS = 1024
MAX_RULES = 4096
MAX_PROVIDERS = 512
MAX_LOG_FIELDS = 32
MAX_LOG_DEVICES = 8
MIHOMO_CLASH_CAPABILITY_KEYS = (
    "status",
    "proxy_groups",
    "proxy_select",
    "proxy_delay",
    "connections_snapshot",
    "connections_stream",
    "connection_disconnect",
    "rules",
    "providers",
    "provider_update",
    "provider_healthcheck",
    "logs",
    "logs_stream",
)

_SENSITIVE_LOG_KEY = re.compile(
    r"(?:authorization|cookie|password|passwd|secret|token|credential|api[-_]?key)",
    re.IGNORECASE,
)
_SENSITIVE_LOG_VALUE = re.compile(
    r"(?i)\b(Bearer\s+)[^\s,;]+|\b(secret|token|password|authorization|cookie)\s*([=:])\s*[^\s,;]+"
)
_LOG_IPV4_CANDIDATE = re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?")
_LOG_BRACKETED_IPV6_CANDIDATE = re.compile(r"\[[0-9a-fA-F:%]+\](?::\d{1,5})?")
_LOG_BARE_IPV6_CANDIDATE = re.compile(r"(?<![\w:])[0-9a-fA-F]*:[0-9a-fA-F:]+(?:%[\w.-]+)?(?![\w:])")


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


def _optional_nonnegative_int(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return max(0, number)


def _mapping_value_casefold(mapping: Mapping[str, Any], *keys: str) -> Any:
    """Read one allow-listed key while tolerating Mihomo's casing changes."""

    wanted = {str(key).casefold() for key in keys}
    for key, value in mapping.items():
        if str(key).casefold() in wanted:
            return value
    return None


def _provider_subscription_dto(raw: Mapping[str, Any]) -> dict[str, int] | None:
    """Normalize quota metadata without forwarding provider source details."""

    info = _mapping(
        raw.get("subscriptionInfo")
        if raw.get("subscriptionInfo") is not None
        else raw.get("subscription-info")
    )
    if not info:
        return None

    explicit_used = _optional_nonnegative_int(
        _mapping_value_casefold(info, "used")
    )
    upload = _optional_nonnegative_int(_mapping_value_casefold(info, "upload"))
    download = _optional_nonnegative_int(_mapping_value_casefold(info, "download"))
    total = _optional_nonnegative_int(_mapping_value_casefold(info, "total"))
    expires_at = _optional_nonnegative_int(
        _mapping_value_casefold(info, "expire", "expires", "expires_at")
    )
    if all(value is None for value in (explicit_used, upload, download, total, expires_at)):
        return None

    # Mihomo normally returns Unix seconds. Tolerate millisecond timestamps
    # from compatible cores while keeping one numeric browser contract.
    normalized_expiry = expires_at or 0
    if normalized_expiry >= 100_000_000_000:
        normalized_expiry //= 1000
    used = explicit_used if explicit_used is not None else (upload or 0) + (download or 0)
    return {
        "used": used,
        "total": total or 0,
        "expires_at": normalized_expiry,
    }


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


def build_mihomo_clash_rules_dto(payload: Any) -> dict[str, Any]:
    """Normalize the ordered read-only rule list without exposing raw fields."""

    raw_rules = _mapping(payload).get("rules")
    candidates = (
        list(raw_rules[: MAX_RULES + 1])
        if isinstance(raw_rules, Sequence) and not isinstance(raw_rules, (str, bytes, bytearray))
        else []
    )
    rules: list[dict[str, Any]] = []
    for index, raw_rule in enumerate(candidates[:MAX_RULES]):
        rule = _mapping(raw_rule)
        rules.append(
            {
                "index": _optional_nonnegative_int(rule.get("index"))
                if rule.get("index") is not None
                else index,
                "type": _text(rule.get("type"), 96),
                "payload": _text(rule.get("payload"), 1024),
                "target": _text(rule.get("proxy") or rule.get("target"), 256),
                "disabled": _optional_bool(
                    _mapping(rule.get("extra")).get("disabled")
                    if _mapping(rule.get("extra")).get("disabled") is not None
                    else rule.get("disabled")
                ),
                "size": _optional_nonnegative_int(rule.get("size")),
            }
        )
    return {
        "schema_version": MIHOMO_CLASH_SCHEMA_VERSION,
        "rules": rules,
        "total_rules": len(raw_rules) if isinstance(raw_rules, Sequence) and not isinstance(raw_rules, (str, bytes, bytearray)) else 0,
        "truncated": len(candidates) > MAX_RULES,
    }


def _provider_dto(name: str, raw: Mapping[str, Any], *, kind: str) -> dict[str, Any]:
    proxies = raw.get("proxies")
    proxy_items = (
        list(proxies[:MAX_GROUP_NODES])
        if isinstance(proxies, Sequence) and not isinstance(proxies, (str, bytes, bytearray))
        else []
    )
    alive_values = [
        item.get("alive")
        for item in (_mapping(candidate) for candidate in proxy_items)
        if isinstance(item.get("alive"), bool)
    ]
    count = len(proxy_items) if kind == "proxy" else _optional_nonnegative_int(
        raw.get("ruleCount") if raw.get("ruleCount") is not None else raw.get("size")
    )
    health = _mapping(raw.get("healthCheck"))
    health_enabled = _optional_bool(health.get("enable"))
    return {
        "name": _text(raw.get("name") or name, 256),
        "kind": kind,
        "type": _text(raw.get("type"), 64),
        "vehicle_type": _text(raw.get("vehicleType"), 64),
        "updated_at": _text(raw.get("updatedAt"), 96),
        "count": count if count is not None else 0,
        "alive": sum(value is True for value in alive_values) if kind == "proxy" else None,
        "failed": sum(value is False for value in alive_values) if kind == "proxy" else None,
        "behavior": _text(raw.get("behavior"), 64),
        "format": _text(raw.get("format"), 32),
        "healthcheck": health_enabled is True if kind == "proxy" else False,
        "subscription": _provider_subscription_dto(raw) if kind == "proxy" else None,
    }


def build_mihomo_clash_providers_dto(
    proxy_payload: Any,
    rule_payload: Any,
) -> dict[str, Any]:
    """Combine proxy and rule provider state into one bounded product DTO."""

    proxy_raw = _mapping(_mapping(proxy_payload).get("providers"))
    rule_raw = _mapping(_mapping(rule_payload).get("providers"))
    candidates: list[tuple[str, str, Mapping[str, Any]]] = []
    candidates.extend(("proxy", str(name), _mapping(value)) for name, value in proxy_raw.items())
    candidates.extend(("rule", str(name), _mapping(value)) for name, value in rule_raw.items())
    providers = [
        _provider_dto(name, value, kind=kind)
        for kind, name, value in candidates[:MAX_PROVIDERS]
        if _text(value.get("name") or name, 256)
    ]
    return {
        "schema_version": MIHOMO_CLASH_SCHEMA_VERSION,
        "providers": providers,
        "total_providers": len(candidates),
        "truncated": len(candidates) > MAX_PROVIDERS,
    }


def _redact_log_text(value: Any, *, secret: str = "", limit: int = 2048) -> str:
    text = _text(value, limit * 2)
    if secret:
        text = text.replace(str(secret), "[redacted]")

    def replace_sensitive(match: re.Match[str]) -> str:
        if match.group(1):
            return f"{match.group(1)}[redacted]"
        return f"{match.group(2)}{match.group(3)}[redacted]"

    return _SENSITIVE_LOG_VALUE.sub(replace_sensitive, text)[:limit]


def _log_device_aliases(values: Sequence[str], device_map: Mapping[str, Any]) -> list[dict[str, str]]:
    """Return only router-known IPs actually present in this normalized frame."""

    aliases: list[dict[str, str]] = []
    seen: set[str] = set()
    for value in values:
        for pattern in (_LOG_IPV4_CANDIDATE, _LOG_BRACKETED_IPV6_CANDIDATE, _LOG_BARE_IPV6_CANDIDATE):
            for match in pattern.finditer(value):
                ip = normalize_ip(match.group(0))
                if not ip or ip in seen:
                    continue
                name = _device_name(device_map, ip)
                if not name or name == ip:
                    continue
                aliases.append({"ip": ip, "name": name})
                seen.add(ip)
                if len(aliases) >= MAX_LOG_DEVICES:
                    return aliases
    return aliases


def build_mihomo_clash_log_entry_dto(
    payload: Any,
    *,
    sequence: int = 0,
    secret: str = "",
    device_map: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Normalize one structured log frame and redact credential-shaped data."""

    raw = _mapping(payload)
    raw_fields_value = raw.get("fields")
    if isinstance(raw_fields_value, Mapping):
        field_candidates = list(raw_fields_value.items())
    elif isinstance(raw_fields_value, Sequence) and not isinstance(
        raw_fields_value, (str, bytes, bytearray)
    ):
        field_candidates = []
        for candidate in raw_fields_value:
            item = _mapping(candidate)
            key = item.get("key") if item.get("key") is not None else item.get("name")
            if key is not None:
                field_candidates.append((key, item.get("value")))
    else:
        field_candidates = []
    fields: dict[str, str] = {}
    for raw_key, raw_value in field_candidates[:MAX_LOG_FIELDS]:
        key = _text(raw_key, 96)
        if not key or _SENSITIVE_LOG_KEY.search(key):
            continue
        if isinstance(raw_value, (str, int, float)) and not isinstance(raw_value, bool):
            fields[key] = _redact_log_text(raw_value, secret=secret, limit=512)
    level = _text(raw.get("level"), 16).lower()
    if level not in {"debug", "info", "warning", "error"}:
        level = "info"
    message = _redact_log_text(raw.get("message"), secret=secret)
    devices = device_map if isinstance(device_map, Mapping) else {}
    return {
        "sequence": max(0, int(sequence)),
        "time": _text(raw.get("time"), 96),
        "level": level,
        "message": message,
        "fields": fields,
        "devices": _log_device_aliases([message, *fields.values()], devices),
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
        # Mihomo's group endpoint is version-dependent: some versions return a
        # mapping of ``node -> delay``, while newer builds wrap the values in
        # ``{"proxies": [{"name": ..., "delay": ...}]}``. Normalize both
        # shapes before validating bounded named results.
        group_proxies = payload.get("proxies")
        if isinstance(group_proxies, Sequence) and not isinstance(group_proxies, (str, bytes, bytearray)):
            candidates = [
                (item.get("name"), item.get("delay"))
                for raw_item in group_proxies
                if isinstance(raw_item, Mapping)
                for item in [_mapping(raw_item)]
            ]
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
            "remote_destination": _text(metadata.get("remoteDestination"), 512),
            "dns_mode": _text(metadata.get("dnsMode"), 64),
            "inbound_ip": _text(metadata.get("inboundIP"), 64),
            "inbound_port": _text(metadata.get("inboundPort"), 16),
            "inbound_name": _text(metadata.get("inboundName"), 128),
            "inbound_user": _text(metadata.get("inboundUser"), 128),
            "process": _text(metadata.get("process"), 256),
            "process_path": _text(metadata.get("processPath"), 1024),
            "uid": _optional_nonnegative_int(metadata.get("uid")),
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
