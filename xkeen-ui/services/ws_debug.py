"""WebSocket/WS-related debug logging helper.

This module exists to keep `app.py` thin and to preserve compatibility with
`run_server.py`, which imports `ws_debug` from `app`.

Implementation is intentionally defensive: it must never break core app logic.
"""

from __future__ import annotations

from typing import Any, Optional


_UI_WS_LOG_PATH: Optional[str] = None


def init_ws_debug(ui_ws_log_path: Optional[str]) -> None:
    """Optionally provide a direct ws.log file path for fallback logging."""
    global _UI_WS_LOG_PATH
    try:
        _UI_WS_LOG_PATH = str(ui_ws_log_path) if ui_ws_log_path else None
    except Exception:
        _UI_WS_LOG_PATH = None


def ws_debug(msg: str, **extra: Any) -> None:
    """Best-effort debug logger.

    Usage: `ws_debug("text", key="value", ...)`.
    Never raises.
    """
    try:
        if extra:
            try:
                tail = ", ".join(f"{k}={v}" for k, v in extra.items())
            except Exception:
                tail = repr(extra)
            full = f"{msg} | {tail}"
        else:
            full = msg

        try:
            from services.logging_setup import ws_enabled, ws_logger

            if not ws_enabled():
                return
            try:
                ws_logger().debug(full)
                return
            except Exception:
                # Fall through to file append
                pass
        except Exception:
            # logging_setup import is optional
            pass

        # Fallback: append to ws log file if path is provided
        try:
            path = _UI_WS_LOG_PATH
            if not path:
                return
            import os

            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(full + "\n")
        except Exception:
            pass
    except Exception:
        # Absolutely never break core flow
        return
