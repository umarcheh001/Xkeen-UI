"""Service-control API routes for xkeen as a Flask Blueprint."""
from __future__ import annotations
import subprocess
import time

from flask import Blueprint, request, jsonify
from typing import Any, Callable

from routes.common.errors import error_response, exception_response
from services.xkeen import control_xkeen_action, get_xkeen_runtime_status

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
    append_restart_log: Callable[..., None],
    XRAY_ERROR_LOG: str,
    broadcast_event: Callable[[dict], None] | None = None,
    append_restart_log_text: Callable[..., None] | None = None,
    read_restart_log: Callable[..., list[str]] | None = None,
    clear_restart_log: Callable[..., None] | None = None,
    read_operation_diagnostic: Callable[..., dict[str, Any] | None] | None = None,
) -> Blueprint:
    """Create blueprint with xkeen service-control endpoints."""
    bp = Blueprint("service", __name__)

    def _service_error(
        message: str,
        status: int,
        *,
        code: str,
        hint: str | None = None,
        **extra,
    ):
        payload_extra = {"code": code}
        if hint:
            payload_extra["hint"] = hint
        payload_extra.update(extra)
        return error_response(message, status, ok=False, **payload_extra)

    def _service_exception(
        message: str,
        *,
        code: str,
        hint: str,
        exc: BaseException,
        status: int = 500,
        log_extra: dict | None = None,
    ):
        return exception_response(
            message,
            status,
            ok=False,
            code=code,
            hint=hint,
            exc=exc,
            log_tag=f"service.{code}",
            log_extra=log_extra,
        )

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

    if read_operation_diagnostic is None:
        def read_operation_diagnostic(ref: str):  # type: ignore[no-redef]
            return None

    def _append_restart_log(ok: bool, source: str = "api", **meta: object) -> None:
        try:
            append_restart_log(ok, source=source, **meta)
        except TypeError:
            try:
                append_restart_log(ok, source=source)
            except Exception:
                pass
        except Exception:
            pass

    def _append_restart_log_text(raw_text: str) -> None:
        if not append_restart_log_text:
            return
        try:
            append_restart_log_text(raw_text)
        except Exception:
            pass

    def _restart_log_elapsed_ms(started_at: float) -> int:
        try:
            return max(0, int(round((time.monotonic() - started_at) * 1000)))
        except Exception:
            return 0

    def _restart_log_runtime_meta(started_at=None) -> dict[str, object]:
        meta: dict[str, object] = {}
        try:
            meta.update(get_xkeen_runtime_status())
        except Exception:
            pass
        if started_at is not None:
            meta["duration_ms"] = _restart_log_elapsed_ms(started_at)
        return meta

    def _detect_core_for_restart_log() -> str:
        try:
            _, current_core = get_cores_status()
            return str(current_core or "")
        except Exception:
            return ""

    def _core_switch_meta(
        *,
        core: str,
        previous_core: str,
        started_at: float,
        phase: str = "",
        returncode: object = None,
    ) -> dict[str, object]:
        meta: dict[str, object] = _restart_log_runtime_meta(started_at)
        meta["core"] = core or "unknown"
        if previous_core:
            meta["previous"] = previous_core
        if phase:
            meta["phase"] = phase
        if returncode is not None:
            meta["returncode"] = returncode
        return meta

    @bp.get("/api/restart-log")
    def api_restart_log() -> Any:
        try:
            lines = read_restart_log(limit=100)
            return jsonify({"lines": lines}), 200
        except Exception as e:  # noqa: BLE001
            return _service_exception(
                "Не удалось прочитать лог перезапуска.",
                code="restart_log_read_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
            )

    @bp.post("/api/restart-log/clear")
    def api_restart_log_clear() -> Any:
        try:
            clear_restart_log()
            return jsonify({"ok": True}), 200
        except Exception as e:  # noqa: BLE001
            return _service_exception(
                "Не удалось очистить лог перезапуска.",
                code="restart_log_clear_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
            )

    @bp.get("/api/operation-diagnostics/<ref>")
    def api_operation_diagnostic(ref: str) -> Any:
        try:
            data = read_operation_diagnostic(ref)
            if not data:
                return _service_error(
                    "Диагностика операции не найдена.",
                    404,
                    code="operation_diagnostic_not_found",
                    hint="Повторите операцию, чтобы создать свежий диагностический снимок.",
                )
            return jsonify(data), 200
        except Exception as e:  # noqa: BLE001
            return _service_exception(
                "Не удалось прочитать диагностику операции.",
                code="operation_diagnostic_read_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
            )



    @bp.post("/api/xkeen/start")
    def api_xkeen_start() -> Any:
        started_at = time.monotonic()
        try:
            ok = control_xkeen_action("start", prefer_init=True)
            _append_restart_log(ok, source="api-start", **_restart_log_runtime_meta(started_at))
            if ok:
                _core_log("info", "xkeen.start", source="api-start")
                return jsonify({"ok": True}), 200
            _core_log("error", "xkeen.start_failed", source="api-start")
            return jsonify({"ok": False}), 500
        except Exception:
            _append_restart_log(False, source="api-start", **_restart_log_runtime_meta(started_at))
            _core_log("error", "xkeen.start_failed", source="api-start")
            return jsonify({"ok": False}), 500


    @bp.post("/api/xkeen/stop")
    def api_xkeen_stop() -> Any:
        started_at = time.monotonic()
        try:
            ok = control_xkeen_action("stop", prefer_init=True)
            _append_restart_log(ok, source="api-stop", **_restart_log_runtime_meta(started_at))
            if ok:
                _core_log("info", "xkeen.stop", source="api-stop")
                return jsonify({"ok": True}), 200
            _core_log("error", "xkeen.stop_failed", source="api-stop")
            return jsonify({"ok": False}), 500
        except Exception:
            _append_restart_log(False, source="api-stop", **_restart_log_runtime_meta(started_at))
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
            _core_log("error", "xkeen.status_failed", error=str(e))
            return _service_exception(
                "Не удалось получить статус xkeen.",
                code="status_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
            )


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
            return _service_exception(
                "Не удалось получить список ядер xkeen.",
                code="cores_status_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
            )


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
            return _service_exception(
                "Не удалось получить список ядер xkeen.",
                code="cores_status_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
            )


    @bp.post("/api/xkeen/core")
    def api_xkeen_core_set() -> Any:
        """Смена ядра xkeen через сервисный модуль (switch_core)."""
        core = ""
        started_at = time.monotonic()
        previous_core = ""
        runtime_log_chunks: list[str] = []

        def _capture_runtime_log(text: str) -> None:
            raw = str(text or "")
            if raw:
                runtime_log_chunks.append(raw)

        def _flush_runtime_log() -> None:
            if not runtime_log_chunks:
                return
            raw = "".join(runtime_log_chunks)
            runtime_log_chunks.clear()
            _append_restart_log_text(raw)

        try:
            payload = request.get_json(silent=True) or {}
            core = str(payload.get("core", "")).strip()
            previous_core = _detect_core_for_restart_log()
            try:
                switch_core(core, XRAY_ERROR_LOG, runtime_log=_capture_runtime_log)
            except ValueError:
                _flush_runtime_log()
                _append_restart_log(
                    False,
                    source="core-switch",
                    **_core_switch_meta(
                        core=core,
                        previous_core=previous_core,
                        started_at=started_at,
                        phase="validate",
                    ),
                )
                return _service_error(
                    "Недопустимое ядро.",
                    400,
                    code="invalid_core",
                    hint="Укажите допустимое ядро: xray или mihomo.",
                )
            except CoreSwitchError as e:
                _flush_runtime_log()
                details = e.details or {}
                _append_restart_log(
                    False,
                    source="core-switch",
                    **_core_switch_meta(
                        core=core,
                        previous_core=previous_core,
                        started_at=started_at,
                        phase=str(details.get("phase") or ""),
                        returncode=details.get("returncode"),
                    ),
                )
                _core_log("error", "xkeen.core_set_failed", core=core, error=str(e), **(e.details or {}))
                return _service_exception(
                    "Не удалось переключить ядро xkeen.",
                    code="core_switch_failed",
                    hint="Подробности смотрите в server logs.",
                    exc=e,
                    log_extra={"core": core},
                )
            except RuntimeError as e:
                _flush_runtime_log()
                _append_restart_log(
                    False,
                    source="core-switch",
                    **_core_switch_meta(
                        core=core,
                        previous_core=previous_core,
                        started_at=started_at,
                        phase="runtime",
                    ),
                )
                _core_log("error", "xkeen.core_set_failed", core=core, error=str(e))
                return _service_exception(
                    "Не удалось переключить ядро xkeen.",
                    code="core_switch_failed",
                    hint="Подробности смотрите в server logs.",
                    exc=e,
                    log_extra={"core": core},
                )

            # Уведомляем всех WS-подписчиков о смене ядра.
            _emit_event({"event": "core_changed", "core": core, "ok": True})

            _flush_runtime_log()
            _append_restart_log(
                True,
                source="core-switch",
                **_core_switch_meta(
                    core=core,
                    previous_core=previous_core,
                    started_at=started_at,
                ),
            )
            _core_log("info", "xkeen.core_set", core=core)
            return jsonify({"ok": True, "core": core, "restarted": True}), 200
        except Exception as e:
            _flush_runtime_log()
            _emit_event({"event": "core_change_error", "core": core, "ok": False, "error": "core_switch_failed"})
            _append_restart_log(
                False,
                source="core-switch",
                **_core_switch_meta(
                    core=core,
                    previous_core=previous_core,
                    started_at=started_at,
                    phase="exception",
                ),
            )
            return _service_exception(
                "Не удалось переключить ядро xkeen.",
                code="core_switch_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                log_extra={"core": core},
            )


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
