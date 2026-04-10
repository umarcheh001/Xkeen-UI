"""USB storage API (mount/unmount + list).

Minimal endpoints used by the File Manager UI:
  - GET  /api/storage/usb
  - POST /api/storage/usb/mount   {"name": "..."}
  - POST /api/storage/usb/unmount {"name": "..."}

Auth/CSRF:
  Protected by the global auth guard in services/auth_setup.py.
  POST requests require X-CSRF-Token.
"""

from __future__ import annotations

from typing import Any

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response, exception_response


def create_storage_usb_blueprint() -> Blueprint:
    bp = Blueprint("storage_usb", __name__)

    @bp.get("/api/storage/usb")
    def api_storage_usb_list():
        try:
            from services.storage_usb import list_usb_filesystems
            payload = list_usb_filesystems()
        except Exception as e:  # noqa: BLE001
            return exception_response(
                "Не удалось получить список USB-накопителей.",
                500,
                ok=False,
                code="storage_list_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                log_tag="storage_usb.list_failed",
            )

        if not payload.get("ok"):
            code = str(payload.get("code") or "error")
            status = 503 if code in ("ndmc_missing", "ndmc_failed") else 400
            return jsonify(payload), status
        return jsonify(payload), 200

    def _name_from_json() -> str:
        data: Any = request.get_json(silent=True)
        if not isinstance(data, dict):
            return ""
        return str(data.get("name") or "").strip()

    @bp.post("/api/storage/usb/mount")
    def api_storage_usb_mount():
        name = _name_from_json()
        if not name:
            return jsonify({"ok": False, "code": "bad_request", "message": "name is required"}), 400

        try:
            from services.storage_usb import mount_filesystem
            payload = mount_filesystem(name)
        except Exception as e:  # noqa: BLE001
            return exception_response(
                "Не удалось смонтировать USB-накопитель.",
                500,
                ok=False,
                code="mount_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                log_tag="storage_usb.mount_failed",
                name=name,
            )

        if not payload.get("ok"):
            code = str(payload.get("code") or "error")
            status = 503 if code in ("ndmc_missing", "ndmc_failed") else 400
            return jsonify(payload), status
        return jsonify(payload), 200

    @bp.post("/api/storage/usb/unmount")
    def api_storage_usb_unmount():
        name = _name_from_json()
        if not name:
            return jsonify({"ok": False, "code": "bad_request", "message": "name is required"}), 400

        try:
            from services.storage_usb import unmount_filesystem
            payload = unmount_filesystem(name)
        except Exception as e:  # noqa: BLE001
            return exception_response(
                "Не удалось размонтировать USB-накопитель.",
                500,
                ok=False,
                code="unmount_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                log_tag="storage_usb.unmount_failed",
                name=name,
            )

        if not payload.get("ok"):
            code = str(payload.get("code") or "error")
            status = 503 if code in ("ndmc_missing", "ndmc_failed") else 400
            return jsonify(payload), status
        return jsonify(payload), 200

    return bp
