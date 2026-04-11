"""One-time WebSocket tokens.

Moved out of `app.py` to keep it smaller and easier to maintain.
`run_server.py` still imports `validate_ws_token` from `app.py` (re-exported).

Tokens are *one-time*: successful validation consumes the token.
"""

from __future__ import annotations

import secrets
import threading
import time
from typing import Dict, Tuple


# Allowed scopes: used to avoid cross-using tokens between endpoints.
WS_TOKEN_SCOPES = {"pty", "cmd", "logs", "events"}

# token -> (expires_ts, scope)
_WS_TOKENS: Dict[str, Tuple[float, str]] = {}
_WS_TOKENS_LOCK = threading.Lock()


def _cleanup_ws_tokens_locked(now: float) -> None:
    """Remove expired tokens (lock must be held)."""
    try:
        dead = [t for t, (exp, _scope) in _WS_TOKENS.items() if float(exp) < float(now)]
        for t in dead:
            _WS_TOKENS.pop(t, None)
    except Exception:
        # Never fail hard on cleanup
        pass


def issue_ws_token(scope: str = "pty", ttl_seconds: int = 60) -> str:
    """Issue a one-time token for a given WS endpoint scope."""
    try:
        scope = (scope or "pty").strip().lower()
    except Exception:
        scope = "pty"
    if scope not in WS_TOKEN_SCOPES:
        scope = "pty"

    try:
        ttl = int(ttl_seconds)
    except Exception:
        ttl = 60
    ttl = max(10, min(300, ttl))

    token = secrets.token_urlsafe(24)
    exp = time.time() + ttl

    with _WS_TOKENS_LOCK:
        # Opportunistic cleanup to prevent unbounded growth.
        if len(_WS_TOKENS) > 1024:
            _cleanup_ws_tokens_locked(time.time())
        _WS_TOKENS[token] = (float(exp), scope)

    return token


def validate_ws_token(token: str, scope: str = "pty") -> bool:
    """Validate and consume (one-time) WS token."""
    try:
        token = (token or "").strip()
    except Exception:
        token = ""
    if not token:
        return False

    try:
        scope = (scope or "pty").strip().lower()
    except Exception:
        scope = "pty"
    if scope not in WS_TOKEN_SCOPES:
        scope = "pty"

    now = time.time()

    # Predictable cleanup: validation traffic should also prune expired entries,
    # not only opportunistic issue-side growth checks.
    with _WS_TOKENS_LOCK:
        _cleanup_ws_tokens_locked(now)
        rec = _WS_TOKENS.pop(token, None)

    if not rec:
        return False
    exp, tok_scope = rec
    if now > float(exp):
        return False
    if tok_scope != scope:
        return False
    return True


# Backward-compatible helpers
def issue_pty_ws_token(ttl_seconds: int = 60) -> str:
    return issue_ws_token(scope="pty", ttl_seconds=ttl_seconds)


def validate_pty_ws_token(token: str) -> bool:
    return validate_ws_token(token, scope="pty")


def validate_cmd_ws_token(token: str) -> bool:
    return validate_ws_token(token, scope="cmd")
