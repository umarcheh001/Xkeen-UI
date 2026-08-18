# Частично основано на коде из проекта "Mihomo Studio"
# Copyright (c) 2024 l-ptrol
# Исходный репозиторий: https://github.com/l-ptrol/mihomo_studio
# Лицензия: MIT

"""Proxy and WireGuard parsing helpers for Mihomo config generation."""

from __future__ import annotations

import base64
import json
import re
import shlex
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse


# === YAML safety helpers (avoid broken YAML / injection via plain scalars) ===
# We build YAML by concatenating strings (router-friendly, no PyYAML dependency),
# so we must quote/escape values that can break YAML syntax.
_YAML_KEYWORDS = {"null", "~", "true", "false", "yes", "no", "on", "off"}
_YAML_NEEDS_QUOTING_RE = re.compile(r"""[\s:#\[\]{}&,*>!%`"'|@?]""")


def _yaml_str(v) -> str:
    """Return a YAML-safe scalar for arbitrary values.

    All callers of `_yaml_str` semantically want a *string* in the YAML output.
    We therefore also quote bare scalars that PyYAML would otherwise reinterpret
    as a number (e.g. an all-digit Reality short-id like ``"28000000"``).
    """
    if v is None:
        return "''"
    s = str(v)
    s = s.replace("\r", "").replace("\n", " ")

    low = s.strip().lower()
    if (
        s == ""
        or low in _YAML_KEYWORDS
        or _YAML_NEEDS_QUOTING_RE.search(s)
        or s[:1] in "-?:&*"
    ):
        return "'" + s.replace("'", "''") + "'"
    try:
        float(s)
    except (TypeError, ValueError):
        return s
    return "'" + s.replace("'", "''") + "'"


def _yaml_list(items) -> str:
    """YAML flow-style list with safe string scalars."""
    return "[" + ", ".join(_yaml_str(x) for x in items) + "]"


def _yaml_append_key(lines: List[str], indent: int, key: str, value: Any) -> None:
    """Append a nested YAML key/value pair using safe scalars."""
    if value is None or value == "":
        return

    pad = " " * indent
    if isinstance(value, dict):
        if not value:
            return
        lines.append(f"{pad}{key}:")
        for sub_key, sub_value in value.items():
            _yaml_append_key(lines, indent + 2, str(sub_key), sub_value)
        return

    if isinstance(value, list):
        items = [item for item in value if item not in (None, "")]
        if not items:
            return
        lines.append(f"{pad}{key}:")
        for item in items:
            if isinstance(item, bool):
                lines.append(f"{pad}  - {'true' if item else 'false'}")
            elif isinstance(item, (int, float)) and not isinstance(item, bool):
                lines.append(f"{pad}  - {item}")
            else:
                lines.append(f"{pad}  - {_yaml_str(item)}")
        return

    if isinstance(value, bool):
        lines.append(f"{pad}{key}: {'true' if value else 'false'}")
        return

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        lines.append(f"{pad}{key}: {value}")
        return

    lines.append(f"{pad}{key}: {_yaml_str(value)}")


def _mapping_first(mapping: Any, *keys: str, default: Any = None) -> Any:
    if not isinstance(mapping, dict):
        return default
    for key in keys:
        if key in mapping:
            value = mapping.get(key)
            if value is not None and value != "":
                return value
    return default


def _mapping_bool(mapping: Any, *keys: str) -> Optional[bool]:
    raw = _mapping_first(mapping, *keys, default=None)
    if isinstance(raw, bool):
        return raw
    if raw is None:
        return None
    text = str(raw).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return None


def _normalize_mihomo_vless_flow(value: Any) -> str:
    flow = str(value or "").strip()
    if not flow:
        return ""
    if flow == "xtls-rprx-vision" or flow.startswith("xtls-rprx-vision-"):
        return "xtls-rprx-vision"
    return flow


def _query_first(mapping: Dict[str, str], *keys: str) -> str:
    for key in keys:
        value = mapping.get(key)
        if value not in (None, ""):
            try:
                return unquote(str(value))
            except Exception:
                return str(value)
    return ""


def _query_bool(mapping: Dict[str, str], *keys: str) -> Optional[bool]:
    raw = _query_first(mapping, *keys)
    if raw == "":
        return None
    text = str(raw).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return None


def _append_reality_pq_support_from_query(lines: List[str], mapping: Dict[str, str]) -> None:
    support = _query_bool(
        mapping,
        "support-x25519mlkem768",
        "supportX25519MLKEM768",
        "support_x25519mlkem768",
    )
    if support is True:
        lines.append("    support-x25519mlkem768: true")


def _append_reality_pq_support_from_mapping(lines: List[str], mapping: Any) -> None:
    support = _mapping_bool(
        mapping,
        "support-x25519mlkem768",
        "supportX25519MLKEM768",
        "support_x25519mlkem768",
    )
    if support is True:
        lines.append("    support-x25519mlkem768: true")


def _append_reality_pq_support_from_qs(lines: List[str], parsed_qs: Dict[str, List[str]]) -> None:
    support = _qs_bool(
        parsed_qs,
        "support-x25519mlkem768",
        "supportX25519MLKEM768",
        "support_x25519mlkem768",
    )
    if support:
        lines.append("    support-x25519mlkem768: true")


def _sanitize_headers(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None

    out: Dict[str, Any] = {}
    for raw_key, raw_value in value.items():
        key = str(raw_key or "").strip()
        if not key or raw_value is None or raw_value == "":
            continue
        if isinstance(raw_value, list):
            items = [str(item) for item in raw_value if item is not None and str(item) != ""]
            if items:
                out[key] = items
            continue
        out[key] = raw_value if isinstance(raw_value, (bool, int, float)) else str(raw_value)
    return out or None


def _sanitize_string_list(value: Any) -> Optional[List[str]]:
    if value in (None, ""):
        return None

    if isinstance(value, str):
        items = [part.strip() for part in value.split(",") if part.strip()]
        return items or None

    if not isinstance(value, list):
        return None

    items = [str(item).strip() for item in value if item is not None and str(item).strip()]
    return items or None


def _sanitize_tree(value: Any) -> Any:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    if isinstance(value, list):
        items = [_sanitize_tree(item) for item in value]
        items = [item for item in items if item not in (None, "", [], {})]
        return items or None
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for raw_key, raw_value in value.items():
            key = str(raw_key or "").strip()
            if not key:
                continue
            clean_value = _sanitize_tree(raw_value)
            if clean_value in (None, "", [], {}):
                continue
            out[key] = clean_value
        return out or None
    return str(value)


def _sanitize_reuse_settings(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None

    alias_map = {
        "max-concurrency": ("max-concurrency", "maxConcurrency"),
        "max-connections": ("max-connections", "maxConnections"),
        "c-max-reuse-times": ("c-max-reuse-times", "cMaxReuseTimes"),
        "h-max-request-times": ("h-max-request-times", "hMaxRequestTimes"),
        "h-max-reusable-secs": ("h-max-reusable-secs", "hMaxReusableSecs"),
    }

    out: Dict[str, Any] = {}
    for target_key, aliases in alias_map.items():
        raw = _mapping_first(value, *aliases, default=None)
        if raw is None or raw == "":
            continue
        out[target_key] = raw if isinstance(raw, (bool, int, float)) else str(raw)
    return out or None


def _sanitize_download_settings(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None

    out: Dict[str, Any] = {}

    path = _mapping_first(value, "path", default=None)
    if path not in (None, ""):
        out["path"] = str(path)

    host = _mapping_first(value, "host", default=None)
    if host not in (None, ""):
        out["host"] = str(host)

    headers = _sanitize_headers(_mapping_first(value, "headers", default=None))
    if headers:
        out["headers"] = headers

    no_grpc_header = _mapping_bool(value, "no-grpc-header", "noGrpcHeader", "noGRPCHeader")
    if no_grpc_header is not None:
        out["no-grpc-header"] = no_grpc_header

    x_padding_bytes = _mapping_first(value, "x-padding-bytes", "xPaddingBytes", default=None)
    if x_padding_bytes not in (None, ""):
        out["x-padding-bytes"] = (
            x_padding_bytes if isinstance(x_padding_bytes, (bool, int, float)) else str(x_padding_bytes)
        )

    sc_max_each_post_bytes = _mapping_first(
        value, "sc-max-each-post-bytes", "scMaxEachPostBytes", default=None
    )
    if sc_max_each_post_bytes not in (None, ""):
        out["sc-max-each-post-bytes"] = (
            sc_max_each_post_bytes
            if isinstance(sc_max_each_post_bytes, (bool, int, float))
            else str(sc_max_each_post_bytes)
        )

    reuse_settings = _sanitize_reuse_settings(_mapping_first(value, "reuse-settings", "reuseSettings", default=None))
    if reuse_settings:
        out["reuse-settings"] = reuse_settings

    server = _mapping_first(value, "server", default=None)
    if server not in (None, ""):
        out["server"] = str(server)

    port = _mapping_first(value, "port", default=None)
    if port not in (None, ""):
        out["port"] = port if isinstance(port, (int, float)) and not isinstance(port, bool) else str(port)

    tls = _mapping_bool(value, "tls")
    if tls is not None:
        out["tls"] = tls

    alpn = _sanitize_string_list(_mapping_first(value, "alpn", default=None))
    if alpn:
        out["alpn"] = alpn

    ech_opts = _sanitize_tree(_mapping_first(value, "ech-opts", "echOpts", default=None))
    if ech_opts is not None:
        out["ech-opts"] = ech_opts

    reality_opts = _sanitize_tree(_mapping_first(value, "reality-opts", "realityOpts", default=None))
    if reality_opts is not None:
        out["reality-opts"] = reality_opts

    skip_cert_verify = _mapping_bool(value, "skip-cert-verify", "skipCertVerify")
    if skip_cert_verify is not None:
        out["skip-cert-verify"] = skip_cert_verify

    fingerprint = _mapping_first(value, "fingerprint", default=None)
    if fingerprint not in (None, ""):
        out["fingerprint"] = str(fingerprint)

    certificate = _sanitize_tree(_mapping_first(value, "certificate", default=None))
    if certificate is not None:
        out["certificate"] = certificate

    private_key = _sanitize_tree(_mapping_first(value, "private-key", "privateKey", default=None))
    if private_key is not None:
        out["private-key"] = private_key

    servername = _mapping_first(value, "servername", "serverName", default=None)
    if servername not in (None, ""):
        out["servername"] = str(servername)

    client_fingerprint = _mapping_first(value, "client-fingerprint", "clientFingerprint", default=None)
    if client_fingerprint not in (None, ""):
        out["client-fingerprint"] = str(client_fingerprint)

    return out or None


def _parse_xhttp_extra(raw: str) -> Dict[str, Any]:
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(unquote(text))
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _build_xhttp_opts(path: str, host: str, mode: str, extra: Any) -> Dict[str, Any]:
    opts: Dict[str, Any] = {"path": path or "/"}
    if host:
        opts["host"] = host
    if mode:
        opts["mode"] = mode

    headers = _sanitize_headers(_mapping_first(extra, "headers", default=None))
    if headers:
        opts["headers"] = headers

    no_grpc_header = _mapping_bool(extra, "no-grpc-header", "noGrpcHeader", "noGRPCHeader")
    if no_grpc_header is True:
        opts["no-grpc-header"] = True

    x_padding_bytes = _mapping_first(extra, "x-padding-bytes", "xPaddingBytes", default=None)
    if x_padding_bytes not in (None, ""):
        opts["x-padding-bytes"] = (
            x_padding_bytes if isinstance(x_padding_bytes, (bool, int, float)) else str(x_padding_bytes)
        )

    sc_max_each_post_bytes = _mapping_first(
        extra, "sc-max-each-post-bytes", "scMaxEachPostBytes", default=None
    )
    if sc_max_each_post_bytes not in (None, ""):
        opts["sc-max-each-post-bytes"] = (
            sc_max_each_post_bytes
            if isinstance(sc_max_each_post_bytes, (bool, int, float))
            else str(sc_max_each_post_bytes)
        )

    reuse_settings = _sanitize_reuse_settings(_mapping_first(extra, "reuse-settings", "reuseSettings", default=None))
    if reuse_settings:
        opts["reuse-settings"] = reuse_settings

    download_settings = _sanitize_download_settings(
        _mapping_first(extra, "download-settings", "downloadSettings", default=None)
    )
    if download_settings:
        opts["download-settings"] = download_settings

    return opts


def _extract_xhttp_opts_from_query(query_params: Dict[str, str], *, fallback_host: str = "") -> Dict[str, Any]:
    path = unquote(str(query_params.get("path", "/") or "/"))
    host = unquote(str(query_params.get("host") or fallback_host or ""))
    mode = unquote(str(query_params.get("mode") or ""))
    extra = _parse_xhttp_extra(str(query_params.get("extra") or ""))
    return _build_xhttp_opts(path, host, mode, extra)


@dataclass
class ProxyParseResult:
    name: str
    yaml: str


VLESS_RE = re.compile(r"^vless://(?P<id>[^@]+)@(?P<server>[^:]+):(?P<port>\d+).*$", re.IGNORECASE)


def parse_vless(link: str, custom_name: Optional[str] = None) -> ProxyParseResult:
    """Parse a VLESS URL and return ProxyParseResult with Mihomo YAML block."""
    link = link.strip()

    comment_name = ""
    hash_pos = link.find("#")
    if hash_pos != -1:
        fragment = link[hash_pos + 1 :]
        try:
            comment_name = unquote(fragment)
        except Exception:
            comment_name = fragment

    m = VLESS_RE.match(link)
    if not m:
        raise ValueError("Not a valid VLESS link")

    server = m.group("server")
    port = int(m.group("port"))
    user_part = m.group("id")

    if ":" in user_part:
        uuid, flow = user_part.split(":", 1)
    else:
        uuid, flow = user_part, ""

    def _safe_unquote(v: str) -> str:
        try:
            return unquote(v)
        except Exception:
            return v

    qs: Dict[str, str] = {}
    if "?" in link:
        q = link.split("?", 1)[1]
        if "#" in q:
            q = q.split("#", 1)[0]
        for part in q.split("&"):
            if not part or "=" not in part:
                continue
            k, v = part.split("=", 1)
            qs[k] = v

    if not flow:
        flow_q = qs.get("flow")
        if flow_q:
            try:
                flow = unquote(flow_q)
            except Exception:
                flow = flow_q
    flow = _normalize_mihomo_vless_flow(flow)

    name = custom_name or qs.get("remarks") or qs.get("remark") or comment_name.strip() or server

    security = qs.get("security", "")
    sni = qs.get("sni") or qs.get("host") or ""
    fp = qs.get("fp") or ""
    alpn = qs.get("alpn") or ""
    type_ = (qs.get("type", "tcp") or "tcp").lower()
    encryption = qs.get("encryption") or ""
    allow_insecure_raw = (qs.get("allowInsecure") or qs.get("insecure") or "").strip().lower()
    allow_insecure = allow_insecure_raw in {"1", "true", "yes", "on"}
    spx = qs.get("spx") or ""

    if sni:
        sni = _safe_unquote(sni)
    if alpn:
        alpn = _safe_unquote(alpn)
    if encryption:
        encryption = _safe_unquote(encryption)
    if spx:
        spx = _safe_unquote(spx)

    yaml_lines: List[str] = []
    yaml_lines.append(f"- name: {_yaml_str(name)}")
    yaml_lines.append("  type: vless")
    yaml_lines.append(f"  server: {_yaml_str(server)}")
    yaml_lines.append(f"  port: {port}")
    yaml_lines.append(f"  uuid: {_yaml_str(uuid)}")

    if flow:
        yaml_lines.append(f"  flow: {_yaml_str(flow)}")

    enc = (encryption or "").strip()
    if not enc or enc.lower() == "none":
        yaml_lines.append('  encryption: ""')
    else:
        yaml_lines.append(f"  encryption: {_yaml_str(enc)}")

    yaml_lines.append(f"  network: {_yaml_str(type_)}")
    yaml_lines.append("  udp: true")
    yaml_lines.append("  packet-encoding: xudp")

    sec = security.lower()
    if sec == "reality":
        yaml_lines.append("  tls: true")
        yaml_lines.append("  tfo: true")
        if sni:
            yaml_lines.append(f"  servername: {_yaml_str(sni)}")
        if alpn:
            alpn_items = [x.strip() for x in alpn.split(",") if x.strip()]
            if alpn_items:
                yaml_lines.append(f"  alpn: {_yaml_list(alpn_items)}")
        if allow_insecure:
            yaml_lines.append("  skip-cert-verify: true")
        yaml_lines.append("  reality-opts:")
        public_key = _query_first(qs, "pbk", "publicKey", "public-key", "public_key")
        short_id = _query_first(qs, "sid", "shortId", "short-id", "short_id", "shortid")
        if public_key:
            yaml_lines.append(f"    public-key: {_yaml_str(public_key)}")
        if short_id:
            yaml_lines.append(f"    short-id: {_yaml_str(short_id)}")
        _append_reality_pq_support_from_query(yaml_lines, qs)
        if spx:
            yaml_lines.append(f"    spider-x: {_yaml_str(spx)}")
        yaml_lines.append(f"  client-fingerprint: {_yaml_str(fp or 'chrome')}")
    elif sec == "tls":
        yaml_lines.append("  tls: true")
        yaml_lines.append("  tfo: true")
        if sni:
            yaml_lines.append(f"  servername: {_yaml_str(sni)}")
        yaml_lines.append(f"  client-fingerprint: {_yaml_str(fp or 'chrome')}")
        if alpn:
            alpn_items = [x.strip() for x in alpn.split(",") if x.strip()]
            yaml_lines.append(f"  alpn: {_yaml_list(alpn_items)}")
        if allow_insecure:
            yaml_lines.append("  skip-cert-verify: true")

    if type_ == "xhttp":
        xhttp_opts = _extract_xhttp_opts_from_query(qs, fallback_host=sni)
        yaml_lines.append("  xhttp-opts:")
        for key, value in xhttp_opts.items():
            _yaml_append_key(yaml_lines, 4, key, value)
    elif type_ == "ws":
        path = qs.get("path", "/")
        if path:
            path = _safe_unquote(path)
        host = qs.get("host") or sni or ""
        yaml_lines.append("  ws-opts:")
        yaml_lines.append(f"    path: {_yaml_str(path)}")
        if host:
            yaml_lines.append("    headers:")
            yaml_lines.append(f"      Host: {_yaml_str(host)}")
    elif type_ == "grpc":
        service_name = qs.get("serviceName") or qs.get("service_name") or ""
        if service_name:
            service_name = _safe_unquote(service_name)
        if service_name:
            yaml_lines.append("  grpc-opts:")
            yaml_lines.append(f"    grpc-service-name: {_yaml_str(service_name)}")
    elif type_ == "httpupgrade":
        path = qs.get("path", "/")
        if path:
            path = _safe_unquote(path)
        host = qs.get("host") or sni or ""
        yaml_lines.append("  http-upgrade-opts:")
        yaml_lines.append(f"    path: {_yaml_str(path)}")
        if host:
            yaml_lines.append("    headers:")
            yaml_lines.append(f"      Host: {_yaml_str(host)}")

    yaml = "\n".join(yaml_lines) + "\n"
    return ProxyParseResult(name=name, yaml=yaml)


def parse_wireguard(conf_text: str, custom_name: Optional[str] = None) -> ProxyParseResult:
    """Parse WireGuard .conf and return ProxyParseResult with Mihomo YAML proxy."""
    section = None
    iface: Dict[str, str] = {}
    peer: Dict[str, str] = {}

    def _strip_inline_comment(value: str) -> str:
        return re.sub(r"\s+[;#].*$", "", str(value or "")).strip()

    def _strip_optional_quotes(value: str) -> str:
        raw = str(value or "").strip()
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {"'", '"'}:
            return raw[1:-1]
        return raw

    def _put(target: Dict[str, str], key: str, value: str) -> None:
        k = str(key or "").strip().lower().replace("-", "")
        if not k:
            return
        target[k] = _strip_inline_comment(value)

    for raw_line in conf_text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith(";"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line.strip("[]").lower()
            continue
        if "=" not in line or not section:
            continue
        k, v = [x.strip() for x in line.split("=", 1)]
        if section == "interface":
            _put(iface, k, v)
        elif section == "peer":
            _put(peer, k, v)

    if "privatekey" not in iface or "publickey" not in peer or "endpoint" not in peer:
        raise ValueError("Invalid WireGuard config: missing mandatory keys")

    host, port = _split_endpoint(peer["endpoint"])
    name = custom_name or peer.get("name") or iface.get("name") or host

    def _strip_ip_cidr(value: str) -> str:
        return str(value or "").strip().split("/", 1)[0].strip()

    address = iface.get("address", "")
    ip_v4 = ""
    ip_v6 = ""
    if address:
        parts = [p.strip() for p in address.split(",")]
        for p in parts:
            if ":" in p:
                ip_v6 = _strip_ip_cidr(p)
            else:
                ip_v4 = _strip_ip_cidr(p)

    dns = iface.get("dns", "")
    dns_list = [d.strip() for d in dns.split(",") if d.strip()] if dns else []

    mtu = iface.get("mtu")
    allowed_ips = peer.get("allowedips", "0.0.0.0/0, ::/0")
    keepalive = peer.get("persistentkeepalive", "")

    def _first_value(*keys: str) -> str:
        for key in keys:
            normalized = key.lower().replace("-", "")
            if normalized in peer and peer[normalized] != "":
                return peer[normalized]
            if normalized in iface and iface[normalized] != "":
                return iface[normalized]
        return ""

    def _append_yaml_scalar(key: str, value: str, *, indent: int = 2, allow_empty: bool = False) -> None:
        raw = str(value or "").strip()
        if not raw and not allow_empty:
            return
        pad = " " * indent
        if re.fullmatch(r"-?\d+", raw):
            yaml_lines.append(f"{pad}{key}: {raw}")
        else:
            yaml_lines.append(f"{pad}{key}: {_yaml_str(raw)}")

    def _append_reserved(value: str) -> None:
        raw = str(value or "").strip()
        if not raw:
            return
        cleaned = raw.strip("[] ")
        parts = [p.strip() for p in cleaned.split(",") if p.strip()]
        if len(parts) >= 3 and all(re.fullmatch(r"\d+", p) for p in parts):
            yaml_lines.append("  reserved: [" + ", ".join(parts) + "]")
            return
        yaml_lines.append(f"  reserved: {_yaml_str(raw)}")

    amz: Dict[str, Any] = {}
    for key in (
        "jc",
        "jmin",
        "jmax",
        "s1",
        "s2",
        "s3",
        "s4",
        "h1",
        "h2",
        "h3",
        "h4",
        "i1",
        "i2",
        "i3",
        "i4",
        "i5",
        "j1",
        "j2",
        "j3",
        "itime",
    ):
        value = _first_value(key)
        if value != "":
            amz[key] = _strip_optional_quotes(value)

    # Mihomo v1.19.30 added a separate AmneziaWG v3 implementation.  AWG
    # .conf files do not normally carry Mihomo's implementation selector, so
    # infer ``version: 3`` as soon as a v3/v3.1-only option is present.  The
    # v3.1 additions still use version 3 in Mihomo.
    v3_scalar_keys = {
        "header-protection-key": ("headerprotectionkey",),
        "content-padding-addition": ("contentpaddingaddition",),
        "rekey-after-time": ("rekeyaftertime",),
        "rekey-timeout": ("rekeytimeout",),
        "reject-after-time": ("rejectaftertime",),
        "keepalive-timeout": ("keepalivetimeout",),
        "max-handshake-attempts": ("maxhandshakeattempts",),
    }
    has_v3_option = False
    for yaml_key, source_keys in v3_scalar_keys.items():
        value = _first_value(*source_keys)
        if value != "":
            amz[yaml_key] = _strip_optional_quotes(value)
            has_v3_option = True

    for yaml_key, source_key in (
        ("random-trailers", "randomtrailers"),
        ("disable-cookies", "disablecookies"),
    ):
        value = _first_value(source_key)
        if value != "":
            parsed_bool = _parse_bool_scalar(_strip_optional_quotes(value))
            if parsed_bool is None:
                raise ValueError(f"Invalid AmneziaWG boolean option: {source_key}")
            amz[yaml_key] = parsed_bool
            has_v3_option = True

    version = _strip_optional_quotes(_first_value("version", "awgversion", "amneziaversion"))
    if has_v3_option:
        # Mihomo selects both AWG 3.0 and 3.1 with the integer value 3.
        amz = {"version": 3, **amz}
    elif version:
        normalized_version = version.strip().lower().lstrip("v")
        if normalized_version in {"3", "3.0", "3.1"}:
            amz = {"version": 3, **amz}
        elif re.fullmatch(r"\d+", normalized_version):
            amz = {"version": int(normalized_version), **amz}

    yaml_lines: List[str] = []
    yaml_lines.append(f"- name: {_yaml_str(name)}")
    yaml_lines.append("  type: wireguard")
    yaml_lines.append(f"  server: {_yaml_str(host)}")
    yaml_lines.append(f"  port: {port}")
    if ip_v4:
        yaml_lines.append(f"  ip: {_yaml_str(ip_v4)}")
    if ip_v6:
        yaml_lines.append(f"  ipv6: {_yaml_str(ip_v6)}")
    yaml_lines.append(f"  private-key: {_yaml_str(iface['privatekey'])}")
    yaml_lines.append(f"  public-key: {_yaml_str(peer['publickey'])}")

    preshared_key = _first_value("presharedkey", "pre-shared-key")
    if preshared_key:
        yaml_lines.append(f"  pre-shared-key: {_yaml_str(preshared_key)}")
    reserved = _first_value("reserved", "clientid", "client-id")
    if reserved:
        _append_reserved(reserved)
    if dns_list:
        yaml_lines.append(f"  dns: {_yaml_list(dns_list)}")
        yaml_lines.append("  remote-dns-resolve: true")
    if mtu:
        yaml_lines.append(f"  mtu: {mtu}")
    if keepalive:
        yaml_lines.append(f"  persistent-keepalive: {keepalive}")
    if allowed_ips:
        items = [x.strip() for x in allowed_ips.split(",") if x.strip()]
        yaml_lines.append(f"  allowed-ips: {_yaml_list(items)}")
    yaml_lines.append("  udp: true")
    if amz:
        yaml_lines.append("  amnezia-wg-option:")
        for k, v in amz.items():
            if isinstance(v, bool):
                yaml_lines.append(f"    {k}: {'true' if v else 'false'}")
            else:
                _append_yaml_scalar(k, v, indent=4, allow_empty=True)

    yaml = "\n".join(yaml_lines) + "\n"
    return ProxyParseResult(name=name, yaml=yaml)


def _strip_config_inline_comment(value: str) -> str:
    raw = str(value or "")
    quote = ""
    out: List[str] = []
    for idx, ch in enumerate(raw):
        if quote:
            out.append(ch)
            if ch == quote:
                quote = ""
            continue
        if ch in {"'", '"'}:
            quote = ch
            out.append(ch)
            continue
        if ch in {"#", ";"} and (idx == 0 or raw[idx - 1].isspace()):
            break
        out.append(ch)
    return "".join(out).strip()


def _clean_multiline_block(value: str) -> str:
    lines = str(value or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(line.rstrip() for line in lines)


def _yaml_append_block(lines: List[str], key: str, value: str) -> None:
    block = _clean_multiline_block(value)
    if not block:
        return
    lines.append(f"  {key}: |")
    for line in block.splitlines():
        lines.append(f"    {line}")


def _parse_bool_scalar(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on", "enable", "enabled"}:
        return True
    if text in {"0", "false", "no", "off", "disable", "disabled"}:
        return False
    return None


def _openvpn_parts(line: str) -> List[str]:
    text = _strip_config_inline_comment(line)
    if not text:
        return []
    try:
        return shlex.split(text, comments=False, posix=True)
    except ValueError:
        return text.split()


def _normalize_openvpn_proto(value: str) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return "udp"
    if raw.startswith("udp"):
        return "udp"
    if raw.startswith("tcp"):
        return "tcp"
    raise ValueError(f"unsupported OpenVPN proto '{value}': Mihomo supports udp/tcp")


def _normalize_openvpn_dev(value: str) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return "tun"
    if raw.startswith("tun"):
        return "tun"
    raise ValueError(f"unsupported OpenVPN dev '{value}': Mihomo supports tun only")


def _normalize_openvpn_cipher(value: str) -> str:
    supported = {"AES-128-GCM", "AES-256-GCM"}
    raw = str(value or "").strip()
    if not raw:
        return "AES-128-GCM"
    for part in re.split(r"[:,\s]+", raw):
        candidate = part.strip().upper()
        if candidate in supported:
            return candidate
    raise ValueError("unsupported OpenVPN cipher: Mihomo supports AES-128-GCM / AES-256-GCM")


def _normalize_openvpn_auth(value: str) -> str:
    raw = str(value or "").strip().upper()
    if not raw:
        return "SHA256"
    if raw == "SHA256":
        return raw
    raise ValueError(f"unsupported OpenVPN auth '{value}': Mihomo supports SHA256 only")


def _parse_openvpn_inline_blocks(conf_text: str) -> Tuple[Dict[str, List[List[str]]], Dict[str, str]]:
    scalars: Dict[str, List[List[str]]] = {}
    blocks: Dict[str, str] = {}
    block_name = ""
    block_lines: List[str] = []
    supported_blocks = {"ca", "cert", "key", "tls-crypt", "auth-user-pass"}

    for line_no, raw_line in enumerate(str(conf_text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"), 1):
        stripped = raw_line.strip()
        if block_name:
            if stripped.lower() == f"</{block_name}>":
                blocks[block_name] = _clean_multiline_block("\n".join(block_lines))
                block_name = ""
                block_lines = []
                continue
            block_lines.append(raw_line.rstrip("\n"))
            continue

        if not stripped or stripped.startswith("#") or stripped.startswith(";"):
            continue

        block_start = re.fullmatch(r"<([A-Za-z0-9_-]+)>", stripped)
        if block_start:
            name = block_start.group(1).lower()
            if name not in supported_blocks:
                raise ValueError(f"unsupported OpenVPN inline block <{name}> at line {line_no}")
            if name in blocks:
                raise ValueError(f"duplicate OpenVPN inline block <{name}>")
            block_name = name
            block_lines = []
            continue

        if re.fullmatch(r"</[A-Za-z0-9_-]+>", stripped):
            raise ValueError(f"unexpected OpenVPN inline block close at line {line_no}")

        parts = _openvpn_parts(raw_line)
        if not parts:
            continue
        key = parts[0].strip().lower()
        if key:
            scalars.setdefault(key, []).append(parts[1:])

    if block_name:
        raise ValueError(f"unterminated OpenVPN inline block <{block_name}>")

    return scalars, blocks


def _openvpn_first(scalars: Dict[str, List[List[str]]], key: str) -> List[str]:
    values = scalars.get(key.lower()) or []
    return values[0] if values else []


def _openvpn_first_text(scalars: Dict[str, List[List[str]]], key: str) -> str:
    parts = _openvpn_first(scalars, key)
    return " ".join(parts).strip()


def _openvpn_auth_user_pass(
    scalars: Dict[str, List[List[str]]], blocks: Dict[str, str]
) -> Tuple[str, str]:
    block = blocks.get("auth-user-pass") or ""
    if block.strip():
        values = [
            _strip_config_inline_comment(line).strip()
            for line in block.splitlines()
            if _strip_config_inline_comment(line).strip()
        ]
        if values:
            return values[0], values[1] if len(values) > 1 else ""

    username = _openvpn_first_text(scalars, "username")
    password = _openvpn_first_text(scalars, "password")
    if username:
        return username, password

    parts = _openvpn_first(scalars, "auth-user-pass")
    if len(parts) >= 2:
        return parts[0], parts[1]
    if len(parts) == 1 and ":" in parts[0]:
        user, pwd = parts[0].split(":", 1)
        return user, pwd
    return "", ""


def parse_openvpn(conf_text: str, custom_name: Optional[str] = None) -> ProxyParseResult:
    """Parse an OpenVPN .ovpn client config into a Mihomo openvpn proxy block."""
    scalars, blocks = _parse_openvpn_inline_blocks(conf_text)

    remote = _openvpn_first(scalars, "remote")
    if len(remote) < 2:
        raise ValueError("Invalid OpenVPN config: missing `remote <host> <port>`")

    server = str(remote[0]).strip()
    try:
        port = int(str(remote[1]).strip())
    except Exception as exc:
        raise ValueError("Invalid OpenVPN config: remote port must be a number") from exc
    if not server or port < 1 or port > 65535:
        raise ValueError("Invalid OpenVPN config: invalid remote host/port")

    remote_proto = str(remote[2]).strip() if len(remote) >= 3 else ""
    proto = _normalize_openvpn_proto(_openvpn_first_text(scalars, "proto") or remote_proto)
    dev = _normalize_openvpn_dev(_openvpn_first_text(scalars, "dev"))
    cipher = _normalize_openvpn_cipher(
        _openvpn_first_text(scalars, "cipher")
        or _openvpn_first_text(scalars, "data-ciphers")
        or _openvpn_first_text(scalars, "ncp-ciphers")
    )
    auth = _normalize_openvpn_auth(_openvpn_first_text(scalars, "auth"))

    ca = blocks.get("ca") or ""
    cert = blocks.get("cert") or ""
    key = blocks.get("key") or ""
    tls_crypt = blocks.get("tls-crypt") or ""
    username, password = _openvpn_auth_user_pass(scalars, blocks)

    if not ca.strip():
        raise ValueError("Invalid OpenVPN config: missing inline <ca> block")
    if not tls_crypt.strip():
        raise ValueError("Invalid OpenVPN config: missing inline <tls-crypt> block")
    if not ((cert.strip() and key.strip()) or username.strip()):
        raise ValueError("Invalid OpenVPN config: requires inline <cert>/<key> or auth-user-pass username")

    mtu_text = _openvpn_first_text(scalars, "mtu") or _openvpn_first_text(scalars, "tun-mtu")
    mtu: Optional[int] = None
    if mtu_text:
        try:
            mtu = int(str(mtu_text).split()[0])
        except Exception:
            mtu = None

    dns_items: List[str] = []
    for args in scalars.get("dhcp-option") or []:
        if len(args) >= 2 and str(args[0]).strip().upper() == "DNS":
            dns = str(args[1]).strip()
            if dns:
                dns_items.append(dns)

    name = custom_name or server

    yaml_lines: List[str] = []
    yaml_lines.append(f"- name: {_yaml_str(name)}")
    yaml_lines.append("  type: openvpn")
    yaml_lines.append(f"  server: {_yaml_str(server)}")
    yaml_lines.append(f"  port: {port}")
    yaml_lines.append(f"  proto: {_yaml_str(proto)}")
    yaml_lines.append(f"  dev: {_yaml_str(dev)}")
    yaml_lines.append(f"  cipher: {_yaml_str(cipher)}")
    yaml_lines.append(f"  auth: {_yaml_str(auth)}")
    if username:
        yaml_lines.append(f"  username: {_yaml_str(username)}")
    if password:
        yaml_lines.append(f"  password: {_yaml_str(password)}")
    _yaml_append_block(yaml_lines, "ca", ca)
    if cert:
        _yaml_append_block(yaml_lines, "cert", cert)
    if key:
        _yaml_append_block(yaml_lines, "key", key)
    _yaml_append_block(yaml_lines, "tls-crypt", tls_crypt)
    if mtu:
        yaml_lines.append(f"  mtu: {mtu}")
    yaml_lines.append("  udp: true")
    if dns_items:
        yaml_lines.append("  remote-dns-resolve: true")
        yaml_lines.append(f"  dns: {_yaml_list(dns_items)}")

    return ProxyParseResult(name=name, yaml="\n".join(yaml_lines) + "\n")


def _tailscale_normalize_key(key: str) -> str:
    raw = str(key or "").strip().lower().replace("_", "-")
    raw = re.sub(r"[^a-z0-9-]", "", raw)
    aliases = {
        "tag": "name",
        "host": "hostname",
        "authkey": "auth-key",
        "controlurl": "control-url",
        "statedir": "state-dir",
        "acceptroutes": "accept-routes",
        "exitnode": "exit-node",
        "exitnodeallowlanaccess": "exit-node-allow-lan-access",
        "interface": "interface-name",
        "interfacename": "interface-name",
        "routingmark": "routing-mark",
        "ipversion": "ip-version",
    }
    compact = raw.replace("-", "")
    return aliases.get(raw) or aliases.get(compact) or raw


def _strip_optional_quotes(value: str) -> str:
    raw = str(value or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {"'", '"'}:
        return raw[1:-1]
    return raw


def _parse_tailscale_kv_lines(text: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for raw_line in str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = _strip_config_inline_comment(raw_line).strip()
        if not line:
            continue
        if line.startswith("- "):
            line = line[2:].strip()
        match = re.match(r"^([A-Za-z0-9_.-]+)\s*[:=]\s*(.*?)\s*$", line)
        if not match:
            continue
        key = _tailscale_normalize_key(match.group(1))
        value = _strip_optional_quotes(match.group(2))
        if key == "type":
            continue
        out[key] = value
    return out


def parse_tailscale(config_text: str, custom_name: Optional[str] = None) -> ProxyParseResult:
    """Parse Tailscale outbound settings into a Mihomo tailscale proxy block."""
    text = str(config_text or "").strip()
    fields: Dict[str, Any] = {}

    if text.lower().startswith("tailscale://"):
        parsed = urlparse(text)
        qs = parse_qs(parsed.query, keep_blank_values=True)
        for key, values in qs.items():
            norm = _tailscale_normalize_key(key)
            if norm == "type":
                continue
            fields[norm] = unquote(values[0] if values else "")
        if parsed.hostname and "hostname" not in fields:
            fields["hostname"] = unquote(parsed.hostname)
        if parsed.fragment and "name" not in fields:
            fields["name"] = unquote(parsed.fragment)
    else:
        fields.update(_parse_tailscale_kv_lines(text))
        if not fields and text.startswith("tskey-"):
            fields["auth-key"] = text

    boolean_keys = {"ephemeral", "udp", "accept-routes", "exit-node-allow-lan-access"}
    for key in list(fields.keys()):
        if key in boolean_keys:
            parsed_bool = _parse_bool_scalar(fields.get(key))
            if parsed_bool is not None:
                fields[key] = parsed_bool

    if "routing-mark" in fields:
        try:
            fields["routing-mark"] = int(str(fields["routing-mark"]).strip())
        except Exception:
            fields.pop("routing-mark", None)

    name = custom_name or str(fields.pop("name", "") or fields.get("hostname") or "tailscale").strip()
    if not name:
        name = "tailscale"

    if "udp" not in fields:
        fields["udp"] = True

    yaml_lines: List[str] = []
    yaml_lines.append(f"- name: {_yaml_str(name)}")
    yaml_lines.append("  type: tailscale")
    for key in (
        "hostname",
        "auth-key",
        "control-url",
        "state-dir",
        "ephemeral",
        "udp",
        "accept-routes",
        "exit-node",
        "exit-node-allow-lan-access",
        "dialer-proxy",
        "interface-name",
        "routing-mark",
        "ip-version",
    ):
        if key in fields:
            _yaml_append_key(yaml_lines, 2, key, fields.get(key))

    return ProxyParseResult(name=name, yaml="\n".join(yaml_lines) + "\n")


def _b64_decode_any(s: str) -> bytes:
    s = (s or "").strip()
    if not s:
        return b""
    s = re.sub(r"\s+", "", s)
    pad = (4 - (len(s) % 4)) % 4
    if pad:
        s += "=" * pad
    try:
        return base64.urlsafe_b64decode(s)
    except Exception:
        return base64.b64decode(s)


def _qs_first(parsed_qs: Dict[str, List[str]], key: str, default: str = "") -> str:
    v = parsed_qs.get(key)
    if not v:
        return default
    return v[0] if isinstance(v, list) else str(v)


def _qs_bool(parsed_qs: Dict[str, List[str]], *keys: str) -> bool:
    for k in keys:
        raw = _qs_first(parsed_qs, k, "").strip().lower()
        if raw in {"1", "true", "yes", "on"}:
            return True
    return False


def _qs_list_csv(parsed_qs: Dict[str, List[str]], key: str) -> List[str]:
    raw = _qs_first(parsed_qs, key, "")
    if not raw:
        return []
    raw = unquote(raw)
    return [x.strip() for x in raw.split(",") if x.strip()]


def parse_trojan(link: str, custom_name: Optional[str] = None) -> ProxyParseResult:
    """Parse trojan:// link into a Mihomo YAML proxy block."""
    link = link.strip()
    u = urlparse(link)
    if (u.scheme or "").lower() != "trojan":
        raise ValueError("Not a trojan link")

    name = custom_name or (unquote(u.fragment) if u.fragment else "") or (u.hostname or "trojan")
    server = u.hostname or ""
    port = int(u.port or 443)
    password = u.username or ""
    if not server or not password:
        raise ValueError("Invalid trojan link")

    qs = parse_qs(u.query, keep_blank_values=True)
    security = (_qs_first(qs, "security", "tls") or "tls").lower()
    net = (_qs_first(qs, "type", "tcp") or "tcp").lower()

    sni = unquote(_qs_first(qs, "sni", "") or _qs_first(qs, "peer", ""))
    alpn = _qs_list_csv(qs, "alpn")
    fp = unquote(_qs_first(qs, "fp", "") or "")
    allow_insecure = _qs_bool(qs, "allowInsecure", "insecure")

    yaml_lines: List[str] = []
    yaml_lines.append(f"- name: {_yaml_str(name)}")
    yaml_lines.append("  type: trojan")
    yaml_lines.append(f"  server: {_yaml_str(server)}")
    yaml_lines.append(f"  port: {port}")
    yaml_lines.append(f"  password: {_yaml_str(password)}")
    yaml_lines.append("  udp: true")

    if security in {"tls", "reality"}:
        yaml_lines.append("  tls: true")
        yaml_lines.append("  tfo: true")
        if sni:
            yaml_lines.append(f"  sni: {_yaml_str(sni)}")
        if alpn:
            yaml_lines.append(f"  alpn: {_yaml_list(alpn)}")
        yaml_lines.append(f"  client-fingerprint: {_yaml_str(fp or 'chrome')}")
        if allow_insecure:
            yaml_lines.append("  skip-cert-verify: true")
        if security == "reality":
            yaml_lines.append("  reality-opts:")
            pbk = unquote(_qs_first(qs, "pbk", ""))
            sid = unquote(_qs_first(qs, "sid", ""))
            if pbk:
                yaml_lines.append(f"    public-key: {_yaml_str(pbk)}")
            if sid:
                yaml_lines.append(f"    short-id: {_yaml_str(sid)}")
            _append_reality_pq_support_from_qs(yaml_lines, qs)

    yaml_lines.append(f"  network: {_yaml_str(net)}")
    if net == "xhttp":
        raise ValueError("xhttp transport is supported by Mihomo only for VLESS proxies")
    if net == "ws":
        path = unquote(_qs_first(qs, "path", "/") or "/")
        host = unquote(_qs_first(qs, "host", "") or "")
        yaml_lines.append("  ws-opts:")
        yaml_lines.append(f"    path: {_yaml_str(path)}")
        if host:
            yaml_lines.append("    headers:")
            yaml_lines.append(f"      Host: {_yaml_str(host)}")
    elif net == "grpc":
        service_name = unquote(_qs_first(qs, "serviceName", "") or _qs_first(qs, "service_name", ""))
        if service_name:
            yaml_lines.append("  grpc-opts:")
            yaml_lines.append(f"    grpc-service-name: {_yaml_str(service_name)}")
    elif net == "httpupgrade":
        path = unquote(_qs_first(qs, "path", "/") or "/")
        host = unquote(_qs_first(qs, "host", "") or "")
        yaml_lines.append("  http-upgrade-opts:")
        yaml_lines.append(f"    path: {_yaml_str(path)}")
        if host:
            yaml_lines.append("    headers:")
            yaml_lines.append(f"      Host: {_yaml_str(host)}")

    return ProxyParseResult(name=name, yaml="\n".join(yaml_lines) + "\n")


def parse_vmess(link: str, custom_name: Optional[str] = None) -> ProxyParseResult:
    """Parse vmess:// (base64 JSON) into a Mihomo YAML proxy block."""
    link = link.strip()
    if not link.lower().startswith("vmess://"):
        raise ValueError("Not a vmess link")

    payload = link.split("vmess://", 1)[1].strip()
    raw = _b64_decode_any(payload)
    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception as e:
        raise ValueError("Invalid vmess payload") from e

    name = custom_name or str(data.get("ps") or "") or "vmess"
    server = str(data.get("add") or data.get("host") or "")
    port = int(str(data.get("port") or 443))
    uuid = str(data.get("id") or "")
    alter_id = int(str(data.get("aid") or 0))
    cipher = str(data.get("scy") or "auto")

    if not server or not uuid:
        raise ValueError("Invalid vmess link")

    net = str(data.get("net") or "tcp").lower()
    tls_mode = str(data.get("tls") or "").lower()
    security = "tls" if tls_mode == "tls" else ("reality" if tls_mode == "reality" else "")

    sni = str(data.get("sni") or data.get("servername") or data.get("peer") or "")
    fp = str(data.get("fp") or "")
    alpn = [x.strip() for x in str(data.get("alpn") or "").split(",") if x.strip()]
    allow_insecure = str(data.get("allowInsecure") or data.get("insecure") or "").strip() in {
        "1",
        "true",
        "yes",
        "on",
    }

    yaml_lines: List[str] = []
    yaml_lines.append(f"- name: {_yaml_str(name)}")
    yaml_lines.append("  type: vmess")
    yaml_lines.append(f"  server: {_yaml_str(server)}")
    yaml_lines.append(f"  port: {port}")
    yaml_lines.append("  udp: true")
    yaml_lines.append(f"  uuid: {_yaml_str(uuid)}")
    yaml_lines.append(f"  alterId: {alter_id}")
    yaml_lines.append(f"  cipher: {_yaml_str(cipher)}")

    if security in {"tls", "reality"}:
        yaml_lines.append("  tls: true")
        yaml_lines.append("  tfo: true")
        if sni:
            yaml_lines.append(f"  servername: {_yaml_str(sni)}")
        if alpn:
            yaml_lines.append(f"  alpn: {_yaml_list(alpn)}")
        yaml_lines.append(f"  client-fingerprint: {_yaml_str(fp or 'chrome')}")
        if allow_insecure:
            yaml_lines.append("  skip-cert-verify: true")
        if security == "reality":
            yaml_lines.append("  reality-opts:")
            pbk = str(data.get("pbk") or "")
            sid = str(data.get("sid") or "")
            if pbk:
                yaml_lines.append(f"    public-key: {_yaml_str(pbk)}")
            if sid:
                yaml_lines.append(f"    short-id: {_yaml_str(sid)}")
            _append_reality_pq_support_from_mapping(yaml_lines, data)

    yaml_lines.append(f"  network: {_yaml_str(net)}")
    if net == "xhttp":
        raise ValueError("xhttp transport is supported by Mihomo only for VLESS proxies")
    if net == "ws":
        path = str(data.get("path") or "/")
        host = str(data.get("host") or "")
        yaml_lines.append("  ws-opts:")
        yaml_lines.append(f"    path: {_yaml_str(path)}")
        if host:
            yaml_lines.append("    headers:")
            yaml_lines.append(f"      Host: {_yaml_str(host)}")
    elif net == "grpc":
        service_name = str(data.get("path") or data.get("serviceName") or "")
        if service_name:
            yaml_lines.append("  grpc-opts:")
            yaml_lines.append(f"    grpc-service-name: {_yaml_str(service_name)}")
    elif net == "httpupgrade":
        path = str(data.get("path") or "/")
        host = str(data.get("host") or "")
        yaml_lines.append("  http-upgrade-opts:")
        yaml_lines.append(f"    path: {_yaml_str(path)}")
        if host:
            yaml_lines.append("    headers:")
            yaml_lines.append(f"      Host: {_yaml_str(host)}")

    return ProxyParseResult(name=name, yaml="\n".join(yaml_lines) + "\n")


def parse_shadowsocks(link: str, custom_name: Optional[str] = None) -> ProxyParseResult:
    """Parse ss:// link into a Mihomo YAML proxy block."""
    link = link.strip()
    if not link.lower().startswith("ss://"):
        raise ValueError("Not a shadowsocks link")

    raw = link.split("ss://", 1)[1]
    frag = ""
    if "#" in raw:
        raw, frag = raw.split("#", 1)
    name = custom_name or (unquote(frag) if frag else "")

    if "?" in raw:
        raw, _q = raw.split("?", 1)

    raw = raw.strip()
    method = password = host = ""
    port = 0

    if "@" in raw:
        left, right = raw.split("@", 1)
        if ":" in left:
            method, password = left.split(":", 1)
        else:
            decoded = _b64_decode_any(left).decode("utf-8", errors="replace")
            if ":" in decoded:
                method, password = decoded.split(":", 1)
        if ":" not in right:
            raise ValueError("Invalid ss link")
        host, port_s = right.rsplit(":", 1)
        port = int(port_s)
    else:
        decoded = _b64_decode_any(raw).decode("utf-8", errors="replace")
        if "@" in decoded:
            creds, hp = decoded.split("@", 1)
            if ":" in creds:
                method, password = creds.split(":", 1)
            if ":" in hp:
                host, port_s = hp.rsplit(":", 1)
                port = int(port_s)

    method = method.strip()
    password = password.strip()
    host = host.strip()
    if not (method and password and host and port):
        raise ValueError("Invalid ss link")

    if not name:
        name = host

    yaml_lines: List[str] = []
    yaml_lines.append(f"- name: {_yaml_str(name)}")
    yaml_lines.append("  type: ss")
    yaml_lines.append(f"  server: {_yaml_str(host)}")
    yaml_lines.append(f"  port: {port}")
    yaml_lines.append(f"  cipher: {_yaml_str(method)}")
    yaml_lines.append(f"  password: {_yaml_str(password)}")
    yaml_lines.append("  udp: true")
    return ProxyParseResult(name=name, yaml="\n".join(yaml_lines) + "\n")


def parse_hysteria2(link: str, custom_name: Optional[str] = None) -> ProxyParseResult:
    """Parse Hysteria2 link into a Mihomo YAML proxy block."""
    link = link.strip()
    u = urlparse(link)
    scheme = (u.scheme or "").lower()
    if scheme not in {"hysteria2", "hy2", "hysteria"}:
        raise ValueError("Not a hysteria2 link")

    name = custom_name or (unquote(u.fragment) if u.fragment else "") or (u.hostname or "hysteria2")
    server = u.hostname or ""
    port = int(u.port or 443)

    user = unquote(u.username or "")
    pwd = unquote(u.password or "")
    password = f"{user}:{pwd}" if (user and pwd) else user
    if not server or not password:
        raise ValueError("Invalid hysteria2 link")

    qs = parse_qs(u.query, keep_blank_values=True)
    sni = unquote(_qs_first(qs, "sni", "") or _qs_first(qs, "peer", "") or "")
    allow_insecure = _qs_bool(qs, "allowInsecure", "insecure")

    up = unquote(_qs_first(qs, "up", "") or "")
    down = unquote(_qs_first(qs, "down", "") or "")
    obfs = unquote(_qs_first(qs, "obfs", "") or "")
    obfs_password = unquote(
        _qs_first(qs, "obfs-password", "")
        or _qs_first(qs, "obfs_password", "")
        or _qs_first(qs, "obfsPassword", "")
        or ""
    )
    alpn = _qs_list_csv(qs, "alpn")
    if not alpn:
        alpn = ["h3"]

    yaml_lines: List[str] = []
    yaml_lines.append(f"- name: {_yaml_str(name)}")
    yaml_lines.append("  type: hysteria2")
    yaml_lines.append(f"  server: {_yaml_str(server)}")
    yaml_lines.append(f"  port: {port}")
    yaml_lines.append(f"  password: {_yaml_str(password)}")
    yaml_lines.append("  udp: true")
    yaml_lines.append("  fast-open: true")

    if alpn:
        yaml_lines.append("  alpn:")
        for a in alpn:
            yaml_lines.append(f"    - {_yaml_str(a)}")

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

    return ProxyParseResult(name=name, yaml="\n".join(yaml_lines) + "\n")


def parse_proxy_uri(link: str, custom_name: Optional[str] = None) -> ProxyParseResult:
    """Auto-detect proxy URI scheme and parse it into Mihomo YAML."""
    s = (link or "").strip()
    if not s:
        raise ValueError("Empty proxy link")
    low = s.lower()
    if low.startswith("vless://"):
        return parse_vless(s, custom_name=custom_name)
    if low.startswith("trojan://"):
        return parse_trojan(s, custom_name=custom_name)
    if low.startswith("vmess://"):
        return parse_vmess(s, custom_name=custom_name)
    if low.startswith("ss://"):
        return parse_shadowsocks(s, custom_name=custom_name)
    if low.startswith("hysteria2://") or low.startswith("hy2://") or low.startswith("hysteria://"):
        return parse_hysteria2(s, custom_name=custom_name)
    if low.startswith("tailscale://"):
        return parse_tailscale(s, custom_name=custom_name)
    raise ValueError("Unsupported proxy scheme")


def _split_endpoint(endpoint: str) -> Tuple[str, int]:
    """Split WG endpoint into (host, port) handling IPv6 in [addr]:port form."""
    endpoint = endpoint.strip()
    if endpoint.startswith("["):
        host, rest = endpoint[1:].split("]", 1)
        port = int(rest.strip(":"))
        return host, port
    if ":" in endpoint:
        host, port_s = endpoint.rsplit(":", 1)
        return host, int(port_s)
    raise ValueError("Invalid endpoint format")


__all__ = [
    "_yaml_str",
    "_yaml_list",
    "ProxyParseResult",
    "parse_vless",
    "parse_wireguard",
    "parse_openvpn",
    "parse_tailscale",
    "parse_trojan",
    "parse_vmess",
    "parse_shadowsocks",
    "parse_hysteria2",
    "parse_proxy_uri",
]
