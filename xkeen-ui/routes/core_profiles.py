"""Module-owned API endpoints for curated core source selection."""

from __future__ import annotations

from typing import Any

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response, exception_response
from services.core_installer import CoreInstallError, CoreInstaller


def _install_error_response(exc: CoreInstallError):
    statuses = {
        "inactive_core": 409,
        "operation_in_progress": 409,
        "confirmation_expired": 409,
        "operation_not_found": 404,
        "invalid_engine": 404,
        "asset_missing": 422,
        "checksum_missing": 422,
        "unsupported_arch": 422,
        "invalid_release": 422,
        "github_unavailable": 503,
    }
    return error_response(exc.message, statuses.get(exc.code, 400), code=exc.code)


def create_core_profiles_blueprint(engine_id: str, installer: CoreInstaller) -> Blueprint:
    """Create the source API for exactly one engine module."""

    normalized = str(engine_id or "").strip().lower()
    if normalized not in {"xray", "mihomo"}:
        raise ValueError("Unknown core engine")
    bp = Blueprint(f"{normalized}_core_profiles", __name__)
    prefix = f"/api/{normalized}"

    @bp.get(f"{prefix}/core-profiles")
    def get_profiles():
        try:
            return jsonify({"ok": True, "data": installer.profiles(normalized)})
        except CoreInstallError as exc:
            return _install_error_response(exc)
        except Exception as exc:  # noqa: BLE001
            return exception_response("Не удалось получить источники ядра.", exc=exc, code="profiles_unavailable")

    @bp.post(f"{prefix}/core-source")
    def set_source():
        data: Any = request.get_json(silent=True)
        profile_id = data.get("profile_id") if isinstance(data, dict) else None
        if not isinstance(profile_id, str) or not profile_id.strip():
            return error_response("Нужен profile_id проверенного источника.", 400, code="profile_required")
        try:
            state = installer.select(normalized, profile_id)
            return jsonify({"ok": True, "state": state})
        except (CoreInstallError, ValueError) as exc:
            if isinstance(exc, CoreInstallError):
                return _install_error_response(exc)
            return error_response("Неизвестный проверенный источник.", 400, code="invalid_profile")
        except Exception as exc:  # noqa: BLE001
            return exception_response("Не удалось сохранить источник ядра.", exc=exc, code="source_save_failed")

    @bp.post(f"{prefix}/core-install/prepare")
    def prepare_install():
        try:
            confirmation = installer.prepare(normalized)
            return jsonify({"ok": True, "confirmation": confirmation})
        except CoreInstallError as exc:
            return _install_error_response(exc)
        except Exception as exc:  # noqa: BLE001
            return exception_response("Не удалось подготовить установку ядра.", exc=exc, code="prepare_failed")

    @bp.post(f"{prefix}/core-install/apply")
    def apply_install():
        data: Any = request.get_json(silent=True)
        confirmation_id = data.get("confirmation_id") if isinstance(data, dict) else None
        if not isinstance(confirmation_id, str) or not confirmation_id.strip():
            return error_response("Нужно подтверждение подготовленной установки.", 400, code="confirmation_required")
        try:
            operation = installer.apply(normalized, confirmation_id)
            return jsonify({"ok": True, "operation": operation}), 202
        except CoreInstallError as exc:
            return _install_error_response(exc)
        except Exception as exc:  # noqa: BLE001
            return exception_response("Не удалось запустить установку ядра.", exc=exc, code="apply_failed")

    @bp.get(f"{prefix}/core-install/status")
    def install_status():
        operation_id = request.args.get("operation_id")
        try:
            operation = installer.status(normalized, operation_id)
            return jsonify({"ok": True, "operation": operation})
        except CoreInstallError as exc:
            return _install_error_response(exc)
        except Exception as exc:  # noqa: BLE001
            return exception_response("Не удалось получить состояние установки.", exc=exc, code="status_failed")

    return bp
