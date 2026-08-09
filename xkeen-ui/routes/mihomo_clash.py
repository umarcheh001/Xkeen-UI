"""Read-only Xkeen facade for the local Mihomo Clash API status."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from flask import Blueprint, jsonify

from routes.common.errors import error_response
from services.mihomo_clash_client import MihomoClashClient, MihomoClashClientError
from services.mihomo_clash_dto import build_mihomo_clash_status_dto
from services.mihomo_clash_target import (
    MihomoClashDiscovery,
    discover_mihomo_clash_target,
)


DiscoveryFactory = Callable[[str, str], MihomoClashDiscovery]
ClientFactory = Callable[[Any], MihomoClashClient]


def _capabilities(*, status: bool | None) -> dict[str, bool | None]:
    """Status only probes operations needed for the current read-only facade."""

    return {
        "status": status,
        "proxy_groups": None,
        "proxy_select": None,
        "proxy_delay": None,
        "connections_snapshot": None,
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


def create_mihomo_clash_blueprint(
    *,
    mihomo_config_file: str,
    mihomo_root: str | None = None,
    discovery_factory: DiscoveryFactory = discover_mihomo_clash_target,
    client_factory: ClientFactory = MihomoClashClient,
) -> Blueprint:
    bp = Blueprint("mihomo_clash", __name__)
    root = str(mihomo_root or Path(mihomo_config_file).parent)

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

    return bp


__all__ = ["create_mihomo_clash_blueprint"]
