"""Dedicated same-origin WebSocket facades for Mihomo runtime streams."""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit

from services.mihomo_clash_client import MihomoClashClient, MihomoClashClientError
from services.mihomo_clash_dto import (
    build_mihomo_clash_connections_dto,
    build_mihomo_clash_log_entry_dto,
)
from services.mihomo_clash_devices import get_mihomo_clash_device_map
from services.mihomo_clash_target import discover_mihomo_clash_target

try:
    from gevent import sleep as _cooperative_sleep  # type: ignore
except Exception:  # pragma: no cover - no-gevent runtime never dispatches this handler
    _cooperative_sleep = time.sleep


def _close_ws(ws: Any) -> None:
    try:
        ws.close()
    except Exception:
        pass


def _send(ws: Any, payload: dict[str, Any]) -> bool:
    try:
        ws.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
        return True
    except Exception:
        return False


_STREAM_LOCK = threading.Lock()
@dataclass
class _StreamLease:
    key: str
    cancelled: threading.Event = field(default_factory=threading.Event)


_ACTIVE_STREAMS: dict[str, _StreamLease] = {}
MAX_ACTIVE_STREAMS = 8


def _request_host(environ: dict[str, Any]) -> str:
    # Do not trust X-Forwarded-Host here: it is frequently client-controlled
    # unless the deployment has an explicit trusted-proxy middleware.
    return str(environ.get("HTTP_HOST") or "").strip().lower()


def is_same_origin_websocket(environ: dict[str, Any]) -> bool:
    """Require a browser Origin whose authority matches the panel request."""

    origin = str(environ.get("HTTP_ORIGIN") or "").strip()
    host = _request_host(environ)
    if not origin or not host:
        return False
    try:
        parsed = urlsplit(origin)
    except Exception:
        return False
    return parsed.scheme.lower() in {"http", "https"} and parsed.netloc.lower() == host


def _envelope(
    *,
    sequence: int,
    state: str,
    payload: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {
        "type": "mihomo-clash-connections",
        "schema_version": 1,
        "sequence": max(0, int(sequence)),
        "received_at_ms": int(time.time() * 1000),
        "state": str(state),
        "payload": payload,
    }
    if error:
        message["error"] = error
    return message


def _log_envelope(
    *,
    sequence: int,
    state: str,
    payload: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
) -> dict[str, Any]:
    message = _envelope(sequence=sequence, state=state, payload=payload, error=error)
    message["type"] = "mihomo-clash-logs"
    return message


def _stream_key(client_key: str, stream_kind: str) -> str:
    client = str(client_key or "unknown")[:96]
    kind = str(stream_kind or "default").strip().lower()[:24] or "default"
    return f"{client}:{kind}"


def _acquire_stream_lease(
    client_key: str,
    stream_kind: str = "default",
    *,
    replace_existing: bool = False,
) -> _StreamLease | None:
    key = _stream_key(client_key, stream_kind)
    with _STREAM_LOCK:
        previous = _ACTIVE_STREAMS.get(key)
        if previous is not None:
            if not replace_existing:
                return None
            previous.cancelled.set()
        elif len(_ACTIVE_STREAMS) >= MAX_ACTIVE_STREAMS:
            return None
        lease = _StreamLease(key=key)
        _ACTIVE_STREAMS[key] = lease
        return lease


def _acquire_stream(client_key: str, stream_kind: str = "default") -> bool:
    return _acquire_stream_lease(client_key, stream_kind) is not None


def _release_stream(
    client_key: str,
    stream_kind: str = "default",
    lease: _StreamLease | None = None,
) -> None:
    key = _stream_key(client_key, stream_kind)
    with _STREAM_LOCK:
        current = _ACTIVE_STREAMS.get(key)
        if lease is None or current is lease:
            _ACTIVE_STREAMS.pop(key, None)


def handle_mihomo_clash_connections_request(
    environ,
    start_response,
    *,
    fallback_app,
    validate_ws_token: Callable[[str, str], bool],
    ws_debug: Callable[..., Any],
    mihomo_config_file: str,
    mihomo_root: str,
    discovery_factory=discover_mihomo_clash_target,
    client_factory=MihomoClashClient,
    device_map_factory=get_mihomo_clash_device_map,
):
    """Stream bounded, normalized connection DTOs until either side closes."""

    if environ.get("wsgi.websocket") is None:
        return fallback_app(environ, start_response)

    ws = environ["wsgi.websocket"]
    if not is_same_origin_websocket(environ):
        _send(ws, _envelope(sequence=0, state="error", error={"code": "origin_rejected"}))
        _close_ws(ws)
        return []

    params = parse_qs(str(environ.get("QUERY_STRING") or ""))
    token = str((params.get("token") or [""])[0] or "").strip()
    if not validate_ws_token(token, scope="mihomo-clash"):
        _send(ws, _envelope(sequence=0, state="error", error={"code": "unauthorized"}))
        _close_ws(ws)
        return []

    client_key = str(environ.get("REMOTE_ADDR") or "unknown")
    lease = _acquire_stream_lease(client_key, "connections", replace_existing=True)
    if lease is None:
        _send(ws, _envelope(sequence=0, state="error", error={"code": "stream_busy"}))
        _close_ws(ws)
        return []

    sequence = 0
    ws_debug("mihomo clash connections stream opened", client=environ.get("REMOTE_ADDR", "unknown"))
    try:
        while True:
            if lease.cancelled.is_set():
                break
            # The official GET endpoint is a bounded snapshot. Polling it inside
            # this one browser stream also works for Unix sockets and avoids a
            # second WebSocket implementation/credential path on the router.
            discovery = discovery_factory(mihomo_config_file, mihomo_root)
            if discovery.target is None:
                _send(
                    ws,
                    _envelope(
                        sequence=sequence,
                        state="error",
                        error={"code": "target_unavailable", "retryable": False},
                    ),
                )
                break
            client = client_factory(discovery.target)
            raw_frame = client.request_json("connections_snapshot").payload
            memory_frame = client.request_memory().payload
            sequence += 1
            payload = build_mihomo_clash_connections_dto(
                raw_frame,
                device_map=device_map_factory(),
                memory=memory_frame.get("inuse") if isinstance(memory_frame, dict) else 0,
            )
            if not _send(ws, _envelope(sequence=sequence, state="live", payload=payload)):
                break
            _cooperative_sleep(1.0)
    except MihomoClashClientError as exc:
        _send(
            ws,
            _envelope(
                sequence=sequence,
                state="error",
                error={"code": exc.code, "retryable": exc.retryable},
            ),
        )
    except Exception:
        _send(
            ws,
            _envelope(
                sequence=sequence,
                state="error",
                error={"code": "stream_failed", "retryable": True},
            ),
        )
    finally:
        _close_ws(ws)
        _release_stream(client_key, "connections", lease)
        ws_debug("mihomo clash connections stream closed", frames=sequence)
    return []


def handle_mihomo_clash_logs_request(
    environ,
    start_response,
    *,
    fallback_app,
    validate_ws_token: Callable[[str, str], bool],
    ws_debug: Callable[..., Any],
    mihomo_config_file: str,
    mihomo_root: str,
    discovery_factory=discover_mihomo_clash_target,
    client_factory=MihomoClashClient,
    device_map_factory=get_mihomo_clash_device_map,
):
    """Relay only normalized structured log entries while the drawer is open."""

    if environ.get("wsgi.websocket") is None:
        return fallback_app(environ, start_response)

    ws = environ["wsgi.websocket"]
    if not is_same_origin_websocket(environ):
        _send(ws, _log_envelope(sequence=0, state="error", error={"code": "origin_rejected"}))
        _close_ws(ws)
        return []

    params = parse_qs(str(environ.get("QUERY_STRING") or ""))
    token = str((params.get("token") or [""])[0] or "").strip()
    if not validate_ws_token(token, scope="mihomo-clash-logs"):
        _send(ws, _log_envelope(sequence=0, state="error", error={"code": "unauthorized"}))
        _close_ws(ws)
        return []

    client_key = str(environ.get("REMOTE_ADDR") or "unknown")
    lease = _acquire_stream_lease(client_key, "logs", replace_existing=True)
    if lease is None:
        _send(ws, _log_envelope(sequence=0, state="error", error={"code": "stream_busy"}))
        _close_ws(ws)
        return []

    sequence = 0
    ws_debug("mihomo clash logs stream opened", client=environ.get("REMOTE_ADDR", "unknown"))
    try:
        discovery = discovery_factory(mihomo_config_file, mihomo_root)
        if discovery.target is None:
            _send(
                ws,
                _log_envelope(
                    sequence=0,
                    state="error",
                    error={"code": "target_unavailable", "retryable": False},
                ),
            )
            return []
        client = client_factory(discovery.target)
        for raw_frame in client.iter_json_frames(
            "logs_stream",
            should_stop=lease.cancelled.is_set,
        ):
            if lease.cancelled.is_set():
                break
            sequence += 1
            entry = build_mihomo_clash_log_entry_dto(
                raw_frame,
                sequence=sequence,
                secret=discovery.target.secret,
                device_map=device_map_factory(),
            )
            message = _log_envelope(sequence=sequence, state="live", payload=entry)
            if not _send(ws, message):
                break
    except MihomoClashClientError as exc:
        _send(
            ws,
            _log_envelope(
                sequence=sequence,
                state="error",
                error={"code": exc.code, "retryable": exc.retryable},
            ),
        )
    except Exception:
        _send(
            ws,
            _log_envelope(
                sequence=sequence,
                state="error",
                error={"code": "stream_failed", "retryable": True},
            ),
        )
    finally:
        _close_ws(ws)
        _release_stream(client_key, "logs", lease)
        ws_debug("mihomo clash logs stream closed", frames=sequence)
    return []


__all__ = [
    "MAX_ACTIVE_STREAMS",
    "handle_mihomo_clash_connections_request",
    "handle_mihomo_clash_logs_request",
    "is_same_origin_websocket",
]
