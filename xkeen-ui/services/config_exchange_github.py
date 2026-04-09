"""GitHub / config-server integration.

PR15: moved out of app.py.

This module supports two backends:
1) Public GitHub repo (raw.githubusercontent.com) for listing/importing bundles
2) External config server (FastAPI) for uploading bundles

Important: keep response payload fields stable by preserving existing helper
semantics (sanitize, caching, timeouts).
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import TimeoutError as FutureTimeoutError
from typing import Any, Dict, List, Tuple

from services.net import net_call, NET_EXECUTOR


# ---------------------------
# Environment / configuration
# ---------------------------

GITHUB_OWNER = os.environ.get("XKEEN_GITHUB_OWNER", "umarcheh001")
GITHUB_REPO = os.environ.get("XKEEN_GITHUB_REPO", "xkeen-community-configs")
GITHUB_BRANCH = os.environ.get("XKEEN_GITHUB_BRANCH", "main")

CONFIG_SERVER_BASE = os.environ.get("XKEEN_CONFIG_SERVER_BASE", "http://144.31.17.58:8000")

# Seconds: how long to consider cached index "fresh".
_GH_INDEX_TTL = int(os.environ.get("XKEEN_GITHUB_INDEX_CACHE_TTL", "60") or 60)


# ---------------------------
# Config server
# ---------------------------


def config_server_request(path: str, *, method: str = "GET", payload=None):
    """Perform a blocking HTTP request to the config server and parse JSON."""
    base = (CONFIG_SERVER_BASE or "").rstrip("/")
    url = base + path

    data = None
    headers: Dict[str, str] = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers or None, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        return json.loads(raw)


def config_server_request_safe(
    path: str,
    *,
    method: str = "GET",
    payload=None,
    wait_seconds: float = 8.0,
):
    """Call config server in a worker thread to avoid blocking the UI."""
    return net_call(lambda: config_server_request(path, method=method, payload=payload), wait_seconds)


# ---------------------------
# GitHub raw
# ---------------------------


def github_raw_get(path: str) -> str | None:
    """Read a file from the public GitHub repo via raw.githubusercontent.com.

    Returns string, or None if file is missing (404).
    """
    base = f"https://raw.githubusercontent.com/{GITHUB_OWNER}/{GITHUB_REPO}/{GITHUB_BRANCH}"
    url = base.rstrip("/") + "/" + path.lstrip("/")

    req = urllib.request.Request(url, headers={"User-Agent": "xkeen-ui"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def github_raw_get_safe(path: str, *, wait_seconds: float = 3.0) -> str | None:
    """Fetch a GitHub raw path with a short wait on the main thread."""
    return net_call(lambda: github_raw_get(path), wait_seconds)


# ---------------------------
# GitHub index caching
# ---------------------------


_GH_INDEX_CACHE: Dict[str, Any] = {"items": [], "ts": 0.0}
_GH_INDEX_FUTURE = None
_GH_INDEX_LOCK = threading.Lock()


def _github_fetch_index_items() -> List[Dict[str, Any]]:
    raw = github_raw_get("configs/index.json")
    if not raw:
        return []
    items = json.loads(raw)
    if not isinstance(items, list):
        return []
    # type: ignore[return-value]
    return items


def github_get_index_items(
    *,
    wait_seconds: float = 2.0,
    force_refresh: bool = False,
) -> Tuple[List[Dict[str, Any]], bool]:
    """Get configs index items without blocking the UI server.

    Returns:
        (items, stale)
    """
    now = time.time()
    ttl = max(5, int(_GH_INDEX_TTL))

    with _GH_INDEX_LOCK:
        # Serve fresh cache immediately.
        if not force_refresh and _GH_INDEX_CACHE["items"] and (now - float(_GH_INDEX_CACHE["ts"])) < ttl:
            # type: ignore[return-value]
            return _GH_INDEX_CACHE["items"], False

        # Ensure a background fetch is in-flight.
        global _GH_INDEX_FUTURE  # noqa: PLW0603
        if _GH_INDEX_FUTURE is None or _GH_INDEX_FUTURE.done():
            _GH_INDEX_FUTURE = NET_EXECUTOR.submit(_github_fetch_index_items)
        future = _GH_INDEX_FUTURE

    # Wait a bit for the background fetch (outside the lock to avoid blocking).
    try:
        items = future.result(timeout=max(0.1, float(wait_seconds)))
        if isinstance(items, list):
            with _GH_INDEX_LOCK:
                _GH_INDEX_CACHE["items"] = items
                _GH_INDEX_CACHE["ts"] = time.time()
            # type: ignore[return-value]
            return items, False
    except FutureTimeoutError:
        # Timeout: fall back to cache if any.
        with _GH_INDEX_LOCK:
            cached = _GH_INDEX_CACHE["items"]
        if cached:
            return cached, True  # type: ignore[return-value]
        raise TimeoutError("timeout")
    except Exception:
        with _GH_INDEX_LOCK:
            cached = _GH_INDEX_CACHE["items"]
        if cached:
            return cached, True  # type: ignore[return-value]
        raise

    # Unexpected type; fall back to cache.
    with _GH_INDEX_LOCK:
        cached = _GH_INDEX_CACHE["items"]
    if cached:
        return cached, True  # type: ignore[return-value]
    return [], False


def sanitize_github_index_items(items) -> List[Dict[str, Any]]:
    """Return a small, safe subset of fields for the UI."""
    out: List[Dict[str, Any]] = []
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        _id = it.get("id")
        if not _id:
            continue
        try:
            created_at = int(it.get("created_at", 0) or 0)
        except Exception:
            created_at = 0
        tags = it.get("tags")
        if not isinstance(tags, list):
            tags = []
        out.append(
            {
                "id": str(_id),
                "title": str(it.get("title") or _id),
                "created_at": created_at,
                "tags": tags[:32],
            }
        )
    return out
