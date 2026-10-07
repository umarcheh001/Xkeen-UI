from __future__ import annotations

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response
from services.router_diagnostics import (
    RciUnavailable,
    cached_router_capabilities,
    cached_router_diagnostics,
    channel_check,
    sample_dns_diagnostics,
    sample_router_clients,
    sample_router_lte,
    sample_router_processes,
)
from services.system_resources import sample_system_resources
from services.memory_guard import get_memory_guard_status
from services.router_modem_control import ModemControlError, ModemControlService, validate_modem_id


MODEM_CONTROL_SERVICE = ModemControlService()

_MODEM_CONTROL_STATUS = {
    "invalid_modem_id": 400,
    "modem_not_found": 404,
    "transport_not_matched": 409,
    "qmi_tool_missing": 503,
    "qmi_probe_timeout": 503,
    "qmi_probe_failed": 503,
    "modem_probe_failed": 502,
}

_MODEM_CONTROL_MESSAGES = {
    "invalid_modem_id": "Некорректный идентификатор модема.",
    "modem_not_found": "Модем не найден в текущем состоянии роутера.",
    "transport_not_matched": "Безопасный транспорт управления не найден.",
    "qmi_tool_missing": "QMI-инструмент на роутере недоступен.",
    "qmi_probe_timeout": "Проверка QMI превысила время ожидания.",
    "qmi_probe_failed": "Проверка QMI завершилась ошибкой.",
    "modem_probe_failed": "Проверка управления модемом не выполнена.",
}


def _no_store_json(payload: dict, status: int = 200):
    response = jsonify(dict(payload))
    response.headers["Cache-Control"] = "no-store"
    return response, status


def _modem_control_error(exc: ModemControlError):
    code = str(exc.code)
    if code not in _MODEM_CONTROL_STATUS:
        code = "modem_probe_failed"
    status = _MODEM_CONTROL_STATUS.get(code, 400)
    message = _MODEM_CONTROL_MESSAGES.get(code, "Проверка управления модемом отклонена.")
    response, response_status = error_response(message, status, ok=False, code=code, retryable=status >= 500)
    response.headers["Cache-Control"] = "no-store"
    return response, response_status


def create_system_resources_blueprint() -> Blueprint:
    bp = Blueprint("system_resources", __name__)

    @bp.get("/api/system/resources")
    def api_system_resources():
        try:
            payload = sample_system_resources()
        except (OSError, ValueError):
            return error_response(
                "Мониторинг ресурсов недоступен на этом устройстве.",
                503,
                ok=False,
                code="system_resources_unavailable",
                retryable=True,
            )
        try:
            payload["router"] = cached_router_diagnostics()
        except Exception:  # noqa: BLE001 - optional router telemetry must not hide procfs metrics
            payload["router"] = {
                "schema_version": 1,
                "sampled_at": payload.get("sampled_at"),
                "freshness": {"state": "unavailable", "age_seconds": 0, "stale_after_seconds": 15},
                "rci": {"available": False, "state": "unavailable"},
                "internet": {"available": False},
                "conntrack": {"available": False},
                "interfaces": {"available": False, "count": 0, "items": [], "truncated": False},
            }
        try:
            payload["ui_process"] = get_memory_guard_status()
        except Exception:  # noqa: BLE001 - optional process telemetry
            pass
        payload["ok"] = True
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store"
        return response, 200

    @bp.get("/api/system/processes")
    def api_system_processes():
        try:
            payload = sample_router_processes()
        except RciUnavailable:
            return error_response(
                "Список процессов недоступен через RCI.",
                503,
                ok=False,
                code="router_processes_unavailable",
                retryable=True,
            )
        payload["ok"] = True
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store"
        return response, 200

    @bp.get("/api/system/router/dns-diagnostics")
    def api_router_dns_diagnostics():
        """Read the bounded router log only after an explicit UI request."""

        try:
            payload = sample_dns_diagnostics()
        except Exception:  # noqa: BLE001 - optional on-demand telemetry
            return error_response(
                "Журнал DNS недоступен.",
                503,
                ok=False,
                code="router_dns_diagnostics_unavailable",
                retryable=True,
            )
        payload["ok"] = True
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store"
        return response, 200

    @bp.get("/api/system/router/clients")
    def api_router_clients():
        try:
            payload = sample_router_clients()
        except Exception:  # noqa: BLE001 - optional on-demand telemetry
            return error_response("Список клиентов недоступен через RCI.", 503, ok=False, code="router_clients_unavailable", retryable=True)
        payload["ok"] = True
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store"
        return response, 200

    @bp.get("/api/system/router/capabilities")
    def api_router_capabilities():
        payload = cached_router_capabilities()
        payload["ok"] = True
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store"
        return response, 200

    @bp.get("/api/system/router/lte")
    def api_router_lte():
        try:
            payload = sample_router_lte()
        except Exception:  # noqa: BLE001 - optional modem telemetry
            payload = {"available": False}
        payload["ok"] = True
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store"
        return response, 200

    @bp.post("/api/system/router/lte/<modem_id>/probe")
    def api_router_lte_modem_probe(modem_id: str):
        try:
            validate_modem_id(modem_id)
            return _no_store_json(MODEM_CONTROL_SERVICE.probe(modem_id))
        except ValueError:
            return _modem_control_error(ModemControlError("invalid_modem_id"))
        except ModemControlError as exc:
            return _modem_control_error(exc)

    @bp.get("/api/system/router/channel-check")
    def api_router_channel_check():
        target = request.args.get("target", "1.1.1.1")
        trace = request.args.get("trace", "0").lower() in {"1", "true", "yes"}
        try:
            payload = channel_check(target, include_trace=trace)
        except ValueError:
            return error_response("Некорректный адрес проверки канала.", 400, ok=False, code="invalid_channel_target", retryable=False)
        payload["ok"] = True
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store"
        return response, 200

    return bp
