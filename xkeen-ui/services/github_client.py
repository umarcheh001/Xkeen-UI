"""One place for every request the panel makes to GitHub.

Anonymous GitHub API access is limited to 60 requests per hour per external
address, shared by every router and computer behind it. This module keeps that
budget:

  - the latest stable tag is read from the ``/releases/latest`` web redirect,
    which is not an API request;
  - once the API refuses a request because of the limit, no further API
    request leaves the panel until GitHub's own reset time;
  - an optional personal token (``XKEEN_UI_GITHUB_TOKEN``) raises the limit.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional, Tuple


_OFFICIAL_API_HOST = "api.github.com"
_MIN_PAUSE_S = 60.0
_MAX_PAUSE_S = 3600.0
_REDIRECT_STATUSES = (301, 302, 303, 307, 308)


class GitHubRateLimited(OSError):
    """The API refused a request because of the rate limit.

    Subclasses ``OSError`` so that callers treating GitHub as "unavailable"
    keep working without knowing about the limit.
    """

    def __init__(self, retry_at: float):
        self.retry_at = float(retry_at)
        super().__init__("GitHub API rate limit exceeded")


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, hdrs, newurl):
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler)
_LOCK = threading.Lock()
# (retry_at, fingerprint of the token the refusal was issued for)
_PAUSE: Tuple[float, str] = (0.0, "")


def _open(request: urllib.request.Request, timeout: float, *, follow_redirects: bool = True):
    if follow_redirects:
        return urllib.request.urlopen(request, timeout=float(timeout))
    return _NO_REDIRECT_OPENER.open(request, timeout=float(timeout))


def api_base() -> str:
    base = os.environ.get("XKEEN_UI_GITHUB_API_BASE", "https://api.github.com") or "https://api.github.com"
    return str(base).rstrip("/")


def web_base() -> str:
    base = (os.environ.get("XKEEN_UI_GITHUB_WEB_BASE") or "").strip()
    if base:
        return base.rstrip("/")
    parsed = urllib.parse.urlsplit(api_base())
    if parsed.scheme and parsed.netloc:
        host = "github.com" if parsed.netloc == _OFFICIAL_API_HOST else parsed.netloc
        return f"{parsed.scheme}://{host}"
    return "https://github.com"


def user_agent() -> str:
    return str(os.environ.get("XKEEN_UI_HTTP_USER_AGENT", "xkeen-ui") or "xkeen-ui")


def token() -> str:
    return str(os.environ.get("XKEEN_UI_GITHUB_TOKEN") or "").strip()


def _token_fingerprint() -> str:
    value = token()
    return hashlib.sha256(value.encode("utf-8")).hexdigest() if value else ""


def api_headers(url: str) -> Dict[str, str]:
    headers = {"User-Agent": user_agent(), "Accept": "application/vnd.github+json"}
    value = token()
    # The token belongs to GitHub only: a custom API base must never receive it.
    if value and urllib.parse.urlsplit(url).hostname == _OFFICIAL_API_HOST:
        headers["Authorization"] = f"Bearer {value}"
    return headers


def rate_limit_retry_at() -> float:
    """Unix time before which API requests are not sent; 0.0 when not paused."""
    with _LOCK:
        retry_at, fingerprint = _PAUSE
    if retry_at <= time.time() or fingerprint != _token_fingerprint():
        return 0.0
    return retry_at


def reset_rate_limit_state() -> None:
    global _PAUSE  # noqa: PLW0603
    with _LOCK:
        _PAUSE = (0.0, "")


def _header(headers: Any, name: str) -> str:
    try:
        return str(headers.get(name) or "").strip()
    except Exception:
        return ""


def _rate_limit_retry_at_from(error: urllib.error.HTTPError) -> Optional[float]:
    if int(getattr(error, "code", 0) or 0) not in (403, 429):
        return None
    headers = getattr(error, "headers", None)
    now = time.time()
    retry_after = _header(headers, "Retry-After")
    remaining = _header(headers, "X-RateLimit-Remaining")
    reset = _header(headers, "X-RateLimit-Reset")
    retry_at: Optional[float] = None
    if remaining == "0" and reset:
        try:
            retry_at = float(reset)
        except ValueError:
            retry_at = None
    if retry_at is None and retry_after:
        try:
            retry_at = now + float(retry_after)
        except ValueError:
            retry_at = None
    if retry_at is None:
        if remaining != "0":
            return None
        retry_at = now + _MIN_PAUSE_S
    return min(max(retry_at, now + _MIN_PAUSE_S), now + _MAX_PAUSE_S)


def api_get_json(url: str, *, timeout: float) -> Tuple[Any, Dict[str, Any]]:
    """GET one GitHub API URL. Returns ``(parsed_json, meta)``.

    Raises ``GitHubRateLimited`` without touching the network while the API
    is paused, and on the refusal that starts the pause.
    """
    global _PAUSE  # noqa: PLW0603
    retry_at = rate_limit_retry_at()
    if retry_at:
        raise GitHubRateLimited(retry_at)

    request = urllib.request.Request(url, headers=api_headers(url), method="GET")
    meta: Dict[str, Any] = {"url": url}
    try:
        with _open(request, timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
            meta["status"] = int(getattr(response, "status", 200) or 200)
            meta["etag"] = _header(response.headers, "ETag") or None
            meta["ratelimit_remaining"] = _header(response.headers, "X-RateLimit-Remaining") or None
            meta["ratelimit_limit"] = _header(response.headers, "X-RateLimit-Limit") or None
            meta["ratelimit_reset"] = _header(response.headers, "X-RateLimit-Reset") or None
    except urllib.error.HTTPError as error:
        limited_until = _rate_limit_retry_at_from(error)
        if limited_until is None:
            raise
        with _LOCK:
            _PAUSE = (limited_until, _token_fingerprint())
        raise GitHubRateLimited(limited_until) from error
    return json.loads(raw), meta


def release_tag_from_url(url: str) -> Optional[str]:
    path = urllib.parse.urlsplit(str(url or "")).path or ""
    match = re.search(r"/releases/tag/([^/?#]+)/?$", path)
    return urllib.parse.unquote(match.group(1)) if match else None


def latest_release_tag(repo: str, *, timeout: float) -> Optional[str]:
    """Tag of the latest stable release, read without the API.

    ``github.com/<repo>/releases/latest`` answers with a redirect to the
    release page. Returns ``None`` when the repository has no releases.
    """
    url = f"{web_base()}/{repo}/releases/latest"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": user_agent(), "Accept": "text/html,*/*;q=0.8"},
        method="GET",
    )
    try:
        with _open(request, timeout, follow_redirects=False) as response:
            location = _header(response.headers, "Location") or str(response.geturl() or "")
    except urllib.error.HTTPError as error:
        status = int(getattr(error, "code", 0) or 0)
        if status == 404:
            return None
        if status not in _REDIRECT_STATUSES:
            raise
        location = _header(getattr(error, "headers", None), "Location")
    return release_tag_from_url(urllib.parse.urljoin(url, location))
