"""Bounded JSON parsers for Mihomo Clash API responses and streams.

Mihomo's HTTP endpoints return JSON while its streaming HTTP responses use
newline-delimited JSON.  Parsing lives in a dependency-free module so the same
limits apply to TCP, Unix socket and HTTP-fallback transports.
"""

from __future__ import annotations

import json
from typing import Any


DEFAULT_MAX_JSON_BYTES = 2 * 1024 * 1024
DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024


class MihomoClashPayloadError(ValueError):
    """Safe parser error with a stable public code."""

    def __init__(self, code: str, message: str):
        self.code = str(code or "upstream_invalid_payload")
        super().__init__(str(message or "Invalid upstream payload."))


def parse_bounded_json(
    payload: bytes | bytearray | memoryview,
    *,
    max_bytes: int = DEFAULT_MAX_JSON_BYTES,
) -> Any:
    """Decode one UTF-8 JSON value after enforcing a byte-size limit."""

    raw = bytes(payload)
    limit = max(1, int(max_bytes))
    if len(raw) > limit:
        raise MihomoClashPayloadError(
            "upstream_payload_too_large",
            "Mihomo returned a payload larger than the configured limit.",
        )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise MihomoClashPayloadError(
            "upstream_encoding_invalid",
            "Mihomo returned a non-UTF-8 payload.",
        ) from exc
    try:
        return json.loads(text)
    except (json.JSONDecodeError, RecursionError) as exc:
        raise MihomoClashPayloadError(
            "upstream_invalid_json",
            "Mihomo returned invalid JSON.",
        ) from exc


class BoundedNDJSONParser:
    """Incrementally parse bounded newline-delimited JSON frames.

    A final frame does not need to end in a newline.  Buffer and frame limits
    are identical by default, preventing a producer from growing memory while
    withholding a delimiter.
    """

    def __init__(self, *, max_frame_bytes: int = DEFAULT_MAX_FRAME_BYTES):
        self.max_frame_bytes = max(1, int(max_frame_bytes))
        self._buffer = bytearray()

    @property
    def buffered_bytes(self) -> int:
        return len(self._buffer)

    def feed(self, chunk: bytes | bytearray | memoryview) -> list[Any]:
        if not isinstance(chunk, (bytes, bytearray, memoryview)):
            raise TypeError("NDJSON chunks must be bytes-like")
        if chunk:
            self._buffer.extend(bytes(chunk))

        frames: list[Any] = []
        while True:
            newline = self._buffer.find(b"\n")
            if newline < 0:
                if len(self._buffer) > self.max_frame_bytes:
                    self._raise_oversized()
                break

            raw = bytes(self._buffer[:newline]).rstrip(b"\r")
            del self._buffer[: newline + 1]
            if not raw.strip():
                continue
            frames.append(parse_bounded_json(raw, max_bytes=self.max_frame_bytes))
        return frames

    def finish(self) -> list[Any]:
        if not self._buffer:
            return []
        raw = bytes(self._buffer).rstrip(b"\r")
        self._buffer.clear()
        if not raw.strip():
            return []
        return [parse_bounded_json(raw, max_bytes=self.max_frame_bytes)]

    def _raise_oversized(self) -> None:
        self._buffer.clear()
        raise MihomoClashPayloadError(
            "upstream_frame_too_large",
            "Mihomo returned a stream frame larger than the configured limit.",
        )


__all__ = [
    "BoundedNDJSONParser",
    "DEFAULT_MAX_FRAME_BYTES",
    "DEFAULT_MAX_JSON_BYTES",
    "MihomoClashPayloadError",
    "parse_bounded_json",
]
