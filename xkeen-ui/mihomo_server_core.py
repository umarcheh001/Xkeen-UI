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
from typing import List, Dict, Tuple, Optional
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
from services.mihomo_proxy_config import (
    insert_proxy_into_groups,
    replace_proxy_block,
    replace_proxy_in_config,
    rename_proxy_in_config,
    apply_proxy_insert,
    apply_insert,
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
