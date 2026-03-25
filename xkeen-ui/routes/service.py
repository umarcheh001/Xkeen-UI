"""Service-control API routes for xkeen as a Flask Blueprint."""
from __future__ import annotations
import os
import subprocess

from flask import Blueprint, request, jsonify
from typing import Any, Callable, Dict, Optional

from routes.common.errors import error_response
from services.xkeen_commands_catalog import build_xkeen_cmd

# --- core.log helpers (never fail) ---
try:
    from services.logging_setup import core_logger as _get_core_logger
    _CORE_LOGGER = _get_core_logger()
except Exception:
    _CORE_LOGGER = None


def _core_log(level: str, msg: str, **extra) -> None:
    if _CORE_LOGGER is None:
        return
    try:
        if extra:
            try:
                tail = ", ".join(f"{k}={v}" for k, v in extra.items())
            except Exception:
                tail = repr(extra)
            full = f"{msg} | {tail}"
        else:
            full = msg
        fn = getattr(_CORE_LOGGER, str(level or "info").lower(), None)
        if callable(fn):
            fn(full)
        else:
            _CORE_LOGGER.info(full)
    except Exception:
        pass

from services.cores import CoreSwitchError, get_cores_status, switch_core


def create_service_blueprint(
    restart_xkeen: Callable[..., bool],
    append_restart_log: Callable[[str, bool, str], None] | Callable[..., None],
    XRAY_ERROR_LOG: str,
    broadcast_event: Callable[[dict], None] | None = None,
    read_restart_log: Callable[..., list[str]] | None = None,
    clear_restart_log: Callable[..., None] | None = None,
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
                _core_log("warning", "broadcast_event error", error=str(e))
            except Exception:
                pass
    # ---- restart-log helpers (injected from app.py; safe defaults for tests) ----
    if read_restart_log is None:
        def read_restart_log(limit: int = 100):  # type: ignore[no-redef]
            return []

    if clear_restart_log is None:
        def clear_restart_log():  # type: ignore[no-redef]
            return None

    @bp.get("/api/restart-log")
    def api_restart_log() -> Any:
        try:
            lines = read_restart_log(limit=100)
            return jsonify({"lines": lines}), 200
        except Exception as e:  # noqa: BLE001
            return error_response(str(e), 500)

    @bp.post("/api/restart-log/clear")
    def api_restart_log_clear() -> Any:
        try:
            clear_restart_log()
            return jsonify({"ok": True}), 200
        except Exception as e:  # noqa: BLE001
            return error_response(str(e), 500, ok=False)



    @bp.post("/api/xkeen/start")
    def api_xkeen_start() -> Any:
        try:
            subprocess.check_call(build_xkeen_cmd("-start"))
            append_restart_log(True, source="api-start")
            _core_log("info", "xkeen.start", source="api-start")
            return jsonify({"ok": True}), 200
        except Exception:
            append_restart_log(False, source="api-start")
            _core_log("error", "xkeen.start_failed", source="api-start")
            return jsonify({"ok": False}), 500


    @bp.post("/api/xkeen/stop")
    def api_xkeen_stop() -> Any:
        try:
            subprocess.check_call(build_xkeen_cmd("-stop"))
            append_restart_log(True, source="api-stop")
            _core_log("info", "xkeen.stop", source="api-stop")
            return jsonify({"ok": True}), 200
        except Exception:
            append_restart_log(False, source="api-stop")
            _core_log("error", "xkeen.stop_failed", source="api-stop")
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
            _core_log("error", "xkeen.core_set_failed", error=str(e))
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


    @bp.get("/api/cores/status")
    def api_cores_status_legacy() -> Any:
        """Legacy alias for older UI builds that still request /api/cores/status."""
        try:
            cores, current_core = get_cores_status()
            return jsonify(
                {
                    "ok": True,
                    "detected_cores": cores,
                    "available_cores": cores,
                    "cores": cores,
                    "current_core": current_core,
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
            except CoreSwitchError as e:
                # Diagnostic payload (safe, local admin UI).
                _core_log("error", "xkeen.core_set_failed", core=core, error=str(e), **(e.details or {}))
                return jsonify({"ok": False, "error": str(e), "details": e.details}), 500
            except RuntimeError as e:
                _core_log("error", "xkeen.core_set_failed", core=core, error=str(e))
                return jsonify({"ok": False, "error": str(e)}), 500

            # Уведомляем всех WS-подписчиков о смене ядра.
            _emit_event({"event": "core_changed", "core": core, "ok": True})

            _core_log("info", "xkeen.core_set", core=core)
            return jsonify({"ok": True, "core": core}), 200
        except Exception as e:
            # Ошибку смены ядра также можно пробрасывать как событие (необязательно).
            _emit_event({"event": "core_change_error", "core": core, "ok": False, "error": str(e)})
            return jsonify({"ok": False, "error": str(e)}), 500


    # ---------- API: restart xkeen ----------
    @bp.post("/api/restart-xkeen")
    def api_restart_xkeen() -> Any:
        restarted = restart_xkeen(source="manual-mihomo")
        _core_log("info", "xkeen.restart", source="manual-mihomo", restarted=bool(restarted))

        # Сообщаем подписчикам, что произошёл перезапуск xkeen.
        _emit_event({"event": "xkeen_restarted", "ok": bool(restarted)})

        return jsonify({"ok": True, "restarted": restarted}), 200

    # Legacy alias used by UI button (kept for compatibility).
    @bp.post("/api/restart")
    def api_restart() -> Any:
        """Restart xkeen (legacy endpoint).

        This endpoint historically returned HTTP 500 on failure.
        """
        ok = restart_xkeen(source="api-button")
        payload = {"ok": bool(ok), "restarted": bool(ok)}
        return jsonify(payload), (200 if ok else 500)

    return bp
