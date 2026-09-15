"""/api/happ-decryptor/*: install and check the Happ link decryptor from the panel.

Expected failures answer 200 with ``error`` and a Russian ``hint``; anything
unexpected is logged and reported without details, like the xk-geodat routes.
"""

from __future__ import annotations

import os
import tempfile
from typing import Any, Callable

from flask import Blueprint, current_app, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

from services.happ_decryptor import engine, keys, service
from services.happ_decryptor.errors import HappDecryptorError
from services.request_limits import PayloadTooLargeError, read_uploaded_file_bytes_limited

_INTERNAL_HINT = "Не удалось выполнить действие с декриптором Happ. Подробности смотрите в журнале панели."


def create_happ_decryptor_blueprint(
    *,
    bin_path: str | None = None,
    fetch=None,
    run=None,
    platform: Callable[[], dict[str, Any]] | None = None,
) -> Blueprint:
    bp = Blueprint("happ_decryptor", __name__)
    run_cmd = run or engine.run_command
    platform_info = platform or engine.platform_info

    def _bin() -> str:
        return bin_path or engine.default_bin_path()

    def _log(tag: str) -> None:
        try:
            current_app.logger.exception("happ_decryptor.%s", tag)
        except Exception:
            pass

    def _status() -> dict[str, Any] | None:
        try:
            return engine.status(_bin(), run_cmd, platform=platform_info())
        except Exception:
            _log("status_failed")
            return None

    def _respond(action: Callable[[], dict[str, Any]], tag: str):
        try:
            result = action()
        except PayloadTooLargeError as exc:
            return jsonify({"ok": False, "error": "payload too large", "max_bytes": int(exc.max_bytes)}), 413
        except RequestEntityTooLarge:
            return jsonify({"ok": False, "error": "payload too large"}), 413
        except HappDecryptorError as exc:
            return jsonify({"ok": False, "error": exc.code, "hint": exc.hint, "status": _status()}), 200
        except Exception:
            _log(tag)
            return jsonify({"ok": False, "error": "internal_error", "hint": _INTERNAL_HINT, "status": _status()}), 200
        return jsonify({"ok": True, **result, "status": _status()}), 200

    @bp.get("/api/happ-decryptor/status")
    def api_happ_decryptor_status():
        status = _status()
        if status is None:
            return jsonify({"ok": False, "error": "internal_error", "hint": _INTERNAL_HINT}), 200
        return jsonify({"ok": True, "status": status}), 200

    @bp.post("/api/happ-decryptor/install")
    def api_happ_decryptor_install():
        """Engine from the release (and keys unless {"keys": false}), or engine from multipart ``file``."""
        upload = request.files.get("file") if request.files else None
        if upload is not None and upload.filename:
            def install_upload() -> dict[str, Any]:
                data = read_uploaded_file_bytes_limited(upload, max_bytes=engine.MAX_BINARY_BYTES)
                fd, tmp = tempfile.mkstemp(prefix="happ-decryptor-upload-")
                try:
                    with os.fdopen(fd, "wb") as f:
                        f.write(data)
                    return service.install_uploaded_engine(_bin(), tmp, run=run_cmd, platform=platform_info)
                finally:
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass

            return _respond(install_upload, "install_upload_failed")

        body = request.get_json(silent=True) or {}
        with_keys = body.get("keys", True) is not False
        return _respond(
            lambda: service.install_all(_bin(), with_keys=with_keys, fetch=fetch, run=run_cmd, platform=platform_info),
            "install_failed",
        )

    @bp.post("/api/happ-decryptor/keys")
    def api_happ_decryptor_update_keys():
        return _respond(lambda: {"keys": service.update_keys(_bin(), fetch=fetch, run=run_cmd)}, "update_keys_failed")

    @bp.post("/api/happ-decryptor/keys/upload")
    def api_happ_decryptor_upload_keys():
        def install_uploads() -> dict[str, Any]:
            uploads = [
                (item.filename, read_uploaded_file_bytes_limited(item, max_bytes=keys.MAX_KEY_FILE_BYTES))
                for item in (request.files.getlist("file") if request.files else [])
                if item and item.filename
            ]
            return {"keys": service.install_uploaded_keys(_bin(), uploads, run=run_cmd)}

        return _respond(install_uploads, "upload_keys_failed")

    return bp
