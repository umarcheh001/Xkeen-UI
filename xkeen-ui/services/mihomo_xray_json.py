"""Convert Xray-style JSON subscriptions to Mihomo proxy YAML blocks.

Subscription formats handled (auto-detected via `_load_subscription_json`):
  - bare JSON array of full Xray configs (each with its own `outbounds[]`)
  - single Xray config object with `outbounds[]`
  - container objects like `{configs: [...]}` / `{nodes: [...]}` / etc.
  - any of the above wrapped in base64

Transports/security supported for VLESS:
  - network: tcp / ws / grpc / xhttp / httpupgrade
  - security: none / tls / reality
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Tuple

from .mihomo_proxy_parsers import (
    ProxyParseResult,
    _build_xhttp_opts,
    _mapping_bool,
    _yaml_append_key,
    _yaml_list,
    _yaml_str,
)
from .xray_subscriptions import (
    _iter_json_proxy_outbounds,
    _load_subscription_json,
)


SUPPORTED_PROTOCOLS = {"vless", "hysteria", "hysteria2", "hy2"}


def convert_outbound_to_mihomo(
    outbound: Dict[str, Any], name: str
) -> Optional[ProxyParseResult]:
    """Convert one Xray outbound dict to a Mihomo proxy YAML block.

    Returns None if the protocol is unsupported or required fields are missing.
    The caller is responsible for ensuring `name` is unique within the target config.
    """
    if not isinstance(outbound, dict):
        return None
    proto = str(outbound.get("protocol") or "").strip().lower()
    if proto not in SUPPORTED_PROTOCOLS:
        return None

    settings = outbound.get("settings") or {}
    stream = outbound.get("streamSettings") or {}

    if proto == "vless":
        return _convert_vless(settings, stream, name)
    if proto in {"hysteria", "hysteria2", "hy2"}:
        return _convert_hysteria2(settings, stream, name, proto)
    return None


def _convert_vless(
    settings: Dict[str, Any], stream: Dict[str, Any], name: str
) -> Optional[ProxyParseResult]:
    vnext_list = settings.get("vnext") if isinstance(settings, dict) else None
    if not isinstance(vnext_list, list) or not vnext_list:
        return None
    vnext = vnext_list[0] if isinstance(vnext_list[0], dict) else {}
    users = vnext.get("users") if isinstance(vnext, dict) else None
    user = users[0] if isinstance(users, list) and users and isinstance(users[0], dict) else {}

    server = str(vnext.get("address") or "").strip()
    raw_port = vnext.get("port")
    uuid = str(user.get("id") or "").strip()
    if not server or not uuid or raw_port in (None, ""):
        return None
    try:
        port = int(raw_port)
    except (TypeError, ValueError):
        return None
    if port <= 0 or port > 65535:
        return None

    flow = str(user.get("flow") or "").strip()
    encryption = str(user.get("encryption") or "").strip().lower()

    network = str(stream.get("network") or "tcp").strip().lower()
    security = str(stream.get("security") or "none").strip().lower()

    sni = ""
    if security == "reality":
        rs = stream.get("realitySettings") or {}
        sni = str(rs.get("serverName") or "").strip()
    elif security == "tls":
        ts = stream.get("tlsSettings") or {}
        sni = str(ts.get("serverName") or "").strip()

    yaml_lines: List[str] = []
    yaml_lines.append(f"- name: {_yaml_str(name)}")
    yaml_lines.append("  type: vless")
    yaml_lines.append(f"  server: {_yaml_str(server)}")
    yaml_lines.append(f"  port: {port}")
    yaml_lines.append(f"  uuid: {_yaml_str(uuid)}")

    if flow:
        yaml_lines.append(f"  flow: {_yaml_str(flow)}")

    if not encryption or encryption == "none":
        yaml_lines.append('  encryption: ""')
    else:
        yaml_lines.append(f"  encryption: {_yaml_str(encryption)}")

    yaml_lines.append(f"  network: {_yaml_str(network)}")
    yaml_lines.append("  udp: true")
    yaml_lines.append("  packet-encoding: xudp")

    if security == "reality":
        rs = stream.get("realitySettings") or {}
        fp = str(rs.get("fingerprint") or "").strip()
        public_key = str(rs.get("publicKey") or "").strip()
        short_id = rs.get("shortId")
        spider_x = str(rs.get("spiderX") or "").strip()

        yaml_lines.append("  tls: true")
        yaml_lines.append("  tfo: true")
        if sni:
            yaml_lines.append(f"  servername: {_yaml_str(sni)}")
        yaml_lines.append("  reality-opts:")
        if public_key:
            yaml_lines.append(f"    public-key: {_yaml_str(public_key)}")
        if short_id is not None:
            yaml_lines.append(f"    short-id: {_yaml_str(short_id)}")
        if _mapping_bool(
            rs,
            "support-x25519mlkem768",
            "supportX25519MLKEM768",
            "support_x25519mlkem768",
        ) is True:
            yaml_lines.append("    support-x25519mlkem768: true")
        if spider_x:
            yaml_lines.append(f"    spider-x: {_yaml_str(spider_x)}")
        yaml_lines.append(f"  client-fingerprint: {_yaml_str(fp or 'chrome')}")
    elif security == "tls":
        ts = stream.get("tlsSettings") or {}
        fp = str(ts.get("fingerprint") or "").strip()
        alpn = ts.get("alpn")
        allow_insecure = bool(ts.get("allowInsecure"))

        yaml_lines.append("  tls: true")
        yaml_lines.append("  tfo: true")
        if sni:
            yaml_lines.append(f"  servername: {_yaml_str(sni)}")
        yaml_lines.append(f"  client-fingerprint: {_yaml_str(fp or 'chrome')}")
        if isinstance(alpn, list):
            alpn_items = [str(x).strip() for x in alpn if str(x or "").strip()]
            if alpn_items:
                yaml_lines.append(f"  alpn: {_yaml_list(alpn_items)}")
        if allow_insecure:
            yaml_lines.append("  skip-cert-verify: true")

    if network == "xhttp":
        xs = stream.get("xhttpSettings") or {}
        path = str(xs.get("path") or "/")
        host = str(xs.get("host") or sni or "")
        mode = str(xs.get("mode") or "")
        extra: Dict[str, Any] = {}
        for k in (
            "headers",
            "no-grpc-header",
            "noGrpcHeader",
            "x-padding-bytes",
            "xPaddingBytes",
            "sc-max-each-post-bytes",
            "scMaxEachPostBytes",
            "reuse-settings",
            "reuseSettings",
            "download-settings",
            "downloadSettings",
        ):
            if isinstance(xs, dict) and k in xs and xs[k] not in (None, ""):
                extra[k] = xs[k]
        opts = _build_xhttp_opts(path, host, mode, extra)
        yaml_lines.append("  xhttp-opts:")
        for key, value in opts.items():
            _yaml_append_key(yaml_lines, 4, key, value)
    elif network == "ws":
        ws = stream.get("wsSettings") or {}
        path = str(ws.get("path") or "/")
        headers = ws.get("headers") or {}
        host = ""
        if isinstance(headers, dict):
            host = str(headers.get("Host") or headers.get("host") or "").strip()
        if not host:
            host = sni
        yaml_lines.append("  ws-opts:")
        yaml_lines.append(f"    path: {_yaml_str(path)}")
        if host:
            yaml_lines.append("    headers:")
            yaml_lines.append(f"      Host: {_yaml_str(host)}")
    elif network == "grpc":
        gs = stream.get("grpcSettings") or {}
        service_name = str(gs.get("serviceName") or "").strip()
        if service_name:
            yaml_lines.append("  grpc-opts:")
            yaml_lines.append(f"    grpc-service-name: {_yaml_str(service_name)}")
    elif network == "httpupgrade":
        hu = stream.get("httpupgradeSettings") or {}
        path = str(hu.get("path") or "/")
        host = str(hu.get("host") or "").strip() or sni
        yaml_lines.append("  http-upgrade-opts:")
        yaml_lines.append(f"    path: {_yaml_str(path)}")
        if host:
            yaml_lines.append("    headers:")
            yaml_lines.append(f"      Host: {_yaml_str(host)}")
    # network == "tcp" — bare, no transport opts (typical for reality+vision)

    yaml = "\n".join(yaml_lines) + "\n"
    return ProxyParseResult(name=name, yaml=yaml)


def _first_text(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _first_value(*values: Any) -> Any:
    for value in values:
        if value not in (None, ""):
            return value
    return None


def _as_mapping(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _int_port(value: Any) -> Optional[int]:
    try:
        port = int(value)
    except (TypeError, ValueError):
        return None
    if port <= 0 or port > 65535:
        return None
    return port


def _int_or_none(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _string_list(value: Any) -> List[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item or "").strip()]
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


def _hysteria_finalmask_obfs(finalmask: Dict[str, Any]) -> Tuple[str, str]:
    if not isinstance(finalmask, dict):
        return "", ""
    masks = finalmask.get("udpmasks")
    if not isinstance(masks, list):
        masks = finalmask.get("udp")
    if not isinstance(masks, list):
        return "", ""
    for item in masks:
        if not isinstance(item, dict):
            continue
        obfs_type = str(item.get("type") or "").strip()
        settings = _as_mapping(item.get("settings"))
        password = _first_text(
            settings.get("password"),
            settings.get("obfs-password"),
            settings.get("obfsPassword"),
            settings.get("obfs_password"),
        )
        if obfs_type or password:
            return obfs_type, password
    return "", ""


def _convert_hysteria2(
    settings: Dict[str, Any],
    stream: Dict[str, Any],
    name: str,
    proto: str,
) -> Optional[ProxyParseResult]:
    settings = _as_mapping(settings)
    stream = _as_mapping(stream)
    hysteria_settings = _as_mapping(stream.get("hysteriaSettings"))
    tls_settings = _as_mapping(stream.get("tlsSettings"))
    finalmask = _as_mapping(stream.get("finalmask"))
    quic_params = _as_mapping(finalmask.get("quicParams"))

    version = _int_or_none(_first_value(settings.get("version"), hysteria_settings.get("version")))
    if version not in (None, 2) and proto == "hysteria":
        return None

    server = _first_text(
        settings.get("address"),
        settings.get("server"),
        hysteria_settings.get("address"),
        hysteria_settings.get("server"),
    )
    port = _int_port(_first_value(settings.get("port"), hysteria_settings.get("port")))
    password = _first_text(
        hysteria_settings.get("auth"),
        hysteria_settings.get("auth_str"),
        hysteria_settings.get("authStr"),
        settings.get("auth"),
        settings.get("password"),
    )
    if not server or port is None or not password:
        return None

    sni = _first_text(
        tls_settings.get("serverName"),
        tls_settings.get("servername"),
        hysteria_settings.get("sni"),
        settings.get("sni"),
    )
    alpn = _string_list(_first_value(tls_settings.get("alpn"), hysteria_settings.get("alpn")))
    if not alpn:
        alpn = ["h3"]

    allow_insecure = bool(
        _mapping_bool(tls_settings, "allowInsecure", "allow_insecure", "skip-cert-verify", "skipCertVerify")
        or _mapping_bool(settings, "allowInsecure", "insecure", "skip-cert-verify", "skipCertVerify")
    )

    up = _first_text(
        hysteria_settings.get("up"),
        settings.get("up"),
        quic_params.get("brutalUp"),
        quic_params.get("up"),
    )
    down = _first_text(
        hysteria_settings.get("down"),
        settings.get("down"),
        quic_params.get("brutalDown"),
        quic_params.get("down"),
    )

    obfs = _first_text(
        hysteria_settings.get("obfs"),
        settings.get("obfs"),
        hysteria_settings.get("obfsType"),
    )
    obfs_password = _first_text(
        hysteria_settings.get("obfs-password"),
        hysteria_settings.get("obfs_password"),
        hysteria_settings.get("obfsPassword"),
        settings.get("obfs-password"),
        settings.get("obfs_password"),
        settings.get("obfsPassword"),
    )
    fm_obfs, fm_obfs_password = _hysteria_finalmask_obfs(finalmask)
    if not obfs:
        obfs = fm_obfs
    if not obfs_password:
        obfs_password = fm_obfs_password

    yaml_lines: List[str] = []
    yaml_lines.append(f"- name: {_yaml_str(name)}")
    yaml_lines.append("  type: hysteria2")
    yaml_lines.append(f"  server: {_yaml_str(server)}")
    yaml_lines.append(f"  port: {port}")
    yaml_lines.append(f"  password: {_yaml_str(password)}")
    yaml_lines.append("  udp: true")
    yaml_lines.append("  fast-open: true")
    if alpn:
        yaml_lines.append(f"  alpn: {_yaml_list(alpn)}")
    if up:
        yaml_lines.append(f"  up: {_yaml_str(up)}")
    if down:
        yaml_lines.append(f"  down: {_yaml_str(down)}")
    if sni:
        yaml_lines.append(f"  sni: {_yaml_str(sni)}")
    if allow_insecure:
        yaml_lines.append("  skip-cert-verify: true")
    if obfs:
        yaml_lines.append(f"  obfs: {_yaml_str(obfs)}")
    if obfs_password:
        yaml_lines.append(f"  obfs-password: {_yaml_str(obfs_password)}")

    yaml = "\n".join(yaml_lines) + "\n"
    return ProxyParseResult(name=name, yaml=yaml)


def _fallback_name(outbound: Dict[str, Any], idx: int) -> str:
    proto = str(outbound.get("protocol") or "proxy").strip()
    settings = outbound.get("settings") or {}
    if isinstance(settings, dict):
        for key in ("vnext", "servers"):
            arr = settings.get(key)
            if isinstance(arr, list) and arr and isinstance(arr[0], dict):
                addr = str(arr[0].get("address") or "").strip()
                if addr:
                    return f"{proto}-{addr}"
    return f"{proto}-{idx + 1}"


def _unique_name(base: str, used: Dict[str, int]) -> str:
    name = base or "proxy"
    count = used.get(name, 0)
    if count == 0:
        used[name] = 1
        return name
    suffix = count + 1
    while True:
        candidate = f"{name}_{suffix}"
        if used.get(candidate, 0) == 0:
            used[name] = suffix
            used[candidate] = 1
            return candidate
        suffix += 1


SubscriptionResult = Tuple[List[ProxyParseResult], List[Dict[str, str]]]


def convert_subscription_text(
    body: str,
    *,
    existing_names: Optional[Iterable[str]] = None,
) -> SubscriptionResult:
    """Parse Xray-JSON subscription text and convert each outbound to Mihomo YAML.

    Returns (proxies, skipped). `proxies` are ProxyParseResult with unique names.
    `existing_names` lets the caller seed the name registry to avoid collisions
    with proxies already present in the target config.
    Raises ValueError if the body does not look like Xray-JSON.
    """
    parsed = _load_subscription_json(body)
    if parsed is None:
        raise ValueError("not_xray_json")

    items = list(_iter_json_proxy_outbounds(parsed))
    if not items:
        return [], []

    used: Dict[str, int] = {}
    if existing_names:
        for n in existing_names:
            n_str = str(n or "").strip()
            if n_str:
                used[n_str] = 1

    proxies: List[ProxyParseResult] = []
    skipped: List[Dict[str, str]] = []
    for idx, (outbound, name_hint) in enumerate(items):
        base_name = (name_hint or "").strip() or _fallback_name(outbound, idx)
        proto = str(outbound.get("protocol") or "").strip().lower()
        try:
            unique = _unique_name(base_name, used)
            result = convert_outbound_to_mihomo(outbound, unique)
        except Exception as exc:
            skipped.append(
                {"name": base_name, "reason": f"convert_error: {type(exc).__name__}: {exc}"}
            )
            continue
        if result is None:
            skipped.append(
                {"name": base_name, "reason": f"unsupported_protocol: {proto or '?'}"}
            )
            continue
        proxies.append(result)
    return proxies, skipped


def format_proxies_section(proxies: Iterable[ProxyParseResult]) -> str:
    """Combine individual proxy YAML blocks into a single `proxies:` section.

    Each block already starts with `- name: ...` at column 0; we prepend a
    `proxies:` header and indent each block by two spaces.
    """
    blocks: List[str] = []
    for p in proxies:
        text = str(p.yaml or "").rstrip("\n")
        if not text:
            continue
        indented = "\n".join(("  " + line) if line else line for line in text.split("\n"))
        blocks.append(indented)
    if not blocks:
        return "proxies: []\n"
    return "proxies:\n" + "\n\n".join(blocks) + "\n"
