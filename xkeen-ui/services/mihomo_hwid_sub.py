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
import hashlib
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
from services.url_policy import URLPolicy, env_flag, is_url_allowed


_B64_RE = re.compile(r"^[A-Za-z0-9+/=]+$")
_NAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")
_MIHOMO_HWID_UA_FALLBACK_VERSION = "1.19.24"
_HWID_RESPONSE_HEADER_KEYS = (
    "x-hwid-active",
    "x-hwid-limit",
    "x-hwid-max-devices-reached",
    "x-hwid-not-supported",
)
_HAPP_FALLBACK_UA_ENV = "XKEEN_MIHOMO_HWID_HAPP_USER_AGENT"
_HAPP_FALLBACK_ENABLED_ENV = "XKEEN_MIHOMO_HWID_HAPP_FALLBACK"
_HAPP_FALLBACK_DEFAULT_UA = "Happ/1.0"
_PROXY_URI_RE = re.compile(
    r"(?mi)^\s*(?:vless|vmess|trojan|ss|ssr|shadowsocks|hysteria2|hy2|hysteria|tuic|wireguard)://"
)


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


def _normalize_env_hwid_override(raw: str | None) -> str:
    """Return a safe x-hwid override value for provider requests.

    Remnawave-style panels treat HWID as a client-provided string, not
    necessarily as a MAC-derived 12-hex value. Keep user-provided strings as-is
    after trimming, but reject control/non-ASCII bytes so they cannot become
    invalid HTTP headers.
    """

    s = (raw or "").strip()
    if not s or len(s) > 128:
        return ""
    if any(ord(ch) < 32 or ord(ch) == 127 or ord(ch) > 126 for ch in s):
        return ""

    # Preserve backward-compatible convenience for MAC-like values with
    # separators while leaving plain Remnawave/Happ HWID strings untouched.
    if re.fullmatch(r"[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}", s):
        return _hwid_from_mac(s)

    return s


def _env_hwid_override() -> tuple[str | None, str | None]:
    for key in ("XKEEN_MIHOMO_HWID", "XKEEN_HWID"):
        hwid = _normalize_env_hwid_override(os.environ.get(key))
        if hwid:
            return hwid, key
    return None, None


def _hwid_from_machine_id() -> tuple[str | None, str | None]:
    for path in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
        raw = _read_text(path, max_bytes=512)
        if not raw:
            continue
        normalized = re.sub(r"[^A-Za-z0-9_-]", "", raw)
        if not normalized:
            continue
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        return digest[:12].upper(), "machine_id"
    return None, None


def _ui_state_dir() -> str:
    try:
        from core.paths import UI_STATE_DIR

        return str(UI_STATE_DIR or "").strip() or "/opt/etc/xkeen-ui"
    except Exception:
        return (
            os.environ.get("XKEEN_UI_STATE_DIR")
            or os.environ.get("XKEEN_UI_DIR")
            or "/opt/etc/xkeen-ui"
        )


def _generated_hwid_path() -> str:
    return os.path.join(_ui_state_dir(), "mihomo-hwid.txt")


def _valid_hwid(hwid: str | None) -> str:
    s = _hwid_from_mac(hwid)
    if len(s) != 12 or s in {"000000000000", "FFFFFFFFFFFF"}:
        return ""
    return s


def _new_random_hwid() -> str:
    raw = bytearray(os.urandom(6))
    # MAC-like, locally administered, unicast. Stable storage happens below.
    raw[0] = (raw[0] | 0x02) & 0xFE
    return "".join(f"{b:02X}" for b in raw)


def _hwid_from_generated_state() -> tuple[str | None, str | None]:
    path = _generated_hwid_path()
    existing = _valid_hwid(_read_text(path, max_bytes=256))
    if existing:
        return existing, "generated_state"

    hwid = _new_random_hwid()
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(hwid + "\n")
        try:
            os.chmod(tmp, 0o600)
        except Exception:
            pass
        os.replace(tmp, path)
        return hwid, "generated_state"
    except Exception:
        try:
            if "tmp" in locals() and os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        return hwid, "generated_ephemeral"


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
    binaries = ("mihomo", "/opt/sbin/mihomo", "/opt/bin/mihomo")
    flags = ("-v", "-V")
    seen: set[tuple[str, str]] = set()
    for binary in binaries:
        if os.path.isabs(binary) and not os.path.exists(binary):
            continue
        for flag in flags:
            args = (binary, flag)
            if args in seen:
                continue
            seen.add(args)
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


def _normalize_mihomo_version_for_ua(version: str | None) -> str:
    s = (version or "").strip()
    if s:
        try:
            m = re.search(r"\b[vV]?([0-9]+\.[0-9]+(?:\.[0-9]+)?)\b", s)
            if m:
                return m.group(1)
        except Exception:
            pass
    return _MIHOMO_HWID_UA_FALLBACK_VERSION


def _mihomo_hwid_user_agent(version: str | None = None) -> str:
    ua_ver = _normalize_mihomo_version_for_ua(version)
    return f"ClashMeta/{ua_ver}; mihomo/{ua_ver}"


def get_device_info() -> Dict[str, Any]:
    """Collect best-effort device info + headers used by HWID subscriptions."""
    # MAC displayed for UX + HWID normalized for headers (upstream-compatible).
    env_hwid, env_source = _env_hwid_override()
    mac = _pick_mac_address_keenetic() or ""
    mac_hwid = _hwid_from_mac(mac)
    hwid_source = "none"
    if env_hwid:
        hwid = env_hwid
        hwid_source = env_source or "env"
    elif mac_hwid:
        hwid = mac_hwid
        hwid_source = "mac"
    else:
        hwid, hwid_source = _hwid_from_machine_id()
        if not hwid:
            hwid, hwid_source = _hwid_from_generated_state()
        hwid = hwid or ""
        hwid_source = hwid_source or "none"

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
    mh_ver_raw = _detect_mihomo_version()
    mh_ver = _normalize_mihomo_version_for_ua(mh_ver_raw)
    ua = _mihomo_hwid_user_agent(mh_ver_raw)

    headers: Dict[str, str] = {
        # Upstream expects HWID without separators and in uppercase.
        "x-hwid": hwid,
        "x-device-os": "Keenetic OS",
        "x-ver-os": os_release or "",
        "x-device-model": device_model or "Keenetic",
        "User-Agent": ua,
    }

    hwid_env_hint = (
        "Если нужно отправлять уже привязанный или ожидаемый провайдером HWID, "
        "откройте DevTools → ENV, найдите через поиск HWID, вставьте значение в "
        "XKEEN_MIHOMO_HWID и нажмите Save. После этого заново нажмите «Проверить» "
        "в окне HWID-подписки."
    )
    generated_hint = (
        "Это не новый random при каждом клике: панель сохраняет его в UI state и "
        "будет использовать повторно, чтобы привязка подписки не менялась сама по себе."
    )

    return {
        "mac": mac,
        "hwid": hwid,
        "hwid_source": hwid_source,
        "device_model": device_model,
        "os_release": os_release,
        "kernel_release": kernel_release,
        "mihomo_version": mh_ver,
        "mihomo_version_raw": mh_ver_raw,
        "user_agent": ua,
        "headers": headers,
        "hwid_warning": (
            (
                "Не удалось взять HWID из MAC роутера, поэтому панель использовала стабильный "
                f"идентификатор {hwid} из machine-id. Обычно этого достаточно. {hwid_env_hint}"
            )
            if hwid and hwid_source == "machine_id"
            else (
                "Не удалось взять HWID из MAC роутера, поэтому панель сгенерировала запасной "
                f"идентификатор {hwid}. {generated_hint} Обычно этого достаточно. {hwid_env_hint}"
                if hwid and hwid_source == "generated_state"
                else (
                    "Не удалось взять HWID из MAC роутера, поэтому панель использовала "
                    f"временный идентификатор {hwid}. Его не удалось сохранить, поэтому он может "
                    f"измениться после перезапуска. {hwid_env_hint}"
                    if hwid and hwid_source == "generated_ephemeral"
                    else (
                        "HWID устройства не удалось определить. Если провайдер требует HWID, "
                        "возьмите значение в личном кабинете или у поддержки провайдера. "
                        f"{hwid_env_hint}"
                        if not hwid
                        else None
                    )
                )
            )
        ),
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
    hwid_response_headers: Dict[str, str] | None = None


def _extract_hwid_response_headers(headers: Any) -> Dict[str, str]:
    """Return Remnawave/Happ HWID response headers in lowercase form."""

    if not headers:
        return {}

    lower_items: Dict[str, str] = {}
    try:
        for k, v in headers.items():
            kk = str(k or "").strip().lower()
            vv = str(v or "").strip()
            if kk and vv:
                lower_items[kk] = vv
    except Exception:
        lower_items = {}

    out: Dict[str, str] = {}
    for key in _HWID_RESPONSE_HEADER_KEYS:
        raw = None
        try:
            raw = headers.get(key)
        except Exception:
            raw = None
        if raw is None:
            raw = lower_items.get(key)
        val = str(raw or "").strip()
        if val:
            out[key] = val
    return out


def _header_truthy(value: str | None) -> bool:
    s = str(value or "").strip().lower()
    return bool(s) and s not in {"0", "false", "no", "off", "none", "null"}


def _hwid_response_warnings(headers: Dict[str, str]) -> list[Dict[str, Any]]:
    warnings: list[Dict[str, Any]] = []
    if _header_truthy(headers.get("x-hwid-not-supported")):
        warnings.append(
            {
                "code": "HWID_NOT_SUPPORTED",
                "header": "x-hwid-not-supported",
                "value": headers.get("x-hwid-not-supported"),
                "hint": "Провайдер сообщил, что HWID не поддержан или не принят этим запросом.",
            }
        )
    if _header_truthy(headers.get("x-hwid-max-devices-reached")):
        warnings.append(
            {
                "code": "HWID_MAX_DEVICES_REACHED",
                "header": "x-hwid-max-devices-reached",
                "value": headers.get("x-hwid-max-devices-reached"),
                "hint": "Провайдер сообщил, что для подписки достигнут лимит устройств.",
            }
        )
    if _header_truthy(headers.get("x-hwid-limit")):
        warnings.append(
            {
                "code": "HWID_LIMIT_REACHED",
                "header": "x-hwid-limit",
                "value": headers.get("x-hwid-limit"),
                "hint": "Провайдер сообщил о срабатывании HWID-лимита устройств.",
            }
        )
    return warnings


_URL_POLICY_ENV_PREFIX = "XKEEN_MIHOMO_HWID"


def _hwid_subscription_policy() -> URLPolicy:
    """URL policy for user-provided Mihomo HWID subscription URLs.

    Subscription URLs are expected to be arbitrary provider endpoints, so public
    custom HTTPS hosts are allowed. Local/private targets and plain HTTP stay
    opt-in to avoid SSRF-style access from the panel process.
    """

    return URLPolicy(
        allow_hosts=(),
        allow_http=env_flag(f"{_URL_POLICY_ENV_PREFIX}_ALLOW_HTTP", False),
        allow_private_hosts=env_flag(f"{_URL_POLICY_ENV_PREFIX}_ALLOW_PRIVATE_HOSTS", False),
        allow_custom_urls=True,
    )


def _url_blocked_hint(reason: str) -> str:
    r = str(reason or "").strip()
    if r == "http_not_allowed":
        return (
            "По умолчанию HWID-подписки принимаются только по HTTPS. "
            f"Для plain HTTP явно включите {_URL_POLICY_ENV_PREFIX}_ALLOW_HTTP=1."
        )
    if r.startswith("private_host_not_allowed:"):
        return (
            "Локальные и private адреса заблокированы для защиты панели. "
            f"Если это осознанно нужный локальный endpoint, включите "
            f"{_URL_POLICY_ENV_PREFIX}_ALLOW_PRIVATE_HOSTS=1."
        )
    return "Разрешены публичные http/https URL, с HTTPS по умолчанию."


def _make_error(
    code: str,
    message: str,
    hint: str = "",
    retryable: bool = True,
    **extra: Any,
):
    payload = {
        "code": code,
        "message": message,
        "hint": hint or None,
        "retryable": bool(retryable),
    }
    if extra:
        payload.update(extra)
    return payload


def _yaml_line_key(line: str) -> tuple[str, bool] | None:
    raw = str(line or "").rstrip("\r\n")
    if not raw.strip() or raw.lstrip().startswith("#"):
        return None
    if raw[:1].isspace():
        return None
    m = re.match(r"^([A-Za-z0-9_.-]+)\s*:\s*(.*)$", raw)
    if not m:
        return None
    value = m.group(2).strip()
    return m.group(1), bool(value and not value.startswith("#"))


def _yaml_extract_top_level_section(text: str, key: str) -> tuple[str | None, int]:
    s = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = s.splitlines(keepends=True)
    start = -1
    end = len(lines)
    top_level_keys = 0

    for idx, line in enumerate(lines):
        parsed = _yaml_line_key(line)
        if not parsed:
            continue
        top_level_keys += 1
        k, _inline = parsed
        if k == key and start < 0:
            start = idx
            continue
        if start >= 0:
            end = idx
            break

    if start < 0:
        return None, top_level_keys
    return "".join(lines[start:end]).strip() + "\n", top_level_keys


def provider_payload_from_subscription_text(text: str) -> tuple[str, Dict[str, Any]]:
    """Return Mihomo proxy-provider compatible payload.

    Some subscription servers return a full Clash/Mihomo config with a top-level
    `proxies:` section. Mihomo proxy-providers expect provider content instead:
    YAML with `proxies:`, plain URI lines, or base64 URI text. If a full config is
    detected, keep only the `proxies:` section.
    """

    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return "proxies: []\n", {"format": "empty", "converted": False, "proxy_section": False}

    if raw[:1] in ("[", "{"):
        try:
            from services.mihomo_xray_json import (
                convert_subscription_text,
                format_proxies_section,
            )

            proxies, skipped = convert_subscription_text(raw)
            if proxies:
                return format_proxies_section(proxies), {
                    "format": "xray-json",
                    "converted": True,
                    "proxy_section": True,
                    "xray_json": True,
                    "proxy_count": len(proxies),
                    "skipped_count": len(skipped),
                }
        except ValueError:
            pass
        except Exception:
            pass

    proxies_section, top_level_keys = _yaml_extract_top_level_section(raw, "proxies")
    if proxies_section:
        converted = top_level_keys > 1
        return proxies_section, {
            "format": "yaml",
            "converted": bool(converted),
            "proxy_section": True,
            "top_level_keys": top_level_keys,
        }

    # URI/base64 providers are already valid proxy-provider payloads.
    return raw + "\n", {
        "format": "raw",
        "converted": False,
        "proxy_section": False,
        "top_level_keys": top_level_keys,
    }


def _decode_base64_subscription_text(text: str) -> str:
    raw = re.sub(r"\s+", "", str(text or ""))
    if len(raw) < 16 or not re.fullmatch(r"[A-Za-z0-9+/=_-]+", raw):
        return ""
    raw = raw.replace("-", "+").replace("_", "/")
    raw += "=" * ((4 - len(raw) % 4) % 4)
    try:
        return base64.b64decode(raw, validate=False).decode("utf-8", errors="replace")
    except Exception:
        return ""


def _provider_payload_node_count(payload: str) -> int:
    text = str(payload or "").strip()
    if not text:
        return 0
    yaml_markers = len(re.findall(r"(?m)^\s*-\s*name\s*:\s*", text))
    if yaml_markers:
        return yaml_markers
    raw_markers = len(_PROXY_URI_RE.findall(text))
    if raw_markers:
        return raw_markers
    decoded = _decode_base64_subscription_text(text)
    return len(_PROXY_URI_RE.findall(decoded)) if decoded else 0


def _fetch_provider_subscription_text(
    url: str,
    *,
    headers: Dict[str, str],
    insecure: bool,
    timeout: float,
    policy: URLPolicy,
    max_bytes: int,
) -> tuple[str, Dict[str, Any]]:
    req = urllib.request.Request(url, headers=dict(headers or {}), method="GET")
    ctx = ssl._create_unverified_context() if insecure else None

    class SafeRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401,N803
            ok, redirect_reason = is_url_allowed(newurl, policy)
            if not ok:
                raise urllib.error.URLError("url_blocked:" + redirect_reason)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    handlers: list[Any] = [SafeRedirect]
    if ctx is not None:
        handlers.append(urllib.request.HTTPSHandler(context=ctx))

    opener = urllib.request.build_opener(*handlers)
    with opener.open(req, timeout=float(timeout)) as resp:
        raw = resp.read(max(1, int(max_bytes)) + 1)
        if len(raw) > max_bytes:
            raise ValueError("subscription_too_large")
        content_type = resp.headers.get("Content-Type") or ""
        hwid_response_headers = _extract_hwid_response_headers(resp.headers)

    charset = "utf-8"
    m = re.search(r"charset=([A-Za-z0-9._-]+)", content_type, flags=re.I)
    if m:
        charset = m.group(1)
    try:
        text = raw.decode(charset, errors="replace")
    except LookupError:
        text = raw.decode("utf-8", errors="replace")

    return text, {
        "content_type": content_type,
        "bytes": len(raw),
        "hwid_response_headers": hwid_response_headers,
    }


def _happ_fallback_headers(headers: Dict[str, str]) -> Dict[str, str] | None:
    if not env_flag(_HAPP_FALLBACK_ENABLED_ENV, True):
        return None
    h = dict(headers or {})
    hwid = ""
    ua = ""
    for key, value in h.items():
        key_l = str(key or "").strip().lower()
        if key_l == "x-hwid":
            hwid = str(value or "").strip()
        elif key_l == "user-agent":
            ua = str(value or "").strip()
    if not hwid or "happ" in ua.lower():
        return None

    fallback_ua = str(os.environ.get(_HAPP_FALLBACK_UA_ENV) or _HAPP_FALLBACK_DEFAULT_UA).strip()
    if not fallback_ua:
        return None
    h["User-Agent"] = fallback_ua
    return h


def _maybe_use_happ_fallback(
    url: str,
    *,
    request_headers: Dict[str, str],
    current_payload: str,
    current_meta: Dict[str, Any],
    insecure: bool,
    timeout: float,
    policy: URLPolicy,
    max_bytes: int,
) -> tuple[str, Dict[str, Any]] | None:
    if current_meta.get("xray_json"):
        return None

    fallback_headers = _happ_fallback_headers(request_headers)
    if not fallback_headers:
        return None

    try:
        text, fetch_meta = _fetch_provider_subscription_text(
            url,
            headers=fallback_headers,
            insecure=insecure,
            timeout=timeout,
            policy=policy,
            max_bytes=max_bytes,
        )
        payload, meta = provider_payload_from_subscription_text(text)
        meta.update(fetch_meta)
    except Exception:
        return None

    if not meta.get("xray_json"):
        return None

    original_count = _provider_payload_node_count(current_payload)
    fallback_count = _provider_payload_node_count(payload)
    if fallback_count <= original_count:
        return None

    meta["happ_fallback_used"] = True
    meta["happ_fallback_original_count"] = original_count
    meta["happ_fallback_original_format"] = current_meta.get("format")
    return payload, meta


def fetch_provider_payload(
    url: str,
    *,
    headers: Dict[str, str] | None,
    insecure: bool = False,
    timeout: float = 20.0,
    policy: URLPolicy | None = None,
    max_bytes: int = 2 * 1024 * 1024,
) -> tuple[str, Dict[str, Any]]:
    """Fetch a HWID subscription and return provider-compatible YAML/text."""

    u = (url or "").strip()
    effective_policy = policy or _hwid_subscription_policy()
    ok_url, reason = is_url_allowed(u, effective_policy)
    if not ok_url:
        raise ValueError("url_blocked:" + reason)

    req_headers = dict(headers or {})
    req_headers.setdefault("Accept", "text/yaml, text/plain, */*")
    text, fetch_meta = _fetch_provider_subscription_text(
        u,
        headers=req_headers,
        insecure=insecure,
        timeout=timeout,
        policy=effective_policy,
        max_bytes=max_bytes,
    )
    payload, meta = provider_payload_from_subscription_text(text)
    meta.update(fetch_meta)

    fallback = _maybe_use_happ_fallback(
        u,
        request_headers=req_headers,
        current_payload=payload,
        current_meta=meta,
        insecure=insecure,
        timeout=timeout,
        policy=effective_policy,
        max_bytes=max_bytes,
    )
    if fallback:
        return fallback
    return payload, meta


def _is_tls_handshake_timeout_message(msg: str) -> bool:
    low = str(msg or "").lower()
    return (
        ("handshake" in low and "timed out" in low)
        or ("_ssl.c" in low and "timed out" in low)
    )


def _tls_handshake_timeout_error(raw_message: str):
    return _make_error(
        "TLS_HANDSHAKE_TIMEOUT",
        "TLS handshake с сервером подписки не завершился вовремя.",
        (
            "Часто это блокировка, CDN/rate-limit или плохой маршрут через текущий "
            "VPN/exit-IP. Попробуйте другой VPN-сервер, повторите позже или включите "
            "«Игнорировать TLS» только для диагностики."
        ),
        retryable=True,
        detail=str(raw_message or ""),
    )


def _probe_once(
    url: str,
    *,
    method: str,
    headers: Dict[str, str],
    insecure: bool,
    timeout: float,
    policy: URLPolicy,
) -> tuple[_ProbeMeta, Dict[str, Any], list[Dict[str, Any]]]:
    """Low-level probe attempt. May raise urllib exceptions."""

    req_headers = dict(headers or {})
    if method.upper() == "GET":
        req_headers.setdefault("Range", "bytes=0-0")

    req = urllib.request.Request(url, headers=req_headers, method=method.upper())
    ctx = ssl._create_unverified_context() if insecure else None

    class SafeRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401,N803
            ok, reason = is_url_allowed(newurl, policy)
            if not ok:
                raise urllib.error.URLError("url_blocked:" + reason)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    start = time.monotonic()
    handlers: list[Any] = [SafeRedirect]
    if ctx is not None:
        handlers.append(urllib.request.HTTPSHandler(context=ctx))
    opener = urllib.request.build_opener(*handlers)
    with opener.open(req, timeout=float(timeout)) as resp:
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

        hwid_response_headers = _extract_hwid_response_headers(resp.headers)
        warnings: list[Dict[str, Any]] = _hwid_response_warnings(hwid_response_headers)
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
            hwid_response_headers=hwid_response_headers,
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
    policy: URLPolicy | None = None,
) -> Dict[str, Any]:
    """Probe a HWID subscription URL.

    Returns a JSON-friendly dict with:
      {ok, probe, profile, headers_used, hwid_response_headers, warnings, error}

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
            "hwid_response_headers": {},
            "warnings": [],
            "error": _make_error(
                "INVALID_URL",
                "Only http/https URLs are allowed.",
                "Укажите ссылку вида https://…",
                retryable=False,
            ),
        }

    effective_policy = policy or _hwid_subscription_policy()
    ok_url, reason = is_url_allowed(u, effective_policy)
    if not ok_url:
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
            "headers_used": dict(headers or {}),
            "hwid_response_headers": {},
            "warnings": [],
            "error": _make_error(
                "URL_BLOCKED",
                "URL HWID-подписки заблокирован политикой безопасности панели.",
                _url_blocked_hint(reason),
                retryable=False,
                reason=reason,
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
                u,
                method=m,
                headers=hdrs,
                insecure=insecure,
                timeout=timeout,
                policy=effective_policy,
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
                "hwid_response_headers": meta.hwid_response_headers or {},
                "warnings": warnings,
                "error": None,
            }
        except urllib.error.HTTPError as e:
            hwid_response_headers = _extract_hwid_response_headers(
                getattr(e, "headers", None)
            )
            last_meta = _ProbeMeta(
                url=u,
                resolved_url=getattr(e, "url", None),
                method=m,
                http_status=getattr(e, "code", None),
                content_type=(getattr(e, "headers", None) or {}).get("Content-Type"),
                content_length=None,
                timing_ms=0,
                hwid_response_headers=hwid_response_headers,
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
                "hwid_response_headers": hwid_response_headers,
                "warnings": _hwid_response_warnings(hwid_response_headers),
                "error": _make_error(
                    "HTTP_ERROR",
                    f"HTTP {getattr(e, 'code', '')}: {getattr(e, 'reason', '')}".strip(),
                    "Проверьте ссылку/доступность подписки.",
                    retryable=True,
                ),
            }
        except urllib.error.URLError as e:
            msg = str(getattr(e, "reason", e))
            if msg.startswith("url_blocked:"):
                reason = msg.split(":", 1)[1]
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
                    "hwid_response_headers": {},
                    "warnings": [],
                    "error": _make_error(
                        "URL_BLOCKED",
                        "Редирект HWID-подписки заблокирован политикой безопасности панели.",
                        _url_blocked_hint(reason),
                        retryable=False,
                        reason=reason,
                    ),
                }
            code = "NETWORK_ERROR"
            hint = "Проверьте доступ к интернету/домену и попробуйте снова."
            err_payload = None
            if _is_tls_handshake_timeout_message(msg):
                code = "TLS_HANDSHAKE_TIMEOUT"
                err_payload = _tls_handshake_timeout_error(msg)
            if not err_payload and (
                "CERTIFICATE_VERIFY_FAILED" in msg
                or "tls" in msg.lower()
                or "x509" in msg.lower()
            ):
                code = "TLS_VERIFY_FAILED"
                hint = "Попробуйте включить «Игнорировать TLS» или исправить сертификат/домен."
                err_payload = None
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
                "hwid_response_headers": {},
                "warnings": [],
                "error": err_payload or _make_error(code, msg, hint, retryable=True),
            }
        except TimeoutError as e:
            msg = str(e)
            err_payload = _tls_handshake_timeout_error(msg) if _is_tls_handshake_timeout_message(msg) else _make_error(
                "TIMEOUT",
                "timeout",
                "Сервер подписки не ответил вовремя. Попробуйте позже.",
                retryable=True,
            )
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
                "hwid_response_headers": {},
                "warnings": [],
                "error": err_payload,
            }
        except Exception as e:
            msg = str(e)
            err_payload = _tls_handshake_timeout_error(msg) if _is_tls_handshake_timeout_message(msg) else None
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
                "hwid_response_headers": (
                    getattr(last_meta, "hwid_response_headers", None) or {}
                ),
                "warnings": [],
                "error": err_payload or _make_error(
                    "PROBE_FAILED",
                    msg,
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
        "hwid_response_headers": {},
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
    policy: URLPolicy | None = None,
) -> Dict[str, Any]:
    """Run probe in a worker thread to avoid blocking the UI server."""
    wait_seconds = max(1.0, float(timeout) + 1.0)
    try:
        return net_call(
            lambda: probe_subscription(
                url,
                headers=headers,
                insecure=insecure,
                timeout=timeout,
                prefer=prefer,
                policy=policy,
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
            "hwid_response_headers": {},
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


def _yaml_normalize_inline_section(text: str, key: str) -> str:
    s = text or ""
    k = (key or "").strip()
    if not k:
        return s
    re_inline = re.compile(
        rf"(?m)^({re.escape(k)}\s*:)\s*(\[\]|\{{\}}|null|~)?\s*(#.*)?$"
    )
    m = re_inline.search(s)
    if not m:
        return s
    comment = f" {m.group(3).strip()}" if m.group(3) else ""
    return re_inline.sub(f"{k}:{comment}", s, count=1)


def _yaml_replace_section(text: str, key: str, new_section: str) -> str:
    s = _yaml_ensure_newline(_yaml_normalize_inline_section(text, key))
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
    s = _yaml_ensure_newline(_yaml_normalize_inline_section(text, key))
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
    *,
    provider_url: str | None = None,
) -> str:
    """Build YAML snippet for a single provider entry (indented under proxy-providers)."""

    nm = _sanitize_provider_name(provider_name or "")
    u = (provider_url or url or "").strip()
    h = dict(headers or {})

    lines: list[str] = []
    lines.append(f"  {nm}:")
    lines.append("    type: http")
    lines.append(f"    url: {_yaml_quote(u)}")
    lines.append("    interval: 43200")
    lines.append(f"    path: {_yaml_quote(f'./proxy_providers/{nm}.yaml')}")
    lines.append("    health-check:")
    lines.append("      enable: true")
    lines.append('      url: "https://www.gstatic.com/generate_204"')
    lines.append("      interval: 300")
    lines.append("      expected-status: 204")

    # Mihomo docs show header values as list-of-strings. This is the most compatible form.
    def push_header(key: str, val: str | None) -> list[str]:
        v = (val or "").strip()
        if not v:
            return []
        return [f"      {key}:", f"      - {_yaml_quote(v)}"]

    header_lines: list[str] = []
    header_lines += push_header("User-Agent", h.get("User-Agent") or h.get("user-agent"))
    header_lines += push_header("x-hwid", h.get("x-hwid"))

    if header_lines:
        lines.append("    header:")
        # Each header item is already indented to be inside 'header:'
        lines.extend(header_lines)

    lines.append("    override:")
    lines.append("      udp: true")
    lines.append("      tfo: true")

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
