"""Shared helpers for request body size limits."""

from __future__ import annotations

import json
import os
from typing import Any, Mapping, Optional


UI_MAX_CONTENT_LENGTH_ENV = "XKEEN_UI_MAX_CONTENT_LENGTH"
JSON_BODY_MAX_BYTES_ENV = "XKEEN_JSON_BODY_MAX_BYTES"
JSON_HEAVY_MAX_BYTES_ENV = "XKEEN_JSON_HEAVY_MAX_BYTES"
MIHOMO_JSON_MAX_BYTES_ENV = "XKEEN_MIHOMO_JSON_MAX_BYTES"
GEODAT_UPLOAD_MAX_BYTES_ENV = "XKEEN_GEODAT_UPLOAD_MAX_BYTES"
ROUTING_SAVE_MAX_BYTES_ENV = "XKEEN_ROUTING_SAVE_MAX_BYTES"
CONFIG_EXCHANGE_MAX_BYTES_ENV = "XKEEN_CONFIG_EXCHANGE_MAX_BYTES"

DEFAULT_UI_MAX_CONTENT_LENGTH = 16 * 1024 * 1024
DEFAULT_JSON_BODY_MAX_BYTES = 64 * 1024
DEFAULT_JSON_HEAVY_MAX_BYTES = 1024 * 1024
DEFAULT_MIHOMO_JSON_MAX_BYTES = 4 * 1024 * 1024
DEFAULT_GEODAT_UPLOAD_MAX_BYTES = 16 * 1024 * 1024
DEFAULT_ROUTING_SAVE_MAX_BYTES = 1024 * 1024
DEFAULT_CONFIG_EXCHANGE_MAX_BYTES = 4 * 1024 * 1024
DEFAULT_FS_WRITE_MAX_BYTES = 2 * 1024 * 1024


class PayloadTooLargeError(ValueError):
    """Raised when request/file body exceeds the configured hard limit."""

    def __init__(self, max_bytes: int, *, actual: int | None = None) -> None:
        super().__init__("payload too large")
        self.max_bytes = int(max_bytes)
        self.actual = None if actual is None else int(actual)


def _env_int(
    env: Optional[Mapping[str, Any]],
    name: str,
    default: int,
    *,
    minimum: int = 0,
    maximum: int = 128 * 1024 * 1024,
) -> int:
    source = env if env is not None else {}
    raw = None
    try:
        raw = source.get(name)  # type: ignore[union-attr]
    except Exception:
        raw = None
    if raw is None:
        try:
            raw = os.environ.get(name)
        except Exception:
            raw = None

    try:
        value = int(float(str(raw).strip()))
    except Exception:
        value = int(default)

    value = max(int(minimum), value)
    value = min(int(maximum), value)
    return value


def get_routing_save_max_bytes(env: Optional[Mapping[str, Any]] = None) -> int:
    return _env_int(
        env,
        ROUTING_SAVE_MAX_BYTES_ENV,
        DEFAULT_ROUTING_SAVE_MAX_BYTES,
        minimum=64 * 1024,
    )


def get_ui_max_content_length(env: Optional[Mapping[str, Any]] = None) -> int:
    return _env_int(
        env,
        UI_MAX_CONTENT_LENGTH_ENV,
        DEFAULT_UI_MAX_CONTENT_LENGTH,
        minimum=64 * 1024,
    )


def get_json_body_max_bytes(env: Optional[Mapping[str, Any]] = None) -> int:
    return _env_int(
        env,
        JSON_BODY_MAX_BYTES_ENV,
        DEFAULT_JSON_BODY_MAX_BYTES,
        minimum=1024,
    )


def get_json_heavy_max_bytes(env: Optional[Mapping[str, Any]] = None) -> int:
    return _env_int(
        env,
        JSON_HEAVY_MAX_BYTES_ENV,
        DEFAULT_JSON_HEAVY_MAX_BYTES,
        minimum=64 * 1024,
    )


def get_mihomo_json_max_bytes(env: Optional[Mapping[str, Any]] = None) -> int:
    return _env_int(
        env,
        MIHOMO_JSON_MAX_BYTES_ENV,
        DEFAULT_MIHOMO_JSON_MAX_BYTES,
        minimum=128 * 1024,
    )


def get_geodat_upload_max_bytes(env: Optional[Mapping[str, Any]] = None) -> int:
    return _env_int(
        env,
        GEODAT_UPLOAD_MAX_BYTES_ENV,
        DEFAULT_GEODAT_UPLOAD_MAX_BYTES,
        minimum=64 * 1024,
    )


def get_config_exchange_max_bytes(env: Optional[Mapping[str, Any]] = None) -> int:
    return _env_int(
        env,
        CONFIG_EXCHANGE_MAX_BYTES_ENV,
        DEFAULT_CONFIG_EXCHANGE_MAX_BYTES,
        minimum=64 * 1024,
    )


def _check_known_content_length(content_length: Any, *, max_bytes: int) -> None:
    try:
        if content_length is None:
            return
        length = int(content_length)
    except Exception:
        return
    if length > int(max_bytes):
        raise PayloadTooLargeError(max_bytes=max_bytes, actual=length)


def _read_stream_limited(stream, *, max_bytes: int, chunk_size: int = 64 * 1024) -> bytes:
    limit = max(1, int(max_bytes))
    chunk = max(1024, int(chunk_size))
    parts: list[bytes] = []
    total = 0

    while True:
        piece = stream.read(min(chunk, limit - total + 1))
        if not piece:
            break
        total += len(piece)
        if total > limit:
            raise PayloadTooLargeError(max_bytes=limit, actual=total)
        parts.append(piece)
        if total >= limit:
            sentinel = stream.read(1)
            if sentinel:
                raise PayloadTooLargeError(max_bytes=limit, actual=total + len(sentinel))
            break

    return b"".join(parts)


def read_request_bytes_limited(request, *, max_bytes: int, chunk_size: int = 64 * 1024) -> bytes:
    _check_known_content_length(getattr(request, "content_length", None), max_bytes=max_bytes)
    return _read_stream_limited(request.stream, max_bytes=max_bytes, chunk_size=chunk_size)


def read_request_json_limited(
    request,
    *,
    max_bytes: int,
    default: Any = None,
    chunk_size: int = 64 * 1024,
) -> Any:
    raw = read_request_bytes_limited(request, max_bytes=max_bytes, chunk_size=chunk_size)
    if not raw.strip():
        return default
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except Exception:
        return default


def read_uploaded_file_bytes_limited(file_storage, *, max_bytes: int, chunk_size: int = 64 * 1024) -> bytes:
    _check_known_content_length(getattr(file_storage, "content_length", None), max_bytes=max_bytes)
    return _read_stream_limited(file_storage.stream, max_bytes=max_bytes, chunk_size=chunk_size)


def classify_json_request_max_bytes(path: str, env: Optional[Mapping[str, Any]] = None) -> int:
    p = str(path or "").split("?", 1)[0].strip()
    if not p:
        return get_json_body_max_bytes(env)

    if p == "/api/routing":
        return get_routing_save_max_bytes(env)

    if p.startswith("/api/local/") or p.startswith("/api/github/"):
        return get_config_exchange_max_bytes(env)

    if p == "/api/fs/write":
        return int(DEFAULT_FS_WRITE_MAX_BYTES)

    if p.startswith("/api/mihomo"):
        return get_mihomo_json_max_bytes(env)

    if p in ("/api/inbounds", "/api/outbounds", "/api/json/format"):
        return get_json_heavy_max_bytes(env)

    if p.startswith("/api/xray/") or p.startswith("/api/xkeen/"):
        return get_json_heavy_max_bytes(env)

    return get_json_body_max_bytes(env)


def install_request_size_guards(app, *, env: Optional[Mapping[str, Any]] = None) -> None:
    """Install app-wide request size guards for API routes.

    The guard has two layers:
      - explicit Flask ``MAX_CONTENT_LENGTH`` ceiling for all request bodies;
      - per-route JSON body ceilings applied before route handlers run.
    """

    from flask import jsonify, request
    from werkzeug.exceptions import RequestEntityTooLarge

    max_content_length = get_ui_max_content_length(env)
    try:
        app.config["MAX_CONTENT_LENGTH"] = int(max_content_length)
    except Exception:
        pass

    def _too_large_response(max_bytes: int):
        return jsonify({"ok": False, "error": "payload too large", "max_bytes": int(max_bytes)}), 413

    @app.errorhandler(RequestEntityTooLarge)
    def _handle_request_entity_too_large(_exc):
        if str(getattr(request, "path", "") or "").startswith("/api/"):
            limit = app.config.get("MAX_CONTENT_LENGTH") or max_content_length
            return _too_large_response(int(limit))
        return _exc

    @app.before_request
    def _guard_json_request_size():
        try:
            path = str(getattr(request, "path", "") or "")
        except Exception:
            path = ""

        if not path.startswith("/api/"):
            return None

        method = str(getattr(request, "method", "") or "").upper()
        if method not in ("POST", "PUT", "PATCH", "DELETE"):
            return None

        try:
            is_json = bool(request.is_json)
        except Exception:
            is_json = False
        if not is_json:
            return None

        max_bytes = classify_json_request_max_bytes(path, env)
        try:
            raw = read_request_bytes_limited(request, max_bytes=max_bytes)
        except PayloadTooLargeError as e:
            return _too_large_response(int(e.max_bytes))

        try:
            request._cached_data = raw  # type: ignore[attr-defined]
        except Exception:
            pass
        return None
