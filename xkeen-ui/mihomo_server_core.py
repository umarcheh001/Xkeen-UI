# Частично основано на коде из проекта "Mihomo Studio"
# Copyright (c) 2024 l-ptrol
# Исходный репозиторий: https://github.com/l-ptrol/mihomo_studio
# Лицензия: MIT

"""
High-level Mihomo server-side core for XKeen UI.

Contains:
  1. Parsers for VLESS links and WireGuard configs (to Mihomo YAML proxies).
  2. Helpers to modify proxies and proxy-groups inside an existing config.yaml.
  3. Profile and backup management (profiles/, backup/ layout).
  4. Saving config with automatic backup and restarting mihomo (xkeen -restart).

All low-level I/O paths are configurable via environment variables,
so the same module can be reused both on router and in development.
"""

from __future__ import annotations

import re
import base64
import json
from dataclasses import dataclass
from typing import Iterable, List, Dict, Tuple, Optional
from urllib.parse import unquote, urlparse, parse_qs

from services.mihomo_runtime import (
    MIHOMO_ROOT,
    CONFIG_PATH,
    PROFILES_DIR,
    BACKUP_DIR,
    ProfileInfo,
    BackupInfo,
    ensure_mihomo_layout,
    get_active_profile_name,
    list_profiles,
    get_profile_content,
    create_profile,
    delete_profile,
    switch_active_profile,
    list_backups,
    create_backup_for_active_profile,
    delete_backup,
    read_backup,
    restore_backup,
    clean_backups,
    save_config,
    restart_mihomo_and_get_log,
    validate_config,
)


# === YAML safety helpers (avoid broken YAML / injection via plain scalars) ===
# We build YAML by concatenating strings (router-friendly, no PyYAML dependency),
# so we must quote/escape values that can break YAML syntax.
_YAML_KEYWORDS = {"null", "~", "true", "false", "yes", "no", "on", "off"}
_YAML_NEEDS_QUOTING_RE = re.compile(r"""[\s:#\[\]{}&,*>!%`"'|@?]""")


def _yaml_str(v) -> str:
    """Return a YAML-safe scalar for arbitrary values.

    - Replaces newlines (prevents multiline injection)
    - Quotes when YAML-plain would be ambiguous/broken
    Uses single quotes; inside them YAML escapes by doubling: ' -> ''
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
        or s[:1] in "-?:&*"  # YAML indicators at start
    ):
        return "'" + s.replace("'", "''") + "'"
    return s


def _yaml_list(items) -> str:
    """YAML flow-style list with safe string scalars."""
    return "[" + ", ".join(_yaml_str(x) for x in items) + "]"


# === Utility dataclasses ===

@dataclass
class ProxyParseResult:
    name: str
    yaml: str

# === 1. PARSERS: proxy links (VLESS/Trojan/VMess/SS/Hysteria2) and WireGuard ===

VLESS_RE = re.compile(r'^vless://(?P<id>[^@]+)@(?P<server>[^:]+):(?P<port>\d+).*$', re.IGNORECASE)


def parse_vless(link: str, custom_name: Optional[str] = None) -> ProxyParseResult:
    """Parse a VLESS URL and return ProxyParseResult with Mihomo YAML block.

    This is a distilled and slightly hardened port of the logic from mihomo_editor.py.
    Only the most relevant options are supported here; everything else is passed through
    as-is when possible.
    """
    link = link.strip()

    # --- имя из #комментария ---
    comment_name = ''
    hash_pos = link.find('#')
    if hash_pos != -1:
        fragment = link[hash_pos + 1 :]
        try:
            comment_name = unquote(fragment)
        except Exception:
            # если что-то не так с %-кодировкой — просто берём сырую строку
            comment_name = fragment

    m = VLESS_RE.match(link)
    if not m:
        raise ValueError('Not a valid VLESS link')

    server = m.group('server')
    port = int(m.group('port'))
    user_part = m.group('id')

    # uuid and optional flow are separated by ':'
    if ':' in user_part:
        uuid, flow = user_part.split(':', 1)
    else:
        uuid, flow = user_part, ''

    # Небольшой helper, чтобы безопасно раскодировать URL-параметры
    def _safe_unquote(v: str) -> str:
        try:
            return unquote(v)
        except Exception:
            return v

    # Query string: we only care about a limited set of keys used in mihomo_editor.
    qs: Dict[str, str] = {}
    if '?' in link:
        q = link.split('?', 1)[1]
        # отрезаем #comment, чтобы он не мешал query
        if '#' in q:
            q = q.split('#', 1)[0]
        for part in q.split('&'):
            if not part or '=' not in part:
                continue
            k, v = part.split('=', 1)
            qs[k] = v

    # If flow was not provided as part of user_part (uuid:flow), try to read it from query (?flow=...)
    if not flow:
        flow_q = qs.get('flow')
        if flow_q:
            try:
                flow = unquote(flow_q)
            except Exception:
                # If anything goes wrong with decoding, keep the raw value
                flow = flow_q

    # --- имя: UI > remarks > #comment > server ---
    name = (
        custom_name
        or qs.get('remarks')
        or qs.get('remark')
        or comment_name.strip()
        or server
    )

    # Основные параметры из query
    security = qs.get('security', '')
    sni = qs.get('sni') or qs.get('host') or ''
    fp = qs.get('fp') or ''
    alpn = qs.get('alpn') or ''
    type_ = (qs.get('type', 'tcp') or 'tcp').lower()
    encryption = qs.get('encryption') or ''
    # allowInsecure/insecure → skip-cert-verify
    allow_insecure_raw = (qs.get('allowInsecure') or qs.get('insecure') or '').strip().lower()
    allow_insecure = allow_insecure_raw in {'1', 'true', 'yes', 'on'}

    # spx используется только для Reality
    spx = qs.get('spx') or ''

    # Нормально раскодируем потенциально URL-кодированные поля
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
    yaml_lines.append('  type: vless')
    yaml_lines.append(f"  server: {_yaml_str(server)}")
    yaml_lines.append(f"  port: {port}")
    yaml_lines.append(f"  uuid: {_yaml_str(uuid)}")
    
    if flow:
        yaml_lines.append(f"  flow: {_yaml_str(flow)}")
    
    # --- encryption ---
    enc = (encryption or "").strip()
    if not enc or enc.lower() == "none":
        yaml_lines.append('  encryption: ""')
    else:
        yaml_lines.append(f"  encryption: {_yaml_str(enc)}")
    
    yaml_lines.append(f"  network: {_yaml_str(type_)}")
    yaml_lines.append("  udp: true")
    # Для VLESS почти всегда нужен xudp (как в официальных примерах mihomo)
    # https://wiki.metacubex.one/en/config/proxies/vless/
    yaml_lines.append("  packet-encoding: xudp")
    
    # TLS / Reality
    sec = security.lower()
    if sec == "reality":
        yaml_lines.append("  tls: true")
        yaml_lines.append("  tfo: true")
        if sni:
            yaml_lines.append(f"  servername: {_yaml_str(sni)}")
        if alpn:
            alpn_items = [x.strip() for x in alpn.split(',') if x.strip()]
            if alpn_items:
                yaml_lines.append(f"  alpn: {_yaml_list(alpn_items)}")
        if allow_insecure:
            yaml_lines.append("  skip-cert-verify: true")
        yaml_lines.append("  reality-opts:")
        if 'pbk' in qs:
            yaml_lines.append(f"    public-key: {_yaml_str(qs['pbk'])}")
        if 'sid' in qs:
            yaml_lines.append(f"    short-id: {_yaml_str(qs['sid'])}")
        # mihomo поддерживает пост-квантовый ключевой обмен для REALITY
        # (опция безопасно игнорируется более старыми версиями)
        yaml_lines.append("    support-x25519mlkem768: true")
        # --- новое: spx → spider-x ---
        if spx:
            yaml_lines.append(f"    spider-x: {_yaml_str(spx)}")
        # fp (client-fingerprint) иногда обязателен для корректного TLS handshaking
        # В генераторе по умолчанию используется chrome
        yaml_lines.append(f"  client-fingerprint: {_yaml_str(fp or 'chrome')}")
    elif sec == "tls":
        yaml_lines.append("  tls: true")
        yaml_lines.append("  tfo: true")
        if sni:
            yaml_lines.append(f"  servername: {_yaml_str(sni)}")
        yaml_lines.append(f"  client-fingerprint: {_yaml_str(fp or 'chrome')}")
        if alpn:
            # alpn может быть 'h2,http/1.1' → получится alpn: [h2,http/1.1]
            alpn_items = [x.strip() for x in alpn.split(',') if x.strip()]
            yaml_lines.append(f"  alpn: {_yaml_list(alpn_items)}")
        if allow_insecure:
            yaml_lines.append("  skip-cert-verify: true")

    # ws / grpc / httpupgrade opts
    if type_ == 'xhttp':
        # xhttp на стороне mihomo напрямую по ссылке не поддерживаем
        raise ValueError('xhttp transport is not supported for mihomo proxies')

    if type_ == 'ws':
        path = qs.get('path', '/')
        if path:
            path = _safe_unquote(path)
        host = qs.get('host') or sni or ''
        yaml_lines.append('  ws-opts:')
        yaml_lines.append(f"    path: {_yaml_str(path)}")
        if host:
            yaml_lines.append('    headers:')
            yaml_lines.append(f"      Host: {_yaml_str(host)}")
    elif type_ == 'grpc':
        service_name = qs.get('serviceName') or qs.get('service_name') or ''
        if service_name:
            service_name = _safe_unquote(service_name)
        yaml_lines.append('  grpc-opts:')
        if service_name:
            yaml_lines.append(f"    grpc-service-name: {_yaml_str(service_name)}")

    elif type_ == 'httpupgrade':
        path = qs.get('path', '/')
        if path:
            path = _safe_unquote(path)
        host = qs.get('host') or sni or ''
        yaml_lines.append('  http-upgrade-opts:')
        yaml_lines.append(f"    path: {_yaml_str(path)}")
        if host:
            yaml_lines.append('    headers:')
            yaml_lines.append(f"      Host: {_yaml_str(host)}")

    yaml = "\n".join(yaml_lines) + "\n"
    return ProxyParseResult(name=name, yaml=yaml)

def parse_wireguard(conf_text: str, custom_name: Optional[str] = None) -> ProxyParseResult:
    """Parse WireGuard .conf and return ProxyParseResult with Mihomo YAML proxy.

    Supports basic WG options and AmneziaWG extension fields used in mihomo_editor.py.
    """
    lines = [l.strip() for l in conf_text.splitlines() if l.strip()]
    section = None
    iface: Dict[str, str] = {}
    peer: Dict[str, str] = {}

    for line in lines:
        if line.startswith('[') and line.endswith(']'):
            section = line.strip('[]').lower()
            continue
        if '=' not in line or not section:
            continue
        k, v = [x.strip() for x in line.split('=', 1)]
        if section == 'interface':
            iface[k] = v
        elif section == 'peer':
            peer[k] = v

    if 'PrivateKey' not in iface or 'PublicKey' not in peer or 'Endpoint' not in peer:
        raise ValueError('Invalid WireGuard config: missing mandatory keys')

    endpoint = peer['Endpoint']
    host, port = _split_endpoint(endpoint)

    name = custom_name or peer.get('Name') or host

    address = iface.get('Address', '')
    ip_v4 = ''
    ip_v6 = ''
    if address:
        parts = [p.strip() for p in address.split(',')]
        for p in parts:
            if ':' in p:
                ip_v6 = p
            else:
                ip_v4 = p

    dns = iface.get('DNS', '')
    dns_list = [d.strip() for d in dns.split(',') if d.strip()] if dns else []

    mtu = iface.get('MTU')
    allowed_ips = peer.get('AllowedIPs', '0.0.0.0/0, ::/0')
    keepalive = peer.get('PersistentKeepalive', '')

    # AmneziaWG extended options (if present)
    amz: Dict[str, str] = {}
    for key in ('jc', 'jmin', 'jmax', 's1', 's2', 'h1', 'h2', 'h3', 'h4'):
        if key in peer:
            amz[key] = peer[key]

    yaml_lines: List[str] = []
    yaml_lines.append(f"- name: {_yaml_str(name)}")
    yaml_lines.append("  type: wireguard")
    yaml_lines.append(f"  server: {_yaml_str(host)}")
    yaml_lines.append(f"  port: {port}")
    yaml_lines.append(f"  ip: {_yaml_str(ip_v4)}") if ip_v4 else None
    if ip_v6:
        yaml_lines.append(f"  ipv6: {_yaml_str(ip_v6)}")
    yaml_lines.append(f"  private-key: {_yaml_str(iface['PrivateKey'])}")
    yaml_lines.append(f"  public-key: {_yaml_str(peer['PublicKey'])}")

    if 'PresharedKey' in peer:
        yaml_lines.append(f"  preshared-key: {_yaml_str(peer['PresharedKey'])}")

    if dns_list:
        yaml_lines.append(f"  dns: {_yaml_list(dns_list)}")

    if mtu:
        yaml_lines.append(f"  mtu: {mtu}")

    if keepalive:
        yaml_lines.append(f"  persistent-keepalive: {keepalive}")

    if allowed_ips:
        items = [x.strip() for x in allowed_ips.split(',') if x.strip()]
        yaml_lines.append(f"  allowed-ips: {_yaml_list(items)}")

    if amz:
        yaml_lines.append("  amnezia-wg-option:")
        for k, v in amz.items():
            yaml_lines.append(f"    {k}: {v}" if str(v).isdigit() else f"    {k}: {_yaml_str(v)}")

    yaml = "\n".join(yaml_lines) + "\n"
    return ProxyParseResult(name=name, yaml=yaml)


# === 1b. PARSERS: Trojan / VMess / Shadowsocks / Hysteria2 ===

def _b64_decode_any(s: str) -> bytes:
    """Decode base64 string with missing padding and urlsafe variants."""
    s = (s or "").strip()
    if not s:
        return b""
    # Remove any whitespace
    s = re.sub(r"\s+", "", s)
    # Fix padding
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

    # TLS settings (trojan requires tls: true per mihomo docs)
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
            yaml_lines.append("    support-x25519mlkem768: true")

    # Transport
    yaml_lines.append(f"  network: {_yaml_str(net)}")
    if net == "xhttp":
        raise ValueError("xhttp transport is not supported for mihomo proxies")
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
        yaml_lines.append("  grpc-opts:")
        if service_name:
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
    allow_insecure = str(data.get("allowInsecure") or data.get("insecure") or "").strip() in {"1", "true", "yes", "on"}

    yaml_lines: List[str] = []
    yaml_lines.append(f"- name: {_yaml_str(name)}")
    yaml_lines.append("  type: vmess")
    yaml_lines.append(f"  server: {_yaml_str(server)}")
    yaml_lines.append(f"  port: {port}")
    yaml_lines.append("  udp: true")
    yaml_lines.append(f"  uuid: {_yaml_str(uuid)}")
    yaml_lines.append(f"  alterId: {alter_id}")
    yaml_lines.append(f"  cipher: {_yaml_str(cipher)}")

    # TLS / Reality
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
            yaml_lines.append("    support-x25519mlkem768: true")

    # Transport
    yaml_lines.append(f"  network: {_yaml_str(net)}")
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
        yaml_lines.append("  grpc-opts:")
        if service_name:
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

    # Strip scheme + fragment
    raw = link.split("ss://", 1)[1]
    frag = ""
    if "#" in raw:
        raw, frag = raw.split("#", 1)
    name = custom_name or (unquote(frag) if frag else "")

    # Remove query part (plugins not supported here)
    if "?" in raw:
        raw, _q = raw.split("?", 1)

    raw = raw.strip()

    # Two main formats:
    # 1) method:pass@host:port
    # 2) base64(method:pass)@host:port
    # 3) base64(method:pass@host:port)
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
        # method:pass@host:port
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
    """Parse Hysteria2 link (hysteria2:// or hy2://) into a Mihomo YAML proxy block."""
    link = link.strip()
    u = urlparse(link)
    scheme = (u.scheme or "").lower()
    if scheme not in {"hysteria2", "hy2", "hysteria"}:
        raise ValueError("Not a hysteria2 link")

    name = custom_name or (unquote(u.fragment) if u.fragment else "") or (u.hostname or "hysteria2")
    server = u.hostname or ""
    port = int(u.port or 443)

    # Hysteria2 auth in URI can be:
    #   hysteria2://<auth>@host:port
    #   hy2://username:password@host:port
    user = unquote(u.username or "")
    pwd = unquote(u.password or "")
    password = f"{user}:{pwd}" if (user and pwd) else user
    if not server or not password:
        raise ValueError("Invalid hysteria2 link")

    qs = parse_qs(u.query, keep_blank_values=True)
    sni = unquote(_qs_first(qs, "sni", "") or _qs_first(qs, "peer", "") or "")
    allow_insecure = _qs_bool(qs, "allowInsecure", "insecure")

    # Optional parameters supported by Mihomo
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
    # Most Hysteria2 configs use QUIC ALPN h3 by default.
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
            # Keep quoting for safety (values like http/1.1 or custom tokens)
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
    """Auto-detect proxy URI scheme and parse it into Mihomo YAML.

    Supported schemes:
      * vless://
      * trojan://
      * vmess://
      * ss://
      * hysteria2://
      * hy2://
    """
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
    raise ValueError("Unsupported proxy scheme")


def _split_endpoint(endpoint: str) -> Tuple[str, int]:
    """Split WG endpoint into (host, port) handling IPv6 in [addr]:port form."""
    endpoint = endpoint.strip()
    if endpoint.startswith('['):
        host, rest = endpoint[1:].split(']', 1)
        port = int(rest.strip(':'))
        return host, port
    if ':' in endpoint:
        host, port_s = endpoint.rsplit(':', 1)
        return host, int(port_s)
    raise ValueError('Invalid endpoint format')


# === 2. CONFIG MANIPULATION (proxies + proxy-groups) ===

PROXY_SECTION_RE = re.compile(r'^proxies:\s*$', re.MULTILINE)
PROXY_GROUPS_SECTION_RE = re.compile(r'^proxy-groups:\s*$', re.MULTILINE)


def insert_proxy_into_groups(content: str, proxy_name: str, target_groups: Iterable[str]) -> str:
    """Insert proxy_name into proxies: list of selected proxy-groups.

    First, reuses the original behavior: if a group already has an explicit
    `proxies:` list, the proxy name is appended there.

    Additionally, for target groups that have `include-all: true` but no
    `proxies:` list at all, this will create a minimal `proxies:` list and
    put the proxy there. This makes manual proxies visible even when the
    template relies purely on `include-all`.
    """
    groups_set = {g.strip() for g in target_groups if g.strip()}
    if not groups_set:
        return content

    def _inject_into_inline_proxies(line: str) -> str:
        """If line is an inline 'proxies: [...]' list, append proxy_name there."""
        stripped = line.lstrip()
        indent = line[: len(line) - len(stripped)]
        prefix = "proxies:"
        rest = stripped[len(prefix):].lstrip()
        # Expect exactly inline list syntax: proxies: [..]
        if not (rest.startswith("[") and rest.endswith("]")):
            return line
        inner = rest[1:-1].strip()
        items = [x.strip() for x in inner.split(",")] if inner else []

        def _norm(s: str) -> str:
            return s.strip().strip('"').strip("'")

        existing = {_norm(x) for x in items if x}
        if _norm(proxy_name) in existing:
            return line

        new_item = proxy_name
        # Quote if contains whitespace or comma and not already quoted
        if not (new_item.startswith('"') or new_item.startswith("'")):
            if re.search(r"[\s,]", new_item):
                new_item = f'"{new_item}"'

        items.append(new_item)
        new_inner = ", ".join(items)
        return f"{indent}proxies: [{new_inner}]"

    # ------------------------------------------------------------------
    # 1) First pass: original behavior — inject into existing proxies: lists.
    # ------------------------------------------------------------------
    lines = content.splitlines()
    out: List[str] = []
    in_groups = False
    current_group: Optional[str] = None
    in_proxies_list = False

    for idx, line in enumerate(lines):
        stripped = line.lstrip()
        if stripped.startswith('proxy-groups:'):
            in_groups = True
            current_group = None
            in_proxies_list = False
            out.append(line)
            continue

        if in_groups and stripped.startswith('- name:'):
            # New group starts
            current_group = stripped.split(':', 1)[1].strip().strip('"').strip("'")
            in_proxies_list = False
            out.append(line)
            continue

        if in_groups and stripped.startswith('proxies:'):
            # Inline list case: proxies: [PASS, GROUP, ...]
            if '[' in stripped and ']' in stripped and current_group in groups_set:
                out.append(_inject_into_inline_proxies(line))
                # Do not enter multiline proxies-list mode
                continue
            in_proxies_list = True
            out.append(line)
            continue

        if in_groups and in_proxies_list:
            # We are in proxies: list of some group
            # Detect end of list: next group or new top-level section.
            if stripped.startswith('- name:') or (stripped and not line.startswith(' ' * 4)):
                # list ended before this line -> maybe insert before leaving
                if current_group in groups_set:
                    # insert if not already present above
                    _inject_proxy_before_leave(out, proxy_name)
                # reset state and process line again with normal logic
                in_proxies_list = False

        # main append
        out.append(line)

        if in_groups and in_proxies_list:
            # When we see the last line of proxies for target group (heuristic):
            if idx + 1 == len(lines) or lines[idx + 1].lstrip().startswith('- name:'):
                if current_group in groups_set:
                    _inject_proxy_before_leave(out, proxy_name)
                in_proxies_list = False

    content_after_first = "\n".join(out) + "\n"

    # ------------------------------------------------------------------
    # 2) Second pass: groups with include-all: true but without proxies:
    #    create proxies: list and put the proxy there.
    # ------------------------------------------------------------------
    lines2 = content_after_first.splitlines()
    out2: List[str] = []
    in_groups = False
    current_group = None
    group_has_proxies = False
    group_has_include_all = False
    group_include_indent = ""

    def flush_group_if_needed():
        nonlocal out2, group_has_proxies, group_has_include_all, group_include_indent
        if not in_groups or not current_group:
            return
        if current_group not in groups_set:
            return
        if group_has_proxies:
            return
        if not group_has_include_all:
            return
        indent = group_include_indent or "    "
        out2.append(f"{indent}proxies:")
        out2.append(f"{indent}  - {_quote_proxy_list_item(proxy_name)}")

    for idx, line in enumerate(lines2):
        stripped = line.lstrip()
        if stripped.startswith('proxy-groups:'):
            # Leaving any previous group section
            if in_groups and current_group is not None:
                flush_group_if_needed()
            in_groups = True
            current_group = None
            group_has_proxies = False
            group_has_include_all = False
            group_include_indent = ""
            out2.append(line)
            continue

        if in_groups and stripped.startswith('- name:'):
            if current_group is not None:
                flush_group_if_needed()
            current_group = stripped.split(':', 1)[1].strip().strip('"').strip("'")
            group_has_proxies = False
            group_has_include_all = False
            group_include_indent = ""
            out2.append(line)
            continue

        if in_groups and 'include-all:' in stripped:
            group_has_include_all = True
            group_include_indent = line[: len(line) - len(stripped)]
            out2.append(line)
            continue

        if in_groups and stripped.startswith('proxies:'):
            group_has_proxies = True
            out2.append(line)
            continue

        # Detect leaving proxy-groups section
        if in_groups and stripped and not line.startswith('  ') and not stripped.startswith('proxy-groups:'):
            # leaving groups: flush last group if needed
            flush_group_if_needed()
            in_groups = False
            current_group = None
            group_has_proxies = False
            group_has_include_all = False
            group_include_indent = ""
            out2.append(line)
            continue

        out2.append(line)

    # End-of-file: flush if we ended inside groups block
    if in_groups and current_group is not None:
        flush_group_if_needed()

    return "\n".join(out2) + "\n"

def _quote_proxy_list_item(proxy_name: str) -> str:
    value = str(proxy_name or "").strip()
    if value.startswith('"') or value.startswith("'"):
        return value
    return f'"{value}"'


def _proxy_list_item_name(line: str) -> Optional[str]:
    m = re.match(r"^\s*-\s*(.+?)\s*$", str(line or ""))
    if not m:
        return None
    raw = m.group(1).strip()
    if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
        return raw[1:-1]
    if raw.startswith("'") and raw.endswith("'") and len(raw) >= 2:
        return raw[1:-1]
    return raw


def _inject_proxy_before_leave(out_lines: List[str], proxy_name: str) -> None:
    """Append '- proxy_name' to the current proxies: list if not there yet."""
    if not out_lines:
        return

    target = str(proxy_name or "").strip().strip('"').strip("'")
    if not target:
        return

    indent = '      '
    for line in reversed(out_lines):
        stripped = line.strip()
        if stripped.startswith('- name:'):
            break
        if stripped.startswith('-'):
            indent = line[: len(line) - len(line.lstrip())]
            break

    for line in reversed(out_lines):
        stripped = line.strip()
        if stripped.startswith('- name:'):
            break
        existing = _proxy_list_item_name(line)
        if existing is not None and existing.strip().strip('"').strip("'") == target:
            return

    out_lines.append(f"{indent}- {_quote_proxy_list_item(target)}")



def _strip_yaml_inline_comment(raw: str) -> str:
    text = str(raw or "")
    if not text:
        return text
    in_single = False
    in_double = False
    escaped = False
    for idx, ch in enumerate(text):
        if in_double:
            if escaped:
                escaped = False
                continue
            if ch == "\\":
                escaped = True
                continue
            if ch == '"':
                in_double = False
            continue
        if in_single:
            if ch == "'":
                in_single = False
            continue
        if ch == '"':
            in_double = True
            continue
        if ch == "'":
            in_single = True
            continue
        if ch == '#':
            return text[:idx].rstrip()
    return text.rstrip()


def _normalize_yaml_scalar(raw: str) -> str:
    text = _strip_yaml_inline_comment(str(raw or "").strip()).strip()
    if len(text) >= 2 and ((text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'"))):
        return text[1:-1]
    return text


def _quote_yaml_name(value: str) -> str:
    text = str(value or "")
    text = text.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{text}"'

def replace_proxy_in_config(content: str, proxy_name: str, new_proxy_yaml: str) -> Tuple[str, bool]:
    """Replace a proxy block inside top-level `proxies:` section.

    Args:
        content: Full Mihomo `config.yaml` text.
        proxy_name: Target proxy name to replace (matches `- name:`).
        new_proxy_yaml: YAML snippet of the new proxy, starting with `- name:`
            and containing relative indentation (e.g. `  server:`). The snippet
            is treated as *unindented* relative to the list item; the function
            will indent it to match existing `proxies:` list indentation.

    Returns:
        (new_content, changed)
    """
    if not isinstance(content, str):
        content = str(content or "")
    if not isinstance(new_proxy_yaml, str):
        new_proxy_yaml = str(new_proxy_yaml or "")

    proxy_name = (proxy_name or "").strip()
    if not proxy_name:
        out0 = content.replace("\r\n", "\n").replace("\r", "\n")
        return (out0 if out0.endswith("\n") else out0 + "\n"), False

    # Normalise newlines
    content_n = content.replace("\r\n", "\n").replace("\r", "\n")
    new_yaml_n = new_proxy_yaml.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n")

    lines = content_n.splitlines()

    # 1) Find top-level `proxies:` section
    proxies_idx = None
    for i, line in enumerate(lines):
        if line.strip() == "proxies:" and (len(line) - len(line.lstrip()) == 0):
            proxies_idx = i
            break

    if proxies_idx is None:
        return (content_n if content_n.endswith("\n") else content_n + "\n"), False

    # 2) Find end of the section (next top-level key)
    end_idx = len(lines)
    for j in range(proxies_idx + 1, len(lines)):
        l = lines[j]
        if not l.strip() or l.lstrip().startswith("#"):
            continue
        if (len(l) - len(l.lstrip()) == 0) and not l.lstrip().startswith("-"):
            end_idx = j
            break

    # 3) Detect list item indentation inside proxies section
    name_line_re = re.compile(r"^(\s*)-\s+name:\s*(.+?)\s*$")
    item_indent_str = "  "  # default
    item_indent_len = 2
    for j in range(proxies_idx + 1, end_idx):
        m = name_line_re.match(lines[j])
        if m:
            item_indent_str = m.group(1)
            item_indent_len = len(item_indent_str)
            break

    # 4) Find target proxy block boundaries
    def _clean_name(raw: str) -> str:
        return _normalize_yaml_scalar(raw)

    target_start = None
    target_end = None

    for j in range(proxies_idx + 1, end_idx):
        m = name_line_re.match(lines[j])
        if not m:
            continue
        indent = m.group(1)
        if len(indent) != item_indent_len:
            continue
        found = _clean_name(m.group(2))
        if found == proxy_name:
            target_start = j
            # next proxy block begins with another `- name:` at same indent
            for k in range(j + 1, end_idx):
                m2 = name_line_re.match(lines[k])
                if m2 and len(m2.group(1)) == item_indent_len:
                    target_end = k
                    break
            if target_end is None:
                target_end = end_idx
            break

    if target_start is None:
        return (content_n if content_n.endswith("\n") else content_n + "\n"), False

    new_lines = new_yaml_n.splitlines()
    if not new_lines or not new_lines[0].lstrip().startswith("- name:"):
        return (content_n if content_n.endswith("\n") else content_n + "\n"), False

    indented_block = [item_indent_str + ln for ln in new_lines]
    out_lines = lines[:target_start] + indented_block + lines[target_end:]

    out = "\n".join(out_lines).rstrip("\n") + "\n"
    return out, True


def replace_proxy_block(content: str, target_name: str, new_yaml_block: str) -> str:
    """Backwards-compatible wrapper (returns only text)."""
    out, _changed = replace_proxy_in_config(content, target_name, new_yaml_block)
    return out

def _rename_inline_group_proxies(line: str, old_name: str, new_name: str) -> str:
    m = re.match(r"^(\s*proxies\s*:\s*\[)(.*?)(\]\s*(#.*)?)$", str(line or ""))
    if not m:
        return line
    inner = (m.group(2) or "").strip()
    if not inner:
        return line

    items = [item.strip() for item in inner.split(",")]
    changed = False
    new_items: List[str] = []
    for item in items:
        if _normalize_yaml_scalar(item) == old_name:
            new_items.append(_quote_proxy_list_item(new_name))
            changed = True
        else:
            new_items.append(item)

    if not changed:
        return line
    return f"{m.group(1)}{', '.join(new_items)}{m.group(3)}"


def rename_proxy_in_config(content: str, old_name: str, new_name: str) -> str:
    """Rename proxy and update its usages inside `proxy-groups:` only."""
    if not isinstance(content, str):
        content = str(content or "")

    old_name = str(old_name or "").strip()
    new_name = str(new_name or "").strip()
    if not old_name or not new_name or old_name == new_name:
        return content

    content_n = content.replace("\r\n", "\n").replace("\r", "\n")
    had_trailing_nl = content_n.endswith("\n")
    lines = content_n.splitlines()

    out: List[str] = []
    in_proxies = False
    in_groups = False
    in_group_proxies_list = False
    proxies_list_indent = -1

    for line in lines:
        stripped = line.lstrip()
        indent_len = len(line) - len(stripped)

        if indent_len == 0 and stripped.startswith("proxies:"):
            in_proxies = True
            in_groups = False
            in_group_proxies_list = False
            proxies_list_indent = -1
            out.append(line)
            continue

        if indent_len == 0 and stripped.startswith("proxy-groups:"):
            in_groups = True
            in_proxies = False
            in_group_proxies_list = False
            proxies_list_indent = -1
            out.append(line)
            continue

        if indent_len == 0 and stripped and not stripped.startswith("#"):
            in_proxies = False
            in_groups = False
            in_group_proxies_list = False
            proxies_list_indent = -1

        if in_proxies:
            m_name = re.match(r"^(\s*)-\s+name:\s*(.+?)(\s*(#.*)?)$", line)
            if m_name and _normalize_yaml_scalar(m_name.group(2)) == old_name:
                comment = m_name.group(3) if m_name.group(4) else ""
                out.append(f"{m_name.group(1)}- name: {_quote_yaml_name(new_name)}{comment}")
                continue

        if in_groups:
            if in_group_proxies_list and stripped and not stripped.startswith("#") and indent_len <= proxies_list_indent:
                in_group_proxies_list = False
                proxies_list_indent = -1

            if stripped.startswith("proxies:"):
                if "[" in stripped and "]" in stripped:
                    out.append(_rename_inline_group_proxies(line, old_name, new_name))
                else:
                    in_group_proxies_list = True
                    proxies_list_indent = indent_len
                    out.append(line)
                continue

            if in_group_proxies_list:
                m_item = re.match(r"^(\s*)-\s*(.+?)\s*$", line)
                if m_item and len(m_item.group(1)) > proxies_list_indent:
                    if _normalize_yaml_scalar(m_item.group(2)) == old_name:
                        out.append(f"{m_item.group(1)}- {_quote_proxy_list_item(new_name)}")
                        continue

        out.append(line)

    out_text = "\n".join(out)
    return out_text + ("\n" if had_trailing_nl else "")

def apply_proxy_insert(
    content: str,
    proxy_yaml_block: str,
    proxy_name: str,
    target_groups: Iterable[str],
) -> str:
    """High-level helper to insert proxy YAML and register it in proxy-groups.

    This mirrors the "apply_insert" action from the original mihomo_editor.py,
    but in a pure-text / library-friendly form suitable for API usage.
    """
    # Normalise newlines
    content = content.replace("\r\n", "\n")
    proxy_yaml_block = proxy_yaml_block.replace("\r\n", "\n")


    # Fresh/default profiles may start as `proxies: []`. Convert that inline
    # empty section into block form before inserting, otherwise the very first
    # import would create a duplicated top-level `proxies:` key.
    content = re.sub(
        r'^(proxies\s*:)\s*(?:\[\]|\{\}|null|~)?\s*(#.*)?$',
        lambda m: f"proxies:{(' ' + m.group(2).strip()) if m.group(2) else ''}",
        content,
        flags=re.M,
    )

    yaml_block_lines = [
        ln.rstrip("\n")
        for ln in proxy_yaml_block.splitlines()
        if ln.strip()
    ]
    if not yaml_block_lines:
        return content

    lines = content.splitlines()
    inserted = False

    # 1) Try to insert under existing *top-level* "proxies:" section.
    for idx, line in enumerate(lines):
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        # Only treat a bare top-level "proxies:" as the section header.
        if stripped == "proxies:" and indent == 0:
            base_indent = line[: len(line) - len(stripped)]

            # Append to the end of the section so UI priority/order is preserved.
            section_end = len(lines)
            for j in range(idx + 1, len(lines)):
                candidate = lines[j]
                candidate_stripped = candidate.lstrip()
                candidate_indent = len(candidate) - len(candidate_stripped)
                if candidate_indent == 0 and candidate_stripped and not candidate_stripped.startswith('#') and not candidate_stripped.startswith('-'):
                    section_end = j
                    break

            insert_at = section_end
            while insert_at > idx + 1 and not lines[insert_at - 1].strip():
                insert_at -= 1
            while insert_at > idx + 1 and lines[insert_at - 1].lstrip().startswith('#'):
                insert_at -= 1

            block_lines = [f"{base_indent}  {block_line}" for block_line in yaml_block_lines]
            lines[insert_at:insert_at] = block_lines
            inserted = True
            break

    # 2) If there is no top-level section yet – create it right before
    #    the subscription header block in the template, so that manual VLESS
    #    proxies live under the "Пример VLESS..." block and do not visually
    #    mix into the subscription header.
    if not inserted:
        # Some templates (e.g. legacy router profiles) use a different
        # Russian wording for the subscription header. Support both the
        # old marker and the ZKeen-style header so that manual proxies
        # appear in the logical place between the VLESS example and the
        # subscription section.
        markers = (
            "подключение с использованием подписки",
            "подписки",
        )
        for idx, line in enumerate(lines):
            lower = line.lower()

            # Skip the 'Пример VLESS...' comment so we don't insert manual proxies
            # before the example block itself.
            if "пример vless" in lower:
                continue

            if any(marker in lower for marker in markers):
                insert_at = idx
                # If the line above looks like a decorative header border for this
                # subscription section (a line of #'s), shift insertion point one
                # line up so that proxies appear between the VLESS example block
                # and the entire subscription header block.
                prev = insert_at - 1
                if prev >= 0:
                    prev_line = lines[prev]
                    if prev_line.strip().startswith("#") and "Пример VLESS" not in prev_line:
                        insert_at = prev

                lines.insert(insert_at, "proxies:")
                for rel_i, block_line in enumerate(yaml_block_lines):
                    lines.insert(insert_at + 1 + rel_i, f"  {block_line}")

                # Add a visual spacer line between the last proxy and the next header
                spacer_index = insert_at + 1 + len(yaml_block_lines)
                if spacer_index < len(lines) and lines[spacer_index].strip().startswith("#"):
                    lines.insert(spacer_index, "")

                inserted = True
                break

# 3) Fallback – append proxies section at the end of file.
    if not inserted:
        lines.append("proxies:")
        for block_line in yaml_block_lines:
            lines.append(f"  {block_line}")

    new_content = "\n".join(lines) + "\n"

    # Now register this proxy name in the selected groups
    return insert_proxy_into_groups(new_content, proxy_name, target_groups)
# Backwards-compatible alias mirroring the original mihomo_editor name
apply_insert = apply_proxy_insert


__all__ = [
    # parsers
    'ProxyParseResult',
    'parse_vless',
    'parse_wireguard',
    # config manipulation
    'insert_proxy_into_groups',
    'replace_proxy_block',
    'replace_proxy_in_config',
    'rename_proxy_in_config',
    'apply_proxy_insert',
    'apply_insert',
    # profiles / backups
    'ProfileInfo',
    'BackupInfo',
    'ensure_mihomo_layout',
    'get_active_profile_name',
    'list_profiles',
    'get_profile_content',
    'create_profile',
    'delete_profile',
    'switch_active_profile',
    'list_backups',
    'create_backup_for_active_profile',
    'delete_backup',
    'read_backup',
    'restore_backup',
    'clean_backups',
    # save + restart
    'save_config',
    'restart_mihomo_and_get_log',
    'validate_config',
]
