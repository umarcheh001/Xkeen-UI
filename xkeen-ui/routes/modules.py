"""Stable HTTP API for the Stage 1 Xkeen UI module registry."""

from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response, exception_response
from services.module_registry import ModuleRegistry, ModuleRegistryError


_MAX_PATCH_BYTES = 8 * 1024


def create_modules_blueprint(
    module_registry: ModuleRegistry,
    *,
    before_change: Callable[[str, bool], dict[str, Any] | None] | None = None,
) -> Blueprint:
    """Create the configuration-only module registry API blueprint."""

    bp = Blueprint("modules", __name__)

    def success(payload: dict[str, Any], status: int = 200):
        response = jsonify(payload)
        response.headers["Cache-Control"] = "no-store"
        return response, status

    def registry_error(error: ModuleRegistryError):
        return error_response(
            str(error),
            error.status,
            ok=False,
            code=error.code,
            **error.details,
        )

    @bp.get("/api/modules")
    def api_modules_list():
        try:
            return success(module_registry.get_registry())
        except Exception as exc:  # noqa: BLE001 - state I/O errors are recoverable API errors
            return exception_response(
                "Не удалось загрузить реестр модулей.",
                500,
                ok=False,
                code="module_registry_load_failed",
                hint="Проверьте доступность каталога UI state.",
                exc=exc,
                log_tag="modules.load_failed",
            )

    @bp.get("/api/modules/<module_id>")
    def api_modules_get(module_id: str):
        try:
            return success(module_registry.get_module(module_id))
        except ModuleRegistryError as error:
            return registry_error(error)
        except Exception as exc:  # noqa: BLE001
            return exception_response(
                "Не удалось загрузить модуль.",
                500,
                ok=False,
                code="module_registry_load_failed",
                hint="Проверьте доступность каталога UI state.",
                exc=exc,
                log_tag="modules.get_failed",
            )

    def update_module(module_id: str, enabled: bool):
        try:
            if before_change is not None:
                blocked = before_change(module_id, enabled)
                if blocked:
                    return error_response(
                        str(blocked.get("message") or "module change is unsafe"),
                        int(blocked.get("status") or 409),
                        ok=False,
                        code=str(blocked.get("code") or "module_change_blocked"),
                        **{
                            key: value
                            for key, value in blocked.items()
                            if key not in {"message", "status", "code"}
                        },
                    )
            payload, changed = module_registry.set_enabled(module_id, enabled)
            payload["changed"] = changed
            return success(payload)
        except ModuleRegistryError as error:
            return registry_error(error)
        except Exception as exc:  # noqa: BLE001
            return exception_response(
                "Не удалось сохранить состояние модуля.",
                500,
                ok=False,
                code="module_registry_save_failed",
                hint="Проверьте доступность каталога UI state.",
                exc=exc,
                log_tag="modules.save_failed",
            )

    @bp.patch("/api/modules/<module_id>")
    def api_modules_patch(module_id: str):
        try:
            if request.content_length and int(request.content_length) > _MAX_PATCH_BYTES:
                return error_response("payload too large", 400, ok=False, code="payload_too_large")
        except (TypeError, ValueError):
            pass

        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return error_response(
                "payload must be an object",
                400,
                ok=False,
                code="invalid_payload",
            )

        unknown_fields = sorted(set(payload) - {"enabled"})
        if unknown_fields:
            return error_response(
                "unsupported module fields",
                400,
                ok=False,
                code="unsupported_module_fields",
                fields=unknown_fields,
            )
        if "enabled" not in payload:
            return error_response(
                "enabled is required",
                400,
                ok=False,
                code="enabled_required",
            )
        return update_module(module_id, payload["enabled"])

    @bp.post("/api/modules/<module_id>/enable")
    def api_modules_enable(module_id: str):
        return update_module(module_id, True)

    @bp.post("/api/modules/<module_id>/disable")
    def api_modules_disable(module_id: str):
        return update_module(module_id, False)

    return bp
