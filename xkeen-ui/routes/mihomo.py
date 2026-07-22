"""Mihomo endpoints.

Extracted from legacy app.py.

Endpoints:
 - GET  /api/mihomo-config
 - POST /api/mihomo-config
 - POST /api/mihomo/preview
 - GET  /api/mihomo/profile_defaults
 - GET  /api/mihomo-config/template
 - GET  /api/mihomo-templates
 - GET  /api/mihomo-template
 - POST /api/mihomo-template
 - POST /api/mihomo/provider/probe
 - POST /api/mihomo/node/import-draft
 - GET  /mihomo/provider.yaml
 - GET  /mihomo/hwid/provider.yaml
 - POST /api/mihomo/hwid/apply
 - POST /api/mihomo/generate
 - POST /api/mihomo/download
 - POST /api/mihomo/save
 - POST /api/mihomo/restart
 - POST /api/mihomo/generate_apply
 - POST /api/mihomo/save_raw
 - POST /api/mihomo/restart_raw
 - POST /api/mihomo/validate_raw
 - GET  /api/mihomo/profiles
 - GET  /api/mihomo/profiles/<name>
 - PUT  /api/mihomo/profiles/<name>
 - DELETE /api/mihomo/profiles/<name>
 - POST /api/mihomo/profiles/<name>/activate
 - POST /api/mihomo/backups/clean
 - GET  /api/mihomo/backups
 - GET  /api/mihomo/backups/<filename>
 - DELETE /api/mihomo/backups/<filename>
 - POST /api/mihomo/backups/<filename>/restore
"""

from __future__ import annotations

import base64
import ipaddress
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict

from flask import Blueprint, jsonify, request, current_app, redirect

from routes.common.errors import exception_response
from mihomo_server_core import (
    ensure_mihomo_layout,
    get_active_profile_name,
    save_config,
    restart_mihomo_and_get_log,
    validate_config,
)
from services.mihomo_proxy_parsers import parse_wireguard
from services.mihomo_proxy_parsers import parse_openvpn, parse_tailscale
from services.mihomo_node_import import build_mihomo_node_draft
from services.mihomo_proxy_config import (
    apply_proxy_insert,
    rename_proxy_in_config,
    replace_proxy_in_config,
)
from services.mihomo_xray_json import (
    convert_subscription_text as _xray_convert_subscription_text,
    format_proxies_section as _xray_format_proxies_section,
)
from services.mihomo_subscriptions import (
    delete_subscription as _mh_sub_delete_subscription,
    list_subscriptions as _mh_sub_list_subscriptions,
    refresh_due_subscriptions as _mh_sub_refresh_due_subscriptions,
    refresh_subscription as _mh_sub_refresh_subscription,
    sync_imported_xray_subscription as _mh_sub_sync_imported_xray_subscription,
    sync_from_generator_state as _mh_sub_sync_from_generator_state,
    update_subscription_settings as _mh_sub_update_subscription_settings,
)
from services.xray_subscriptions import (
    fetch_subscription_body_for_xray as _xray_fetch_subscription_body_raw,
    _happ_helper_error_message,
)


import xkeen_mihomo_service as mihomo_svc

from services import happ_links
from services.mihomo import (
    parse_state_from_payload as _mihomo_parse_state,
    list_profiles_for_api as _mh_list_profiles_for_api,
    get_profile_content_for_api as _mh_get_profile_content_for_api,
    create_profile_from_content as _mh_create_profile_from_content,
    delete_profile_by_name as _mh_delete_profile_by_name,
    activate_profile as _mh_activate_profile,
)


def _xray_fetch_subscription_body(url: str) -> tuple[str, Dict[str, str]]:
    result = _xray_fetch_subscription_body_raw(url)
    if not isinstance(result, tuple):
        raise RuntimeError("unexpected_subscription_fetch_result")
    if len(result) == 2:
        body, headers = result
        return str(body or ""), dict(headers or {})
    if len(result) == 3:
        body, headers, _meta = result
        return str(body or ""), dict(headers or {})
    raise RuntimeError("unexpected_subscription_fetch_result")

from services.mihomo_backups import (
    list_backups_for_profile as _mh_list_backups_for_profile,
    get_backup_content as _mh_get_backup_content,
    restore_backup_file as _mh_restore_backup_file,
    delete_backup_file as _mh_delete_backup_file,
    clean_backups_for_api as _mh_clean_backups_for_api,
)

from services.mihomo_hwid_sub import (
    get_device_info as _mh_hwid_get_device_info,
    probe_subscription_safe as _mh_hwid_probe_subscription_safe,
    fetch_provider_payload as _mh_hwid_fetch_provider_payload,
    apply_mode as _mh_hwid_apply_mode,
    build_provider_entry as _mh_hwid_build_provider_entry,
    ensure_unique_provider_name as _mh_hwid_ensure_unique_provider_name,
    extract_hwid_limit_info as _mh_hwid_extract_limit_info,
)

from services.url_policy import URLPolicy, env_flag, is_url_allowed
from services.mihomo_yaml import validate_yaml_syntax
from utils.fs import load_text, save_text

# Background command jobs (used to avoid long-running HTTP requests)
from services.command_jobs import create_command_job
from services.cores import detect_running_core


def _api_error(message: str, status: int = 400, *, ok: bool | None = None, **extra: Any):
    payload: Dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    if extra:
        payload.update(extra)
    return jsonify(payload), status


def _mihomo_error(
    message: str,
    status: int = 400,
    *,
    code: str | None = None,
    hint: str | None = None,
    ok: bool | None = False,
    **extra: Any,
):
    if code and "code" not in extra:
        extra["code"] = code
    if hint and "hint" not in extra:
        extra["hint"] = hint
    return _api_error(message, status, ok=ok, **extra)


def _mihomo_exception(
    message: str,
    *,
    code: str,
    hint: str,
    exc: BaseException,
    status: int = 500,
    **extra: Any,
):
    return exception_response(
        message,
        status,
        ok=False,
        code=code,
        hint=hint,
        exc=exc,
        log_tag=f"mihomo.{code}",
        **extra,
    )


def _subscription_fetch_failure_reason(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        status = int(getattr(exc, "code", 0) or 0)
        if status:
            return f"http_{status}"
    reason = getattr(exc, "reason", None)
    text = str(reason or exc or "request_failed").strip()
    if not text:
        text = "request_failed"
    if len(text) > 240:
        text = text[:237].rstrip() + "..."
    return text


def _is_subscription_landing_page_error(reason: Any) -> bool:
    return str(reason or "").strip().lower().startswith("landing_page_html")


def _subscription_landing_page_probe_error(result: Dict[str, Any], *, mode: str):
    payload = dict(result or {})
    payload["ok"] = False
    failure_text = " ".join(
        str(payload.get(key) or "").strip()
        for key in ("provider_adapter_error", "provider_direct_error", "provider_hwid_error")
        if str(payload.get(key) or "").strip()
    ).lower()
    hint = (
        "Для импорта в XKeen нужен прямой URL, который отдает proxy-provider YAML, "
        "список URI-узлов или Xray JSON. Этот адрес похож на лендинг для Happ/INCY."
    )
    if "happ_decryptor_not_configured" in failure_text:
        hint += (
            " Настройте XKEEN_HAPP_DECRYPTOR_CMD, положите внешний decryptor "
            "в xkeen-ui/bin или укажите XKEEN_HAPP_DECRYPTOR_REMOTE_URL для "
            "осознанного HTTP fallback."
        )
    elif "happ_helper_not_configured" in failure_text:
        hint += " Настройте XKEEN_HAPP_HELPER_CMD, чтобы панель могла обработать Happ landing page."
    elif "happ_helper_" in failure_text:
        hint += " Happ helper не смог расшифровать deep-link этой подписки."
    elif "happ_decryptor_" in failure_text:
        hint += " Внешний Happ decryptor не смог расшифровать deep-link этой подписки."
        detail = _compact_happ_route_error_detail(failure_text, "happ_decryptor_failed:")
        if detail:
            hint += f" Детали: {detail}"
    payload["error"] = {
        "code": "LANDING_PAGE_HTML",
        "message": "URL возвращает HTML-страницу установки, а не прямую подписку.",
        "hint": hint,
        "mode": str(mode or "").strip() or "provider",
        "retryable": False,
    }
    return jsonify(payload), 400


def _compact_happ_route_error_detail(text: Any, prefix: str) -> str:
    raw = str(text or "")
    idx = raw.find(prefix)
    if idx < 0:
        return ""
    detail = raw[idx + len(prefix) :].strip()
    detail = re.sub(r"\s+", " ", detail)
    return detail[:360]


def _mihomo_fetch_failed_response(reason: str):
    return _mihomo_error(
        f"Не удалось скачать подписку: {reason}",
        status=502,
        code="fetch_failed",
        hint="Проверьте интернет, DNS/блокировки и доступность URL подписки.",
    )


_MIHOMO_HWID_URL_POLICY_ENV_PREFIX = "XKEEN_MIHOMO_HWID"
_MIHOMO_PROVIDER_URL_POLICY_ENV_PREFIX = "XKEEN_MIHOMO_PROVIDER"


def _mihomo_hwid_url_policy() -> URLPolicy:
    return URLPolicy(
        allow_hosts=(),
        allow_http=env_flag(f"{_MIHOMO_HWID_URL_POLICY_ENV_PREFIX}_ALLOW_HTTP", False),
        allow_private_hosts=env_flag(f"{_MIHOMO_HWID_URL_POLICY_ENV_PREFIX}_ALLOW_PRIVATE_HOSTS", False),
        allow_custom_urls=True,
    )


def _mihomo_provider_url_policy() -> URLPolicy:
    return URLPolicy(
        allow_hosts=(),
        allow_http=env_flag(f"{_MIHOMO_PROVIDER_URL_POLICY_ENV_PREFIX}_ALLOW_HTTP", True),
        allow_private_hosts=env_flag(f"{_MIHOMO_PROVIDER_URL_POLICY_ENV_PREFIX}_ALLOW_PRIVATE_HOSTS", False),
        allow_custom_urls=True,
    )


def _mihomo_provider_direct_headers() -> Dict[str, str]:
    ua = str(os.environ.get(f"{_MIHOMO_PROVIDER_URL_POLICY_ENV_PREFIX}_USER_AGENT") or "router").strip()
    return {"User-Agent": ua} if ua else {}


def _mihomo_provider_payload_is_non_empty(payload: str, meta: Dict[str, Any] | None = None) -> bool:
    summary = _mihomo_provider_payload_summary(payload, meta)
    return bool(summary.get("has_nodes"))


def _mihomo_header_truthy(value: Any) -> bool:
    text = str(value or "").strip().lower()
    return bool(text) and text not in {"0", "false", "no", "off", "none", "null"}


def _mihomo_hwid_headers_suggest_required(headers: Any) -> bool:
    if not isinstance(headers, dict):
        return False
    return any(
        _mihomo_header_truthy(headers.get(key))
        for key in ("x-hwid-not-supported", "x-hwid-max-devices-reached", "x-hwid-limit")
    )


def _mihomo_decode_base64_subscription(text: str) -> str:
    raw = re.sub(r"\s+", "", str(text or ""))
    if len(raw) < 16 or not re.fullmatch(r"[A-Za-z0-9+/=_-]+", raw):
        return ""
    raw = raw.replace("-", "+").replace("_", "/")
    raw += "=" * ((4 - len(raw) % 4) % 4)
    try:
        return base64.b64decode(raw, validate=False).decode("utf-8", errors="replace")
    except Exception:
        return ""


_MIHOMO_URI_RE = re.compile(
    r"(?mi)^\s*(?:vless|vmess|trojan|ss|ssr|shadowsocks|hysteria2|hy2|hysteria|tuic|wireguard)://"
)
_MIHOMO_YAML_PROXY_NAME_RE = re.compile(r"(?m)^\s*-\s*name\s*:\s*")
_MIHOMO_LOOPBACK_PLACEHOLDER_RE = re.compile(r"://[^\s#]*@?0\.0\.0\.0:1(?=$|[/?#])", re.IGNORECASE)
_MIHOMO_YAML_LOOPBACK_PLACEHOLDER_RE = re.compile(
    r"(?ims)^\s*-\s*name\s*:\s*.+?(?:^\s*server\s*:\s*[\"']?0\.0\.0\.0[\"']?\s*$)"
    r".+?(?:^\s*port\s*:\s*[\"']?1[\"']?\s*$)"
)


def _mihomo_uri_lines(text: str) -> list[str]:
    return [line.strip() for line in str(text or "").splitlines() if _MIHOMO_URI_RE.match(line)]


def _mihomo_provider_payload_is_hwid_placeholder(
    text: str,
    decoded: str,
    meta: Dict[str, Any],
) -> bool:
    return bool(_mihomo_provider_payload_hwid_placeholder_reason(text, decoded, meta))


def _mihomo_provider_payload_hwid_placeholder_reason(
    text: str,
    decoded: str,
    meta: Dict[str, Any],
) -> str:
    candidates = _mihomo_uri_lines(decoded) or _mihomo_uri_lines(text)
    raw_text = "\n".join(part for part in (decoded, text) if part)
    readable = urllib.parse.unquote(raw_text, errors="replace")
    lowered = readable.lower()

    headers = meta.get("hwid_response_headers") or {}
    if _mihomo_hwid_headers_suggest_required(headers):
        if _mihomo_header_truthy(headers.get("x-hwid-max-devices-reached")) or _mihomo_header_truthy(headers.get("x-hwid-limit")):
            return "device_limit"
        return "hwid_required"

    has_uri_placeholder = bool(candidates) and all(
        _MIHOMO_LOOPBACK_PLACEHOLDER_RE.search(line) for line in candidates
    )
    has_yaml_placeholder = bool(_MIHOMO_YAML_LOOPBACK_PLACEHOLDER_RE.search(str(text or "")))
    if not has_uri_placeholder and not has_yaml_placeholder:
        return ""

    if any(
        marker in lowered
        for marker in (
            "превышен лимит устройств",
            "лимит устройств",
            "max devices",
            "device limit",
        )
    ):
        return "device_limit"

    if any(
        marker in lowered
        for marker in (
            "hwid",
            "не поддерж",
            "включите hwid",
        )
    ):
        return "hwid_required"

    return ""


def _mihomo_provider_payload_summary(
    payload: str,
    meta: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    text = str(payload or "").strip()
    m = dict(meta or {})
    yaml_proxy_markers = len(_MIHOMO_YAML_PROXY_NAME_RE.findall(text))
    raw_uri_markers = len(_MIHOMO_URI_RE.findall(text))
    decoded = _mihomo_decode_base64_subscription(text)
    base64_uri_markers = len(_MIHOMO_URI_RE.findall(decoded)) if decoded else 0

    inline_empty = bool(re.match(r"(?is)^proxies\s*:\s*\[\s*\]\s*$", text))
    block_empty = bool(re.match(r"(?is)^proxies\s*:\s*(?:#.*)?$", text)) and yaml_proxy_markers == 0
    empty_proxy_provider = inline_empty or (
        bool(m.get("proxy_section")) and yaml_proxy_markers == 0 and raw_uri_markers == 0
    )

    hwid_headers = m.get("hwid_response_headers") or {}
    marker_node_count = yaml_proxy_markers or raw_uri_markers or base64_uri_markers
    hwid_placeholder_reason = _mihomo_provider_payload_hwid_placeholder_reason(text, decoded, m)
    hwid_placeholder_provider = bool(hwid_placeholder_reason)
    node_count = 0 if hwid_placeholder_provider else marker_node_count
    has_nodes = bool(node_count) and not empty_proxy_provider
    hwid_limit_info = _mh_hwid_extract_limit_info(hwid_headers)
    if hwid_placeholder_reason == "device_limit":
        hwid_limit_info = dict(hwid_limit_info or {})
        hwid_limit_info["reached"] = True
    return {
        "format": m.get("format"),
        "converted": bool(m.get("converted")),
        "xray_json": bool(m.get("xray_json")),
        "happ_fallback_used": bool(m.get("happ_fallback_used")),
        "happ_fallback_original_count": m.get("happ_fallback_original_count"),
        "proxy_count": m.get("proxy_count"),
        "skipped_count": m.get("skipped_count"),
        "proxy_section": bool(m.get("proxy_section")),
        "bytes": m.get("bytes"),
        "content_type": m.get("content_type"),
        "hwid_response_headers": hwid_headers,
        "hwid_limit_info": hwid_limit_info,
        "node_count": int(node_count),
        "yaml_proxy_count": int(yaml_proxy_markers),
        "raw_uri_count": int(raw_uri_markers),
        "base64_uri_count": int(base64_uri_markers),
        "placeholder_node_count": int(marker_node_count) if hwid_placeholder_provider else 0,
        "hwid_placeholder_provider": bool(hwid_placeholder_provider),
        "hwid_placeholder_reason": hwid_placeholder_reason,
        "empty_proxy_provider": bool(empty_proxy_provider or block_empty or hwid_placeholder_provider),
        "has_nodes": bool(has_nodes),
    }


def _mihomo_proxy_name_from_yaml_line(line: str) -> str:
    m = re.match(r"^\s*-\s*name\s*:\s*(.+?)\s*$", str(line or ""))
    if not m:
        return ""
    raw = m.group(1).strip()
    if raw and raw[0] not in ("'", '"'):
        raw = re.sub(r"\s+#.*$", "", raw).strip()
    return raw.strip("'\"")


def _mihomo_provider_payload_proxy_blocks(payload: str, *, max_count: int = 256) -> list[Dict[str, str]]:
    """Extract individual proxy YAML blocks from a provider `proxies:` payload."""

    text = str(payload or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.splitlines()
    section_start = -1
    section_indent = 0
    for idx, line in enumerate(lines):
        stripped = line.lstrip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(stripped)
        if re.match(r"^proxies\s*:\s*(?:#.*)?$", stripped):
            section_start = idx + 1
            section_indent = indent
            break
        if indent == 0 and re.match(r"^[A-Za-z0-9_.-]+\s*:", stripped):
            continue

    if section_start < 0:
        return []

    section: list[str] = []
    for line in lines[section_start:]:
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if stripped and not stripped.startswith("#") and indent <= section_indent:
            break
        section.append(line)

    starts: list[int] = []
    item_indent: int | None = None
    for idx, line in enumerate(section):
        m = re.match(r"^(\s*)-\s*name\s*:", line)
        if not m:
            continue
        indent = len(m.group(1))
        if item_indent is None:
            item_indent = indent
        if indent == item_indent:
            starts.append(idx)

    if not starts or item_indent is None:
        return []

    out: list[Dict[str, str]] = []
    for pos, start in enumerate(starts[:max_count]):
        end = starts[pos + 1] if pos + 1 < len(starts) else len(section)
        block_lines = section[start:end]
        normalized: list[str] = []
        for line in block_lines:
            if len(line) >= item_indent and line[:item_indent].strip() == "":
                normalized.append(line[item_indent:])
            else:
                normalized.append(line)
        while normalized and not normalized[-1].strip():
            normalized.pop()
        if not normalized:
            continue
        name = _mihomo_proxy_name_from_yaml_line(normalized[0])
        yaml_block = "\n".join(normalized).rstrip() + "\n"
        if name and yaml_block.lstrip().startswith("- name"):
            out.append({"proxy_name": name, "proxy_yaml": yaml_block})
    return out


def _mihomo_hwid_url_blocked_hint(reason: str) -> str:
    r = str(reason or "").strip()
    if r == "http_not_allowed":
        return (
            "По умолчанию HWID-подписки принимаются только по HTTPS. "
            f"Для plain HTTP явно включите {_MIHOMO_HWID_URL_POLICY_ENV_PREFIX}_ALLOW_HTTP=1."
        )
    if r.startswith("private_host_not_allowed:"):
        return (
            "Локальные и private адреса заблокированы для защиты панели. "
            f"Если это осознанно нужный локальный endpoint, включите "
            f"{_MIHOMO_HWID_URL_POLICY_ENV_PREFIX}_ALLOW_PRIVATE_HOSTS=1."
        )
    return "Разрешены публичные http/https URL, с HTTPS по умолчанию."


def _mihomo_hwid_url_blocked_result(url: str, reason: str) -> Dict[str, Any]:
    return {
        "ok": False,
        "probe": {
            "url": str(url or "").strip(),
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
        "error": {
            "code": "URL_BLOCKED",
            "message": "URL HWID-подписки заблокирован политикой безопасности панели.",
            "hint": _mihomo_hwid_url_blocked_hint(reason),
            "reason": reason,
            "retryable": False,
        },
    }


def _mihomo_hwid_policy_block_reason(url: str, policy: URLPolicy) -> str | None:
    url_s = str(url or "").strip()
    if not url_s:
        return None
    try:
        scheme = (urllib.parse.urlparse(url_s).scheme or "").lower()
    except Exception:
        return None
    if scheme not in ("http", "https"):
        return None
    ok, reason = is_url_allowed(url_s, policy)
    return None if ok else reason


def _mihomo_provider_policy_block_reason(url: str, policy: URLPolicy) -> str | None:
    return _mihomo_hwid_policy_block_reason(url, policy)


def _mihomo_yaml_invalid(*, stage: str | None = None):
    code = "yaml_invalid"
    message = "Некорректный YAML-конфиг."
    hint = "Проверьте YAML и попробуйте снова."
    if stage:
        return (
            jsonify(
                {
                    "ok": False,
                    "stage": stage,
                    "error": {
                        "code": code,
                        "message": message,
                        "hint": hint,
                        "retryable": False,
                    },
                }
            ),
            400,
        )
    return _mihomo_error(message, 400, ok=False, code=code, hint=hint)


def _safe_template_path(templates_dir: str, name: str) -> str | None:
    # не даём уходить вверх по дереву и использовать подкаталоги
    if not name or "/" in name or "\\" in name or ".." in name:
        return None
    if not name.endswith(".yaml") and not name.endswith(".yml"):
        name = name + ".yaml"
    return os.path.join(templates_dir, name)


def _mihomo_ui_loopback_port_from_request() -> int:
    candidates = [
        os.environ.get("XKEEN_UI_PORT"),
        str(urllib.parse.urlsplit(request.host_url or "").port or ""),
        "8088",
    ]
    for raw in candidates:
        try:
            port = int(str(raw or "").strip())
        except Exception:
            continue
        if 0 < port <= 65535:
            return port
    return 8088


def _mihomo_provider_adapter_base_from_request() -> str:
    return f"http://127.0.0.1:{_mihomo_ui_loopback_port_from_request()}"


def _mihomo_get_state_from_request() -> Dict[str, Any]:
    """Obtain Mihomo state from the current HTTP request via service parser."""
    data = request.get_json(silent=True) or {}
    state = _mihomo_parse_state(data)
    state["_xk_mihomo_provider_adapter_base"] = _mihomo_provider_adapter_base_from_request()
    return state


def create_mihomo_blueprint(
    *,
    MIHOMO_CONFIG_FILE: str,
    MIHOMO_TEMPLATES_DIR: str,
    MIHOMO_DEFAULT_TEMPLATE: str,
    restart_xkeen: Any,
    ui_state_dir: str = "",
) -> Blueprint:
    bp = Blueprint("mihomo", __name__)

    def _bool_arg(name: str, default: bool) -> bool:
        raw = request.args.get(name)
        if raw is None:
            return bool(default)
        return str(raw or "").strip().lower() in {"1", "true", "yes", "on", "y"}

    def _same_config_text(left: str, right: str) -> bool:
        return str(left or "").replace("\r\n", "\n").rstrip("\n") == str(right or "").replace("\r\n", "\n").rstrip("\n")

    def _request_is_loopback() -> bool:
        addr = str(request.remote_addr or "").strip()
        if addr in {"localhost", "127.0.0.1", "::1"}:
            return True
        try:
            return bool(ipaddress.ip_address(addr).is_loopback)
        except Exception:
            return False

    def _ui_loopback_port() -> int:
        return _mihomo_ui_loopback_port_from_request()

    def _hwid_provider_adapter_url(upstream_url: str, *, insecure: bool) -> str:
        query = urllib.parse.urlencode(
            {
                "url": str(upstream_url or "").strip(),
                "insecure": "1" if insecure else "0",
            }
        )
        return f"http://127.0.0.1:{_ui_loopback_port()}/mihomo/hwid/provider.yaml?{query}"

    def _write_hwid_provider_cache(provider_name: str, payload: str) -> bool:
        name = _mh_hwid_ensure_unique_provider_name("", provider_name)
        if not name:
            return False
        try:
            root = os.path.dirname(MIHOMO_CONFIG_FILE)
            provider_dir = os.path.join(root, "proxy_providers")
            os.makedirs(provider_dir, exist_ok=True)
            save_text(os.path.join(provider_dir, f"{name}.yaml"), payload)
            return True
        except Exception:
            return False

    def _sync_mihomo_managed_subscriptions(state: Dict[str, Any], cfg: str) -> None:
        try:
            state_for_sync = dict(state)
            state_for_sync.pop("_xk_mihomo_provider_adapter_base", None)
            _mh_sub_sync_from_generator_state(ui_state_dir, state_for_sync, config_text=cfg)
        except Exception:
            # Managed subscription metadata is best-effort; config save/restart
            # must not fail just because the sidecar state could not be updated.
            pass

    @bp.get("/mihomo/provider.yaml")
    def public_mihomo_provider_yaml():
        """Loopback-only provider adapter for regular HTTP subscriptions."""

        if not _request_is_loopback():
            return current_app.response_class("forbidden\n", status=403, mimetype="text/plain")

        url = (request.args.get("url") or "").strip()
        insecure = _bool_arg("insecure", False)
        policy = _mihomo_provider_url_policy()
        reason = _mihomo_provider_policy_block_reason(url, policy)
        if reason:
            return current_app.response_class(
                f"url blocked: {reason}\n",
                status=400,
                mimetype="text/plain",
            )

        try:
            payload, _meta = _mh_hwid_fetch_provider_payload(
                url,
                headers={},
                insecure=insecure,
                timeout=20.0,
                policy=policy,
            )
            return current_app.response_class(payload, mimetype="text/yaml")
        except ValueError as exc:
            msg = str(exc or "invalid_provider_payload")
            status = 400 if msg.startswith("url_blocked:") else 502
            return current_app.response_class(msg + "\n", status=status, mimetype="text/plain")
        except Exception as exc:
            return current_app.response_class(
                _subscription_fetch_failure_reason(exc) + "\n",
                status=502,
                mimetype="text/plain",
            )

    @bp.post("/api/mihomo/provider/probe")
    def api_mihomo_provider_probe():
        """Probe regular provider subscription URL without HWID/Mihomo headers."""
        data = request.get_json(silent=True) or {}
        url = (data.get("url") or "").strip()
        insecure = bool(data.get("insecure", False))
        prefer = (data.get("prefer") or "head_then_range_get").strip() or "head_then_range_get"

        policy = _mihomo_provider_url_policy()
        reason = _mihomo_provider_policy_block_reason(url, policy)
        if reason:
            return jsonify(_mihomo_hwid_url_blocked_result(url, reason)), 400

        timeout_ms = data.get("timeout_ms", 8000)
        try:
            timeout_ms = int(timeout_ms)
        except Exception:
            timeout_ms = 8000
        timeout_s = max(1.0, min(float(timeout_ms) / 1000.0, 60.0))

        result = _mh_hwid_probe_subscription_safe(
            url,
            headers={},
            insecure=insecure,
            timeout=timeout_s,
            prefer=prefer,
            policy=policy,
        )

        if isinstance(result, dict):
            result = dict(result)
            result["hwid_limit_info"] = _mh_hwid_extract_limit_info(
                result.get("hwid_response_headers") or {}
            )
            if result.get("ok") is True:
                adapter_url = (
                    f"http://127.0.0.1:{_ui_loopback_port()}/mihomo/provider.yaml?"
                    + urllib.parse.urlencode({"url": url, "insecure": "1" if insecure else "0"})
                )
                result["provider_url"] = adapter_url
                result["provider_headers"] = {}
                result["provider_mode"] = "adapter"
                current_provider_summary: Dict[str, Any] | None = None

                direct_headers = _mihomo_provider_direct_headers()
                if direct_headers:
                    try:
                        payload, meta = _mh_hwid_fetch_provider_payload(
                            url,
                            headers=direct_headers,
                            insecure=insecure,
                            timeout=timeout_s,
                            policy=policy,
                        )
                        direct_summary = _mihomo_provider_payload_summary(payload, meta)
                        current_provider_summary = direct_summary
                        if direct_summary.get("has_nodes"):
                            result["provider_url"] = url
                            result["provider_headers"] = dict(direct_headers)
                            result["provider_mode"] = "direct_headers"
                            result["provider_payload"] = direct_summary
                    except Exception as exc:
                        result["provider_direct_error"] = _subscription_fetch_failure_reason(exc)

                hwid_markers = {}
                try:
                    hwid_markers.update(result.get("hwid_response_headers") or {})
                except Exception:
                    pass
                try:
                    if current_provider_summary:
                        hwid_markers.update(current_provider_summary.get("hwid_response_headers") or {})
                except Exception:
                    pass

                direct_looks_hwid_gated = bool(
                    current_provider_summary
                    and current_provider_summary.get("hwid_placeholder_provider")
                )
                if _mihomo_hwid_headers_suggest_required(hwid_markers) or direct_looks_hwid_gated:
                    try:
                        info = _mh_hwid_get_device_info()
                        hwid_payload, hwid_meta = _mh_hwid_fetch_provider_payload(
                            url,
                            headers=info.get("headers") or {},
                            insecure=insecure,
                            timeout=timeout_s,
                            policy=_mihomo_hwid_url_policy(),
                        )
                        hwid_summary = _mihomo_provider_payload_summary(hwid_payload, hwid_meta)
                        current_count = int((current_provider_summary or {}).get("node_count") or 0)
                        if hwid_summary.get("has_nodes") and int(hwid_summary.get("node_count") or 0) > current_count:
                            result["provider_url"] = (
                                f"http://127.0.0.1:{_ui_loopback_port()}/mihomo/hwid/provider.yaml?"
                                + urllib.parse.urlencode({"url": url, "insecure": "1" if insecure else "0"})
                            )
                            result["provider_headers"] = {}
                            result["provider_mode"] = "hwid_adapter"
                            result["provider_payload"] = hwid_summary
                            provider_proxies = _mihomo_provider_payload_proxy_blocks(hwid_payload)
                            if provider_proxies:
                                result["provider_proxies"] = provider_proxies
                    except Exception as exc:
                        result["provider_hwid_error"] = _subscription_fetch_failure_reason(exc)

                if (
                    str(result.get("provider_mode") or "").strip() == "adapter"
                    and (
                        not current_provider_summary
                        or not current_provider_summary.get("has_nodes")
                    )
                ):
                    try:
                        adapter_payload, adapter_meta = _mh_hwid_fetch_provider_payload(
                            url,
                            headers={},
                            insecure=insecure,
                            timeout=timeout_s,
                            policy=policy,
                        )
                        adapter_summary = _mihomo_provider_payload_summary(
                            adapter_payload,
                            adapter_meta,
                        )
                        current_provider_summary = adapter_summary
                        result["provider_payload"] = adapter_summary
                    except Exception as exc:
                        result["provider_adapter_error"] = _subscription_fetch_failure_reason(exc)

                if (
                    str(result.get("provider_mode") or "").strip() == "adapter"
                    and not (
                        current_provider_summary
                        and current_provider_summary.get("has_nodes")
                    )
                    and (
                        result.get("provider_adapter_error")
                        or result.get("provider_direct_error")
                        or result.get("provider_hwid_error")
                    )
                ):
                    failure_reason = (
                        result.get("provider_adapter_error")
                        or result.get("provider_direct_error")
                        or result.get("provider_hwid_error")
                    )
                    if _is_subscription_landing_page_error(failure_reason):
                        return _subscription_landing_page_probe_error(result, mode="provider")

        if isinstance(result, dict) and result.get("ok") is True:
            return jsonify(result), 200

        err = (result.get("error") or {}) if isinstance(result, dict) else {}
        code = (err.get("code") or "").upper()
        status = 502
        if code == "INVALID_URL":
            status = 400
        elif code in {"TIMEOUT", "TLS_HANDSHAKE_TIMEOUT"}:
            status = 504
        elif code == "URL_BLOCKED":
            status = 400
        return jsonify(result), status

    @bp.get("/mihomo/hwid/provider.yaml")
    def public_mihomo_hwid_provider_yaml():
        """Loopback-only provider adapter for full-config HWID subscriptions."""

        if not _request_is_loopback():
            return current_app.response_class("forbidden\n", status=403, mimetype="text/plain")

        url = (request.args.get("url") or "").strip()
        insecure = _bool_arg("insecure", False)
        policy = _mihomo_hwid_url_policy()
        reason = _mihomo_hwid_policy_block_reason(url, policy)
        if reason:
            return current_app.response_class(
                f"url blocked: {reason}\n",
                status=400,
                mimetype="text/plain",
            )

        try:
            info = _mh_hwid_get_device_info()
            payload, _meta = _mh_hwid_fetch_provider_payload(
                url,
                headers=info.get("headers") or {},
                insecure=insecure,
                timeout=20.0,
                policy=policy,
            )
            return current_app.response_class(payload, mimetype="text/yaml")
        except ValueError as exc:
            msg = str(exc or "invalid_provider_payload")
            status = 400 if msg.startswith("url_blocked:") else 502
            return current_app.response_class(msg + "\n", status=status, mimetype="text/plain")
        except Exception as exc:
            return current_app.response_class(
                _subscription_fetch_failure_reason(exc) + "\n",
                status=502,
                mimetype="text/plain",
            )

    # ---------- API: mihomo config.yaml ----------

    @bp.get("/api/mihomo-config")
    def api_get_mihomo_config():
        content = load_text(MIHOMO_CONFIG_FILE, default=None)
        if content is None:
            return _mihomo_error("Файл config.yaml не найден.", 404, code="config_not_found")
        return jsonify({"ok": True, "content": content}), 200

    @bp.post("/api/mihomo-config")
    def api_set_mihomo_config():
        data = request.get_json(silent=True) or {}
        content = data.get("content", "")

        try:
            # Сохраняем конфиг через mihomo_server_core, чтобы перед записью делался бэкап
            ensure_mihomo_layout()
            save_config(content)
        except Exception as e:
            return _mihomo_exception(
                "Не удалось сохранить active config.yaml.",
                code="config_save_failed",
                hint="Проверьте конфиг и server logs.",
                exc=e,
                status=400,
            )

        restart_flag = bool(data.get("restart", True))
        async_q = request.args.get("async")

        resp = {"ok": True, "restarted": False}
        if restart_flag and async_q in ("1", "true", "yes"):
            job = create_command_job(flag="-restart", stdin_data=None, cmd=None, use_pty=True)
            resp.update({"restart_queued": True, "restart_job_id": job.id})
            return jsonify(resp), 202

        restarted = restart_flag and restart_xkeen(source="mihomo-config")
        resp["restarted"] = restarted
        return jsonify(resp), 200

    @bp.post("/api/mihomo/preview")
    def api_mihomo_preview():
        """Generate Mihomo config preview from UI state without saving or restart."""
        data = request.get_json(silent=True) or {}
        try:
            cfg, warnings = mihomo_svc.generate_preview(data)
        except Exception as exc:  # pragma: no cover - defensive
            return _mihomo_exception(
                "Не удалось сгенерировать предпросмотр.",
                code="preview_failed",
                hint="Проверьте входные данные и повторите попытку.",
                exc=exc,
                status=400,
            )
        return jsonify({"ok": True, "content": cfg, "warnings": warnings}), 200

    @bp.get("/api/mihomo/profile_defaults")
    def api_mihomo_profile_defaults():
        """Return profile-specific presets for the Mihomo generator UI."""
        profile = request.args.get("profile")
        try:
            data = mihomo_svc.get_profile_defaults(profile)
        except Exception as exc:  # pragma: no cover - defensive
            return _mihomo_exception(
                "Не удалось получить пресет профиля Mihomo.",
                code="profile_defaults_failed",
                hint="Проверьте выбранный профиль и повторите попытку.",
                exc=exc,
                status=400,
            )

        resp = {"ok": True}
        resp.update(data)
        return jsonify(resp), 200

    # ---------- API: HWID subscription helper ----------

    @bp.get("/api/mihomo/hwid/device")
    def api_mihomo_hwid_device():
        """Return best-effort device info + headers for HWID-bound subscriptions."""
        try:
            info = _mh_hwid_get_device_info()
        except Exception as exc:  # pragma: no cover - defensive
            return _mihomo_exception(
                "Не удалось получить данные устройства для HWID.",
                code="hwid_device_failed",
                hint="Повторите попытку позже. Подробности смотрите в server logs.",
                exc=exc,
                status=400,
            )
        return jsonify({"ok": True, **info}), 200

    @bp.post("/api/mihomo/hwid/probe")
    def api_mihomo_hwid_probe():
        """Probe subscription URL and try to extract profile-title (if present)."""
        data = request.get_json(silent=True) or {}
        url = (data.get("url") or "").strip()
        insecure = bool(data.get("insecure", False))
        prefer = (data.get("prefer") or "head_then_range_get").strip() or "head_then_range_get"

        policy = _mihomo_hwid_url_policy()
        reason = _mihomo_hwid_policy_block_reason(url, policy)
        if reason:
            return jsonify(_mihomo_hwid_url_blocked_result(url, reason)), 400

        timeout_ms = data.get("timeout_ms", 8000)
        try:
            timeout_ms = int(timeout_ms)
        except Exception:
            timeout_ms = 8000
        timeout_s = max(1.0, min(float(timeout_ms) / 1000.0, 60.0))

        info = _mh_hwid_get_device_info()
        headers = info.get("headers") or {}

        result = _mh_hwid_probe_subscription_safe(
            url,
            headers=headers,
            insecure=insecure,
            timeout=timeout_s,
            prefer=prefer,
            policy=policy,
        )

        # Map known error codes to helpful HTTP statuses (no 500).
        if result.get("ok") is True:
            result = dict(result)
            result["hwid_limit_info"] = _mh_hwid_extract_limit_info(
                result.get("hwid_response_headers") or {}
            )
            warnings = list(result.get("warnings") or [])
            try:
                provider_payload, provider_meta = _mh_hwid_fetch_provider_payload(
                    url,
                    headers=headers,
                    insecure=insecure,
                    timeout=max(3.0, min(timeout_s, 12.0)),
                    policy=policy,
                )
                provider_summary = _mihomo_provider_payload_summary(
                    provider_payload,
                    provider_meta,
                )
                result["provider_payload"] = provider_summary

                if not provider_summary.get("has_nodes"):
                    warnings.append(
                        {
                            "code": "HWID_PROVIDER_EMPTY",
                            "hint": (
                                "HWID-подписка доступна, но вернула 0 узлов. "
                                "Возможно, этот HWID не привязан к подписке или URL лучше добавить как обычную подписку."
                            ),
                        }
                    )
                    try:
                        regular_payload, regular_meta = _mh_hwid_fetch_provider_payload(
                            url,
                            headers={},
                            insecure=insecure,
                            timeout=max(3.0, min(timeout_s, 12.0)),
                            policy=policy,
                        )
                        regular_summary = _mihomo_provider_payload_summary(
                            regular_payload,
                            regular_meta,
                        )
                        result["regular_provider_payload"] = regular_summary
                        if regular_summary.get("has_nodes"):
                            warnings.append(
                                {
                                    "code": "HWID_EMPTY_BUT_REGULAR_HAS_NODES",
                                    "hint": (
                                        "Без HWID эта ссылка возвращает узлы, а с HWID — пустой provider. "
                                        "Попробуйте добавить её как обычную подписку или проверьте привязку HWID у провайдера."
                                    ),
                                }
                            )
                    except Exception as exc:
                        result["regular_provider_payload_error"] = {
                            "code": type(exc).__name__,
                            "message": _subscription_fetch_failure_reason(exc),
                        }
            except Exception as exc:
                result["provider_payload_error"] = {
                    "code": type(exc).__name__,
                    "message": _subscription_fetch_failure_reason(exc),
                }
                warnings.append(
                    {
                        "code": "PROVIDER_PAYLOAD_CHECK_FAILED",
                        "hint": (
                            "Проверка URL прошла, но не удалось получить payload подписки для подсчёта узлов."
                        ),
                    }
                )
            result["warnings"] = warnings
            return jsonify(result), 200

        err = (result.get("error") or {}) if isinstance(result, dict) else {}
        code = (err.get("code") or "").upper()
        status = 502
        if code == "INVALID_URL":
            status = 400
        elif code in {"TIMEOUT", "TLS_HANDSHAKE_TIMEOUT"}:
            status = 504
        elif code == "URL_BLOCKED":
            status = 400
        return jsonify(result), status

    @bp.post("/api/mihomo/hwid/apply")
    def api_mihomo_hwid_apply():
        """Apply HWID subscription provider to mihomo config (server-side).

        Supported modes:
          - add: insert provider into existing config
          - replace_providers: replace whole proxy-providers section
          - replace_all: replace whole config with a template, then insert provider

        If restart=true, schedules xkeen -restart via background job and returns 202.
        """

        data = request.get_json(silent=True) or {}
        url = (data.get("url") or "").strip()
        insecure = bool(data.get("insecure", False))
        mode = (data.get("mode") or "add").strip() or "add"
        provider_name = (data.get("name") or "").strip()
        restart_flag = bool(data.get("restart", False))

        # Optional template selector for replace_all
        template_name = (data.get("template_name") or "").strip()
        template_inline = data.get("template")  # optional inline YAML

        # Reuse probe logic to validate URL and get suggested name.
        policy = _mihomo_hwid_url_policy()
        reason = _mihomo_hwid_policy_block_reason(url, policy)
        if reason:
            blocked = _mihomo_hwid_url_blocked_result(url, reason)
            return jsonify({"ok": False, "stage": "probe", "probe": blocked}), 400

        info = _mh_hwid_get_device_info()
        headers = info.get("headers") or {}

        # Probe (in worker thread) to get profile-title and validate URL.
        probe = _mh_hwid_probe_subscription_safe(
            url,
            headers=headers,
            insecure=insecure,
            timeout=8.0,
            prefer="head_then_range_get",
            policy=policy,
        )

        if not (probe and isinstance(probe, dict) and probe.get("ok") is True):
            # Keep probe error payload intact, but mark that apply failed.
            err = (probe.get("error") or {}) if isinstance(probe, dict) else {}
            code = (err.get("code") or "").upper()
            status = 502
            if code == "INVALID_URL":
                status = 400
            elif code in {"TIMEOUT", "TLS_HANDSHAKE_TIMEOUT"}:
                status = 504
            elif code == "URL_BLOCKED":
                status = 400
            return jsonify({"ok": False, "stage": "probe", "probe": probe}), status

        suggested = ((probe.get("profile") or {}) if isinstance(probe, dict) else {}).get(
            "suggested_name"
        )
        name_base = provider_name or (suggested or "")

        # Base YAML depends on mode.
        base_yaml = load_text(MIHOMO_CONFIG_FILE, default="") or ""
        tmpl_yaml = None

        if mode.strip().lower() == "replace_all":
            if isinstance(template_inline, str) and template_inline.strip():
                tmpl_yaml = template_inline
            else:
                # If template_name is provided, load from templates dir; otherwise use default template.
                if template_name:
                    sp = _safe_template_path(MIHOMO_TEMPLATES_DIR, template_name)
                    if not sp:
                        return _api_error("Invalid template_name", 400, ok=False)
                    tmpl_yaml = load_text(sp, default=None)
                    if tmpl_yaml is None:
                        return _api_error(f"Template not found: {template_name}", 404, ok=False)
                else:
                    tmpl_yaml = load_text(MIHOMO_DEFAULT_TEMPLATE, default=None)
                    if tmpl_yaml is None:
                        return _mihomo_error("Шаблон Mihomo по умолчанию не найден.", 404, code="template_not_found")
            base_for_name = tmpl_yaml or ""
        else:
            base_for_name = base_yaml

        name_unique = _mh_hwid_ensure_unique_provider_name(base_for_name, name_base)
        adapter_url = _hwid_provider_adapter_url(url, insecure=insecure)
        entry = _mh_hwid_build_provider_entry(name_unique, url, {}, provider_url=adapter_url)
        provider_cache_written = False
        try:
            provider_payload, _provider_meta = _mh_hwid_fetch_provider_payload(
                url,
                headers=headers,
                insecure=insecure,
                timeout=20.0,
                policy=policy,
            )
            provider_cache_written = _write_hwid_provider_cache(name_unique, provider_payload)
        except Exception:
            provider_cache_written = False

        try:
            cfg_new = _mh_hwid_apply_mode(base_yaml, mode, entry, template_yaml=tmpl_yaml)
        except ValueError:
            return _mihomo_error(
                "Не удалось применить HWID-подписку.",
                400,
                code="hwid_apply_invalid",
                hint="Проверьте параметры режима и выбранный шаблон.",
            )
        except Exception as e:
            return _mihomo_exception(
                "Не удалось применить HWID-подписку.",
                code="hwid_apply_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=400,
            )

        # Validate YAML (fast, optional) to prevent writing broken config.
        ok_yaml, yaml_err = validate_yaml_syntax(cfg_new)
        if not ok_yaml:
            return _mihomo_yaml_invalid(stage="validate")

        try:
            ensure_mihomo_layout()
            save_config(cfg_new)
            active_profile = get_active_profile_name()

            running_core = detect_running_core()

            resp = {
                "ok": True,
                "mode": mode,
                "provider_name": name_unique,
                "active_profile": active_profile,
                "config_length": len(cfg_new),
                "core": running_core,
                "provider_url": adapter_url,
                "provider_cache_written": provider_cache_written,
            }

            if restart_flag:
                job = create_command_job(flag="-restart", stdin_data=None, cmd=None, use_pty=True)
                resp.update({"restart_queued": True, "restart_job_id": job.id})
                return jsonify(resp), 202

            resp["restart_queued"] = False
            return jsonify(resp), 200
        except Exception as e:
            return _mihomo_exception(
                "Не удалось сохранить изменения после применения HWID-подписки.",
                code="hwid_apply_save_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=400,
            )

    @bp.get("/api/mihomo-config/template")
    def api_get_mihomo_default_template():
        content = load_text(MIHOMO_DEFAULT_TEMPLATE, default=None)
        if content is None:
            return _mihomo_error("Шаблон Mihomo по умолчанию не найден.", 404, code="template_not_found")
        return jsonify({"ok": True, "content": content}), 200

    # ---------- API: mihomo templates directory ----------

    @bp.get("/api/mihomo-templates")
    def api_list_mihomo_templates():
        if not os.path.isdir(MIHOMO_TEMPLATES_DIR):
            os.makedirs(MIHOMO_TEMPLATES_DIR, exist_ok=True)

        items = []
        for fname in sorted(os.listdir(MIHOMO_TEMPLATES_DIR)):
            if not (fname.endswith(".yaml") or fname.endswith(".yml")):
                continue
            items.append({"name": fname})

        return jsonify({"ok": True, "templates": items}), 200

    @bp.get("/api/mihomo-template")
    def api_get_mihomo_template():
        name = request.args.get("name", "").strip()
        path = _safe_template_path(MIHOMO_TEMPLATES_DIR, name)
        if not path:
            return _api_error("invalid template name", 400, ok=False)

        content = load_text(path, default=None)
        if content is None:
            return _api_error("template not found", 404, ok=False)

        return (
            jsonify({"ok": True, "content": content, "name": os.path.basename(path)}),
            200,
        )

    @bp.post("/api/mihomo-template")
    def api_save_mihomo_template():
        data = request.get_json(silent=True) or {}
        name = (data.get("name") or "").strip()
        content = data.get("content", "")

        path = _safe_template_path(MIHOMO_TEMPLATES_DIR, name)
        if not path:
            return _api_error("invalid template name", 400, ok=False)

        d = os.path.dirname(path)
        if not os.path.isdir(d):
            os.makedirs(d, exist_ok=True)

        save_text(path, content)
        return jsonify({"ok": True, "name": os.path.basename(path)}), 200

    # ---------- API: mihomo universal generator backend ----------

    @bp.post("/api/mihomo/generate")
    def api_mihomo_generate():
        try:
            state = _mihomo_get_state_from_request()
            cfg = mihomo_svc.generate_config_from_state(state)
            return current_app.response_class(cfg, mimetype="text/plain; charset=utf-8")
        except Exception as e:
            return _mihomo_exception(
                "Не удалось сгенерировать конфиг Mihomo.",
                code="generate_failed",
                hint="Проверьте входные данные и попробуйте снова.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/download")
    def api_mihomo_download():
        try:
            state = _mihomo_get_state_from_request()
            cfg = mihomo_svc.generate_config_from_state(state)
            return current_app.response_class(
                cfg,
                mimetype="application/x-yaml",
                headers={"Content-Disposition": "attachment; filename=config.yaml"},
            )
        except Exception as e:
            return _mihomo_exception(
                "Не удалось подготовить конфиг Mihomo для скачивания.",
                code="download_failed",
                hint="Проверьте входные данные и попробуйте снова.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/save")
    def api_mihomo_save():
        try:
            state = _mihomo_get_state_from_request()
            cfg, active_profile, warnings = mihomo_svc.generate_and_save_config(state)
            _sync_mihomo_managed_subscriptions(state, cfg)
            return (
                jsonify(
                    {
                        "ok": True,
                        "active_profile": active_profile,
                        "config_length": len(cfg),
                        "warnings": warnings,
                    }
                ),
                200,
            )
        except Exception as e:
            return _mihomo_exception(
                "Не удалось сохранить конфиг Mihomo.",
                code="save_failed",
                hint="Проверьте входные данные и попробуйте снова.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/restart")
    def api_mihomo_restart():
        # Optional async mode: schedule restart as command_job to avoid long-running HTTP.
        # Compatibility: default behavior remains synchronous (returns log inline).
        async_q = request.args.get("async")
        if async_q in ("1", "true", "yes"):
            try:
                state = _mihomo_get_state_from_request()
                cfg = mihomo_svc.generate_config_from_state(state)
                if not cfg.strip():
                    return _api_error("Empty config", 400, ok=False)

                ensure_mihomo_layout()
                save_config(cfg.rstrip("\n"))
                _sync_mihomo_managed_subscriptions(state, cfg)
                active_profile = get_active_profile_name()
                running_core = detect_running_core()

                job = create_command_job(flag="-restart", stdin_data=None, cmd=None, use_pty=True)
                return (
                    jsonify(
                        {
                            "ok": True,
                            "active_profile": active_profile,
                            "config_length": len(cfg),
                            "warnings": [],
                            "restart_queued": True,
                            "restart_job_id": job.id,
                            "core": running_core,
                        }
                    ),
                    202,
                )
            except Exception as e:
                return _mihomo_exception(
                    "Не удалось сохранить конфиг Mihomo и поставить перезапуск в очередь.",
                    code="restart_prepare_failed",
                    hint="Проверьте конфиг и повторите попытку.",
                    exc=e,
                    status=400,
                )
        try:
            state = _mihomo_get_state_from_request()
            cfg, log, warnings = mihomo_svc.generate_save_and_restart(state)
            _sync_mihomo_managed_subscriptions(state, cfg)
            return (
                jsonify({"ok": True, "config_length": len(cfg), "log": log, "warnings": warnings}),
                200,
            )
        except Exception as e:
            return _mihomo_exception(
                "Не удалось сохранить и перезапустить конфиг Mihomo.",
                code="restart_failed",
                hint="Проверьте входные данные и попробуйте снова.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/generate_apply")
    def api_mihomo_generate_apply():
        """Generate+save mihomo config and restart xkeen via background job.

        Why background job?
          - xkeen restart may take ~60s on routers;
          - the web UI can hang and the browser may abort the request.

        Response includes a job_id that can be polled via /api/run-command/<job_id>.
        """
        data = request.get_json(silent=True) or {}
        try:
            # If there is a raw YAML override from the editor – validate YAML syntax early.
            cfg_override = (data.get("configOverride") or "")
            if cfg_override.strip():
                ok_yaml, yaml_err = validate_yaml_syntax(cfg_override)
                if not ok_yaml:
                    return _mihomo_yaml_invalid()

            # Build generated config (for warnings) but save override if provided.
            cfg_generated, warnings = mihomo_svc.generate_preview(data)
            state = _mihomo_parse_state(data)

            cfg_to_save = cfg_override.rstrip("\n") if cfg_override.strip() else (cfg_generated or "")
            if not cfg_to_save.strip():
                return _api_error("Empty config", 400, ok=False)

            ensure_mihomo_layout()
            save_config(cfg_to_save)
            if _same_config_text(cfg_to_save, cfg_generated):
                _sync_mihomo_managed_subscriptions(state, cfg_to_save)
            active_profile = get_active_profile_name()

            # Snapshot current running core (best-effort) so UI can warn when it's not mihomo.
            running_core = detect_running_core()

            # Schedule xkeen restart in background.
            job = create_command_job(flag="-restart", stdin_data=None, cmd=None, use_pty=True)

            return (
                jsonify(
                    {
                        "ok": True,
                        "active_profile": active_profile,
                        "config_length": len(cfg_to_save),
                        "warnings": warnings,
                        "restart_queued": True,
                        "restart_job_id": job.id,
                        "core": running_core,
                    }
                ),
                202,
            )
        except FileNotFoundError as e:
            return _mihomo_exception(
                "Не найден требуемый файл Mihomo.",
                code="file_not_found",
                hint="Проверьте профиль и шаблоны Mihomo.",
                exc=e,
                status=404,
            )
        except ValueError as e:
            return _mihomo_exception(
                "Некорректные параметры генерации конфигурации.",
                code="invalid_config_params",
                hint="Проверьте параметры и попробуйте снова.",
                exc=e,
                status=400,
            )
        except Exception as e:
            return _mihomo_exception(
                "Не удалось сгенерировать, сохранить и поставить перезапуск в очередь.",
                code="generate_apply_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=500,
            )

    @bp.post("/api/mihomo/save_raw")
    def api_mihomo_save_raw():
        """Save arbitrary YAML as active profile mihomo (with backup)."""
        data = request.get_json(silent=True) or {}
        cfg = (data.get("config") or "").rstrip()
        if not cfg:
            return _api_error("config is required", 400, ok=False)

        ok_yaml, yaml_err = validate_yaml_syntax(cfg)
        if not ok_yaml:
            return _mihomo_yaml_invalid()

        try:
            ensure_mihomo_layout()
            save_config(cfg)
            active = get_active_profile_name()
            return (
                jsonify({"ok": True, "active_profile": active, "config_length": len(cfg)}),
                200,
            )
        except Exception as e:
            return _mihomo_exception(
                "Не удалось сохранить raw config.yaml.",
                code="save_raw_failed",
                hint="Проверьте конфиг и повторите попытку.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/restart_raw")
    def api_mihomo_restart_raw():
        """Save arbitrary YAML and restart mihomo (xkeen -restart)."""
        data = request.get_json(silent=True) or {}
        cfg = (data.get("config") or "").rstrip()
        if not cfg:
            return _api_error("config is required", 400, ok=False)

        ok_yaml, yaml_err = validate_yaml_syntax(cfg)
        if not ok_yaml:
            return _mihomo_yaml_invalid()

        try:
            ensure_mihomo_layout()
            log = restart_mihomo_and_get_log(cfg)
            return (
                jsonify({"ok": True, "config_length": len(cfg), "log": log}),
                200,
            )
        except Exception as e:
            return _mihomo_exception(
                "Не удалось сохранить raw config.yaml и перезапустить Mihomo.",
                code="restart_raw_failed",
                hint="Проверьте конфиг и повторите попытку.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/validate_raw")
    def api_mihomo_validate_raw():
        """Validate YAML config with external Mihomo core (mihomo -t), without restart."""
        data = request.get_json(silent=True) or {}
        cfg = (data.get("config") or "").rstrip()

        try:
            ensure_mihomo_layout()

            # Если конфиг не прислали – читаем активный config.yaml
            if not cfg:
                try:
                    with open(MIHOMO_CONFIG_FILE, "r", encoding="utf-8") as f:
                        cfg = f.read()
                except FileNotFoundError:
                    return _api_error("active config.yaml not found", 404, ok=False)

            # Проверяем конфиг только через внешнее ядро Mihomo (mihomo -t)
            log_lines = []
            rc = 0

            try:
                mh_log = validate_config(new_content=cfg)
            except Exception as e:
                current_app.logger.exception("mihomo.validate_raw.runner_failed")
                mh_log = "Не удалось запустить проверку конфигурации Mihomo. Подробности смотрите в server logs."

            if mh_log:
                log_lines.append(mh_log)
                m = re.search(r"\[exit code:\s*(\d+)\]", mh_log)
                if m:
                    rc = int(m.group(1))

            log = "\n".join(log_lines)
            return jsonify({"ok": rc == 0, "log": log})
        except Exception as e:
            return _mihomo_exception(
                "Не удалось проверить конфигурацию Mihomo.",
                code="validate_failed",
                hint="Проверьте конфиг и повторите попытку.",
                exc=e,
                status=400,
            )


    # ---------- API: Mihomo YAML patch helpers (pure text) ----------

    _PATCH_MAX_BYTES = 512 * 1024  # 512KB

    def _patch_guard():
        cl = request.content_length
        if cl is not None and cl > _PATCH_MAX_BYTES:
            return _api_error("payload too large", 413, ok=False)
        return None

    def _norm_text(s: Any) -> str:
        if not isinstance(s, str):
            s = str(s or "")
        return s.replace("\r\n", "\n").replace("\r", "\n")

    def _norm_groups(v: Any):
        if v is None:
            return []
        if isinstance(v, str):
            return [x.strip() for x in v.split(",") if x.strip()]
        if isinstance(v, (list, tuple)):
            out = []
            for x in v:
                xs = str(x or "").strip()
                if xs:
                    out.append(xs)
            return out
        return []

    def _infer_proxy_name_from_yaml(proxy_yaml: str) -> str:
        # best-effort: read first "- name:" line
        m = re.search(r"^\s*-\s*name:\s*(.+?)\s*$", proxy_yaml, flags=re.M)
        if not m:
            return ""
        raw = m.group(1).strip()
        # remove trailing comment (best-effort)
        if raw and raw[0] not in ("'", '"'):
            raw = re.sub(r"\s+#.*$", "", raw).strip()
        return raw.strip("'\"")

    @bp.post("/api/mihomo/patch/apply_insert")
    def api_mihomo_patch_apply_insert():
        """Insert proxy YAML under `proxies:` and register it in target proxy-groups."""
        guard = _patch_guard()
        if guard is not None:
            return guard

        data = request.get_json(silent=True) or {}
        content = _norm_text(data.get("content") or "")
        proxy_yaml = _norm_text(data.get("proxy_yaml") or data.get("proxyYaml") or "")
        proxy_name = (data.get("proxy_name") or data.get("proxyName") or "").strip()
        groups = _norm_groups(data.get("groups") or data.get("target_groups"))

        # Extra safety when Content-Length is missing: avoid large payloads.
        if request.content_length is None:
            total = len(content) + len(proxy_yaml) + len(proxy_name) + sum(len(g) for g in groups)
            if total > _PATCH_MAX_BYTES:
                return _api_error("payload too large", 413, ok=False)

        if not proxy_yaml.strip():
            return _api_error("proxy_yaml is required", 400, ok=False)

        if not proxy_name:
            proxy_name = _infer_proxy_name_from_yaml(proxy_yaml)
        if not proxy_name:
            return _api_error("proxy_name is required", 400, ok=False)

        try:
            patched = apply_proxy_insert(content, proxy_yaml, proxy_name, groups)
            return jsonify({"ok": True, "content": patched}), 200
        except Exception as e:
            return _mihomo_exception(
                "Не удалось вставить прокси в конфиг Mihomo.",
                code="apply_insert_failed",
                hint="Проверьте YAML прокси и список целевых групп.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/patch/rename_proxy")
    def api_mihomo_patch_rename_proxy():
        """Rename proxy and update its usages in proxy-groups."""
        guard = _patch_guard()
        if guard is not None:
            return guard

        data = request.get_json(silent=True) or {}
        content = _norm_text(data.get("content") or "")
        old_name = (data.get("old_name") or data.get("oldName") or "").strip()
        new_name = (data.get("new_name") or data.get("newName") or "").strip()

        if request.content_length is None:
            total = len(content) + len(old_name) + len(new_name)
            if total > _PATCH_MAX_BYTES:
                return _api_error("payload too large", 413, ok=False)

        if not old_name or not new_name:
            return _api_error("old_name and new_name are required", 400, ok=False)

        try:
            patched = rename_proxy_in_config(content, old_name, new_name)
            return jsonify({"ok": True, "content": patched}), 200
        except Exception as e:
            return _mihomo_exception(
                "Не удалось переименовать прокси в конфиге Mihomo.",
                code="rename_proxy_failed",
                hint="Проверьте имена прокси и попробуйте снова.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/patch/replace_proxy")
    def api_mihomo_patch_replace_proxy():
        """Replace one proxy block inside `proxies:` section by name."""
        guard = _patch_guard()
        if guard is not None:
            return guard

        data = request.get_json(silent=True) or {}
        content = _norm_text(data.get("content") or "")
        proxy_name = (data.get("proxy_name") or data.get("proxyName") or "").strip()
        proxy_yaml = _norm_text(data.get("proxy_yaml") or data.get("proxyYaml") or "")

        if request.content_length is None:
            total = len(content) + len(proxy_name) + len(proxy_yaml)
            if total > _PATCH_MAX_BYTES:
                return _api_error("payload too large", 413, ok=False)

        if not proxy_name or not proxy_yaml.strip():
            return _api_error("proxy_name and proxy_yaml are required", 400, ok=False)

        try:
            patched, changed = replace_proxy_in_config(content, proxy_name, proxy_yaml)
            return jsonify({"ok": True, "content": patched, "changed": bool(changed)}), 200
        except Exception as e:
            return _mihomo_exception(
                "Не удалось заменить прокси в конфиге Mihomo.",
                code="replace_proxy_failed",
                hint="Проверьте YAML прокси и попробуйте снова.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/parse/wireguard")
    def api_mihomo_parse_wireguard():
        """Parse WireGuard/AmneziaWG config text and return Mihomo proxy YAML block."""
        guard = _patch_guard()
        if guard is not None:
            return guard

        data = request.get_json(silent=True) or {}
        text = _norm_text(data.get("text") or "")
        name = (data.get("name") or "").strip() or None

        if request.content_length is None:
            total = len(text) + (len(name) if name else 0)
            if total > _PATCH_MAX_BYTES:
                return _api_error("payload too large", 413, ok=False)

        if not text.strip():
            return _api_error("text is required", 400, ok=False)

        try:
            r = parse_wireguard(text, custom_name=name)
            return jsonify({"ok": True, "proxy_name": r.name, "proxy_yaml": r.yaml}), 200
        except Exception as e:
            return _mihomo_exception(
                "Не удалось преобразовать WireGuard-конфиг в формат Mihomo.",
                code="parse_wireguard_failed",
                hint="Проверьте содержимое конфигурации и попробуйте снова.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/parse/openvpn")
    def api_mihomo_parse_openvpn():
        """Parse OpenVPN .ovpn config text and return Mihomo proxy YAML block."""
        guard = _patch_guard()
        if guard is not None:
            return guard

        data = request.get_json(silent=True) or {}
        text = _norm_text(data.get("text") or "")
        name = (data.get("name") or "").strip() or None

        if request.content_length is None:
            total = len(text) + (len(name) if name else 0)
            if total > _PATCH_MAX_BYTES:
                return _api_error("payload too large", 413, ok=False)

        if not text.strip():
            return _api_error("text is required", 400, ok=False)

        try:
            r = parse_openvpn(text, custom_name=name)
            return jsonify({"ok": True, "proxy_name": r.name, "proxy_yaml": r.yaml}), 200
        except Exception as e:
            return _mihomo_exception(
                "Не удалось преобразовать OpenVPN-конфиг в формат Mihomo.",
                code="parse_openvpn_failed",
                hint="Проверьте .ovpn: нужны remote, <ca>, <tls-crypt> и cert/key либо auth-user-pass.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/parse/tailscale")
    def api_mihomo_parse_tailscale():
        """Parse Tailscale outbound settings and return Mihomo proxy YAML block."""
        guard = _patch_guard()
        if guard is not None:
            return guard

        data = request.get_json(silent=True) or {}
        text = _norm_text(data.get("text") or "")
        name = (data.get("name") or "").strip() or None

        if request.content_length is None:
            total = len(text) + (len(name) if name else 0)
            if total > _PATCH_MAX_BYTES:
                return _api_error("payload too large", 413, ok=False)

        if not text.strip():
            return _api_error("text is required", 400, ok=False)

        try:
            r = parse_tailscale(text, custom_name=name)
            return jsonify({"ok": True, "proxy_name": r.name, "proxy_yaml": r.yaml}), 200
        except Exception as e:
            return _mihomo_exception(
                "Не удалось преобразовать Tailscale-параметры в формат Mihomo.",
                code="parse_tailscale_failed",
                hint="Укажите auth-key/hostname/state-dir или tailscale:// URL с параметрами.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/node/import-draft")
    def api_mihomo_node_import_draft():
        """Parse node material and return a patched config draft without saving it."""
        guard = _patch_guard()
        if guard is not None:
            return guard

        data = request.get_json(silent=True) or {}
        content = _norm_text(data.get("content") or data.get("config") or "")
        source = _norm_text(data.get("source") or data.get("input") or data.get("text") or "")
        mode = str(data.get("mode") or "auto").strip().lower()
        groups = _norm_groups(data.get("groups") or [])
        auto_update_subscriptions = bool(data.get("auto_update_subscriptions", False))
        try:
            interval_hours = max(1, min(int(data.get("interval_hours", 24)), 168))
        except Exception:
            interval_hours = 24
        parsed_xray_sources = []

        if request.content_length is None:
            total = len(content) + len(source) + sum(len(group) for group in groups)
            if total > _PATCH_MAX_BYTES:
                return _api_error("payload too large", 413, ok=False)

        def parse_xray_subscription(url: str, existing_names):
            body, _headers = _xray_fetch_subscription_body(url)
            try:
                proxies, skipped = _xray_convert_subscription_text(
                    body,
                    existing_names=list(existing_names),
                )
            except ValueError:
                return None
            if not proxies:
                raise ValueError("В подписке не найдено поддерживаемых узлов.")
            parsed_xray_sources.append((url, list(proxies)))
            return proxies, len(skipped or [])

        def provider_target(url: str):
            policy = _mihomo_provider_url_policy()
            reason = _mihomo_provider_policy_block_reason(url, policy)
            if reason:
                raise ValueError(f"URL подписки заблокирован: {reason}")

            ordinary_adapter = (
                f"http://127.0.0.1:{_ui_loopback_port()}/mihomo/provider.yaml?"
                + urllib.parse.urlencode({"url": url, "insecure": "0"})
            )
            try:
                probe = _mh_hwid_probe_subscription_safe(
                    url,
                    headers={},
                    insecure=False,
                    timeout=8.0,
                    prefer="head_then_range_get",
                    policy=policy,
                )
            except Exception:
                return ordinary_adapter
            if not isinstance(probe, dict) or probe.get("ok") is not True:
                return ordinary_adapter

            current_summary: Dict[str, Any] | None = None
            direct_headers = _mihomo_provider_direct_headers()
            if direct_headers:
                try:
                    payload, meta = _mh_hwid_fetch_provider_payload(
                        url,
                        headers=direct_headers,
                        insecure=False,
                        timeout=8.0,
                        policy=policy,
                    )
                    current_summary = _mihomo_provider_payload_summary(payload, meta)
                    if current_summary.get("has_nodes"):
                        return url, direct_headers
                except Exception:
                    current_summary = None

            markers = dict(probe.get("hwid_response_headers") or {})
            if current_summary:
                markers.update(current_summary.get("hwid_response_headers") or {})
            needs_hwid = _mihomo_hwid_headers_suggest_required(markers) or bool(
                current_summary and current_summary.get("hwid_placeholder_provider")
            )
            if needs_hwid:
                try:
                    device = _mh_hwid_get_device_info()
                    payload, meta = _mh_hwid_fetch_provider_payload(
                        url,
                        headers=device.get("headers") or {},
                        insecure=False,
                        timeout=8.0,
                        policy=_mihomo_hwid_url_policy(),
                    )
                    hwid_summary = _mihomo_provider_payload_summary(payload, meta)
                    current_count = int((current_summary or {}).get("node_count") or 0)
                    if hwid_summary.get("has_nodes") and int(hwid_summary.get("node_count") or 0) > current_count:
                        return (
                            f"http://127.0.0.1:{_ui_loopback_port()}/mihomo/hwid/provider.yaml?"
                            + urllib.parse.urlencode({"url": url, "insecure": "0"})
                        )
                except Exception:
                    pass
            return ordinary_adapter

        try:
            result = build_mihomo_node_draft(
                content=content,
                source=source,
                mode=mode,
                groups=groups,
                xray_subscription_parser=parse_xray_subscription,
                provider_url_factory=provider_target,
            )
        except ValueError as exc:
            return _mihomo_error(
                str(exc) or "Не удалось добавить узел Mihomo.",
                status=400,
                code="mihomo_node_import_invalid",
            )
        except Exception as exc:
            return _mihomo_exception(
                "Не удалось разобрать или добавить узел Mihomo.",
                code="mihomo_node_import_failed",
                hint="Проверьте ссылку, тип импорта и доступность подписки.",
                exc=exc,
                status=400,
            )

        registered_subscriptions = 0
        subscription_warning = ""
        if auto_update_subscriptions and parsed_xray_sources:
            for url, proxies in parsed_xray_sources:
                try:
                    _mh_sub_sync_imported_xray_subscription(
                        ui_state_dir,
                        url=url,
                        config_text=result.content,
                        proxy_yamls=[proxy.yaml for proxy in proxies],
                        groups=groups,
                        interval_hours=interval_hours,
                        refresh_parser="xray-json",
                    )
                    registered_subscriptions += 1
                except Exception as exc:
                    subscription_warning = str(exc or "Не удалось сохранить автообновление подписки.")
                    current_app.logger.warning(
                        "mihomo.node_import.subscription_register_failed: %s",
                        subscription_warning,
                    )

        return jsonify(
            {
                "ok": True,
                "content": result.content,
                "inserted_names": list(result.inserted_names),
                "inserted_kind": result.inserted_kind,
                "skipped_count": result.skipped_count,
                "registered_subscriptions": registered_subscriptions,
                "subscription_warning": subscription_warning,
                "highlight": {
                    "start": result.highlight_start,
                    "end": result.highlight_end,
                },
            }
        ), 200

    @bp.get("/api/mihomo/subscriptions")
    def api_mihomo_subscriptions_list():
        """List Xray-JSON subscriptions managed through the Mihomo generator."""
        try:
            return (
                jsonify(
                    {
                        "ok": True,
                        "subscriptions": _mh_sub_list_subscriptions(ui_state_dir),
                    }
                ),
                200,
            )
        except Exception as e:
            return _mihomo_exception(
                "Не удалось прочитать подписки Mihomo.",
                code="mihomo_subscription_list_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=500,
            )

    @bp.post("/api/mihomo/subscriptions/<string:sub_id>/refresh")
    def api_mihomo_subscription_refresh(sub_id: str):
        """Refresh one managed Mihomo Xray-JSON subscription now."""
        try:
            result = _mh_sub_refresh_subscription(
                ui_state_dir,
                sub_id,
                mihomo_config_file=MIHOMO_CONFIG_FILE,
                restart_xkeen=restart_xkeen,
                restart=_bool_arg("restart", True),
                force=_bool_arg("force", False),
                save_callback=save_config,
            )
        except KeyError:
            return _mihomo_error("Подписка не найдена.", status=404, ok=False, code="subscription_not_found")
        except Exception as e:
            return _mihomo_exception(
                "Не удалось обновить подписку Mihomo.",
                code="mihomo_subscription_refresh_failed",
                hint="Проверьте URL подписки и server logs.",
                exc=e,
                status=500,
            )
        status = 200 if result.get("ok") else (409 if result.get("error") == "active_config_changed" else 400)
        return jsonify(result), status

    @bp.post("/api/mihomo/subscriptions/<string:sub_id>")
    def api_mihomo_subscription_update(sub_id: str):
        """Update settings for one managed Mihomo Xray-JSON subscription."""
        payload = request.get_json(silent=True) or {}
        try:
            subscription = _mh_sub_update_subscription_settings(ui_state_dir, sub_id, payload)
        except KeyError:
            return _mihomo_error("Подписка не найдена.", status=404, ok=False, code="subscription_not_found")
        except Exception as e:
            return _mihomo_exception(
                "Не удалось сохранить настройки подписки Mihomo.",
                code="mihomo_subscription_update_failed",
                hint="Интервал должен быть от 1 до 168 часов.",
                exc=e,
                status=400,
            )
        return jsonify({"ok": True, "subscription": subscription}), 200

    @bp.delete("/api/mihomo/subscriptions/<string:sub_id>")
    def api_mihomo_subscription_delete(sub_id: str):
        """Delete one managed Mihomo Xray-JSON subscription entry."""
        guard = _patch_guard()
        if guard is not None:
            return guard

        payload = request.get_json(silent=True) or {}
        remove_blocks = _bool_arg("remove_blocks", False) or bool(
            payload.get("remove_blocks") or payload.get("removeConfigBlocks")
        )
        raw_content = payload.get("content", payload.get("config", payload.get("config_text")))
        config_text = _norm_text(raw_content) if isinstance(raw_content, str) else None

        if request.content_length is None and config_text is not None:
            total = len(config_text) + len(sub_id)
            if total > _PATCH_MAX_BYTES:
                return _api_error("payload too large", 413, ok=False)

        try:
            result = _mh_sub_delete_subscription(
                ui_state_dir,
                sub_id,
                mihomo_config_file=MIHOMO_CONFIG_FILE,
                remove_config_blocks=remove_blocks,
                config_text=config_text,
                save_callback=save_config,
            )
        except KeyError:
            return _mihomo_error("Подписка не найдена.", status=404, ok=False, code="subscription_not_found")
        except RuntimeError as e:
            code = str(e) or "mihomo_subscription_delete_refused"
            return _mihomo_error(
                "Не удалось удалить подписку Mihomo.",
                status=400,
                ok=False,
                code=code,
                hint="Проверьте, что запись относится к Xray-JSON блоку proxies.",
            )
        except Exception as e:
            return _mihomo_exception(
                "Не удалось удалить подписку Mihomo.",
                code="mihomo_subscription_delete_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=500,
            )
        return jsonify(result), 200

    @bp.post("/api/mihomo/subscriptions/refresh-due")
    def api_mihomo_subscriptions_refresh_due():
        """Refresh every due managed Mihomo Xray-JSON subscription."""
        try:
            results = _mh_sub_refresh_due_subscriptions(
                ui_state_dir,
                mihomo_config_file=MIHOMO_CONFIG_FILE,
                restart_xkeen=restart_xkeen,
                restart=_bool_arg("restart", True),
                save_callback=save_config,
            )
        except Exception as e:
            return _mihomo_exception(
                "Не удалось обновить подписки Mihomo.",
                code="mihomo_subscription_refresh_due_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=500,
            )
        ok_count = sum(1 for item in results if item.get("ok"))
        return jsonify({"ok": True, "updated": len(results), "ok_count": ok_count, "results": results}), 200

    @bp.post("/api/mihomo/subscriptions/imported-xray")
    def api_mihomo_subscription_register_imported_xray():
        """Register an Xray-JSON subscription inserted via the raw Mihomo import modal."""
        guard = _patch_guard()
        if guard is not None:
            return guard

        payload = request.get_json(silent=True) or {}
        config_text = _norm_text(payload.get("config") or payload.get("config_text") or payload.get("content") or "")
        url = (payload.get("url") or "").strip()
        proxies_raw = payload.get("proxies") or payload.get("proxy_yamls") or []
        if not isinstance(proxies_raw, list):
            proxies_raw = []

        proxy_yamls = []
        for item in proxies_raw:
            if isinstance(item, dict):
                value = item.get("proxy_yaml") or item.get("proxyYaml") or item.get("content") or ""
            else:
                value = item
            if str(value or "").strip():
                proxy_yamls.append(str(value))

        if request.content_length is None:
            total = len(config_text) + len(url) + sum(len(item) for item in proxy_yamls)
            if total > _PATCH_MAX_BYTES:
                return _api_error("payload too large", 413, ok=False)

        if not url or not config_text.strip() or not proxy_yamls:
            return _api_error("url, config and proxies are required", 400, ok=False)

        try:
            subscription = _mh_sub_sync_imported_xray_subscription(
                ui_state_dir,
                url=url,
                config_text=config_text,
                proxy_yamls=proxy_yamls,
                groups=_norm_groups(payload.get("groups") or []),
                interval_hours=payload.get("interval_hours", payload.get("intervalHours")),
                tag=(payload.get("tag") or "").strip() or None,
                refresh_parser=payload.get("refresh_parser", payload.get("refreshParser")),
            )
        except Exception as e:
            return _mihomo_exception(
                "Не удалось сохранить настройки автообновления Xray-JSON.",
                code="mihomo_subscription_import_register_failed",
                hint="Проверьте URL подписки, YAML preview и попробуйте снова.",
                exc=e,
                status=400,
            )
        return jsonify({"ok": True, "subscription": subscription}), 200

    @bp.post("/api/mihomo/parse/xray-json")
    def api_mihomo_parse_xray_json():
        """Detect/parse an Xray-style JSON subscription and return Mihomo proxies.

        Accepts ``{"url": ...}`` (server fetches via the SSRF-safe subscription
        fetcher) or ``{"text": ...}`` (caller-supplied body).  Optional
        ``existing_names`` is a list of proxy names already present in the target
        config — used to keep generated names unique without a second roundtrip.

        Response on success::

            {"ok": true, "count": N,
             "proxies": [{"proxy_name": "...", "proxy_yaml": "- name: ...\\n..."}],
             "proxies_yaml": "proxies:\\n  - name: ...",
             "skipped": [{"name": "...", "reason": "..."}]}

        Distinct error codes the frontend can branch on:
          - ``not_xray_json`` (422): body parses but isn't recognizable as Xray JSON.
          - ``no_supported_proxies`` (422): JSON parsed but every outbound was skipped.
          - ``url_blocked`` (400): URL policy rejected the destination.
          - ``size_limit`` (413): subscription body exceeded ``XKEEN_SUBSCRIPTION_MAX_BYTES``.
          - ``fetch_failed`` (502): network/HTTP error talking to upstream.
        """
        guard = _patch_guard()
        if guard is not None:
            return guard

        data = request.get_json(silent=True) or {}
        url = (data.get("url") or "").strip()
        text = _norm_text(data.get("text") or "")
        existing_names_raw = data.get("existing_names") or []
        existing_names = [str(n) for n in existing_names_raw if str(n or "").strip()] if isinstance(existing_names_raw, list) else []

        if request.content_length is None:
            total = len(url) + len(text) + sum(len(n) for n in existing_names)
            if total > _PATCH_MAX_BYTES:
                return _api_error("payload too large", 413, ok=False)

        if not url and not text:
            return _api_error("url or text is required", 400, ok=False)

        if url and not text:
            try:
                text, _headers = _xray_fetch_subscription_body(url)
            except RuntimeError as e:
                reason = str(e or "")
                if reason.startswith("url_blocked:"):
                    return _mihomo_error(
                        "URL заблокирован политикой подписок: " + reason.split(":", 1)[1],
                        status=400,
                        code="url_blocked",
                    )
                if reason == "size_limit":
                    return _mihomo_error(
                        "Подписка превышает разрешённый размер.",
                        status=413,
                        code="size_limit",
                    )
                if reason.startswith("happ_helper_") or reason.startswith("happ_decryptor_"):
                    hint = (
                        f"Проверьте {happ_links.HAPP_HELPER_CMD_ENV} "
                        f"и {happ_links.HAPP_DECRYPTOR_CMD_ENV}. "
                        f"Для сетевого fallback можно задать {happ_links.HAPP_DECRYPTOR_REMOTE_URL_ENV}, "
                        "затем повторите попытку."
                    )
                    return _mihomo_error(
                        _happ_helper_error_message(reason),
                        status=422,
                        code="happ_helper_failed",
                        hint=hint,
                    )
                return _mihomo_fetch_failed_response(reason)
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                return _mihomo_fetch_failed_response(_subscription_fetch_failure_reason(e))
            except Exception as e:
                return _mihomo_exception(
                    "Не удалось скачать подписку.",
                    code="fetch_failed",
                    hint="Проверьте URL и сетевую доступность.",
                    exc=e,
                    status=502,
                )
            if happ_links.looks_like_html_landing(
                text,
                content_type=(_headers or {}).get("content-type"),
            ) and happ_links.extract_happ_links(text):
                helper_error = str((_headers or {}).get(happ_links.HAPP_ERROR_HEADER) or "").strip()
                hint = (
                    "Эта ссылка ведет на Happ-страницу установки, а не на прямой Xray JSON URL. "
                    "Для такого формата панели нужен настроенный Happ helper-дешифратор."
                )
                if helper_error == "happ_decryptor_not_configured":
                    hint += (
                        f" Настройте {happ_links.HAPP_DECRYPTOR_CMD_ENV} "
                        "или положите внешний decryptor в xkeen-ui/bin. "
                        f"При осознанном доверии внешнему сервису можно задать {happ_links.HAPP_DECRYPTOR_REMOTE_URL_ENV}."
                    )
                elif helper_error == "happ_helper_not_configured":
                    hint += f" Настройте {happ_links.HAPP_HELPER_CMD_ENV}."
                elif helper_error.startswith("happ_helper_"):
                    hint += " Текущий Happ helper не смог расшифровать deep-link."
                elif helper_error.startswith("happ_decryptor_"):
                    hint += " Текущий внешний Happ decryptor не смог расшифровать deep-link."
                    detail = _compact_happ_route_error_detail(helper_error, "happ_decryptor_failed:")
                    if detail:
                        hint += f" Детали: {detail}"
                return _mihomo_error(
                    "URL возвращает Happ landing page, а не прямую Xray-JSON подписку.",
                    status=422,
                    code="happ_landing_page",
                    hint=hint,
                )

        try:
            proxies, skipped = _xray_convert_subscription_text(
                text, existing_names=existing_names
            )
        except ValueError:
            return _mihomo_error(
                "Не похоже на Xray-JSON подписку.",
                status=422,
                code="not_xray_json",
                hint="Если это обычная Mihomo/Clash YAML-подписка — добавьте её как proxy-provider.",
            )
        except Exception as e:
            return _mihomo_exception(
                "Не удалось разобрать Xray-подписку.",
                code="parse_xray_json_failed",
                hint="Проверьте содержимое подписки и попробуйте снова.",
                exc=e,
                status=400,
            )

        if not proxies:
            return _mihomo_error(
                "В подписке не нашлось поддерживаемых прокси.",
                status=422,
                code="no_supported_proxies",
                hint="Поддерживаются VLESS-узлы (TCP/WS/gRPC/xhttp/HTTPUpgrade, TLS/Reality).",
                skipped=skipped,
            )

        return jsonify({
            "ok": True,
            "count": len(proxies),
            "proxies": [{"proxy_name": p.name, "proxy_yaml": p.yaml} for p in proxies],
            "proxies_yaml": _xray_format_proxies_section(proxies),
            "skipped": skipped,
        }), 200


    # ---------- Same-origin proxy: Mihomo external UI (Zashboard) ----------

    _MIHOMO_UI_DEFAULT_PORT = 9090
    _MIHOMO_UI_ALLOWED_PORTS_ENV = "XKEEN_MIHOMO_UI_ALLOWED_PORTS"
    _MIHOMO_UI_PUBLIC_SCHEME_ENV = "XKEEN_MIHOMO_UI_PUBLIC_SCHEME"
    _MIHOMO_UI_ALLOW_PROXY_FALLBACK_ENV = "XKEEN_MIHOMO_UI_ALLOW_PROXY_FALLBACK"
    _MIHOMO_UI_SENSITIVE_REQUEST_HEADERS = {
        'cookie',
        'authorization',
        'x-csrf-token',
    }
    _MIHOMO_UI_BLOCKED_RESPONSE_HEADERS = {
        'set-cookie',
        'server',
        'date',
        'access-control-allow-origin',
        'access-control-allow-credentials',
        'access-control-allow-headers',
        'access-control-allow-methods',
    }

    def _parse_allowed_mihomo_ui_ports() -> set[int]:
        raw = str(os.environ.get(_MIHOMO_UI_ALLOWED_PORTS_ENV) or "").strip()
        out: set[int] = set()
        if raw:
            for part in raw.split(","):
                token = str(part or "").strip()
                if not token:
                    continue
                try:
                    port = int(token)
                except Exception:
                    continue
                if 1 <= port <= 65535:
                    out.add(port)
        if not out:
            out.add(_MIHOMO_UI_DEFAULT_PORT)
        return out

    def _get_mihomo_ui_binding() -> tuple[str, int]:
        '''Parse external-controller host/port from the active config.yaml (best-effort).'''
        try:
            cfg = load_text(MIHOMO_CONFIG_FILE, default='') or ''
        except Exception:
            cfg = ''
        m = re.search(
            r"external-controller:\s*(?:['\"]?)((?:\[[^\]]+\])|(?:[^:\s'\"]+)):(\d+)(?:['\"]?)",
            cfg,
        )
        if m:
            try:
                host = str(m.group(1) or '').strip() or '0.0.0.0'
            except Exception:
                host = '0.0.0.0'
            try:
                port = int(m.group(2))
                if 1 <= port <= 65535:
                    return host, port
            except Exception:
                pass
        return '0.0.0.0', _MIHOMO_UI_DEFAULT_PORT

    def _get_mihomo_ui_port() -> int:
        '''Parse external-controller port from the active config.yaml (best-effort).

        We keep it strictly local (127.0.0.1) and use only this single port.
        '''
        return _get_mihomo_ui_binding()[1]

    def _mihomo_ui_port_allowed(port: int) -> bool:
        try:
            return int(port) in _parse_allowed_mihomo_ui_ports()
        except Exception:
            return False

    def _mihomo_ui_proxy_fallback_enabled() -> bool:
        return str(os.environ.get(_MIHOMO_UI_ALLOW_PROXY_FALLBACK_ENV) or "0").strip() == "1"

    def _mihomo_ui_bind_host_is_loopback(bind_host: str) -> bool:
        host = str(bind_host or "").strip().lower()
        host = host.strip("[]")
        return host in ("", "127.0.0.1", "localhost", "::1")

    def _get_mihomo_ui_public_scheme() -> str:
        raw = str(os.environ.get(_MIHOMO_UI_PUBLIC_SCHEME_ENV) or "").strip().lower()
        if raw in ("http", "https"):
            return raw
        return "http"

    def _get_request_host_name() -> str:
        try:
            parsed = urllib.parse.urlsplit(request.host_url or "")
            return str(parsed.hostname or "").strip()
        except Exception:
            return ""

    def _build_mihomo_ui_direct_base(port: int) -> str | None:
        host = _get_request_host_name()
        if not host:
            return None
        host_text = f'[{host}]' if ':' in host and not host.startswith('[') else host
        scheme = _get_mihomo_ui_public_scheme()
        return f"{scheme}://{host_text}:{int(port)}"

    _HOP_BY_HOP_HEADERS = {
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailers',
        'transfer-encoding',
        'upgrade',
    }

    @bp.route('/mihomo_panel/', defaults={'path': ''}, methods=['GET', 'HEAD'])
    @bp.route('/mihomo_panel/<path:path>', methods=['GET', 'HEAD'])
    def mihomo_panel_proxy(path: str):
        '''Open Mihomo UI with a direct origin when possible.

        Default security posture:
        - prefer direct-origin redirect to Mihomo UI (`http://<router-host>:<port>/...`)
          so Zashboard does not inherit panel origin/cookies;
        - keep same-origin proxy only as an explicit loopback-only fallback.
        '''
        # Basic path hardening: disallow backslashes and parent traversal.
        sp = str(path or '')
        if '\\' in sp or any(seg == '..' for seg in sp.split('/')):
            return _api_error('bad path', 400, ok=False)

        bind_host, port = _get_mihomo_ui_binding()
        if not _mihomo_ui_port_allowed(port):
            return _api_error(
                f'Порт Mihomo UI {port} не разрешён политикой безопасности. '
                f'Разрешите его через {_MIHOMO_UI_ALLOWED_PORTS_ENV} или верните external-controller к {_MIHOMO_UI_DEFAULT_PORT}.',
                409,
                ok=False,
            )

        rel = sp.lstrip('/')
        qs = request.query_string.decode('utf-8', errors='ignore')

        if not _mihomo_ui_bind_host_is_loopback(bind_host):
            direct_base = _build_mihomo_ui_direct_base(port)
            if direct_base:
                direct_url = f"{direct_base}/{rel}" if rel else f"{direct_base}/"
                if qs:
                    direct_url = direct_url + '?' + qs
                resp = redirect(direct_url, code=302)
                resp.headers.setdefault('Cache-Control', 'no-store, no-cache, must-revalidate')
                resp.headers.setdefault('Pragma', 'no-cache')
                resp.headers.setdefault('Referrer-Policy', 'no-referrer')
                return resp

        if not _mihomo_ui_proxy_fallback_enabled():
            return _api_error(
                'Same-origin proxy для loopback-only Mihomo UI отключён по умолчанию. '
                f'Используйте browser-reachable external-controller (например 0.0.0.0:{_MIHOMO_UI_DEFAULT_PORT}) '
                f'или явно включите {_MIHOMO_UI_ALLOW_PROXY_FALLBACK_ENV}=1.',
                409,
                ok=False,
            )

        base = f'http://127.0.0.1:{port}'
        target_url = f"{base}/{rel}" if rel else f"{base}/"
        if qs:
            target_url = target_url + '?' + qs

        method = request.method.upper()
        req = urllib.request.Request(target_url, data=None, method=method)

        # Proxy fallback is intentionally narrow: do not bridge panel credentials into Mihomo UI.
        for k, v in request.headers.items():
            kl = k.lower()
            if kl in ('host', 'origin', 'referer', 'content-length'):
                continue
            if kl in _HOP_BY_HOP_HEADERS:
                continue
            if kl in _MIHOMO_UI_SENSITIVE_REQUEST_HEADERS:
                continue
            try:
                req.add_header(k, v)
            except Exception:
                pass

        # Important: set Host for the upstream.
        try:
            req.add_header('Host', f'127.0.0.1:{port}')
        except Exception:
            pass

        status = 502
        body = b''
        resp_headers = {}

        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                status = int(getattr(resp, 'status', 200) or 200)
                resp_headers = dict(resp.headers.items())
                if method != 'HEAD':
                    body = resp.read() or b''
        except urllib.error.HTTPError as e:
            status = int(getattr(e, 'code', 502) or 502)
            resp_headers = dict(getattr(e, 'headers', {}).items()) if getattr(e, 'headers', None) else {}
            if method != 'HEAD':
                try:
                    body = e.read() or b''
                except Exception:
                    body = b''
        except Exception as e:
            # Do not expose internal errors; this is an upstream availability issue.
            return _mihomo_exception(
                "Не удалось открыть Mihomo UI через proxy fallback.",
                code="mihomo_ui_unavailable",
                hint="Проверьте доступность Mihomo UI и server logs.",
                exc=e,
                status=502,
            )

        r = current_app.response_class(body if method != 'HEAD' else b'', status=status)

        # Copy headers (filter server/date/cors/cookies and hop-by-hop).
        # Rewrite Location to keep requests inside the narrow /mihomo_panel/ fallback path.
        for k, v in (resp_headers or {}).items():
            kl = str(k).lower()
            if kl in _HOP_BY_HOP_HEADERS:
                continue
            if kl in _MIHOMO_UI_BLOCKED_RESPONSE_HEADERS:
                continue
            if kl == 'location' and isinstance(v, str):
                # Rewrite absolute redirects back to /mihomo_panel/...
                if v.startswith(base + '/'):
                    v = '/mihomo_panel/' + v[len(base) + 1:]
                elif v == base or v.startswith(base + '?'):
                    v = '/mihomo_panel/'
            try:
                r.headers[k] = v
            except Exception:
                pass

        # Prevent aggressive caching of UI assets (helps when Mihomo UI updates).
        r.headers.setdefault('Cache-Control', 'no-store, no-cache, must-revalidate')
        r.headers.setdefault('Pragma', 'no-cache')
        r.headers.setdefault('Referrer-Policy', 'no-referrer')
        r.headers.setdefault('X-Content-Type-Options', 'nosniff')
        r.headers.setdefault('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        return r


    # ---------- Profiles ----------

    @bp.get("/api/mihomo/profiles")
    def api_mihomo_profiles_list():
        """List Mihomo profiles (name + is_active) via service layer."""
        try:
            infos = _mh_list_profiles_for_api()
            return jsonify(infos)
        except Exception as e:
            return _mihomo_exception(
                "Не удалось получить список профилей Mihomo.",
                code="profiles_list_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=400,
            )

    @bp.get("/api/mihomo/profiles/<name>")
    def api_mihomo_profiles_get(name: str):
        """Return raw YAML content of the given Mihomo profile."""
        try:
            content = _mh_get_profile_content_for_api(name)
            return current_app.response_class(content, mimetype="text/plain; charset=utf-8")
        except FileNotFoundError:
            return _api_error("profile not found", 404, ok=False)
        except Exception as e:
            return _mihomo_exception(
                "Не удалось прочитать профиль Mihomo.",
                code="profile_read_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=400,
            )

    @bp.put("/api/mihomo/profiles/<name>")
    def api_mihomo_profiles_put(name: str):
        """Create a new Mihomo profile with given YAML content."""
        content = request.data.decode("utf-8", errors="ignore")
        if not content.strip():
            return _api_error("empty content", 400, ok=False)
        try:
            _mh_create_profile_from_content(name, content)
            return jsonify({"ok": True})
        except FileExistsError:
            return _api_error("profile already exists", 409, ok=False)
        except Exception as e:
            return _mihomo_exception(
                "Не удалось сохранить профиль Mihomo.",
                code="profile_write_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=400,
            )

    @bp.delete("/api/mihomo/profiles/<name>")
    def api_mihomo_profiles_delete(name: str):
        """Delete Mihomo profile."""
        try:
            _mh_delete_profile_by_name(name)
            return jsonify({"ok": True})
        except RuntimeError:
            return _mihomo_error(
                "Нельзя удалить активный профиль Mihomo.",
                400,
                code="profile_delete_blocked",
            )
        except Exception as e:
            return _mihomo_exception(
                "Не удалось удалить профиль Mihomo.",
                code="profile_delete_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/profiles/<name>/activate")
    def api_mihomo_profiles_activate(name: str):
        "Activate given Mihomo profile and restart xkeen."
        try:
            _mh_activate_profile(name)
            restarted = restart_xkeen(source="mihomo-profile-activate")
            return jsonify({"ok": True, "restarted": restarted})
        except FileNotFoundError:
            return _api_error("profile not found", 404, ok=False)
        except Exception as e:
            return _mihomo_exception(
                "Не удалось активировать профиль Mihomo.",
                code="profile_activate_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=400,
            )

    # ---------- Backups ----------

    @bp.post("/api/mihomo/backups/clean")
    def api_mihomo_backups_clean():
        """Remove old Mihomo config backups, keeping at most `limit` newest ones."""
        data = request.get_json(silent=True) or {}
        limit = data.get("limit", 5)
        profile = (data.get("profile") or "").strip() or None

        try:
            limit = int(limit)
        except Exception:
            return _api_error("limit must be an integer", 400, ok=False)
        if limit < 0:
            return _api_error("limit must be >= 0", 400, ok=False)

        try:
            result = _mh_clean_backups_for_api(limit, profile)
            return jsonify(result)
        except Exception as e:
            return _mihomo_exception(
                "Не удалось очистить бэкапы Mihomo.",
                code="backups_clean_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=400,
            )

    @bp.get("/api/mihomo/backups")
    def api_mihomo_backups_list():
        profile = request.args.get("profile") or None
        infos = _mh_list_backups_for_profile(profile)
        return jsonify(infos)

    @bp.get("/api/mihomo/backups/<filename>")
    def api_mihomo_backup_get(filename: str):
        try:
            content = _mh_get_backup_content(filename)
            return current_app.response_class(content, mimetype="text/plain; charset=utf-8")
        except FileNotFoundError:
            return _api_error("backup not found", 404, ok=False)

    @bp.delete("/api/mihomo/backups/<filename>")
    def api_mihomo_backup_delete(filename: str):
        try:
            _mh_delete_backup_file(filename)
            return jsonify({"ok": True})
        except Exception as e:
            return _mihomo_exception(
                "Не удалось удалить бэкап Mihomo.",
                code="backup_delete_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=400,
            )

    @bp.post("/api/mihomo/backups/<filename>/restore")
    def api_mihomo_backup_restore(filename: str):
        try:
            _mh_restore_backup_file(filename)
            # Перезапуск после восстановления бэкапа, чтобы конфиг применился
            restarted = restart_xkeen(source="mihomo-backup-restore")
            return jsonify({"ok": True, "restarted": restarted})
        except FileNotFoundError:
            return _api_error("backup not found", 404, ok=False)
        except Exception as e:
            return _mihomo_exception(
                "Не удалось восстановить бэкап Mihomo.",
                code="backup_restore_failed",
                hint="Подробности смотрите в server logs.",
                exc=e,
                status=400,
            )

    return bp
