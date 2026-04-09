"""Service-wide event broadcast helpers.

`run_server.py` uses WebSocket subscribers for `/ws/events`.
We keep the subscribers list in this module so `app.py` can re-export it and
both modules share the *same* list object.
"""

from __future__ import annotations

import json
import threading
from typing import Any, Dict, List

from services.ws_debug import ws_debug


# Global list of WebSocket subscribers.
# Filled in `run_server.py` when a client connects to /ws/events.
EVENT_SUBSCRIBERS: List[Any] = []

# Protects all mutations and iterations of EVENT_SUBSCRIBERS.
# Use subscribe()/unsubscribe() instead of touching the list directly.
_EVENT_SUBSCRIBERS_LOCK: threading.Lock = threading.Lock()


def subscribe(ws: Any) -> None:
    """Register a WebSocket as an event subscriber. Thread-safe."""
    with _EVENT_SUBSCRIBERS_LOCK:
        EVENT_SUBSCRIBERS.append(ws)


def unsubscribe(ws: Any) -> None:
    """Remove a WebSocket subscriber. Thread-safe. No-op if already removed."""
    with _EVENT_SUBSCRIBERS_LOCK:
        try:
            EVENT_SUBSCRIBERS.remove(ws)
        except ValueError:
            pass


def broadcast_event(event: Dict[str, Any]) -> None:
    """Send an event to all active WebSocket subscribers.

    On systems without gevent/geventwebsocket the list will stay empty.
    This function must never raise.
    """
    try:
        payload: Dict[str, Any] = {"type": "event", **(event or {})}
    except Exception:
        payload = {"type": "event", "raw": repr(event)}

    try:
        data = json.dumps(payload, ensure_ascii=False)
    except Exception as e:
        ws_debug("broadcast_event: failed to encode payload", error=str(e))
        return

    # Snapshot under the lock so we iterate a stable list.
    # We release the lock before calling ws.send() - a slow or blocking send
    # must not stall subscribe/unsubscribe callers on other greenlets/threads.
    with _EVENT_SUBSCRIBERS_LOCK:
        snapshot = list(EVENT_SUBSCRIBERS)

    dead: List[Any] = []
    for ws in snapshot:
        try:
            ws.send(data)
        except Exception as e:  # noqa: BLE001
            dead.append(ws)
            ws_debug("broadcast_event: failed to send to subscriber", error=str(e))

    if dead:
        with _EVENT_SUBSCRIBERS_LOCK:
            for ws in dead:
                try:
                    EVENT_SUBSCRIBERS.remove(ws)
                except ValueError:
                    # Already removed by unsubscribe() racing with us - fine.
                    pass

    ws_debug(
        "broadcast_event: dispatched",
        event=event,
        subscribers=len(snapshot),
        removed=len(dead),
    )
