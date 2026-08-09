"""Versioned Xkeen facade for allow-listed local Mihomo Clash operations."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Mapping

from flask import Blueprint, jsonify, request, session

from routes.common.errors import error_response
from services.mihomo_clash_client import MihomoClashClient, MihomoClashClientError
from services.mihomo_clash_dto import (
    build_mihomo_clash_connections_dto,
    build_mihomo_clash_delay_dto,
    build_mihomo_clash_proxy_groups_dto,
    build_mihomo_clash_status_dto,
)
from services.mihomo_clash_guard import MihomoClashActionGuard, MihomoClashActionRejected
from services.request_limits import PayloadTooLargeError, read_request_json_limited
from services.mihomo_clash_target import (
    MihomoClashDiscovery,
    discover_mihomo_clash_target,
)


DiscoveryFactory = Callable[[str, str], MihomoClashDiscovery]
ClientFactory = Callable[[Any], MihomoClashClient]
MAX_ACTION_BODY_BYTES = 8 * 1024
MAX_ACTION_NAME_CHARS = 256
AuditLogger = Callable[..., Any]
ActionGuard = MihomoClashActionGuard


def _capabilities(
    *,
    status: bool | None,
    proxy_groups: bool | None = None,
    proxy_select: bool | None = None,
    proxy_delay: bool | None = None,
    connections_snapshot: bool | None = None,
) -> dict[str, bool | None]:
    return {
        "status": status,
        "proxy_groups": proxy_groups,
        "proxy_select": proxy_select,
        "proxy_delay": proxy_delay,
        "connections_snapshot": connections_snapshot,
        "connections_stream": None,
        "connection_disconnect": None,
    }


def _security_posture(discovery: MihomoClashDiscovery) -> dict[str, Any]:
    diagnostic_codes = {item.code for item in discovery.diagnostics}
    transport = discovery.target.transport if discovery.target else None
    lan_without_secret = "secret_missing_on_lan_bind" in diagnostic_codes

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
        "panel_password_reuse": False,
        "migration_required": lan_without_secret,
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
        capabilities=_capabilities(status=status_capability),
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
            if key in {"group", "scope", "preset", "error_code"}
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

        payload = build_mihomo_clash_proxy_groups_dto(proxies.payload, providers.payload)
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
            client.select_proxy(group, selected)
            refreshed = client.request_json("proxies")
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
            }
        ), 200

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
        client, unavailable = _client_or_response()
        if unavailable:
            return unavailable
        try:
            snapshot = client.request_json("connections_snapshot")
        except MihomoClashClientError as exc:
            return _safe_client_error(exc)
        except Exception:
            return error_response(
                "Не удалось получить соединения Mihomo.",
                500,
                ok=False,
                code="mihomo_clash_connections_failed",
            )
        payload = build_mihomo_clash_connections_dto(snapshot.payload)
        payload["ok"] = True
        payload["capabilities"] = _capabilities(
            status=True,
            connections_snapshot=True,
        )
        payload["telemetry"] = {
            "elapsed_ms": snapshot.elapsed_ms,
            "size_bytes": snapshot.size_bytes,
        }
        return jsonify(payload), 200

    return bp


__all__ = ["create_mihomo_clash_blueprint"]
