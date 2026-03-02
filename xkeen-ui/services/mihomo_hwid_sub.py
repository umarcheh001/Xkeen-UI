"""Mihomo HWID subscription helpers.

This module implements backend helpers used by the UI to work with
"HWID-bound" subscription endpoints.

Design goals:
 - No third-party dependencies (router-friendly).
 - Best-effort device identification (MAC/model/kernel).
 - Network calls run via services.net.net_call so the UI server doesn't freeze.
 - Errors are returned as structured JSON-friendly dicts (no 500s).
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import ssl
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict
from urllib.parse import urlparse

from services.net import net_call


_B64_RE = re.compile(r"^[A-Za-z0-9+/=]+$")
_NAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _read_text(path: str, *, max_bytes: int = 64 * 1024) -> str | None:
    try:
        with open(path, "rb") as f:
            raw = f.read(max(1, int(max_bytes)))
        return raw.decode("utf-8", errors="replace").strip()
    except Exception:
        return None


def _is_printable(s: str) -> bool:
    if not s:
        return False
    printable = sum(1 for ch in s if ch.isprintable())
    return printable / max(1, len(s)) > 0.92


def _decode_profile_title(raw: str) -> tuple[str | None, str | None]:
    """Return (decoded, encoding).

    encoding is "base64" or None.
    """
    if not raw:
        return None, None

    s = raw.strip()
    low = s.lower()

    # Formats seen in the wild: "base64:<...>", "base64,...".
    for prefix in ("base64:", "base64,", "base64 "):
        if low.startswith(prefix):
            b64 = s[len(prefix) :].strip()
            try:
                dec = base64.b64decode(b64, validate=False).decode(
                    "utf-8", errors="replace"
                )
                dec = dec.strip()
                if _is_printable(dec):
                    return dec, "base64"
            except Exception:
                return None, None
            return None, None

    # Heuristic: if it looks like base64 and decodes to printable UTF-8.
    if len(s) >= 8 and len(s) % 4 == 0 and _B64_RE.fullmatch(s):
        try:
            dec = base64.b64decode(s, validate=False).decode("utf-8", errors="replace")
            dec = dec.strip()
            if _is_printable(dec):
                return dec, "base64"
        except (binascii.Error, UnicodeError, ValueError):
            pass

    return s, None


def _sanitize_provider_name(name: str, *, max_len: int = 64) -> str:
    s = (name or "").strip()
    if not s:
        s = "sub_" + datetime.now().strftime("%Y%m%d")

    s = s.replace(" ", "_")
    s = _NAME_SAFE_RE.sub("_", s)
    s = re.sub(r"_+", "_", s)
    s = s.strip("._-")

    if not s:
        s = "sub_" + datetime.now().strftime("%Y%m%d")

    if len(s) > max_len:
        s = s[:max_len].rstrip("._-")
    return s


def _pick_mac_address() -> str | None:
    base = "/sys/class/net"
    try:
        ifaces = sorted(os.listdir(base))
    except Exception:
        return None

    def _iface_score(ifname: str) -> int:
        if ifname == "lo":
            return -10
        oper = _read_text(os.path.join(base, ifname, "operstate")) or ""
        if oper.strip().lower() == "up":
            return 10
        return 0

    ifaces.sort(key=lambda n: (_iface_score(n), n), reverse=True)

    for ifname in ifaces:
        if ifname == "lo":
            continue
        mac = _read_text(os.path.join(base, ifname, "address"))
        if not mac:
            continue
        mac = mac.strip().lower()
        if mac in ("00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff"):
            continue
        if re.fullmatch(r"[0-9a-f]{2}(:[0-9a-f]{2}){5}", mac):
            return mac
    return None


def _read_iface_mac(ifname: str) -> str | None:
    mac = _read_text(f"/sys/class/net/{ifname}/address")
    if not mac:
        return None
    mac = mac.strip().lower()
    if mac in ("00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff"):
        return None
    if re.fullmatch(r"[0-9a-f]{2}(:[0-9a-f]{2}){5}", mac):
        return mac
    return None


def _pick_mac_address_keenetic() -> str | None:
    """Pick MAC in a way compatible with the external install.sh.

    The upstream script prefers br0, then eth0, then any other active iface.
    """
    for ifname in ("br0", "eth0"):
        mac = _read_iface_mac(ifname)
        if mac:
            return mac
    return _pick_mac_address()


def _hwid_from_mac(mac: str | None) -> str:
    """Normalize MAC into HWID expected by HWID-subscription servers.

    Format (as in upstream install.sh): 12 hex chars, uppercase, no separators.
    """
    s = (mac or "").strip()
    if not s:
        return ""
    s = re.sub(r"[^0-9A-Fa-f]", "", s)
    s = s.upper()
    return s


def _run_cmd(args: list[str], *, timeout: float = 2.0) -> str | None:
    try:
        p = subprocess.run(
            list(args),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=float(timeout),
        )
        out = (p.stdout or "").strip()
        return out or None
    except Exception:
        return None


def _ndmc_show_version() -> str | None:
    return _run_cmd(["ndmc", "-c", "show version"], timeout=2.5)


def _parse_ndmc_os_ver(ndm_out: str | None) -> str | None:
    if not ndm_out:
        return None
    m = re.search(r"(?mi)^\s*title:\s*(\S+)", ndm_out)
    if not m:
        return None
    v = (m.group(1) or "").strip()
    return v or None


def _parse_ndmc_model_raw(ndm_out: str | None) -> str | None:
    if not ndm_out:
        return None
    m = re.search(r"(?mi)^\s*model:\s*(.+)$", ndm_out)
    if not m:
        return None
    v = (m.group(1) or "").strip()
    return v or None


def _sanitize_model_for_header(model_raw: str | None) -> str | None:
    """Sanitize model string similar to the upstream install.sh.

    install.sh does:
      MODEL_RAW -> tr ' ()' '--' -> tr -cd '[:alnum:]._-'\n
    """
    s = (model_raw or "").strip()
    if not s:
        return None
    # Replace spaces and parentheses with '-'
    s = s.translate(str.maketrans({" ": "-", "(": "-", ")": "-"}))
    # Keep only safe chars
    s = re.sub(r"[^A-Za-z0-9._-]+", "", s)
    return s or None


def _detect_device_model() -> str:
    # Prefer ndmc output on Keenetic routers (matches upstream install.sh).
    ndm = _ndmc_show_version()
    model_raw = _parse_ndmc_model_raw(ndm)
    model = _sanitize_model_for_header(model_raw) or (model_raw or "").strip()
    if model:
        return model

    m = _read_text("/proc/device-tree/model")
    if m:
        return m

    bj = _read_text("/etc/board.json")
    if bj:
        try:
            data = json.loads(bj)
            model = (
                (data.get("model") or {}).get("name")
                or (data.get("model") or {}).get("id")
                or data.get("model")
            )
            if isinstance(model, str) and model.strip():
                return model.strip()
        except Exception:
            pass

    return "Keenetic"


def _detect_mihomo_version() -> str | None:
    for args in (("mihomo", "-v"), ("mihomo", "-V")):
        try:
            p = subprocess.run(
                list(args),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=2.5,
            )
            out = (p.stdout or "").strip()
            if not out:
                continue
            # Prefer vX.Y(.Z) (matches upstream install.sh)
            m = re.search(r"\b(v[0-9]+\.[0-9]+(?:\.[0-9]+)?)\b", out)
            if m:
                return m.group(1)
            m2 = re.search(r"\b([0-9]+\.[0-9]+(?:\.[0-9]+)?)\b", out)
            if m2:
                return "v" + m2.group(1)
            return out.splitlines()[0][:64]
        except Exception:
            continue
    return None


def get_device_info() -> Dict[str, Any]:
    """Collect best-effort device info + headers used by HWID subscriptions."""
    # MAC displayed for UX + HWID normalized for headers (upstream-compatible).
    mac = _pick_mac_address_keenetic() or ""
    hwid = _hwid_from_mac(mac)

    ndm = _ndmc_show_version()
    os_ver = _parse_ndmc_os_ver(ndm)
    model_raw = _parse_ndmc_model_raw(ndm)
    model_hdr = _sanitize_model_for_header(model_raw)

    # Keenetic OS version is preferable for HWID subscriptions.
    try:
        kernel_release = os.uname().release
    except Exception:
        kernel_release = _read_text("/proc/version") or ""

    os_release = os_ver or kernel_release

    # For headers we use sanitized model (to match upstream install.sh).
    device_model = model_hdr or _detect_device_model()
    mh_ver = _detect_mihomo_version() or "v1.0.0"
    ua = f"mihomo/{mh_ver}" if mh_ver else "mihomo"

    headers: Dict[str, str] = {
        # Upstream expects HWID without separators and in uppercase.
        "x-hwid": hwid,
        "x-device-os": "Keenetic OS",
        "x-ver-os": os_release or "",
        "x-device-model": device_model or "Keenetic",
        "User-Agent": ua,
    }

    return {
        "mac": mac,
        "hwid": hwid,
        "device_model": device_model,
        "os_release": os_release,
        "kernel_release": kernel_release,
        "mihomo_version": mh_ver,
        "user_agent": ua,
        "headers": headers,
    }


@dataclass
class _ProbeMeta:
    url: str
    resolved_url: str | None
    method: str | None
    http_status: int | None
    content_type: str | None
    content_length: int | None
    timing_ms: int


def _make_error(code: str, message: str, hint: str = "", retryable: bool = True):
    return {
        "code": code,
        "message": message,
        "hint": hint or None,
        "retryable": bool(retryable),
    }


def _probe_once(
    url: str,
    *,
    method: str,
    headers: Dict[str, str],
    insecure: bool,
    timeout: float,
) -> tuple[_ProbeMeta, Dict[str, Any], list[Dict[str, Any]]]:
    """Low-level probe attempt. May raise urllib exceptions."""

    req_headers = dict(headers or {})
    if method.upper() == "GET":
        req_headers.setdefault("Range", "bytes=0-0")

    req = urllib.request.Request(url, headers=req_headers, method=method.upper())
    ctx = ssl._create_unverified_context() if insecure else None

    start = time.monotonic()
    with urllib.request.urlopen(req, timeout=float(timeout), context=ctx) as resp:
        elapsed_ms = int(max(0.0, (time.monotonic() - start) * 1000.0))
        try:
            resolved = resp.geturl()
        except Exception:
            resolved = url

        try:
            code = int(resp.getcode())
        except Exception:
            code = None

        ctype = resp.headers.get("Content-Type")
        clen_raw = resp.headers.get("Content-Length")
        clen = None
        if clen_raw:
            try:
                clen = int(clen_raw)
            except Exception:
                clen = None

        pt_raw = resp.headers.get("profile-title")
        pt_dec, enc = _decode_profile_title(pt_raw) if pt_raw else (None, None)
        suggested = _sanitize_provider_name(pt_dec or "")

        warnings: list[Dict[str, Any]] = []
        if not pt_raw:
            warnings.append(
                {
                    "code": "PROFILE_TITLE_MISSING",
                    "hint": "Сервер не вернул заголовок profile-title — имя будет сгенерировано автоматически.",
                }
            )

        meta = _ProbeMeta(
            url=url,
            resolved_url=resolved,
            method=method.upper(),
            http_status=code,
            content_type=ctype,
            content_length=clen,
            timing_ms=elapsed_ms,
        )

        profile = {
            "profile_title": pt_dec,
            "profile_title_raw": pt_raw,
            "profile_title_encoding": enc,
            "suggested_name": suggested,
        }
        return meta, profile, warnings


def probe_subscription(
    url: str,
    *,
    headers: Dict[str, str] | None,
    insecure: bool = False,
    timeout: float = 8.0,
    prefer: str = "head_then_range_get",
) -> Dict[str, Any]:
    """Probe a HWID subscription URL.

    Returns a JSON-friendly dict with:
      {ok, probe, profile, headers_used, warnings, error}

    This function is blocking (network I/O). Prefer probe_subscription_safe().
    """

    u = (url or "").strip()
    parsed = urlparse(u)
    if not parsed.scheme or parsed.scheme.lower() not in ("http", "https"):
        return {
            "ok": False,
            "probe": {
                "url": u,
                "resolved_url": None,
                "method": None,
                "http_status": None,
                "content_type": None,
                "content_length": None,
                "timing_ms": 0,
            },
            "profile": {
                "profile_title": None,
                "profile_title_raw": None,
                "profile_title_encoding": None,
                "suggested_name": None,
            },
            "headers_used": None,
            "warnings": [],
            "error": _make_error(
                "INVALID_URL",
                "Only http/https URLs are allowed.",
                "Укажите ссылку вида https://…",
                retryable=False,
            ),
        }

    hdrs: Dict[str, str] = dict(headers or {})

    # Strategy: HEAD first (cheap), then Range GET fallback.
    methods = ["GET"] if prefer == "get" else ["HEAD", "GET"]

    last_meta = _ProbeMeta(
        url=u,
        resolved_url=None,
        method=None,
        http_status=None,
        content_type=None,
        content_length=None,
        timing_ms=0,
    )

    for m in methods:
        try:
            meta, profile, warnings = _probe_once(
                u, method=m, headers=hdrs, insecure=insecure, timeout=timeout
            )
            return {
                "ok": True,
                "probe": {
                    "url": meta.url,
                    "resolved_url": meta.resolved_url,
                    "method": meta.method,
                    "http_status": meta.http_status,
                    "content_type": meta.content_type,
                    "content_length": meta.content_length,
                    "timing_ms": meta.timing_ms,
                },
                "profile": profile,
                "headers_used": hdrs,
                "warnings": warnings,
                "error": None,
            }
        except urllib.error.HTTPError as e:
            last_meta = _ProbeMeta(
                url=u,
                resolved_url=getattr(e, "url", None),
                method=m,
                http_status=getattr(e, "code", None),
                content_type=(getattr(e, "headers", None) or {}).get("Content-Type"),
                content_length=None,
                timing_ms=0,
            )

            # If HEAD isn't supported (405/501) or is rejected (400), try GET.
            if m == "HEAD" and int(getattr(e, "code", 0) or 0) in (400, 405, 501):
                continue

            pt_raw = None
            try:
                pt_raw = e.headers.get("profile-title")
            except Exception:
                pt_raw = None
            pt_dec, enc = _decode_profile_title(pt_raw) if pt_raw else (None, None)

            return {
                "ok": False,
                "probe": {
                    "url": u,
                    "resolved_url": getattr(e, "url", None),
                    "method": m,
                    "http_status": getattr(e, "code", None),
                    "content_type": None,
                    "content_length": None,
                    "timing_ms": 0,
                },
                "profile": {
                    "profile_title": pt_dec,
                    "profile_title_raw": pt_raw,
                    "profile_title_encoding": enc,
                    "suggested_name": _sanitize_provider_name(pt_dec or "")
                    if pt_dec
                    else None,
                },
                "headers_used": hdrs,
                "warnings": [],
                "error": _make_error(
                    "HTTP_ERROR",
                    f"HTTP {getattr(e, 'code', '')}: {getattr(e, 'reason', '')}".strip(),
                    "Проверьте ссылку/доступность подписки.",
                    retryable=True,
                ),
            }
        except urllib.error.URLError as e:
            msg = str(getattr(e, "reason", e))
            code = "NETWORK_ERROR"
            hint = "Проверьте доступ к интернету/домену и попробуйте снова."
            if (
                "CERTIFICATE_VERIFY_FAILED" in msg
                or "tls" in msg.lower()
                or "x509" in msg.lower()
            ):
                code = "TLS_VERIFY_FAILED"
                hint = "Попробуйте включить «Игнорировать TLS» или исправить сертификат/домен."
            return {
                "ok": False,
                "probe": {
                    "url": u,
                    "resolved_url": None,
                    "method": m,
                    "http_status": None,
                    "content_type": None,
                    "content_length": None,
                    "timing_ms": 0,
                },
                "profile": {
                    "profile_title": None,
                    "profile_title_raw": None,
                    "profile_title_encoding": None,
                    "suggested_name": None,
                },
                "headers_used": hdrs,
                "warnings": [],
                "error": _make_error(code, msg, hint, retryable=True),
            }
        except TimeoutError:
            return {
                "ok": False,
                "probe": {
                    "url": u,
                    "resolved_url": None,
                    "method": m,
                    "http_status": None,
                    "content_type": None,
                    "content_length": None,
                    "timing_ms": int(timeout * 1000),
                },
                "profile": {
                    "profile_title": None,
                    "profile_title_raw": None,
                    "profile_title_encoding": None,
                    "suggested_name": None,
                },
                "headers_used": hdrs,
                "warnings": [],
                "error": _make_error(
                    "TIMEOUT",
                    "timeout",
                    "Сервер подписки не ответил вовремя. Попробуйте позже.",
                    retryable=True,
                ),
            }
        except Exception as e:
            return {
                "ok": False,
                "probe": {
                    "url": u,
                    "resolved_url": getattr(last_meta, "resolved_url", None),
                    "method": m,
                    "http_status": getattr(last_meta, "http_status", None),
                    "content_type": None,
                    "content_length": None,
                    "timing_ms": 0,
                },
                "profile": {
                    "profile_title": None,
                    "profile_title_raw": None,
                    "profile_title_encoding": None,
                    "suggested_name": None,
                },
                "headers_used": hdrs,
                "warnings": [],
                "error": _make_error(
                    "PROBE_FAILED",
                    str(e),
                    "Не удалось проверить подписку.",
                    retryable=True,
                ),
            }

    return {
        "ok": False,
        "probe": {
            "url": u,
            "resolved_url": None,
            "method": None,
            "http_status": None,
            "content_type": None,
            "content_length": None,
            "timing_ms": 0,
        },
        "profile": {
            "profile_title": None,
            "profile_title_raw": None,
            "profile_title_encoding": None,
            "suggested_name": None,
        },
        "headers_used": hdrs,
        "warnings": [],
        "error": _make_error("PROBE_FAILED", "unknown", "", retryable=True),
    }


def probe_subscription_safe(
    url: str,
    *,
    headers: Dict[str, str] | None,
    insecure: bool = False,
    timeout: float = 8.0,
    prefer: str = "head_then_range_get",
) -> Dict[str, Any]:
    """Run probe in a worker thread to avoid blocking the UI server."""
    wait_seconds = max(1.0, float(timeout) + 1.0)
    try:
        return net_call(
            lambda: probe_subscription(
                url, headers=headers, insecure=insecure, timeout=timeout, prefer=prefer
            ),
            wait_seconds,
        )
    except TimeoutError:
        u = (url or "").strip()
        return {
            "ok": False,
            "probe": {
                "url": u,
                "resolved_url": None,
                "method": None,
                "http_status": None,
                "content_type": None,
                "content_length": None,
                "timing_ms": int(max(0.0, float(timeout) * 1000.0)),
            },
            "profile": {
                "profile_title": None,
                "profile_title_raw": None,
                "profile_title_encoding": None,
                "suggested_name": None,
            },
            "headers_used": dict(headers or {}),
            "warnings": [],
            "error": _make_error(
                "TIMEOUT",
                "timeout",
                "Сервер подписки не ответил вовремя. Попробуйте позже.",
                retryable=True,
            ),
        }


# ---------------------------------------------------------------------------
# YAML patching + apply modes (backend-side)
# ---------------------------------------------------------------------------


_TOP_LEVEL_KEY_RE = re.compile(
    r"(?m)^(?P<k>[A-Za-z0-9_][A-Za-z0-9_-]*)\s*:\s*(?:#.*)?$"
)


def _yaml_ensure_newline(text: str) -> str:
    s = text or ""
    return s if not s or s.endswith("\n") else (s + "\n")


def _yaml_find_section_range(text: str, key: str) -> tuple[int, int, int] | None:
    """Return (start_idx, end_idx, header_end_idx) for a top-level YAML section.

    - start_idx: start of the 'key:' line
    - header_end_idx: end of the 'key:' line (position right after newline)
    - end_idx: start of the next top-level key, or len(text)
    """

    if not text:
        return None
    k = (key or "").strip()
    if not k:
        return None
    m = re.search(rf"(?m)^{re.escape(k)}\s*:\s*(?:#.*)?$", text)
    if not m:
        return None

    # Find end of the header line
    nl = text.find("\n", m.end())
    header_end = len(text) if nl < 0 else (nl + 1)

    # Find next top-level key
    end = len(text)
    for m2 in _TOP_LEVEL_KEY_RE.finditer(text, pos=header_end):
        if m2.start() <= m.start():
            continue
        end = m2.start()
        break
    return m.start(), end, header_end


def _yaml_provider_name_from_entry(provider_entry: str) -> str | None:
    if not provider_entry:
        return None
    m = re.search(r"(?m)^\s{2}([A-Za-z0-9._-]+)\s*:\s*$", provider_entry)
    return m.group(1) if m else None


def yaml_provider_exists(cfg: str, provider_name: str) -> bool:
    nm = _sanitize_provider_name(provider_name or "")
    if not nm:
        return False
    esc = re.escape(nm)
    # Best-effort: provider entry under proxy-providers is usually indented by 2 spaces.
    return bool(re.search(rf"(?m)^\s{{2}}{esc}\s*:\s*$", cfg or ""))


def ensure_unique_provider_name(cfg: str, provider_name: str, *, max_tries: int = 50) -> str:
    base = _sanitize_provider_name(provider_name or "")
    if not yaml_provider_exists(cfg, base):
        return base
    for i in range(2, max_tries + 1):
        cand = f"{base}_{i}"
        if not yaml_provider_exists(cfg, cand):
            return cand
    # Worst-case fallback
    return f"{base}_{int(time.time())}"


def _yaml_replace_section(text: str, key: str, new_section: str) -> str:
    s = _yaml_ensure_newline(text)
    new_s = _yaml_ensure_newline(new_section)
    rng = _yaml_find_section_range(s, key)
    if not rng:
        # If section is absent, append it.
        if s and not s.endswith("\n\n"):
            s += "\n"
        return s + new_s

    start, end, _header_end = rng
    return s[:start] + new_s + s[end:]


def _yaml_insert_into_section(
    text: str,
    key: str,
    provider_entry: str,
    *,
    avoid_duplicates: bool = True,
) -> str:
    s = _yaml_ensure_newline(text)
    entry = _yaml_ensure_newline(provider_entry)
    rng = _yaml_find_section_range(s, key)

    if not rng:
        # Append new section at the end.
        if s and not s.endswith("\n\n"):
            s += "\n"
        return s + f"{key}:\n" + entry

    start, end, header_end = rng

    if avoid_duplicates:
        nm = _yaml_provider_name_from_entry(entry)
        if nm and yaml_provider_exists(s[start:end], nm):
            return s

    # Insert at the end of this section (right before next top-level key).
    before = s[:end]
    after = s[end:]

    # If the section has no body (key line only), insert right after header.
    if end == header_end:
        before = s[:header_end]
        after = s[header_end:]

    if before and not before.endswith("\n"):
        before += "\n"
    return before + entry + after


def _yaml_quote(v: str) -> str:
    s = "" if v is None else str(v)
    s = s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return f'"{s}"'


def build_provider_entry(
    provider_name: str,
    url: str,
    headers: Dict[str, str] | None,
) -> str:
    """Build YAML snippet for a single provider entry (indented under proxy-providers)."""

    nm = _sanitize_provider_name(provider_name or "")
    u = (url or "").strip()
    h = dict(headers or {})

    lines: list[str] = []
    lines.append(f"  {nm}:")
    lines.append("    type: http")
    lines.append(f"    url: {_yaml_quote(u)}")
    lines.append("    interval: 3600")
    lines.append(f"    path: {_yaml_quote(f'./proxy_providers/{nm}.yaml')}")
    lines.append("    health-check:")
    lines.append("      enable: true")
    lines.append('      url: "https://www.gstatic.com/generate_204"')
    lines.append("      interval: 600")

    # Mihomo docs show header values as list-of-strings. This is the most compatible form.
    def push_header(key: str, val: str | None) -> list[str]:
        v = (val or "").strip()
        if not v:
            return []
        return [f"      {key}:", f"      - {_yaml_quote(v)}"]

    header_lines: list[str] = []
    header_lines += push_header("x-hwid", h.get("x-hwid"))
    header_lines += push_header("x-device-os", h.get("x-device-os"))
    header_lines += push_header("x-ver-os", h.get("x-ver-os"))
    header_lines += push_header("x-device-model", h.get("x-device-model"))
    header_lines += push_header("User-Agent", h.get("User-Agent") or h.get("user-agent"))

    if header_lines:
        lines.append("    header:")
        # Each header item is already indented to be inside 'header:'
        lines.extend(header_lines)

    return "\n".join(lines) + "\n"


def apply_mode(
    existing_yaml: str,
    mode: str,
    provider_entry: str,
    *,
    template_yaml: str | None = None,
) -> str:
    """Apply one of HWID subscription modes to YAML text.

    Modes:
      - add: insert provider into proxy-providers section
      - replace_providers: replace entire proxy-providers section
      - replace_all: replace whole config with template_yaml, then insert provider
    """

    m = (mode or "add").strip().lower()
    if m not in ("add", "replace_providers", "replace_all"):
        raise ValueError("invalid mode")

    base = template_yaml if m == "replace_all" else (existing_yaml or "")
    if m == "replace_all" and (template_yaml is None or not str(template_yaml).strip()):
        raise ValueError("template_yaml is required for replace_all")

    if m == "replace_providers":
        section = "proxy-providers:\n" + _yaml_ensure_newline(provider_entry)
        return _yaml_replace_section(base, "proxy-providers", section)

    # add / replace_all
    return _yaml_insert_into_section(
        base,
        "proxy-providers",
        provider_entry,
        avoid_duplicates=True,
    )
