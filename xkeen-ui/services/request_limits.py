"""Shared helpers for request body size limits."""

from __future__ import annotations

import json
import os
from typing import Any, Mapping, Optional


ROUTING_SAVE_MAX_BYTES_ENV = "XKEEN_ROUTING_SAVE_MAX_BYTES"
CONFIG_EXCHANGE_MAX_BYTES_ENV = "XKEEN_CONFIG_EXCHANGE_MAX_BYTES"

DEFAULT_ROUTING_SAVE_MAX_BYTES = 1024 * 1024
DEFAULT_CONFIG_EXCHANGE_MAX_BYTES = 4 * 1024 * 1024


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
