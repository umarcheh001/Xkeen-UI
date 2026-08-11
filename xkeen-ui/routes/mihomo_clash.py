"""Versioned Xkeen facade for allow-listed local Mihomo Clash operations."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Callable, Mapping

from flask import Blueprint, jsonify, request, session

from routes.common.errors import error_response
from services.mihomo_clash_client import MihomoClashClient, MihomoClashClientError
from services.mihomo_clash_dto import (
    build_mihomo_clash_connections_dto,
    build_mihomo_clash_delay_dto,
    build_mihomo_clash_providers_dto,
    build_mihomo_clash_proxy_groups_dto,
    build_mihomo_clash_rules_dto,
    build_mihomo_clash_status_dto,
)
from services.mihomo_clash_guard import MihomoClashActionGuard, MihomoClashActionRejected
from services.mihomo_rule_provider_inspector import (
    RuleProviderInspectorError,
    inspect_rule_provider,
)
from services.mihomo_clash_devices import get_mihomo_clash_device_map
from services.request_limits import PayloadTooLargeError, read_request_json_limited
from services.mihomo_clash_target import (
    MihomoClashDiscovery,
    discover_mihomo_clash_target,
)

try:
    import yaml as _yaml
except Exception:  # pragma: no cover - optional on very small router builds
    _yaml = None


DiscoveryFactory = Callable[[str, str], MihomoClashDiscovery]
ClientFactory = Callable[[Any], MihomoClashClient]
DeviceMapFactory = Callable[[], Mapping[str, Any]]
MAX_ACTION_BODY_BYTES = 8 * 1024
MAX_ACTION_NAME_CHARS = 256
MAX_AFFECTED_DISCONNECTS = 24
MIHOMO_PROXY_UNFIX_MIN_VERSION = (1, 18, 9)
AUTOMATIC_GROUP_TYPES = {"urltest", "fallback", "smart"}
MAX_PROXY_DETAIL_CONFIG_BYTES = 4 * 1024 * 1024
AuditLogger = Callable[..., Any]
ActionGuard = MihomoClashActionGuard


def _capabilities(
    *,
    status: bool | None,
    proxy_groups: bool | None = None,
    proxy_select: bool | None = None,
    proxy_unfix: bool | None = None,
    proxy_delay: bool | None = None,
    connections_snapshot: bool | None = None,
    connections_stream: bool | None = None,
    connection_disconnect: bool | None = None,
    rules: bool | None = None,
    providers: bool | None = None,
    provider_update: bool | None = None,
    provider_healthcheck: bool | None = None,
    logs: bool | None = None,
    logs_stream: bool | None = None,
) -> dict[str, bool | None]:
    return {
        "status": status,
        "proxy_groups": proxy_groups,
        "proxy_select": proxy_select,
        "proxy_unfix": proxy_unfix,
        "proxy_delay": proxy_delay,
        "connections_snapshot": connections_snapshot,
        "connections_stream": connections_stream,
        "connection_disconnect": connection_disconnect,
        "rules": rules,
        "providers": providers,
        "provider_update": provider_update,
        "provider_healthcheck": provider_healthcheck,
        "logs": logs,
        "logs_stream": logs_stream,
    }


def _ws_runtime_available() -> bool:
    return str(os.environ.get("XKEEN_WS_RUNTIME") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _mihomo_version_tuple(version_payload: Any) -> tuple[int, int, int] | None:
    value = str((version_payload or {}).get("version") if isinstance(version_payload, Mapping) else version_payload or "")
    match = re.search(r"(?<!\d)v?(\d+)\.(\d+)\.(\d+)(?!\d)", value, re.IGNORECASE)
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def _supports_proxy_unfix(version_payload: Any) -> bool:
    version = _mihomo_version_tuple(version_payload)
    return bool(version and version >= MIHOMO_PROXY_UNFIX_MIN_VERSION)


def _affected_connection_ids(payload: Any, group: str) -> tuple[list[str], bool]:
    snapshot = build_mihomo_clash_connections_dto(payload, max_rows=1000)
    matches = [
        str(item.get("id"))
        for item in snapshot.get("connections", [])
        if group in item.get("chains", []) and item.get("id")
    ]
    # If Mihomo returned more than our DTO ceiling, the omitted tail may also
    # contain affected connections. Surface that explicitly instead of
    # implying the optional disconnect was exhaustive.
    truncated = (
        snapshot.get("truncated") is True
        or snapshot.get("total_connections", 0) > 1000
        or len(matches) > MAX_AFFECTED_DISCONNECTS
    )
    return matches[:MAX_AFFECTED_DISCONNECTS], truncated


def _disconnect_captured_connections(client: MihomoClashClient, ids: list[str]) -> tuple[int, int]:
    disconnected = 0
    failed = 0
    for connection_id in ids:
        try:
            client.disconnect_connection(connection_id)
            disconnected += 1
        except Exception:
            failed += 1
    return disconnected, failed


def _security_posture(discovery: MihomoClashDiscovery) -> dict[str, Any]:
    diagnostic_codes = {item.code for item in discovery.diagnostics}
    transport = discovery.target.transport if discovery.target else None
    lan_without_secret = "secret_missing_on_lan_bind" in diagnostic_codes
    setup_required = (
        not discovery.configured
        or "controller_missing" in diagnostic_codes
        or "unix_socket_missing" in diagnostic_codes
    )

    if transport == "unix":
        mode = "unix_socket"
    elif lan_without_secret:
        mode = "tcp_lan_unprotected"
    elif transport == "tcp" and discovery.secret_configured:
        mode = "tcp_authenticated"
    elif transport == "tcp":
        mode = "tcp_loopback"
    else:
        mode = "not_ready"

    return {
        "mode": mode,
        "recommended_transport": "unix",
        "recommended_value": "external-controller-unix: ./mihomo-api.sock",
        "panel_password_reuse": False,
        "migration_required": lan_without_secret,
        "setup_required": setup_required,
    }


def _status_payload(
    discovery: MihomoClashDiscovery,
    *,
    state: str,
    version_payload: Any = None,
    config_payload: Any = None,
    status_capability: bool | None,
    telemetry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = build_mihomo_clash_status_dto(
        discovery,
        version_payload=version_payload,
        config_payload=config_payload,
        capabilities=_capabilities(
            status=status_capability,
            proxy_unfix=_supports_proxy_unfix(version_payload) if status_capability else False,
            connections_snapshot=status_capability,
            connections_stream=_ws_runtime_available() if status_capability else False,
            connection_disconnect=status_capability,
            rules=status_capability,
            providers=status_capability,
            provider_update=status_capability,
            provider_healthcheck=status_capability,
            logs=status_capability,
            logs_stream=_ws_runtime_available() if status_capability else False,
        ),
    )
    payload["ok"] = state == "ready"
    payload["state"] = state
    payload["security"] = _security_posture(discovery)
    if telemetry:
        payload["telemetry"] = telemetry
    return payload


def _safe_client_error(exc: MihomoClashClientError):
    return error_response(
        "Mihomo API не выполнил запрос.",
        exc.status,
        ok=False,
        **exc.public_dict(),
    )


def _proxy_transport_details(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        return {}
    network = str(raw.get("network") or "").strip()
    security = str(raw.get("security") or "").strip()
    tls = raw.get("tls")
    if not security and isinstance(tls, bool) and tls:
        security = "tls"
    if not security and str(tls or "").strip().lower() in {"tls", "true"}:
        security = "tls"
    option_keys = [f"{network}-opts"] if network else []
    option_keys.extend(("ws-opts", "http-opts", "h2-opts", "grpc-opts", "xhttp-opts"))
    options: Mapping[str, Any] = {}
    for key in option_keys:
        candidate = raw.get(key)
        if isinstance(candidate, Mapping):
            options = candidate
            break
    headers = options.get("headers") if isinstance(options.get("headers"), Mapping) else {}
    return {
        "server": raw.get("server"),
        "port": raw.get("port"),
        "network": network,
        "security": security,
        "sni": raw.get("servername") or raw.get("sni") or raw.get("server-name"),
        "host": raw.get("host") or options.get("host") or headers.get("Host") or headers.get("host"),
        "path": raw.get("path") or options.get("path") or options.get("service-name"),
        "flow": raw.get("flow"),
    }


def _yaml_display_scalar(value: Any) -> str:
    text = str(value or "").strip()
    if " #" in text:
        text = text.split(" #", 1)[0].rstrip()
    if len(text) >= 2 and text[:1] == text[-1:] and text[:1] in {"'", '"'}:
        text = text[1:-1]
        if value and str(value).strip().startswith("'"):
            text = text.replace("''", "'")
    return text.strip()


def _fallback_proxy_rows(text: str) -> dict[str, dict[str, Any]]:
    """Extract card-safe scalar fields without requiring PyYAML on routers."""
    rows: dict[str, dict[str, Any]] = {}
    in_proxies = False
    section_indent = -1
    current: dict[str, Any] | None = None
    current_indent = -1
    nested_key = ""
    for raw_line in str(text or "").replace("\r\n", "\n").replace("\r", "\n").splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        if not in_proxies:
            if re.match(r"^\s*proxies\s*:\s*(?:#.*)?$", raw_line):
                in_proxies = True
                section_indent = indent
            continue
        if indent <= section_indent and not stripped.startswith("-"):
            break
        item = re.match(r"^-\s*name\s*:\s*(.+?)\s*$", stripped)
        if item:
            current = {"name": _yaml_display_scalar(item.group(1))}
            current_indent = indent
            nested_key = ""
            if current["name"]:
                rows[current["name"]] = current
            continue
        if current is None or indent <= current_indent:
            continue
        pair = re.match(r"^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$", stripped)
        if not pair:
            continue
        key = pair.group(1).lower()
        value = _yaml_display_scalar(pair.group(2))
        if not value:
            if key.endswith("-opts"):
                nested_key = key
            elif key == "headers" and nested_key.endswith("-opts"):
                nested_key = f"{nested_key}/headers"
            continue
        if key in {"server", "port", "network", "security", "tls", "servername", "sni", "server-name", "flow"}:
            current[key] = value
        elif key in {"path", "service-name"} and "-opts" in nested_key:
            current["path"] = value
        elif key == "host" and "-opts" in nested_key:
            current["host"] = value
    return {name: _proxy_transport_details(row) for name, row in rows.items()}


def _fallback_provider_specs(text: str) -> dict[str, str]:
    specs: dict[str, str] = {}
    in_section = False
    section_indent = -1
    current = ""
    current_indent = -1
    for raw_line in str(text or "").replace("\r\n", "\n").replace("\r", "\n").splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        if not in_section:
            if re.match(r"^\s*proxy-providers\s*:\s*(?:#.*)?$", raw_line):
                in_section = True
                section_indent = indent
            continue
        if indent <= section_indent:
            break
        provider = re.match(r"^([^:#][^:]*)\s*:\s*(?:#.*)?$", stripped)
        if provider and indent > section_indent:
            current = _yaml_display_scalar(provider.group(1))
            current_indent = indent
            specs.setdefault(current, "")
            continue
        path_match = re.match(r"^path\s*:\s*(.+?)\s*$", stripped, re.IGNORECASE)
        if current and indent > current_indent and path_match:
            specs[current] = _yaml_display_scalar(path_match.group(1))
    return specs


def _load_proxy_transport_index(config_file: str, mihomo_root: str) -> dict[str, Any]:
    """Read only display-safe proxy fields from the active config/provider cache."""
    try:
        root_path = Path(mihomo_root).expanduser().resolve(strict=True)
        config_path = Path(config_file).expanduser().resolve(strict=True)
        config_path.relative_to(root_path)
        if config_path.stat().st_size > MAX_PROXY_DETAIL_CONFIG_BYTES:
            return {}
        config_text = config_path.read_text(encoding="utf-8")
        config = _yaml.safe_load(config_text) if _yaml is not None else None
        config = config or {}
    except Exception:
        return {}
    if config and not isinstance(config, Mapping):
        return {}

    local: dict[str, Any] = _fallback_proxy_rows(config_text)
    if isinstance(config, Mapping):
        for raw in config.get("proxies") or []:
            if isinstance(raw, Mapping) and str(raw.get("name") or "").strip():
                local[str(raw.get("name")).strip()] = _proxy_transport_details(raw)

    providers: dict[str, Any] = {}
    configured: Mapping[str, Any] = config.get("proxy-providers") if isinstance(config, Mapping) else {}
    if not isinstance(configured, Mapping):
        configured = {}
    fallback_specs = _fallback_provider_specs(config_text)
    provider_names = list(dict.fromkeys([*configured.keys(), *fallback_specs.keys()]))
    if provider_names:
        for provider_name in provider_names:
            spec = configured.get(provider_name, {})
            if not isinstance(spec, Mapping):
                spec = {}
            provider_name_text = str(provider_name)
            configured_path = str(spec.get("path") or fallback_specs.get(provider_name_text) or "").strip()
            path_candidates = [configured_path] if configured_path else []
            # Mihomo's default HTTP-provider cache location. It is also the
            # path generated by Xkeen, but older/custom configs may omit path.
            path_candidates.extend((
                f"proxy_providers/{provider_name_text}.yaml",
                f"providers/{provider_name_text}.yaml",
            ))
            try:
                provider_path = None
                for raw_path in path_candidates:
                    candidate_path = Path(raw_path).expanduser()
                    if not candidate_path.is_absolute():
                        candidate_path = root_path / candidate_path
                    try:
                        candidate_path = candidate_path.resolve(strict=True)
                        candidate_path.relative_to(root_path)
                        provider_path = candidate_path
                        break
                    except (OSError, ValueError):
                        continue
                if provider_path is None:
                    continue
                provider_path.relative_to(root_path)
                if provider_path.stat().st_size > MAX_PROXY_DETAIL_CONFIG_BYTES:
                    continue
                provider_text = provider_path.read_text(encoding="utf-8")
                provider_rows = _fallback_proxy_rows(provider_text)
                if _yaml is not None:
                    content = _yaml.safe_load(provider_text) or {}
                    rows = content.get("proxies") if isinstance(content, Mapping) else None
                    if isinstance(rows, list):
                        provider_rows.update({
                            str(raw.get("name")).strip(): _proxy_transport_details(raw)
                            for raw in rows
                            if isinstance(raw, Mapping) and str(raw.get("name") or "").strip()
                        })
                if provider_rows:
                    providers[provider_name_text] = provider_rows
            except Exception:
                continue
    return {"local": local, "providers": providers}


def _read_action_body() -> Mapping[str, Any] | None:
    if not request.is_json:
        return None
    try:
        body = read_request_json_limited(
            request,
            max_bytes=MAX_ACTION_BODY_BYTES,
            default=None,
        )
    except PayloadTooLargeError:
        raise
    return body if isinstance(body, Mapping) else None


def _action_name(body: Mapping[str, Any], field: str) -> str | None:
    value = body.get(field)
    if not isinstance(value, str):
        return None
    name = value.strip()
    if not name or len(name) > MAX_ACTION_NAME_CHARS or any(ord(char) < 32 for char in name):
        return None
    return name


def _guard_rejected(rejected: MihomoClashActionRejected):
    response = error_response(
        "Операция Mihomo временно ограничена.",
        429,
        ok=False,
        code=rejected.code,
        retryable=True,
        retry_after_seconds=rejected.retry_after_seconds,
    )
    try:
        response[0].headers["Retry-After"] = str(rejected.retry_after_seconds)
    except Exception:
        pass
    return response


def create_mihomo_clash_blueprint(
    *,
    mihomo_config_file: str,
    mihomo_root: str | None = None,
    discovery_factory: DiscoveryFactory = discover_mihomo_clash_target,
    client_factory: ClientFactory = MihomoClashClient,
    audit_logger: AuditLogger | None = None,
    action_guard: ActionGuard | None = None,
    device_map_factory: DeviceMapFactory = get_mihomo_clash_device_map,
) -> Blueprint:
    bp = Blueprint("mihomo_clash", __name__)
    root = str(mihomo_root or Path(mihomo_config_file).parent)
    guard = action_guard or MihomoClashActionGuard()

    def _client_or_response():
        discovery = discovery_factory(mihomo_config_file, root)
        if discovery.target is None:
            return None, error_response(
                "Mihomo controller не настроен или заблокирован.",
                503,
                ok=False,
                code="mihomo_clash_target_unavailable",
                retryable=False,
            )
        return client_factory(discovery.target), None

    def _audit_action(action: str, ok: bool, **metadata: Any) -> None:
        if audit_logger is None:
            return
        safe_metadata = {
            key: value
            for key, value in metadata.items()
            if key in {"group", "scope", "preset", "provider_kind", "error_code"}
            and isinstance(value, (str, int, bool))
        }
        try:
            audit_logger(
                bool(ok),
                source="mihomo-clash",
                action=str(action or "unknown")[:48],
                **safe_metadata,
            )
        except TypeError:
            try:
                audit_logger(bool(ok), source="mihomo-clash")
            except Exception:
                pass
        except Exception:
            pass

    def _acquire_action(action: str):
        subject = str(session.get("user") or "authenticated")
        lease, rejected = guard.try_acquire(action, subject)
        if rejected is not None:
            return None, _guard_rejected(rejected)
        return lease, None

    @bp.get("/api/mihomo/clash/status")
    def api_mihomo_clash_status():
        discovery = discovery_factory(mihomo_config_file, root)
        if discovery.target is None:
            state = "controller_missing"
            codes = {item.code for item in discovery.diagnostics}
            if codes & {"config_missing", "mihomo_root_missing"}:
                state = "not_configured"
            elif "port_not_allowed" in codes:
                state = "blocked"
            return jsonify(
                _status_payload(
                    discovery,
                    state=state,
                    status_capability=False,
                )
            ), 200

        client = client_factory(discovery.target)
        try:
            version = client.request_json("version")
            configs = client.request_json("configs")
        except MihomoClashClientError as exc:
            state = "error"
            if exc.code == "api_unauthorized":
                state = "unauthorized"
            elif exc.code in {"upstream_timeout", "upstream_unreachable"}:
                state = "core_stopped"
            payload = _status_payload(
                discovery,
                state=state,
                status_capability=False,
            )
            payload["error"] = {
                "code": exc.code,
                "retryable": exc.retryable,
            }
            return jsonify(payload), 200
        except Exception:
            return error_response(
                "Не удалось получить состояние Mihomo API.",
                500,
                ok=False,
                code="mihomo_clash_status_failed",
            )

        return jsonify(
            _status_payload(
                discovery,
                state="ready",
                version_payload=version.payload,
                config_payload=configs.payload,
                status_capability=True,
                telemetry={
                    "version": {
                        "elapsed_ms": version.elapsed_ms,
                        "size_bytes": version.size_bytes,
                    },
                    "configs": {
                        "elapsed_ms": configs.elapsed_ms,
                        "size_bytes": configs.size_bytes,
                    },
                },
            )
        ), 200

    @bp.get("/api/mihomo/clash/proxy-groups")
    def api_mihomo_clash_proxy_groups():
        client, unavailable = _client_or_response()
        if unavailable:
            return unavailable
        try:
            proxies = client.request_json("proxies")
            providers = client.request_json("providers_proxies")
        except MihomoClashClientError as exc:
            return _safe_client_error(exc)
        except Exception:
            return error_response(
                "Не удалось получить группы Mihomo.",
                500,
                ok=False,
                code="mihomo_clash_proxy_groups_failed",
            )

        details = _load_proxy_transport_index(mihomo_config_file, root)
        payload = build_mihomo_clash_proxy_groups_dto(proxies.payload, providers.payload, details)
        payload["ok"] = True
        payload["capabilities"] = _capabilities(
            status=True,
            proxy_groups=True,
            proxy_select=True,
            proxy_delay=True,
        )
        payload["telemetry"] = {
            "proxies": {"elapsed_ms": proxies.elapsed_ms, "size_bytes": proxies.size_bytes},
            "providers": {"elapsed_ms": providers.elapsed_ms, "size_bytes": providers.size_bytes},
        }
        return jsonify(payload), 200

    @bp.get("/api/mihomo/clash/rules")
    def api_mihomo_clash_rules():
        client, unavailable = _client_or_response()
        if unavailable:
            return unavailable
        try:
            result = client.request_json("rules")
        except MihomoClashClientError as exc:
            return _safe_client_error(exc)
        except Exception:
            return error_response(
                "Не удалось получить правила Mihomo.",
                500,
                ok=False,
                code="mihomo_clash_rules_failed",
            )
        payload = build_mihomo_clash_rules_dto(result.payload)
        payload["ok"] = True
        payload["capabilities"] = _capabilities(status=True, rules=True)
        payload["telemetry"] = {
            "elapsed_ms": result.elapsed_ms,
            "size_bytes": result.size_bytes,
        }
        return jsonify(payload), 200

    @bp.get("/api/mihomo/clash/providers")
    def api_mihomo_clash_providers():
        client, unavailable = _client_or_response()
        if unavailable:
            return unavailable
        try:
            proxy_result = client.request_json("providers_proxies")
            rule_result = client.request_json("providers_rules")
        except MihomoClashClientError as exc:
            return _safe_client_error(exc)
        except Exception:
            return error_response(
                "Не удалось получить providers Mihomo.",
                500,
                ok=False,
                code="mihomo_clash_providers_failed",
            )
        payload = build_mihomo_clash_providers_dto(
            proxy_result.payload,
            rule_result.payload,
        )
        payload["ok"] = True
        payload["capabilities"] = _capabilities(
            status=True,
            providers=True,
            provider_update=True,
            provider_healthcheck=True,
        )
        payload["telemetry"] = {
            "proxy": {
                "elapsed_ms": proxy_result.elapsed_ms,
                "size_bytes": proxy_result.size_bytes,
            },
            "rule": {
                "elapsed_ms": rule_result.elapsed_ms,
                "size_bytes": rule_result.size_bytes,
            },
        }
        return jsonify(payload), 200

    @bp.get("/api/mihomo/clash/providers/rule/<path:provider_name>/content")
    def api_mihomo_clash_rule_provider_content(provider_name: str):
        try:
            payload = inspect_rule_provider(
                config_file=mihomo_config_file,
                mihomo_root=root,
                provider_name=provider_name,
                query=request.args.get("q", ""),
                limit=request.args.get("limit", 200),
                offset=request.args.get("offset", 0),
            )
        except RuleProviderInspectorError as exc:
            return error_response(
                exc.message,
                exc.status,
                ok=False,
                code=exc.code,
                retryable=False,
            )
        except Exception:
            return error_response(
                "Не удалось прочитать rule-provider Mihomo.",
                500,
                ok=False,
                code="mihomo_rule_provider_inspection_failed",
                retryable=False,
            )
        return jsonify(payload), 200

    @bp.post("/api/mihomo/clash/providers/<kind>/<path:provider_name>/update")
    def api_mihomo_clash_provider_update(kind: str, provider_name: str):
        provider_kind = str(kind or "").strip().lower()
        provider = str(provider_name or "").strip()
        if (
            provider_kind not in {"proxy", "rule"}
            or not provider
            or len(provider) > MAX_ACTION_NAME_CHARS
            or any(ord(char) < 32 for char in provider)
        ):
            return error_response(
                "Некорректный provider Mihomo.",
                400,
                ok=False,
                code="invalid_provider",
            )
        lease, rejected_response = _acquire_action("provider-update")
        if rejected_response:
            return rejected_response
        client, unavailable = _client_or_response()
        if unavailable:
            lease.release()
            return unavailable
        try:
            current_proxy = client.request_json("providers_proxies")
            current_rule = client.request_json("providers_rules")
            current = build_mihomo_clash_providers_dto(
                current_proxy.payload,
                current_rule.payload,
            )["providers"]
            if not any(item["kind"] == provider_kind and item["name"] == provider for item in current):
                return error_response(
                    "Provider больше не доступен.",
                    409,
                    ok=False,
                    code="provider_not_found",
                )
            client.update_provider(provider_kind, provider)
        except MihomoClashClientError as exc:
            _audit_action(
                "provider-update",
                False,
                provider_kind=provider_kind,
                error_code=exc.code,
            )
            return _safe_client_error(exc)
        except Exception:
            _audit_action(
                "provider-update",
                False,
                provider_kind=provider_kind,
                error_code="internal_error",
            )
            return error_response(
                "Не удалось обновить provider Mihomo.",
                500,
                ok=False,
                code="mihomo_clash_provider_update_failed",
            )
        finally:
            lease.release()
        _audit_action("provider-update", True, provider_kind=provider_kind)
        return jsonify(
            {"ok": True, "schema_version": 1, "updated": True, "kind": provider_kind}
        ), 200

    @bp.post("/api/mihomo/clash/providers/proxy/<path:provider_name>/healthcheck")
    def api_mihomo_clash_provider_healthcheck(provider_name: str):
        provider = str(provider_name or "").strip()
        if (
            not provider
            or len(provider) > MAX_ACTION_NAME_CHARS
            or any(ord(char) < 32 for char in provider)
        ):
            return error_response(
                "Некорректный proxy provider Mihomo.",
                400,
                ok=False,
                code="invalid_provider",
            )
        lease, rejected_response = _acquire_action("provider-healthcheck")
        if rejected_response:
            return rejected_response
        client, unavailable = _client_or_response()
        if unavailable:
            lease.release()
            return unavailable
        try:
            current_proxy = client.request_json("providers_proxies")
            current = build_mihomo_clash_providers_dto(current_proxy.payload, {})["providers"]
            candidate = next(
                (item for item in current if item["kind"] == "proxy" and item["name"] == provider),
                None,
            )
            if not candidate or not candidate["healthcheck"]:
                return error_response(
                    "Healthcheck для provider недоступен.",
                    409,
                    ok=False,
                    code="provider_healthcheck_not_available",
                )
            client.healthcheck_provider(provider)
        except MihomoClashClientError as exc:
            _audit_action("provider-healthcheck", False, error_code=exc.code)
            return _safe_client_error(exc)
        except Exception:
            _audit_action("provider-healthcheck", False, error_code="internal_error")
            return error_response(
                "Не удалось запустить healthcheck provider Mihomo.",
                500,
                ok=False,
                code="mihomo_clash_provider_healthcheck_failed",
            )
        finally:
            lease.release()
        _audit_action("provider-healthcheck", True)
        return jsonify(
            {"ok": True, "schema_version": 1, "healthcheck_started": True}
        ), 200

    @bp.put("/api/mihomo/clash/proxy-groups/<path:group_name>")
    def api_mihomo_clash_proxy_select(group_name: str):
        try:
            body = _read_action_body()
        except PayloadTooLargeError:
            return error_response(
                "Тело запроса слишком большое.",
                413,
                ok=False,
                code="payload_too_large",
            )
        selected = _action_name(body or {}, "name")
        disconnect_affected = (body or {}).get("disconnect_affected") is True
        group = str(group_name or "").strip()
        if not selected or not group or len(group) > MAX_ACTION_NAME_CHARS:
            return error_response(
                "Некорректная группа или узел Mihomo.",
                400,
                ok=False,
                code="invalid_proxy_selection",
            )

        lease, rejected_response = _acquire_action("proxy-select")
        if rejected_response:
            return rejected_response

        client, unavailable = _client_or_response()
        if unavailable:
            lease.release()
            return unavailable
        try:
            before = client.request_json("proxies")
            before_groups = build_mihomo_clash_proxy_groups_dto(before.payload).get("groups", [])
            candidate_group = next(
                (item for item in before_groups if item.get("name") == group),
                None,
            )
            candidate_names = {
                item.get("name")
                for item in (candidate_group or {}).get("nodes", [])
                if isinstance(item, Mapping)
            }
            if (
                not candidate_group
                or not candidate_group.get("selectable")
                or selected not in candidate_names
            ):
                _audit_action(
                    "proxy-select",
                    False,
                    group=group,
                    error_code="selection_not_available",
                )
                return error_response(
                    "Группа или узел больше не доступны для выбора.",
                    409,
                    ok=False,
                    code="proxy_selection_not_available",
                )
            affected_ids: list[str] = []
            affected_truncated = False
            if disconnect_affected:
                connections = client.request_json("connections_snapshot")
                affected_ids, affected_truncated = _affected_connection_ids(connections.payload, group)
            client.select_proxy(group, selected)
            refreshed = client.request_json("proxies")
            disconnected, disconnect_failed = _disconnect_captured_connections(client, affected_ids)
        except MihomoClashClientError as exc:
            _audit_action("proxy-select", False, group=group, error_code=exc.code)
            return _safe_client_error(exc)
        except Exception:
            _audit_action("proxy-select", False, group=group, error_code="internal_error")
            return error_response(
                "Не удалось переключить группу Mihomo.",
                500,
                ok=False,
                code="mihomo_clash_proxy_select_failed",
            )
        finally:
            lease.release()

        groups = build_mihomo_clash_proxy_groups_dto(refreshed.payload).get("groups", [])
        current = next((item for item in groups if item.get("name") == group), None)
        _audit_action("proxy-select", True, group=group)
        return jsonify(
            {
                "ok": True,
                "schema_version": 1,
                "group": current,
                "reconciled": bool(current and current.get("now") == selected),
                "connections": {
                    "requested": disconnect_affected,
                    "matched": len(affected_ids),
                    "disconnected": disconnected,
                    "failed": disconnect_failed,
                    "truncated": affected_truncated,
                },
            }
        ), 200

    @bp.delete("/api/mihomo/clash/proxy-groups/<path:group_name>/fixed")
    def api_mihomo_clash_proxy_unfix(group_name: str):
        try:
            body = _read_action_body() or {}
        except PayloadTooLargeError:
            return error_response("Тело запроса слишком большое.", 413, ok=False, code="payload_too_large")
        group = str(group_name or "").strip()
        disconnect_affected = body.get("disconnect_affected") is True
        if not group or len(group) > MAX_ACTION_NAME_CHARS or any(ord(char) < 32 for char in group):
            return error_response("Некорректная группа Mihomo.", 400, ok=False, code="invalid_proxy_group")

        lease, rejected_response = _acquire_action("proxy-unfix")
        if rejected_response:
            return rejected_response
        client, unavailable = _client_or_response()
        if unavailable:
            lease.release()
            return unavailable
        try:
            version = client.request_json("version")
            if not _supports_proxy_unfix(version.payload):
                return error_response(
                    "Установленная версия Mihomo не поддерживает возврат автоматического выбора.",
                    409,
                    ok=False,
                    code="proxy_unfix_not_supported",
                )
            before = client.request_json("proxies")
            groups_before = build_mihomo_clash_proxy_groups_dto(before.payload).get("groups", [])
            candidate = next((item for item in groups_before if item.get("name") == group), None)
            if (
                not candidate
                or str(candidate.get("type") or "").lower() not in AUTOMATIC_GROUP_TYPES
                or not candidate.get("fixed")
            ):
                return error_response(
                    "Группа больше не зафиксирована или не поддерживает автоматический выбор.",
                    409,
                    ok=False,
                    code="proxy_unfix_not_available",
                )
            affected_ids: list[str] = []
            affected_truncated = False
            if disconnect_affected:
                connections = client.request_json("connections_snapshot")
                affected_ids, affected_truncated = _affected_connection_ids(connections.payload, group)
            client.unfix_proxy(group)
            refreshed = client.request_json("proxies")
            disconnected, disconnect_failed = _disconnect_captured_connections(client, affected_ids)
        except MihomoClashClientError as exc:
            _audit_action("proxy-unfix", False, group=group, error_code=exc.code)
            return _safe_client_error(exc)
        except Exception:
            _audit_action("proxy-unfix", False, group=group, error_code="internal_error")
            return error_response(
                "Не удалось вернуть автоматический выбор Mihomo.",
                500,
                ok=False,
                code="mihomo_clash_proxy_unfix_failed",
            )
        finally:
            lease.release()

        groups_after = build_mihomo_clash_proxy_groups_dto(refreshed.payload).get("groups", [])
        current = next((item for item in groups_after if item.get("name") == group), None)
        _audit_action("proxy-unfix", True, group=group)
        return jsonify({
            "ok": True,
            "schema_version": 1,
            "group": current,
            "reconciled": bool(current and not current.get("fixed")),
            "connections": {
                "requested": disconnect_affected,
                "matched": len(affected_ids),
                "disconnected": disconnected,
                "failed": disconnect_failed,
                "truncated": affected_truncated,
            },
        }), 200

    @bp.post("/api/mihomo/clash/delay")
    def api_mihomo_clash_delay():
        try:
            body = _read_action_body()
        except PayloadTooLargeError:
            return error_response(
                "Тело запроса слишком большое.",
                413,
                ok=False,
                code="payload_too_large",
            )
        body = body or {}
        scope = body.get("scope") if isinstance(body.get("scope"), str) else ""
        name = _action_name(body, "name")
        preset = body.get("preset", "google")
        provider = _action_name(body, "provider") if scope == "provider-proxy" else None
        if (
            not name
            or scope not in {"proxy", "group", "provider-proxy"}
            or not isinstance(preset, str)
            or (scope == "provider-proxy" and not provider)
        ):
            return error_response(
                "Некорректные параметры проверки задержки.",
                400,
                ok=False,
                code="invalid_delay_request",
            )

        lease, rejected_response = _acquire_action("delay")
        if rejected_response:
            return rejected_response

        client, unavailable = _client_or_response()
        if unavailable:
            lease.release()
            return unavailable
        try:
            if scope == "provider-proxy":
                result = client.request_provider_proxy_delay(provider, name, preset=preset)
            else:
                result = client.request_delay(scope, name, preset=preset)
        except MihomoClashClientError as exc:
            _audit_action(
                "delay",
                False,
                scope=scope,
                preset=preset,
                error_code=exc.code,
            )
            return _safe_client_error(exc)
        except Exception:
            _audit_action(
                "delay",
                False,
                scope=scope,
                preset=preset,
                error_code="internal_error",
            )
            return error_response(
                "Не удалось проверить задержку Mihomo.",
                500,
                ok=False,
                code="mihomo_clash_delay_failed",
            )
        finally:
            lease.release()
        payload = build_mihomo_clash_delay_dto(
            result.payload,
            scope=scope,
            name=name,
            preset=preset,
        )
        if not payload["results"]:
            _audit_action(
                "delay",
                False,
                scope=scope,
                preset=preset,
                error_code="upstream_delay_invalid",
            )
            return error_response(
                "Mihomo вернул некорректный результат задержки.",
                502,
                ok=False,
                code="upstream_delay_invalid",
            )
        payload["ok"] = True
        _audit_action("delay", True, scope=scope, preset=preset)
        return jsonify(payload), 200

    @bp.get("/api/mihomo/clash/connections")
    def api_mihomo_clash_connections():
        lease, rejected_response = _acquire_action("connections-snapshot")
        if rejected_response:
            return rejected_response
        client, unavailable = _client_or_response()
        if unavailable:
            lease.release()
            return unavailable
        try:
            snapshot = client.request_json("connections_snapshot")
            memory = client.request_memory()
        except MihomoClashClientError as exc:
            return _safe_client_error(exc)
        except Exception:
            return error_response(
                "Не удалось получить соединения Mihomo.",
                500,
                ok=False,
                code="mihomo_clash_connections_failed",
            )
        finally:
            lease.release()
        payload = build_mihomo_clash_connections_dto(
            snapshot.payload,
            device_map=device_map_factory(),
            memory=memory.payload.get("inuse") if isinstance(memory.payload, dict) else 0,
        )
        payload["ok"] = True
        payload["capabilities"] = _capabilities(
            status=True,
            connections_snapshot=True,
            connections_stream=_ws_runtime_available(),
            connection_disconnect=True,
        )
        payload["fallback"] = {"transport": "http-snapshot", "poll_interval_ms": 2000}
        payload["telemetry"] = {
            "elapsed_ms": snapshot.elapsed_ms,
            "size_bytes": snapshot.size_bytes,
        }
        return jsonify(payload), 200

    @bp.delete("/api/mihomo/clash/connections/<path:connection_id>")
    def api_mihomo_clash_disconnect_connection(connection_id: str):
        connection = str(connection_id or "").strip()
        if not connection or len(connection) > MAX_ACTION_NAME_CHARS:
            return error_response(
                "Некорректный идентификатор соединения Mihomo.",
                400,
                ok=False,
                code="invalid_connection_id",
            )

        lease, rejected_response = _acquire_action("connection-disconnect")
        if rejected_response:
            return rejected_response
        client, unavailable = _client_or_response()
        if unavailable:
            lease.release()
            return unavailable
        try:
            snapshot = client.request_json("connections_snapshot")
            current = build_mihomo_clash_connections_dto(snapshot.payload)
            ids = {row.get("id") for row in current.get("connections", [])}
            if connection not in ids:
                _audit_action(
                    "connection-disconnect",
                    False,
                    error_code="connection_not_found",
                )
                return error_response(
                    "Соединение уже завершено или больше недоступно.",
                    409,
                    ok=False,
                    code="connection_not_found",
                )
            client.disconnect_connection(connection)
        except MihomoClashClientError as exc:
            _audit_action("connection-disconnect", False, error_code=exc.code)
            return _safe_client_error(exc)
        except Exception:
            _audit_action("connection-disconnect", False, error_code="internal_error")
            return error_response(
                "Не удалось завершить соединение Mihomo.",
                500,
                ok=False,
                code="mihomo_clash_disconnect_failed",
            )
        finally:
            lease.release()

        _audit_action("connection-disconnect", True)
        return jsonify({"ok": True, "schema_version": 1, "disconnected": True}), 200

    @bp.delete("/api/mihomo/clash/connections")
    def api_mihomo_clash_disconnect_all():
        try:
            body = _read_action_body()
        except PayloadTooLargeError:
            return error_response(
                "Тело запроса слишком большое.",
                413,
                ok=False,
                code="payload_too_large",
            )
        expected_count = (body or {}).get("count")
        if (
            (body or {}).get("confirm") is not True
            or isinstance(expected_count, bool)
            or not isinstance(expected_count, int)
            or expected_count < 0
            or expected_count > 1_000_000
        ):
            return error_response(
                "Для завершения всех соединений требуется явное подтверждение и их количество.",
                400,
                ok=False,
                code="disconnect_all_confirmation_required",
            )

        lease, rejected_response = _acquire_action("connections-disconnect-all")
        if rejected_response:
            return rejected_response
        client, unavailable = _client_or_response()
        if unavailable:
            lease.release()
            return unavailable
        try:
            snapshot = client.request_json("connections_snapshot")
            actual_count = build_mihomo_clash_connections_dto(snapshot.payload)["total_connections"]
            if actual_count != expected_count:
                _audit_action(
                    "connections-disconnect-all",
                    False,
                    error_code="connection_count_changed",
                )
                return error_response(
                    "Количество соединений изменилось. Обновите список и подтвердите действие снова.",
                    409,
                    ok=False,
                    code="connection_count_changed",
                    current_count=actual_count,
                )
            client.disconnect_all_connections()
        except MihomoClashClientError as exc:
            _audit_action("connections-disconnect-all", False, error_code=exc.code)
            return _safe_client_error(exc)
        except Exception:
            _audit_action("connections-disconnect-all", False, error_code="internal_error")
            return error_response(
                "Не удалось завершить все соединения Mihomo.",
                500,
                ok=False,
                code="mihomo_clash_disconnect_all_failed",
            )
        finally:
            lease.release()

        _audit_action("connections-disconnect-all", True)
        return jsonify(
            {
                "ok": True,
                "schema_version": 1,
                "disconnected": True,
                "count": actual_count,
            }
        ), 200

    return bp


__all__ = ["create_mihomo_clash_blueprint"]
