"""Config import/export API routes.

PR15: move Local and GitHub/config-server config exchange out of app.py.

Endpoints (must stay stable):
- GET  /api/local/export-configs
- POST /api/local/import-configs
- POST /api/github/export-configs
- GET  /api/github/configs
- POST /api/github/import-configs
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict

from flask import Blueprint, current_app, jsonify, request

from services.config_exchange_local import build_user_configs_bundle, apply_user_configs_bundle
from services.request_limits import (
    PayloadTooLargeError,
    get_config_exchange_max_bytes,
    read_request_json_limited,
    read_uploaded_file_bytes_limited,
)
from services import config_exchange_github as gh


def _api_error(message: str, status: int = 400, *, ok: bool | None = None, **extra: Any):
    """Local copy of app.api_error() to avoid circular imports."""
    payload: Dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    if extra:
        payload.update(extra)
    return jsonify(payload), status


def _log_exception(tag: str, exc: Exception, **extra: Any) -> None:
    try:
        if extra:
            current_app.logger.exception("config_exchange.%s | %r", tag, extra)
        else:
            current_app.logger.exception("config_exchange.%s", tag)
    except Exception:
        pass


def _api_exception(
    error: str,
    hint: str,
    *,
    status: int,
    exc: Exception,
    **extra: Any,
):
    _log_exception(error, exc, **extra)
    return _api_error(error, status, ok=False, hint=hint, **extra)


def create_config_exchange_blueprint(*, github_owner: str = "", github_repo: str = "") -> Blueprint:
    bp = Blueprint("config_exchange", __name__)

    # ---------- Local export/import ----------

    @bp.get("/api/local/export-configs")
    def api_local_export_configs():
        """Export user configs (except 04_outbounds.json) into a single JSON file."""
        bundle = build_user_configs_bundle(github_owner=github_owner, github_repo=github_repo)
        filename = time.strftime("xkeen-config-%Y%m%d-%H%M%S.json")

        resp = current_app.response_class(
            response=json.dumps(bundle, ensure_ascii=False, indent=2),
            status=200,
            mimetype="application/json",
        )
        resp.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
        return resp

    @bp.post("/api/local/import-configs")
    def api_local_import_configs():
        """Import configs from a local JSON bundle file."""
        max_bytes = get_config_exchange_max_bytes()
        try:
            if request.content_length is not None and int(request.content_length) > max_bytes:
                return _api_error("payload too large", 413, ok=False, max_bytes=max_bytes)
        except Exception:
            pass

        file = request.files.get("file")
        if not file or file.filename == "":
            return _api_error("no file uploaded", 400, ok=False)

        try:
            raw = read_uploaded_file_bytes_limited(file, max_bytes=max_bytes).decode("utf-8", errors="replace")
        except PayloadTooLargeError:
            return _api_error("payload too large", 413, ok=False, max_bytes=max_bytes)
        except Exception as e:  # noqa: BLE001
            return _api_exception(
                "read_failed",
                "Не удалось прочитать загруженный файл конфигурации.",
                status=400,
                exc=e,
                filename=str(getattr(file, "filename", "") or ""),
            )

        try:
            bundle = json.loads(raw)
        except Exception as e:  # noqa: BLE001
            return _api_exception(
                "invalid_json",
                "Файл конфигурации содержит некорректный JSON.",
                status=400,
                exc=e,
                filename=str(getattr(file, "filename", "") or ""),
            )

        if not isinstance(bundle, dict):
            return _api_error("bundle must be a dict", 400, ok=False)

        try:
            apply_user_configs_bundle(bundle)
        except Exception as e:  # noqa: BLE001
            return _api_exception(
                "apply_failed",
                "Не удалось применить импортированный набор конфигураций.",
                status=500,
                exc=e,
            )

        return jsonify({"ok": True}), 200

    # ---------- GitHub / config-server integration ----------

    @bp.post("/api/github/export-configs")
    def api_github_export_configs():
        if not gh.CONFIG_SERVER_BASE:
            return _api_error("CONFIG_SERVER_BASE is not configured", 500, ok=False)

        max_bytes = get_config_exchange_max_bytes()
        try:
            data = read_request_json_limited(request, max_bytes=max_bytes, default={}) or {}
        except PayloadTooLargeError:
            return _api_error("payload too large", 413, ok=False, max_bytes=max_bytes)

        bundle = build_user_configs_bundle(github_owner=github_owner, github_repo=github_repo)
        title = (data.get("title") or "").strip()
        description = (data.get("description") or "").strip()
        tags = data.get("tags") or []

        if not title:
            title = f"XKeen config {time.strftime('%Y-%m-%d %H:%M:%S')}"

        upload_payload = {
            "title": title,
            "description": description,
            "tags": tags,
            "bundle": bundle,
        }

        try:
            server_resp = gh.config_server_request_safe(
                "/upload",
                method="POST",
                payload=upload_payload,
                wait_seconds=10.0,
            )
        except Exception as e:  # noqa: BLE001
            return _api_exception(
                "upload_failed",
                "Не удалось выгрузить конфигурацию на config-server.",
                status=500,
                exc=e,
            )

        ok = bool(server_resp.get("ok")) if isinstance(server_resp, dict) else False
        cfg_id = server_resp.get("id") if isinstance(server_resp, dict) else None

        if not ok or not cfg_id:
            return _api_error(
                "upload_failed",
                500,
                ok=False,
                hint="Config-server отклонил выгрузку конфигурации.",
            )

        return jsonify({"ok": True, "id": cfg_id, "server_response": server_resp}), 200

    @bp.get("/api/github/configs")
    def api_github_list_configs():
        """Return list of configs from GitHub (configs/index.json) with caching."""
        limit = request.args.get("limit", type=int) or 200
        limit = max(1, min(int(limit), 500))

        wait = request.args.get("wait", type=float)
        if wait is None:
            wait = 2.0
        wait = max(0.2, min(float(wait), 8.0))

        force = request.args.get("force", type=int) or 0

        try:
            items, stale = gh.github_get_index_items(wait_seconds=wait, force_refresh=bool(force))
        except TimeoutError:
            return _api_error("GitHub timeout while loading configs index (try again later)", 504, ok=False)
        except Exception as e:  # noqa: BLE001
            return _api_exception(
                "github_index_failed",
                "Не удалось загрузить каталог конфигураций из GitHub.",
                status=500,
                exc=e,
            )

        safe_items = gh.sanitize_github_index_items(items)
        total = len(safe_items)

        safe_items.sort(key=lambda it: int(it.get("created_at", 0) or 0), reverse=True)
        safe_items = safe_items[:limit]

        return jsonify({"ok": True, "items": safe_items, "total": total, "stale": bool(stale)}), 200

    @bp.post("/api/github/import-configs")
    def api_github_import_configs():
        """Import a bundle from GitHub by cfg_id or import the latest from index."""
        max_bytes = get_config_exchange_max_bytes()
        try:
            payload = read_request_json_limited(request, max_bytes=max_bytes, default={}) or {}
        except PayloadTooLargeError:
            return _api_error("payload too large", 413, ok=False, max_bytes=max_bytes)
        cfg_id = (payload.get("cfg_id") or "").strip()

        if not cfg_id:
            try:
                items, _stale = gh.github_get_index_items(wait_seconds=2.5, force_refresh=False)
            except TimeoutError:
                return _api_error("GitHub timeout while loading configs index", 504, ok=False)
            except Exception as e:  # noqa: BLE001
                return _api_exception(
                    "github_index_failed",
                    "Не удалось загрузить каталог конфигураций из GitHub.",
                    status=500,
                    exc=e,
                )

            safe_items = gh.sanitize_github_index_items(items)
            if not safe_items:
                return _api_error("no configs found in repo", 404, ok=False)

            latest = max(safe_items, key=lambda it: int(it.get("created_at", 0) or 0))
            cfg_id = latest.get("id")
            if not cfg_id:
                return _api_error("latest config has no id", 500, ok=False)

        try:
            raw_bundle = gh.github_raw_get_safe(f"configs/{cfg_id}/bundle.json", wait_seconds=4.0)
        except TimeoutError:
            return _api_error("GitHub timeout while loading bundle.json", 504, ok=False)
        except Exception as e:  # noqa: BLE001
            return _api_exception(
                "github_fetch_failed",
                "Не удалось получить bundle конфигурации из GitHub.",
                status=500,
                exc=e,
                cfg_id=cfg_id,
            )

        if not raw_bundle:
            return _api_error(f"config {cfg_id} not found in repo", 404, ok=False)

        try:
            bundle = json.loads(raw_bundle)
        except Exception as e:  # noqa: BLE001
            return _api_exception(
                "invalid_bundle_json",
                "Полученный bundle содержит некорректный JSON.",
                status=500,
                exc=e,
                cfg_id=cfg_id,
            )

        if not isinstance(bundle, dict):
            return _api_error("invalid bundle structure from repo", 500, ok=False)

        try:
            apply_user_configs_bundle(bundle)
        except Exception as e:  # noqa: BLE001
            return _api_exception(
                "apply_failed",
                "Не удалось применить импортированный набор конфигураций.",
                status=500,
                exc=e,
                cfg_id=cfg_id,
            )

        return jsonify({"ok": True, "cfg_id": cfg_id}), 200

    return bp
