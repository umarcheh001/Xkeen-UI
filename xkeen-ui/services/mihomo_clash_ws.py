"""Dedicated same-origin WebSocket facade for Mihomo connection snapshots."""

from __future__ import annotations

import json
import threading
import time
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit

from services.mihomo_clash_client import MihomoClashClient, MihomoClashClientError
from services.mihomo_clash_dto import build_mihomo_clash_connections_dto
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
_ACTIVE_STREAMS: dict[str, int] = {}
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


def _acquire_stream(client_key: str) -> bool:
    key = str(client_key or "unknown")[:128]
    with _STREAM_LOCK:
        if sum(_ACTIVE_STREAMS.values()) >= MAX_ACTIVE_STREAMS or _ACTIVE_STREAMS.get(key, 0) >= 1:
            return False
        _ACTIVE_STREAMS[key] = _ACTIVE_STREAMS.get(key, 0) + 1
        return True


def _release_stream(client_key: str) -> None:
    key = str(client_key or "unknown")[:128]
    with _STREAM_LOCK:
        remaining = max(0, _ACTIVE_STREAMS.get(key, 0) - 1)
        if remaining:
            _ACTIVE_STREAMS[key] = remaining
        else:
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
    if not _acquire_stream(client_key):
        _send(ws, _envelope(sequence=0, state="error", error={"code": "stream_busy"}))
        _close_ws(ws)
        return []

    sequence = 0
    ws_debug("mihomo clash connections stream opened", client=environ.get("REMOTE_ADDR", "unknown"))
    try:
        while True:
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
            sequence += 1
            payload = build_mihomo_clash_connections_dto(
                raw_frame,
                device_map=device_map_factory(),
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
        _release_stream(client_key)
        ws_debug("mihomo clash connections stream closed", frames=sequence)
    return []


__all__ = [
    "MAX_ACTIVE_STREAMS",
    "handle_mihomo_clash_connections_request",
    "is_same_origin_websocket",
]
