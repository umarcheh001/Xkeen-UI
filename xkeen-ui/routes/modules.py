"""Stable HTTP API for the Stage 1 Xkeen UI module registry."""

from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response, exception_response
from services import request_limits
from services.module_lifecycle import FULL_SCOPE_OPERATIONS, ModuleLifecycleError, ModuleLifecycleService
from services.module_registry import MODULE_IDS, PROFILE_PRESETS, ModuleRegistry, ModuleRegistryError
from services.notification_center import NotificationCenter, NotificationCenterError


_MAX_PATCH_BYTES = 8 * 1024


def create_modules_blueprint(
    module_registry: ModuleRegistry,
    *,
    before_change: Callable[[str, bool], dict[str, Any] | None] | None = None,
    lifecycle_service: ModuleLifecycleService | None = None,
    notification_center: NotificationCenter | None = None,
    panel_update_preparer: Any | None = None,
) -> Blueprint:
    """Create the configuration-only module registry API blueprint."""

    bp = Blueprint("modules", __name__)
    if panel_update_preparer is None and lifecycle_service is not None:
        from services.panel_update_prepare import PanelUpdatePreparer

        panel_update_preparer = PanelUpdatePreparer(lifecycle_service)

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

    def lifecycle_response(call: Callable[[], dict[str, Any]], status: int = 200):
        if lifecycle_service is None:
            return error_response(
                "module lifecycle service is unavailable",
                503,
                ok=False,
                code="module_lifecycle_unavailable",
            )
        try:
            return success(call(), status)
        except ModuleLifecycleError as error:
            return error_response(
                error.message,
                error.status,
                ok=False,
                code=error.code,
                **error.details,
            )
        except Exception as exc:  # noqa: BLE001
            return exception_response(
                "Module lifecycle operation failed.",
                500,
                ok=False,
                code="module_lifecycle_failed",
                exc=exc,
                log_tag="modules.lifecycle_failed",
            )

    def notification_response(call: Callable[[], dict[str, Any]], status: int = 200):
        if notification_center is None:
            return error_response(
                "notification center is unavailable",
                503,
                ok=False,
                code="notification_center_unavailable",
            )
        try:
            return success(call(), status)
        except NotificationCenterError as error:
            return error_response(
                error.message,
                error.status,
                ok=False,
                code=error.code,
            )
        except Exception as exc:  # noqa: BLE001
            return exception_response(
                "Notification center failed.",
                500,
                ok=False,
                code="notification_center_failed",
                exc=exc,
                log_tag="modules.notification_center_failed",
            )

    def lifecycle_body(
        *,
        allowed: set[str],
        required: set[str],
    ):
        try:
            payload = request_limits.read_request_json_limited(
                request,
                max_bytes=_MAX_PATCH_BYTES,
                default=None,
            )
        except request_limits.PayloadTooLargeError:
            return None, error_response(
                "payload too large", 400, ok=False, code="payload_too_large"
            )
        if not isinstance(payload, dict):
            return None, error_response(
                "payload must be an object",
                400,
                ok=False,
                code="invalid_payload",
            )
        unknown = sorted(set(payload) - allowed)
        if unknown:
            return None, error_response(
                "unsupported lifecycle fields",
                400,
                ok=False,
                code="unsupported_lifecycle_fields",
                fields=unknown,
            )
        missing = sorted(required - set(payload))
        if missing:
            return None, error_response(
                "required lifecycle field is missing",
                400,
                ok=False,
                code="lifecycle_field_required",
                fields=missing,
            )
        return payload, None

    @bp.get("/api/modules/installed")
    def api_modules_installed():
        return lifecycle_response(lambda: lifecycle_service.installed())

    @bp.get("/api/modules/update-channel")
    def api_modules_update_channel():
        return lifecycle_response(lambda: lifecycle_service.update_channel())

    @bp.post("/api/modules/update-channel")
    def api_modules_set_update_channel():
        payload, failure = lifecycle_body(allowed={"channel"}, required={"channel"})
        if failure is not None:
            return failure
        def update_channel():
            result = lifecycle_service.set_update_channel(payload["channel"])
            if notification_center is not None:
                notification_center.wake_background()
            return result
        return lifecycle_response(update_channel)

    @bp.get("/api/modules/available")
    def api_modules_available():
        return lifecycle_response(lambda: lifecycle_service.available())

    @bp.post("/api/modules/panel/update-check")
    def api_modules_panel_update_check():
        payload, failure = lifecycle_body(
            allowed={"force_refresh"},
            required=set(),
        )
        if failure is not None:
            return failure
        force_refresh = payload.get("force_refresh", False)
        if not isinstance(force_refresh, bool):
            return error_response(
                "force_refresh must be boolean",
                400,
                ok=False,
                code="update_check_field_invalid",
                fields=["force_refresh"],
            )
        return lifecycle_response(
            lambda: lifecycle_service.panel_update_check(
                force_refresh=force_refresh,
            )
        )

    @bp.get("/api/notifications")
    @bp.get("/api/modules/notifications")
    def api_modules_notifications():
        return notification_response(lambda: notification_center.snapshot())

    @bp.post("/api/notifications/check")
    @bp.post("/api/modules/notifications/check")
    def api_modules_notifications_check():
        payload, failure = lifecycle_body(
            allowed={"force_refresh"},
            required=set(),
        )
        if failure is not None:
            return failure
        force_refresh = payload.get("force_refresh", True)
        if not isinstance(force_refresh, bool):
            return error_response(
                "force_refresh must be boolean",
                400,
                ok=False,
                code="notification_check_field_invalid",
                fields=["force_refresh"],
            )
        return notification_response(
            lambda: notification_center.check(force_refresh=force_refresh),
        )

    @bp.post("/api/notifications/mark-seen")
    @bp.post("/api/modules/notifications/mark-seen")
    def api_modules_notifications_mark_seen():
        payload, failure = lifecycle_body(
            allowed={"record_ids"},
            required=set(),
        )
        if failure is not None:
            return failure
        record_ids = payload.get("record_ids")
        if record_ids is not None and (
            not isinstance(record_ids, list)
            or any(not isinstance(item, str) for item in record_ids)
            or len(record_ids) > 160
        ):
            return error_response(
                "record_ids must be a short list of notification ids",
                400,
                ok=False,
                code="notification_record_ids_invalid",
            )
        return notification_response(
            lambda: notification_center.mark_seen(record_ids),
        )

    @bp.patch("/api/notifications/<record_id>")
    @bp.patch("/api/modules/notifications/<record_id>")
    def api_modules_notification_state(record_id: str):
        payload, failure = lifecycle_body(
            allowed={"action", "snooze_seconds"},
            required={"action"},
        )
        if failure is not None:
            return failure
        action = payload["action"]
        snooze_seconds = payload.get("snooze_seconds")
        if not isinstance(action, str):
            return error_response(
                "action must be a string",
                400,
                ok=False,
                code="notification_action_invalid",
            )
        if snooze_seconds is not None and (
            not isinstance(snooze_seconds, int) or isinstance(snooze_seconds, bool)
        ):
            return error_response(
                "snooze_seconds must be an integer",
                400,
                ok=False,
                code="notification_snooze_invalid",
            )
        return notification_response(
            lambda: notification_center.set_record_state(
                record_id,
                action,
                snooze_seconds=snooze_seconds,
            )
        )

    @bp.post("/api/modules/operations/plan")
    def api_modules_operation_plan():
        payload, failure = lifecycle_body(
            allowed={"operation", "module_id"},
            required={"operation"},
        )
        if failure is not None:
            return failure
        operation = payload["operation"]
        full_scope = operation in FULL_SCOPE_OPERATIONS
        if not full_scope and "module_id" not in payload:
            return error_response("required lifecycle field is missing", 400, ok=False, code="lifecycle_field_required", fields=["module_id"])
        if full_scope and "module_id" in payload:
            return error_response("unsupported lifecycle fields", 400, ok=False, code="unsupported_lifecycle_fields", fields=["module_id"])
        return lifecycle_response(
            lambda: lifecycle_service.plan(operation, payload.get("module_id"))
        )

    # A panel update is prepared in the background: the window watches the
    # download and the check of the release instead of a silent request.
    @bp.post("/api/modules/panel/prepare")
    def api_modules_panel_prepare():
        _payload, failure = lifecycle_body(allowed=set(), required=set())
        if failure is not None:
            return failure
        return lifecycle_response(lambda: {"ok": True, **panel_update_preparer.start()})

    @bp.get("/api/modules/panel/prepare/<prepare_id>")
    def api_modules_panel_prepare_status(prepare_id: str):
        return lifecycle_response(lambda: {"ok": True, **panel_update_preparer.status(prepare_id)})

    @bp.post("/api/modules/panel/prepare/<prepare_id>/cancel")
    def api_modules_panel_prepare_cancel(prepare_id: str):
        return lifecycle_response(lambda: {"ok": True, **panel_update_preparer.cancel(prepare_id)})

    @bp.post("/api/modules/operations/apply")
    def api_modules_operation_apply():
        payload, failure = lifecycle_body(
            allowed={"operation", "module_id", "plan_id"},
            required={"operation", "plan_id"},
        )
        if failure is not None:
            return failure
        operation = payload["operation"]
        full_scope = operation in FULL_SCOPE_OPERATIONS
        if not full_scope and "module_id" not in payload:
            return error_response("required lifecycle field is missing", 400, ok=False, code="lifecycle_field_required", fields=["module_id"])
        if full_scope and "module_id" in payload:
            return error_response("unsupported lifecycle fields", 400, ok=False, code="unsupported_lifecycle_fields", fields=["module_id"])
        plan_id = payload["plan_id"]
        if (
            not isinstance(plan_id, str)
            or len(plan_id) != 64
            or any(character not in "0123456789abcdef" for character in plan_id)
        ):
            return error_response(
                "plan_id must be a lowercase SHA-256 digest",
                400,
                ok=False,
                code="module_plan_id_invalid",
            )
        return lifecycle_response(
            lambda: lifecycle_service.apply(
                operation, payload.get("module_id"), plan_id
            ),
            202,
        )

    @bp.get("/api/modules/operations/status")
    def api_modules_operation_status():
        return lifecycle_response(lambda: lifecycle_service.status())

    @bp.post("/api/modules/operations/<operation_id>/cancel")
    def api_modules_operation_cancel(operation_id: str):
        return lifecycle_response(lambda: lifecycle_service.cancel(operation_id), 202)

    @bp.post("/api/modules/recovery")
    def api_modules_recovery():
        return lifecycle_response(lambda: lifecycle_service.recover())

    @bp.post("/api/modules/restart")
    def api_modules_restart():
        return lifecycle_response(lambda: lifecycle_service.restart())

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

    @bp.patch("/api/modules/editor")
    def api_modules_editor_patch():
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

        unknown_fields = sorted(set(payload) - {"variant"})
        if unknown_fields:
            return error_response(
                "unsupported editor fields",
                400,
                ok=False,
                code="unsupported_editor_fields",
                fields=unknown_fields,
            )
        if "variant" not in payload:
            return error_response(
                "variant is required",
                400,
                ok=False,
                code="editor_variant_required",
            )

        try:
            response_payload, changed = module_registry.set_editor_variant(payload["variant"])
            response_payload["changed"] = changed
            return success(response_payload)
        except ModuleRegistryError as error:
            return registry_error(error)
        except Exception as exc:  # noqa: BLE001
            return exception_response(
                "Не удалось сохранить вариант редакторов.",
                500,
                ok=False,
                code="editor_variant_save_failed",
                hint="Проверьте доступность каталога UI state.",
                exc=exc,
                log_tag="modules.editor_variant_save_failed",
            )

    @bp.post("/api/modules/profile")
    def api_modules_profile():
        try:
            if request.content_length and int(request.content_length) > _MAX_PATCH_BYTES:
                return error_response("payload too large", 400, ok=False, code="payload_too_large")
        except (TypeError, ValueError):
            pass
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return error_response("payload must be an object", 400, ok=False, code="invalid_payload")
        unknown_fields = sorted(set(payload) - {"profile", "profile_id", "module_ids", "editor_variant"})
        if unknown_fields:
            return error_response("unsupported profile fields", 400, ok=False, code="unsupported_profile_fields", fields=unknown_fields)
        profile = payload.get("profile", payload.get("profile_id"))
        if not isinstance(profile, str) or not profile.strip():
            return error_response("profile is required", 400, ok=False, code="profile_required")
        profile = profile.strip().lower()
        try:
            if before_change is not None:
                requested = payload.get("module_ids") if profile == "custom" else PROFILE_PRESETS.get(profile)
                if isinstance(requested, (list, tuple, set)):
                    currently_enabled = set(module_registry.get_registry()["configured_module_ids"])
                    for module_id in MODULE_IDS:
                        if module_id in currently_enabled and module_id not in requested:
                            blocked = before_change(module_id, False)
                            if blocked:
                                return error_response(
                                    str(blocked.get("message") or "module change is unsafe"),
                                    int(blocked.get("status") or 409),
                                    ok=False,
                                    code=str(blocked.get("code") or "module_change_blocked"),
                                    **{key: value for key, value in blocked.items() if key not in {"message", "status", "code"}},
                                )
            response_payload, changed = module_registry.set_profile(
                profile,
                module_ids=payload.get("module_ids"),
                editor_variant=payload.get("editor_variant"),
            )
            response_payload["changed"] = changed
            if lifecycle_service is not None:
                response_payload.update(lifecycle_service.profile_transition_status())
            return success(response_payload)
        except ModuleRegistryError as error:
            return registry_error(error)
        except Exception as exc:  # noqa: BLE001
            return exception_response(
                "Не удалось сохранить профиль установки.",
                500,
                ok=False,
                code="module_profile_save_failed",
                hint="Проверьте доступность каталога UI state.",
                exc=exc,
                log_tag="modules.profile_save_failed",
            )

    def update_module(module_id: str, enabled: bool):
        try:
            if not enabled:
                # The last engine is said first: the other refusals would send
                # the owner to undo the DNS guard only to be refused again.
                module_registry.check_disable(module_id)
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
