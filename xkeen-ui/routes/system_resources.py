from __future__ import annotations

import math

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response
from services.router_diagnostics import (
    RciUnavailable,
    apply_router_resource_telemetry,
    cached_router_capabilities,
    cached_router_diagnostics,
    cached_router_system,
    channel_check,
    sample_dns_diagnostics,
    sample_router_clients,
    sample_router_lte,
    sample_router_processes,
)
from services.system_resources import sample_storage, sample_system_resources
from services.system_resources_history.collector import get_collector
from services.system_resources_history.store import RANGES
from services.system_resources_history.zones import header_zones, zone as zone_of
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


HISTORY_RANGES = frozenset(RANGES)


def _tariff_or_none(tariff: dict) -> dict | None:
    return tariff if any(v is not None for v in tariff.values()) else None


def _history_unavailable():
    response, status = error_response(
        "История загрузки ещё не собрана: сборщик не запущен.",
        503,
        ok=False,
        code="history_unavailable",
        retryable=True,
    )
    response.headers["Cache-Control"] = "no-store"
    return response, status


def _router_fallback(sampled_at) -> dict:
    return {
        "schema_version": 1,
        "sampled_at": sampled_at,
        "freshness": {"state": "unavailable", "age_seconds": 0, "stale_after_seconds": 15},
        "rci": {"available": False, "state": "unavailable"},
        "internet": {"available": False},
        "conntrack": {"available": False},
        "interfaces": {"available": False, "count": 0, "items": [], "truncated": False},
    }


def _modem_control_error(exc: ModemControlError):
    code = str(exc.code)
    if code not in _MODEM_CONTROL_STATUS:
        code = "modem_probe_failed"
    status = _MODEM_CONTROL_STATUS.get(code, 400)
    message = _MODEM_CONTROL_MESSAGES.get(code, "Проверка управления модемом отклонена.")
    response, response_status = error_response(message, status, ok=False, code=code, retryable=status >= 500)
    response.headers["Cache-Control"] = "no-store"
    return response, response_status


def create_system_resources_blueprint(*, include_summary: bool = True) -> Blueprint:
    bp = Blueprint("system_resources", __name__)

    if include_summary:
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
                payload["router"] = _router_fallback(payload.get("sampled_at"))
            apply_router_resource_telemetry(payload, system_reader=cached_router_system)
            try:
                payload["ui_process"] = get_memory_guard_status()
            except Exception:  # noqa: BLE001 - optional process telemetry
                pass
            payload["zones"] = header_zones(
                (payload.get("cpu") or {}).get("percent"), (payload.get("memory") or {}).get("percent")
            )
            payload["ok"] = True
            response = jsonify(payload)
            response.headers["Cache-Control"] = "no-store"
            return response, 200

    @bp.get("/api/system/history")
    def api_system_history():
        range_id = request.args.get("range", "")
        if range_id not in HISTORY_RANGES:
            response, status = error_response(
                "Неизвестный интервал истории.", 400, ok=False, code="bad_range", retryable=False
            )
            response.headers["Cache-Control"] = "no-store"
            return response, status
        collector = get_collector()
        if collector is None:
            return _history_unavailable()
        data = collector.history(range_id)
        zones = data.get("zones", {})
        metrics = {}
        for name, columns in data["metrics"].items():
            entry = {"avg": columns["avg"], "max": columns["max"]}
            if name in zones:
                entry["zone"] = zones[name]["avg"]
                entry["peak_zone"] = zones[name]["max"]
            metrics[name] = entry
        links = [dict(link, tariff=_tariff_or_none(link["tariff"])) for link in data["links"]]
        return _no_store_json(
            {
                "ok": True,
                "range": range_id,
                "step_s": data["step_s"],
                "start": data["start"],
                "history_since": data["history_since"],
                "cores": data["cores"],
                "bands": data["bands"],
                "metrics": metrics,
                "links": links,
                "top": data.get("top") or [],
            }
        )

    @bp.get("/api/system/hardware")
    def api_system_hardware():
        collector = get_collector()
        if collector is None:
            return _history_unavailable()
        hardware = collector.hardware()
        storage = sample_storage()
        if storage is not None:
            storage = dict(storage, zone=zone_of("storage", storage.get("percent")))
        temperatures = []
        for group in hardware["temperatures"]:
            group = dict(group)
            group["hotter_by"] = group.pop("hotter_by_c")
            temperatures.append(group)
        return _no_store_json(
            {
                "ok": True,
                "identity": hardware["identity"],
                "cores": hardware["cores"],
                "temperatures": temperatures,
                "throttle": hardware["throttle"],
                "memory": hardware["memory"],
                "zram": hardware["zram"],
                "storage": storage,
                "conntrack": hardware["conntrack"],
                "ports": hardware["ports"],
                "slow_ports": hardware["slow_ports"],
            }
        )

    @bp.get("/api/system/events")
    def api_system_events():
        collector = get_collector()
        if collector is None:
            return _history_unavailable()
        try:
            since = float(request.args.get("since", 0))
        except (TypeError, ValueError):
            since = 0.0
        if not math.isfinite(since):
            since = 0.0
        return _no_store_json(
            {"ok": True, "events": collector.events(since), "active": collector.active_events()}
        )

    @bp.get("/api/system/summary")
    def api_system_summary():
        collector = get_collector()
        if collector is None:
            return _history_unavailable()
        payload = collector.snapshot()
        try:
            payload["router"] = cached_router_diagnostics()
        except Exception:  # noqa: BLE001 - the chain is optional; the history summary stays
            payload["router"] = _router_fallback(payload.get("ts"))
        payload["ok"] = True
        return _no_store_json(payload)

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
