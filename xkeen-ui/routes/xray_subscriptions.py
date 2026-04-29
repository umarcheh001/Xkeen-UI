"""API routes for Xray subscription-managed outbounds."""

from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response, exception_response
from services.xray_subscriptions import (
    delete_subscription,
    list_subscription_routing_balancers,
    list_subscriptions,
    preview_subscription,
    probe_subscription_node_latency,
    probe_subscription_nodes_latency,
    refresh_due_subscriptions,
    refresh_subscription,
    upsert_subscription,
)


def create_xray_subscriptions_blueprint(
    *,
    ui_state_dir: str,
    xray_configs_dir: str,
    restart_xkeen: Callable[..., Any],
    snapshot_xray_config_before_overwrite: Callable[[str], None],
) -> Blueprint:
    bp = Blueprint("xray_subscriptions", __name__)

    def _bool_arg(name: str, default: bool) -> bool:
        raw = request.args.get(name)
        if raw is None:
            return bool(default)
        try:
            return str(raw or "").strip().lower() in {"1", "true", "yes", "on", "y"}
        except Exception:
            return bool(default)

    @bp.get("/api/xray/subscriptions")
    def api_list_xray_subscriptions():
        try:
            return (
                jsonify(
                    {
                        "ok": True,
                        "subscriptions": list_subscriptions(ui_state_dir),
                        "routing_balancers": list_subscription_routing_balancers(xray_configs_dir),
                    }
                ),
                200,
            )
        except Exception as exc:
            return exception_response(
                "Не удалось прочитать список подписок Xray.",
                500,
                ok=False,
                code="subscription_list_failed",
                hint="Подробности смотрите в server logs.",
                exc=exc,
                log_tag="xray_subscriptions.list_failed",
            )

    @bp.post("/api/xray/subscriptions")
    def api_upsert_xray_subscription():
        payload = request.get_json(silent=True) or {}
        try:
            sub = upsert_subscription(ui_state_dir, payload)
        except ValueError as exc:
            return error_response(str(exc), 400, ok=False)
        except Exception as exc:
            return exception_response(
                "Не удалось сохранить подписку Xray.",
                500,
                ok=False,
                code="subscription_save_failed",
                hint="Подробности смотрите в server logs.",
                exc=exc,
                log_tag="xray_subscriptions.save_failed",
            )
        return jsonify({"ok": True, "subscription": sub}), 200

    @bp.post("/api/xray/subscriptions/preview")
    def api_preview_xray_subscription():
        payload = request.get_json(silent=True) or {}
        try:
            result = preview_subscription(payload)
        except ValueError as exc:
            return error_response(str(exc), 400, ok=False)
        except Exception as exc:
            return exception_response(
                "Не удалось получить предпросмотр подписки Xray.",
                500,
                ok=False,
                code="subscription_preview_failed",
                hint="Проверьте URL подписки и фильтры.",
                exc=exc,
                log_tag="xray_subscriptions.preview_failed",
            )
        return jsonify(result), 200

    @bp.delete("/api/xray/subscriptions/<string:sub_id>")
    def api_delete_xray_subscription(sub_id: str):
        restart = _bool_arg("restart", True)
        remove_file = _bool_arg("remove_file", True)
        try:
            result = delete_subscription(
                ui_state_dir,
                sub_id,
                xray_configs_dir=xray_configs_dir,
                snapshot=snapshot_xray_config_before_overwrite,
                remove_file=remove_file,
                restart_xkeen=restart_xkeen if restart else None,
            )
        except KeyError:
            return error_response("subscription not found", 404, ok=False)
        except Exception as exc:
            return exception_response(
                "Не удалось удалить подписку Xray.",
                500,
                ok=False,
                code="subscription_delete_failed",
                hint="Подробности смотрите в server logs.",
                exc=exc,
                log_tag="xray_subscriptions.delete_failed",
            )
        return jsonify({"ok": True, **result}), 200

    @bp.post("/api/xray/subscriptions/<string:sub_id>/refresh")
    def api_refresh_xray_subscription(sub_id: str):
        restart = _bool_arg("restart", True)
        try:
            result = refresh_subscription(
                ui_state_dir,
                sub_id,
                xray_configs_dir=xray_configs_dir,
                snapshot=snapshot_xray_config_before_overwrite,
                restart_xkeen=restart_xkeen,
                restart=restart,
            )
        except KeyError:
            return error_response("subscription not found", 404, ok=False)
        except Exception as exc:
            return exception_response(
                "Не удалось обновить подписку Xray.",
                500,
                ok=False,
                code="subscription_refresh_failed",
                hint="Подробности смотрите в server logs.",
                exc=exc,
                log_tag="xray_subscriptions.refresh_failed",
            )
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @bp.post("/api/xray/subscriptions/<string:sub_id>/nodes/ping")
    def api_probe_xray_subscription_node(sub_id: str):
        payload = request.get_json(silent=True) or {}
        node_key = str(
            payload.get("node_key")
            or payload.get("nodeKey")
            or payload.get("key")
            or ""
        ).strip()
        timeout_raw = payload.get("timeout_s", payload.get("timeoutSec", payload.get("timeout")))
        try:
            timeout_s = float(timeout_raw) if timeout_raw is not None and str(timeout_raw).strip() != "" else 8.0
        except Exception:
            timeout_s = 8.0
        try:
            result = probe_subscription_node_latency(
                ui_state_dir,
                sub_id,
                node_key,
                xray_configs_dir=xray_configs_dir,
                timeout_s=timeout_s,
            )
        except KeyError as exc:
            msg = str(exc)
            if "subscription" in msg:
                return error_response("subscription not found", 404, ok=False)
            return error_response("node not found", 404, ok=False)
        except ValueError as exc:
            return error_response(str(exc), 400, ok=False)
        except Exception as exc:
            return exception_response(
                "Не удалось проверить задержку узла подписки.",
                500,
                ok=False,
                code="subscription_node_ping_failed",
                hint="Подробности смотрите в server logs.",
                exc=exc,
                log_tag="xray_subscriptions.node_ping_failed",
            )
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @bp.post("/api/xray/subscriptions/<string:sub_id>/nodes/ping-bulk")
    def api_probe_xray_subscription_nodes(sub_id: str):
        payload = request.get_json(silent=True) or {}
        node_keys = payload.get("node_keys", payload.get("nodeKeys", payload.get("keys")))
        timeout_raw = payload.get("timeout_s", payload.get("timeoutSec", payload.get("timeout")))
        try:
            timeout_s = float(timeout_raw) if timeout_raw is not None and str(timeout_raw).strip() != "" else 8.0
        except Exception:
            timeout_s = 8.0
        try:
            result = probe_subscription_nodes_latency(
                ui_state_dir,
                sub_id,
                node_keys,
                xray_configs_dir=xray_configs_dir,
                timeout_s=timeout_s,
            )
        except KeyError:
            return error_response("subscription not found", 404, ok=False)
        except ValueError as exc:
            return error_response(str(exc), 400, ok=False)
        except Exception as exc:
            return exception_response(
                "Не удалось проверить задержку узлов подписки.",
                500,
                ok=False,
                code="subscription_nodes_ping_failed",
                hint="Подробности смотрите в server logs.",
                exc=exc,
                log_tag="xray_subscriptions.nodes_ping_failed",
            )
        return jsonify(result), 200

    @bp.post("/api/xray/subscriptions/refresh-due")
    def api_refresh_due_xray_subscriptions():
        restart = _bool_arg("restart", True)
        try:
            results = refresh_due_subscriptions(
                ui_state_dir,
                xray_configs_dir=xray_configs_dir,
                snapshot=snapshot_xray_config_before_overwrite,
                restart_xkeen=restart_xkeen,
                restart=restart,
            )
        except Exception as exc:
            return exception_response(
                "Не удалось обновить подписки Xray.",
                500,
                ok=False,
                code="subscription_refresh_due_failed",
                hint="Подробности смотрите в server logs.",
                exc=exc,
                log_tag="xray_subscriptions.refresh_due_failed",
            )
        ok_count = sum(1 for item in results if item.get("ok"))
        return jsonify({"ok": True, "updated": len(results), "ok_count": ok_count, "results": results}), 200

    return bp
