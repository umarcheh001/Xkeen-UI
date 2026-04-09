from __future__ import annotations

import ipaddress
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence, Tuple
from urllib.parse import urlparse


DEFAULT_TRUSTED_DOWNLOAD_HOSTS: Tuple[str, ...] = (
    "github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "codeload.github.com",
)

_LOCAL_HOSTS = {
    "localhost",
    "localhost.localdomain",
}


@dataclass(frozen=True)
class URLPolicy:
    allow_hosts: Tuple[str, ...]
    allow_http: bool = False
    allow_private_hosts: bool = False
    allow_custom_urls: bool = False


def env_flag(name: str, default: bool = False) -> bool:
    raw = str(os.environ.get(name) or "").strip().lower()
    if not raw:
        return bool(default)
    return raw in {"1", "true", "yes", "on"}


def parse_allow_hosts(
    raw: Optional[str] = None,
    *,
    env_key: Optional[str] = None,
    default_hosts: Sequence[str] = DEFAULT_TRUSTED_DOWNLOAD_HOSTS,
) -> List[str]:
    if raw is None and env_key:
        raw = os.environ.get(env_key)
    src = str(raw or "").strip()
    parts = [p.strip().lower() for p in src.split(",") if p.strip()]
    if not parts:
        parts = [str(h or "").strip().lower() for h in default_hosts if str(h or "").strip()]

    out: List[str] = []
    for part in parts:
        if part and part not in out:
            out.append(part)
    return out


def get_policy_from_env(
    prefix: str,
    *,
    default_hosts: Sequence[str] = DEFAULT_TRUSTED_DOWNLOAD_HOSTS,
) -> URLPolicy:
    pfx = str(prefix or "").strip()
    return URLPolicy(
        allow_hosts=tuple(parse_allow_hosts(env_key=f"{pfx}_ALLOW_HOSTS", default_hosts=default_hosts)),
        allow_http=env_flag(f"{pfx}_ALLOW_HTTP", False),
        allow_private_hosts=env_flag(f"{pfx}_ALLOW_PRIVATE_HOSTS", False),
        allow_custom_urls=env_flag(f"{pfx}_ALLOW_CUSTOM_URLS", False),
    )


def url_host(url: str) -> Optional[str]:
    try:
        return (urlparse(url).hostname or "").lower() or None
    except Exception:
        return None


def host_matches_allow_hosts(host: str, allow_hosts: Iterable[str]) -> bool:
    host_l = str(host or "").strip().lower()
    if not host_l:
        return False
    for raw in allow_hosts:
        allowed = str(raw or "").strip().lower()
        if not allowed:
            continue
        if host_l == allowed or host_l.endswith("." + allowed):
            return True
    return False


def host_is_private_or_local(host: str) -> bool:
    host_l = str(host or "").strip().lower()
    if not host_l:
        return False
    if host_l in _LOCAL_HOSTS or host_l.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(host_l)
    except ValueError:
        return False
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def is_url_allowed(url: str, policy: URLPolicy) -> Tuple[bool, str]:
    url_s = str(url or "").strip()
    if not url_s:
        return False, "empty"

    try:
        parsed = urlparse(url_s)
    except Exception:
        return False, "parse_failed"

    scheme = (parsed.scheme or "").lower()
    if scheme not in ("https", "http"):
        return False, f"bad_scheme:{scheme or 'none'}"
    if scheme == "http" and not policy.allow_http:
        return False, "http_not_allowed"

    host = (parsed.hostname or "").lower()
    if not host:
        return False, "no_host"
    if host_is_private_or_local(host) and not policy.allow_private_hosts:
        return False, f"private_host_not_allowed:{host}"

    if host_matches_allow_hosts(host, policy.allow_hosts):
        return True, "ok"
    if policy.allow_custom_urls:
        return True, "ok_custom"
    return False, f"host_not_allowed:{host}"


def policy_hosts_text(policy: URLPolicy) -> str:
    hosts = [str(h or "").strip() for h in (policy.allow_hosts or ()) if str(h or "").strip()]
    return ", ".join(hosts)


def blocked_url_hint(policy: URLPolicy, *, env_prefix: str, feature_label: str) -> str:
    hosts = policy_hosts_text(policy)
    parts = [
        f"{feature_label}: по умолчанию разрешены только доверенные HTTPS-URL.",
    ]
    if hosts:
        parts.append("Разрешённые хосты: " + hosts + ".")
    parts.append(
        f"Для своего mirror либо добавьте host в {env_prefix}_ALLOW_HOSTS, "
        f"либо явно включите {env_prefix}_ALLOW_CUSTOM_URLS=1."
    )
    parts.append(
        f"Для локальных/private адресов нужен {env_prefix}_ALLOW_PRIVATE_HOSTS=1, "
        f"для plain HTTP нужен {env_prefix}_ALLOW_HTTP=1."
    )
    return " ".join(parts)


def download_to_file_with_policy(
    url: str,
    tmp_path: str,
    max_bytes: int | None,
    *,
    policy: URLPolicy,
    user_agent: str = "Xkeen-UI",
    timeout: int = 45,
) -> int:
    ok, reason = is_url_allowed(url, policy)
    if not ok:
        raise RuntimeError("url_blocked:" + reason)

    class SafeRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            next_ok, next_reason = is_url_allowed(newurl, policy)
            if not next_ok:
                raise urllib.error.URLError("url_blocked:" + next_reason)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    opener = urllib.request.build_opener(SafeRedirect)
    req = urllib.request.Request(url, headers={"User-Agent": user_agent})
    try:
        with opener.open(req, timeout=timeout) as resp:
            status = getattr(resp, "status", None)
            if isinstance(status, int) and status >= 400:
                raise RuntimeError(f"http_{status}")
            try:
                length = resp.headers.get("Content-Length")
                if length is not None and max_bytes is not None and int(length) > max_bytes:
                    raise RuntimeError("size_limit")
            except ValueError:
                pass

            total = 0
            with open(tmp_path, "wb") as f:
                while True:
                    chunk = resp.read(256 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if max_bytes is not None and total > max_bytes:
                        raise RuntimeError("size_limit")
                    f.write(chunk)
        return total
    except urllib.error.URLError as exc:
        reason_text = str(getattr(exc, "reason", "") or exc or "").strip()
        if reason_text.startswith("url_blocked:"):
            raise RuntimeError(reason_text) from exc
        raise
