"""Service-control API routes for xkeen as a Flask Blueprint."""
from __future__ import annotations
import os
import subprocess

from flask import Blueprint, request, jsonify
from typing import Any, Callable, Dict, Optional



def error_response(message: str, status: int = 400, *, ok: bool | None = None) -> Any:
    """Return a JSON error response for this blueprint.

    Mirrors ``app.api_error`` format: at least ``{"error": ...}``,
    optionally with ``"ok": False`` when ``ok`` is explicitly passed.
    """
    payload: Dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    return jsonify(payload), status

from services.cores import get_cores_status, switch_core


def create_service_blueprint(
    restart_xkeen: Callable[..., bool],
    append_restart_log: Callable[[str, bool, str], None] | Callable[..., None],
    XRAY_ERROR_LOG: str,
    broadcast_event: Callable[[dict], None] | None = None,
) -> Blueprint:
    """Create blueprint with xkeen service-control endpoints."""
    bp = Blueprint("service", __name__)

    # Локальный шорткат: безопасно вызываем broadcast_event, даже если он не передан.
    def _emit_event(event: dict) -> None:
        if broadcast_event is None:
            return
        try:
            broadcast_event(event)
        except Exception as e:  # noqa: BLE001
            # Ошибки в канале событий не должны ломать API.
            try:
                # Логируем через стандартный stderr, Flask сам подхватит.
                print(f"[broadcast_event error] {e}")
            except Exception:
                pass

    @bp.post("/api/xkeen/start")
    def api_xkeen_start() -> Any:
        try:
            subprocess.check_call(["xkeen", "-start"])
            append_restart_log(True, source="api-start")
            return jsonify({"ok": True}), 200
        except Exception:
            append_restart_log(False, source="api-start")
            return jsonify({"ok": False}), 500


    @bp.post("/api/xkeen/stop")
    def api_xkeen_stop() -> Any:
        try:
            subprocess.check_call(["xkeen", "-stop"])
            append_restart_log(True, source="api-stop")
            return jsonify({"ok": True}), 200
        except Exception:
            append_restart_log(False, source="api-stop")
            return jsonify({"ok": False}), 500


    @bp.get("/api/xkeen/status")
    def api_xkeen_status() -> Any:
        """
        Возвращает статус работы сервиса xkeen и информацию
        о запущенном ядре (xray / mihomo), если оно обнаружено.
        """
        try:
            running = False
            running_core = None

            # Проверяем, запущено ли одно из известных ядер
            for core_name in ("xray", "mihomo"):
                try:
                    res = subprocess.run(
                        ["pidof", core_name],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                    )
                    if res.returncode == 0:
                        running = True
                        running_core = core_name
                        break
                except FileNotFoundError:
                    # pidof или бинарник могут отсутствовать — просто пропускаем
                    continue

            status = "running" if running else "stopped"

            return jsonify(
                {
                    "ok": True,
                    "running": running,
                    "status": status,
                    "core": running_core,
                }
            ), 200
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500


    @bp.get("/api/xkeen/core")
    def api_xkeen_core_get() -> Any:
        """Список доступных ядер и текущее ядро xkeen (через сервисный модуль)."""
        try:
            cores, current_core = get_cores_status()
            return jsonify(
                {
                    "ok": True,
                    "cores": cores,
                    "currentCore": current_core,
                }
            ), 200
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500


    @bp.post("/api/xkeen/core")
    def api_xkeen_core_set() -> Any:
        """Смена ядра xkeen через сервисный модуль (switch_core)."""
        try:
            payload = request.get_json(silent=True) or {}
            core = str(payload.get("core", "")).strip()
            try:
                switch_core(core, XRAY_ERROR_LOG)
            except ValueError as e:
                return jsonify({"ok": False, "error": str(e)}), 400
            except RuntimeError as e:
                return jsonify({"ok": False, "error": str(e)}), 500

            # Уведомляем всех WS-подписчиков о смене ядра.
            _emit_event({"event": "core_changed", "core": core, "ok": True})

            return jsonify({"ok": True, "core": core}), 200
        except Exception as e:
            # Ошибку смены ядра также можно пробрасывать как событие (необязательно).
            _emit_event({"event": "core_change_error", "core": core, "ok": False, "error": str(e)})
            return jsonify({"ok": False, "error": str(e)}), 500


    # ---------- API: restart xkeen ----------
    @bp.post("/api/restart-xkeen")
    def api_restart_xkeen() -> Any:
        restarted = restart_xkeen(source="manual-mihomo")

        # Сообщаем подписчикам, что произошёл перезапуск xkeen.
        _emit_event({"event": "xkeen_restarted", "ok": bool(restarted)})

        return jsonify({"ok": True, "restarted": restarted}), 200

    return bp
