"""Service-wide event broadcast helpers.

`run_server.py` uses WebSocket subscribers for `/ws/events`.
We keep the subscribers list in this module so `app.py` can re-export it and
both modules share the *same* list object.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

from services.ws_debug import ws_debug


# Global list of WebSocket subscribers.
# Filled in `run_server.py` when a client connects to /ws/events.
EVENT_SUBSCRIBERS: List[Any] = []


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

    dead: List[Any] = []
    for ws in list(EVENT_SUBSCRIBERS):
        try:
            ws.send(data)
        except Exception as e:  # noqa: BLE001
            dead.append(ws)
            ws_debug("broadcast_event: failed to send to subscriber", error=str(e))

    # Remove broken subscribers
    for ws in dead:
        try:
            EVENT_SUBSCRIBERS.remove(ws)
        except ValueError:
            pass
        except Exception:
            pass

    ws_debug(
        "broadcast_event: dispatched",
        event=event,
        subscribers=len(EVENT_SUBSCRIBERS),
        removed=len(dead),
    )
