"""One-time WebSocket token manager for FileOps."""

from __future__ import annotations

import secrets
import time
from typing import Callable, Dict


class WsTokenManager:
    def __init__(self, *, now_fn: Callable[[], float] | None = None) -> None:
        self._now = now_fn or time.time
        self._tokens: Dict[str, float] = {}

    def issue(self, *, ttl_seconds: int = 60) -> str:
        token = secrets.token_urlsafe(24)
        self._tokens[token] = self._now() + int(ttl_seconds)
        return token

    def validate(self, token: str) -> bool:
        try:
            token = (token or '').strip()
        except Exception:
            token = ''
        if not token:
            return False
        exp = self._tokens.get(token)
        if not exp:
            return False
        if self._now() > float(exp):
            self._tokens.pop(token, None)
            return False
        # one-time
        self._tokens.pop(token, None)
        return True


__all__ = ['WsTokenManager']
