"""Login rate limiting and temporary lockout for auth endpoints."""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass
from typing import Any, Mapping, Optional


WINDOW_ENV = "XKEEN_AUTH_LOGIN_WINDOW_SECONDS"
MAX_ATTEMPTS_ENV = "XKEEN_AUTH_LOGIN_MAX_ATTEMPTS"
LOCKOUT_ENV = "XKEEN_AUTH_LOGIN_LOCKOUT_SECONDS"

DEFAULT_WINDOW_SECONDS = 300
DEFAULT_MAX_ATTEMPTS = 5
DEFAULT_LOCKOUT_SECONDS = 900

_STATE_LOCK = threading.Lock()
_FAILED_ATTEMPTS: dict[str, list[float]] = {}
_LOCKED_UNTIL: dict[str, float] = {}


@dataclass(frozen=True)
class LoginRateLimitPolicy:
    enabled: bool
    window_seconds: int
    max_attempts: int
    lockout_seconds: int


def _env_int(
    env: Optional[Mapping[str, Any]],
    name: str,
    default: int,
    *,
    minimum: int = 0,
    maximum: Optional[int] = None,
) -> int:
    source = env if env is not None else {}
    raw = None
    try:
        raw = source.get(name)  # type: ignore[union-attr]
    except Exception:
        raw = None
    if raw is None:
        try:
            import os

            raw = os.environ.get(name)
        except Exception:
            raw = None
    try:
        value = int(float(str(raw).strip()))
    except Exception:
        value = int(default)
    if value < minimum:
        value = minimum
    if maximum is not None and value > maximum:
        value = maximum
    return value


def get_login_rate_limit_policy(env: Optional[Mapping[str, Any]] = None) -> LoginRateLimitPolicy:
    window_seconds = _env_int(
        env,
        WINDOW_ENV,
        DEFAULT_WINDOW_SECONDS,
        minimum=0,
        maximum=24 * 60 * 60,
    )
    max_attempts = _env_int(
        env,
        MAX_ATTEMPTS_ENV,
        DEFAULT_MAX_ATTEMPTS,
        minimum=0,
        maximum=1000,
    )
    lockout_seconds = _env_int(
        env,
        LOCKOUT_ENV,
        DEFAULT_LOCKOUT_SECONDS,
        minimum=0,
        maximum=24 * 60 * 60,
    )
    enabled = bool(window_seconds > 0 and max_attempts > 0 and lockout_seconds > 0)
    return LoginRateLimitPolicy(
        enabled=enabled,
        window_seconds=window_seconds,
        max_attempts=max_attempts,
        lockout_seconds=lockout_seconds,
    )


def _rate_limit_key(remote_addr: Any) -> str:
    try:
        value = str(remote_addr or "").strip()
    except Exception:
        value = ""
    if not value:
        return "unknown"
    return value[:128]


def _cleanup_state(now: float, policy: LoginRateLimitPolicy) -> None:
    cutoff = now - max(int(policy.window_seconds or 0), 1)

    for key, attempts in list(_FAILED_ATTEMPTS.items()):
        recent = [ts for ts in attempts if ts > cutoff]
        if recent:
            _FAILED_ATTEMPTS[key] = recent
        else:
            _FAILED_ATTEMPTS.pop(key, None)

    for key, locked_until in list(_LOCKED_UNTIL.items()):
        if locked_until <= now:
            _LOCKED_UNTIL.pop(key, None)


def _status_payload(
    policy: LoginRateLimitPolicy,
    *,
    failures: int = 0,
    attempts_left: int = 0,
    locked: bool = False,
    retry_after: int = 0,
) -> dict[str, Any]:
    return {
        "enabled": bool(policy.enabled),
        "window_seconds": int(policy.window_seconds),
        "max_attempts": int(policy.max_attempts),
        "lockout_seconds": int(policy.lockout_seconds),
        "failures": max(0, int(failures)),
        "attempts_left": max(0, int(attempts_left)),
        "locked": bool(locked),
        "retry_after": max(0, int(retry_after)),
    }


def get_login_rate_limit_status(
    remote_addr: Any,
    *,
    env: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    policy = get_login_rate_limit_policy(env)
    if not policy.enabled:
        return _status_payload(policy)

    key = _rate_limit_key(remote_addr)
    now = time.monotonic()

    with _STATE_LOCK:
        _cleanup_state(now, policy)
        locked_until = float(_LOCKED_UNTIL.get(key) or 0.0)
        if locked_until > now:
            return _status_payload(
                policy,
                failures=policy.max_attempts,
                attempts_left=0,
                locked=True,
                retry_after=int(math.ceil(locked_until - now)),
            )

        failures = len(_FAILED_ATTEMPTS.get(key) or ())
        return _status_payload(
            policy,
            failures=failures,
            attempts_left=max(0, policy.max_attempts - failures),
        )


def register_login_failure(
    remote_addr: Any,
    *,
    env: Optional[Mapping[str, Any]] = None,
) -> dict[str, Any]:
    policy = get_login_rate_limit_policy(env)
    if not policy.enabled:
        return _status_payload(policy)

    key = _rate_limit_key(remote_addr)
    now = time.monotonic()

    with _STATE_LOCK:
        _cleanup_state(now, policy)
        locked_until = float(_LOCKED_UNTIL.get(key) or 0.0)
        if locked_until > now:
            return _status_payload(
                policy,
                failures=policy.max_attempts,
                attempts_left=0,
                locked=True,
                retry_after=int(math.ceil(locked_until - now)),
            )

        attempts = list(_FAILED_ATTEMPTS.get(key) or ())
        attempts.append(now)
        cutoff = now - max(int(policy.window_seconds or 0), 1)
        attempts = [ts for ts in attempts if ts > cutoff]

        if len(attempts) >= policy.max_attempts:
            _FAILED_ATTEMPTS.pop(key, None)
            _LOCKED_UNTIL[key] = now + float(policy.lockout_seconds)
            return _status_payload(
                policy,
                failures=policy.max_attempts,
                attempts_left=0,
                locked=True,
                retry_after=policy.lockout_seconds,
            )

        _FAILED_ATTEMPTS[key] = attempts
        failures = len(attempts)
        return _status_payload(
            policy,
            failures=failures,
            attempts_left=max(0, policy.max_attempts - failures),
        )


def clear_login_rate_limit(remote_addr: Any) -> None:
    key = _rate_limit_key(remote_addr)
    with _STATE_LOCK:
        _FAILED_ATTEMPTS.pop(key, None)
        _LOCKED_UNTIL.pop(key, None)


def format_lockout_wait(seconds: Any) -> str:
    total = max(0, int(math.ceil(float(seconds or 0))))
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    parts: list[str] = []
    if hours:
        parts.append(f"{hours} ч")
    if minutes:
        parts.append(f"{minutes} мин")
    if secs or not parts:
        parts.append(f"{secs} сек")
    return " ".join(parts)
