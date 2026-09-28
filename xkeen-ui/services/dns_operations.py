"""The outcome of the last DNS-protection operation, kept for the window.

Switching either DNS protection restarts the core, and a restart can take the
browser's connection down with it: access through a tunnel that itself runs
through the core drops for half a minute.  The operation still finishes on the
router, but its answer is written into a dead socket and the window waits for
nothing until its timeout.

So the window sends a random id with the request, the route writes the answer
here under that id exactly as it sent it, and the status carries it back.  A
window that lost the answer finds it in the next status it manages to read.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Any, Optional

from services.io.atomic import _atomic_write_json

FILENAME = "dns_operations.json"
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_LOCK = threading.Lock()


def normalize_id(value: Any) -> str:
    text = str(value or "").strip()
    return text if _ID_RE.match(text) else ""


def _path(ui_state_dir: str) -> str:
    return os.path.join(str(ui_state_dir or ""), FILENAME)


def _read(ui_state_dir: str) -> dict[str, Any]:
    try:
        with open(_path(ui_state_dir), "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def record(
    ui_state_dir: str,
    feature: str,
    operation_id: Any,
    *,
    action: str,
    status_code: int,
    body: Any,
) -> None:
    """Keep the answer of one operation; only the latest per feature."""

    op_id = normalize_id(operation_id)
    if not op_id or not ui_state_dir:
        return
    entry = {
        "id": op_id,
        "action": str(action or ""),
        "status_code": int(status_code),
        "body": body if isinstance(body, dict) else {},
        "finished_at": time.time(),
    }
    with _LOCK:
        data = _read(ui_state_dir)
        data[feature] = entry
        try:
            os.makedirs(str(ui_state_dir), exist_ok=True)
            _atomic_write_json(_path(ui_state_dir), data)
        except OSError:
            # Losing this only costs the window its fallback; the operation
            # itself has already been applied and answered.
            pass


def last(ui_state_dir: str, feature: str) -> Optional[dict[str, Any]]:
    entry = _read(ui_state_dir).get(feature)
    return entry if isinstance(entry, dict) and entry.get("id") else None


def remember_response(ui_state_dir: str, feature: str, payload: Any) -> None:
    """Record the answer of the current Flask request once it is built.

    Hooked with ``after_this_request`` so every return path of the route --
    refusals before the operation included -- is recorded the same way.
    """

    from flask import after_this_request

    op_id = normalize_id((payload or {}).get("operation_id") if isinstance(payload, dict) else "")
    if not op_id:
        return
    action = str((payload or {}).get("action") or "").strip().lower()

    @after_this_request
    def _remember(response):  # type: ignore[no-untyped-def]
        try:
            body = response.get_json(silent=True)
        except Exception:  # noqa: BLE001 - a body that is not JSON is recorded empty
            body = None
        record(
            ui_state_dir,
            feature,
            op_id,
            action=action,
            status_code=response.status_code,
            body=body,
        )
        return response
