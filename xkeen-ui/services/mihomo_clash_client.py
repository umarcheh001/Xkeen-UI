"""Allow-listed HTTP client for the local Mihomo Clash API.

The browser never supplies a controller address, method or path.  Callers pick
an operation from :data:`MIHOMO_CLASH_ENDPOINTS`; the client connects only to a
target produced by ``mihomo_clash_target`` and supports both loopback TCP and a
Unix domain socket without an additional runtime dependency.
"""

from __future__ import annotations

import http.client
import socket
import time
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Iterator, Mapping

from services.mihomo_clash_stream import (
    BoundedNDJSONParser,
    MihomoClashPayloadError,
    parse_bounded_json,
)
from services.mihomo_clash_target import MihomoClashTarget


DEFAULT_RESPONSE_LIMIT = 2 * 1024 * 1024
DEFAULT_STREAM_FRAME_LIMIT = 2 * 1024 * 1024
READ_CHUNK_BYTES = 64 * 1024


@dataclass(frozen=True)
class MihomoClashEndpoint:
    method: str
    path: str
    timeout_seconds: float
    max_response_bytes: int = DEFAULT_RESPONSE_LIMIT
    stream: bool = False


MIHOMO_CLASH_ENDPOINTS: Mapping[str, MihomoClashEndpoint] = MappingProxyType(
    {
        "version": MihomoClashEndpoint("GET", "/version", 2.0, 64 * 1024),
        "configs": MihomoClashEndpoint("GET", "/configs", 3.0, 512 * 1024),
        "proxies": MihomoClashEndpoint("GET", "/proxies", 5.0),
        "groups": MihomoClashEndpoint("GET", "/group", 5.0),
        "providers_proxies": MihomoClashEndpoint("GET", "/providers/proxies", 8.0),
        "connections_snapshot": MihomoClashEndpoint("GET", "/connections", 5.0),
        "connections_stream": MihomoClashEndpoint(
            "GET",
            "/connections?interval=1000",
            15.0,
            DEFAULT_STREAM_FRAME_LIMIT,
            stream=True,
        ),
    }
)


@dataclass(frozen=True)
class MihomoClashJSONResponse:
    payload: Any
    status: int
    elapsed_ms: float
    size_bytes: int


class MihomoClashClientError(RuntimeError):
    """Sanitized upstream failure safe to map into an Xkeen response."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = 502,
        upstream_status: int | None = None,
        retryable: bool = False,
    ):
        self.code = str(code or "upstream_error")
        self.status = int(status)
        self.upstream_status = int(upstream_status) if upstream_status is not None else None
        self.retryable = bool(retryable)
        super().__init__(str(message or "Mihomo API request failed."))

    def public_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "code": self.code,
            "retryable": self.retryable,
        }
        if self.upstream_status is not None:
            payload["upstream_status"] = self.upstream_status
        return payload


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path: str, *, timeout: float):
        self._socket_path = socket_path
        super().__init__("localhost", timeout=timeout)

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(self.timeout)
            sock.connect(self._socket_path)
        except Exception:
            sock.close()
            raise
        self.sock = sock


class MihomoClashClient:
    """Small synchronous client intended for Flask worker calls."""

    def __init__(
        self,
        target: MihomoClashTarget,
        *,
        endpoints: Mapping[str, MihomoClashEndpoint] | None = None,
    ):
        if target.transport not in {"tcp", "unix"}:
            raise ValueError("unsupported Mihomo transport")
        self._target = target
        supplied = MIHOMO_CLASH_ENDPOINTS if endpoints is None else endpoints
        validated: dict[str, MihomoClashEndpoint] = {}
        for raw_name, spec in supplied.items():
            name = str(raw_name or "")
            if not name or not isinstance(spec, MihomoClashEndpoint):
                raise ValueError("invalid Mihomo endpoint table")
            method = str(spec.method or "").upper()
            path = str(spec.path or "")
            if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
                raise ValueError("invalid Mihomo endpoint method")
            if not path.startswith("/") or path.startswith("//") or "#" in path or "\x00" in path:
                raise ValueError("invalid Mihomo endpoint path")
            if spec.timeout_seconds <= 0 or spec.max_response_bytes <= 0:
                raise ValueError("invalid Mihomo endpoint limits")
            validated[name] = spec
        self._endpoints = MappingProxyType(validated)

    def request_json(self, operation: str) -> MihomoClashJSONResponse:
        spec = self._endpoint(operation, stream=False)
        started = time.monotonic()
        connection: http.client.HTTPConnection | None = None
        response: http.client.HTTPResponse | None = None
        try:
            connection = self._open_connection(spec.timeout_seconds)
            connection.request(spec.method, spec.path, headers=self._headers())
            response = connection.getresponse()
            self._validate_response(response, stream=False)
            raw = self._read_bounded(response, spec.max_response_bytes)
            payload = parse_bounded_json(raw, max_bytes=spec.max_response_bytes)
            return MihomoClashJSONResponse(
                payload=payload,
                status=int(response.status),
                elapsed_ms=round((time.monotonic() - started) * 1000.0, 1),
                size_bytes=len(raw),
            )
        except MihomoClashClientError:
            raise
        except MihomoClashPayloadError as exc:
            raise MihomoClashClientError(exc.code, str(exc), status=502) from exc
        except (TimeoutError, socket.timeout) as exc:
            raise MihomoClashClientError(
                "upstream_timeout",
                "Mihomo API did not respond before the timeout.",
                status=504,
                retryable=True,
            ) from exc
        except (ConnectionError, OSError, http.client.HTTPException) as exc:
            raise MihomoClashClientError(
                "upstream_unreachable",
                "Mihomo API is not reachable.",
                status=502,
                retryable=True,
            ) from exc
        finally:
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass
            if connection is not None:
                connection.close()

    def iter_json_frames(self, operation: str = "connections_stream") -> Iterator[Any]:
        """Yield bounded NDJSON frames and always close the upstream socket."""

        spec = self._endpoint(operation, stream=True)
        connection: http.client.HTTPConnection | None = None
        response: http.client.HTTPResponse | None = None
        parser = BoundedNDJSONParser(max_frame_bytes=spec.max_response_bytes)
        try:
            connection = self._open_connection(spec.timeout_seconds)
            connection.request(spec.method, spec.path, headers=self._headers())
            response = connection.getresponse()
            self._validate_response(response, stream=True)
            while True:
                chunk = response.read1(READ_CHUNK_BYTES)
                if not chunk:
                    break
                for frame in parser.feed(chunk):
                    yield frame
            yield from parser.finish()
        except MihomoClashClientError:
            raise
        except MihomoClashPayloadError as exc:
            raise MihomoClashClientError(exc.code, str(exc), status=502) from exc
        except (TimeoutError, socket.timeout) as exc:
            raise MihomoClashClientError(
                "upstream_timeout",
                "Mihomo API stream timed out.",
                status=504,
                retryable=True,
            ) from exc
        except (ConnectionError, OSError, http.client.HTTPException) as exc:
            raise MihomoClashClientError(
                "upstream_unreachable",
                "Mihomo API stream is not reachable.",
                status=502,
                retryable=True,
            ) from exc
        finally:
            if response is not None:
                try:
                    response.close()
                except Exception:
                    pass
            if connection is not None:
                connection.close()

    def _endpoint(self, operation: str, *, stream: bool) -> MihomoClashEndpoint:
        try:
            spec = self._endpoints[str(operation)]
        except (KeyError, TypeError) as exc:
            raise MihomoClashClientError(
                "operation_not_allowed",
                "The requested Mihomo API operation is not allowed.",
                status=400,
            ) from exc
        if bool(spec.stream) != bool(stream):
            raise MihomoClashClientError(
                "operation_not_allowed",
                "The requested Mihomo API operation is not valid for this transport mode.",
                status=400,
            )
        return spec

    def _open_connection(self, timeout: float) -> http.client.HTTPConnection:
        if self._target.transport == "unix":
            if self._target.socket_path is None:
                raise MihomoClashClientError(
                    "target_invalid",
                    "The Mihomo Unix socket target is invalid.",
                    status=500,
                )
            return _UnixHTTPConnection(str(self._target.socket_path), timeout=timeout)
        if not self._target.loopback_host or not self._target.port:
            raise MihomoClashClientError(
                "target_invalid",
                "The Mihomo TCP target is invalid.",
                status=500,
            )
        return http.client.HTTPConnection(
            self._target.loopback_host,
            self._target.port,
            timeout=timeout,
        )

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json, application/x-ndjson",
            "Connection": "close",
            "User-Agent": "Xkeen-UI-Mihomo-Clash/1",
        }
        authorization = self._target.authorization_header()
        if authorization:
            headers["Authorization"] = authorization
        return headers

    @staticmethod
    def _validate_response(response: http.client.HTTPResponse, *, stream: bool) -> None:
        status = int(response.status)
        if status < 200 or status >= 300:
            if status in {401, 403}:
                code, message = "api_unauthorized", "Mihomo API rejected its configured credential."
            elif status == 404:
                code, message = "endpoint_not_supported", "This Mihomo API endpoint is not supported."
            elif status == 429:
                code, message = "upstream_busy", "Mihomo API is temporarily busy."
            else:
                code, message = "upstream_http_error", "Mihomo API returned an error response."
            raise MihomoClashClientError(
                code,
                message,
                status=502,
                upstream_status=status,
                retryable=status == 429 or status >= 500,
            )

        content_type = str(response.getheader("Content-Type") or "").split(";", 1)[0].strip().lower()
        allowed = {"application/json", "application/x-ndjson", "application/ndjson"}
        if content_type not in allowed:
            raise MihomoClashClientError(
                "upstream_content_type_invalid",
                "Mihomo API returned an unexpected content type.",
                status=502,
            )

    @staticmethod
    def _read_bounded(response: http.client.HTTPResponse, limit: int) -> bytes:
        maximum = max(1, int(limit))
        raw_length = response.getheader("Content-Length")
        if raw_length:
            try:
                declared = int(raw_length)
            except (TypeError, ValueError):
                declared = -1
            if declared > maximum:
                raise MihomoClashClientError(
                    "upstream_payload_too_large",
                    "Mihomo returned a payload larger than the configured limit.",
                    status=502,
                )

        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = response.read(min(READ_CHUNK_BYTES, maximum + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > maximum:
                raise MihomoClashClientError(
                    "upstream_payload_too_large",
                    "Mihomo returned a payload larger than the configured limit.",
                    status=502,
                )
        return b"".join(chunks)


__all__ = [
    "DEFAULT_RESPONSE_LIMIT",
    "DEFAULT_STREAM_FRAME_LIMIT",
    "MIHOMO_CLASH_ENDPOINTS",
    "MihomoClashClient",
    "MihomoClashClientError",
    "MihomoClashEndpoint",
    "MihomoClashJSONResponse",
]
