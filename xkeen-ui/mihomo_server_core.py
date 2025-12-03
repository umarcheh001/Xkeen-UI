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

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, List, Dict, Tuple, Optional
from urllib.parse import unquote


# === Base paths and constants ===

# Root directory where mihomo config and profiles live.
# For XKeen this is usually /opt/etc/mihomo, но можно переопределить через env.
MIHOMO_ROOT = Path(os.environ.get('MIHOMO_ROOT', '/opt/etc/mihomo')).resolve()
CONFIG_PATH = MIHOMO_ROOT / 'config.yaml'
PROFILES_DIR = MIHOMO_ROOT / 'profiles'
BACKUP_DIR = MIHOMO_ROOT / 'backup'

# How many backups we try to keep per active profile (best-effort, не строго).
MAX_BACKUPS_PER_PROFILE = int(os.environ.get('MIHOMO_MAX_BACKUPS', '20'))

# Command used to restart mihomo via XKeen wrapper.
RESTART_CMD = os.environ.get('MIHOMO_RESTART_CMD', 'xkeen -restart')


# === Utility dataclasses ===

@dataclass
class ProxyParseResult:
    name: str
    yaml: str


@dataclass
class ProfileInfo:
    name: str
    path: Path
    is_active: bool


@dataclass
class BackupInfo:
    filename: str
    path: Path
    profile: str
    created_at: datetime


# === 1. PARSERS: VLESS and WireGuard ===

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
    type_ = qs.get('type', 'tcp')
    encryption = qs.get('encryption') or ''
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
    yaml_lines.append(f"- name: {name}")
    yaml_lines.append('  type: vless')
    yaml_lines.append(f"  server: {server}")
    yaml_lines.append(f"  port: {port}")
    yaml_lines.append(f"  uuid: {uuid}")

    if flow:
        yaml_lines.append(f"  flow: {flow}")

    # --- новое: encryption из URL ---
    if encryption:
        yaml_lines.append(f"  encryption: {encryption}")

    yaml_lines.append(f"  network: {type_}")

    # TLS / Reality
    if security.lower() == 'reality':
        yaml_lines.append('  tls: true')
        yaml_lines.append('  reality-opts:')
        if sni:
            yaml_lines.append(f"    server-name: {sni}")
        if 'pbk' in qs:
            yaml_lines.append(f"    public-key: {qs['pbk']}")
        if 'sid' in qs:
            yaml_lines.append(f"    short-id: {qs['sid']}")
        # --- новое: spx → spider-x ---
        if spx:
            yaml_lines.append(f"    spider-x: {spx}")
        if fp:
            yaml_lines.append(f"  client-fingerprint: {fp}")
    elif security.lower() == 'tls':
        yaml_lines.append('  tls: true')
        if sni:
            yaml_lines.append(f"  servername: {sni}")
        if fp:
            yaml_lines.append(f"  client-fingerprint: {fp}")
        if alpn:
            # alpn может быть 'h2,http/1.1' → получится alpn: [h2,http/1.1]
            yaml_lines.append(f"  alpn: [{alpn}]")

    # ws / grpc opts
    if type_ == 'ws':
        path = qs.get('path', '/')
        if path:
            path = _safe_unquote(path)
        host = qs.get('host') or sni or ''
        yaml_lines.append('  ws-opts:')
        yaml_lines.append(f"    path: {path}")
        if host:
            yaml_lines.append('    headers:')
            yaml_lines.append(f"      Host: {host}")
    elif type_ == 'grpc':
        service_name = qs.get('serviceName') or qs.get('service_name') or ''
        if service_name:
            service_name = _safe_unquote(service_name)
        yaml_lines.append('  grpc-opts:')
        if service_name:
            yaml_lines.append(f"    grpc-service-name: {service_name}")

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
    yaml_lines.append(f"- name: {name}")
    yaml_lines.append("  type: wireguard")
    yaml_lines.append(f"  server: {host}")
    yaml_lines.append(f"  port: {port}")
    yaml_lines.append(f"  ip: {ip_v4}") if ip_v4 else None
    if ip_v6:
        yaml_lines.append(f"  ipv6: {ip_v6}")
    yaml_lines.append(f"  private-key: {iface['PrivateKey']}")
    yaml_lines.append(f"  public-key: {peer['PublicKey']}")

    if 'PresharedKey' in peer:
        yaml_lines.append(f"  preshared-key: {peer['PresharedKey']}")

    if dns_list:
        dns_str = ', '.join(dns_list)
        yaml_lines.append(f"  dns: [{dns_str}]")

    if mtu:
        yaml_lines.append(f"  mtu: {mtu}")

    if keepalive:
        yaml_lines.append(f"  persistent-keepalive: {keepalive}")

    if allowed_ips:
        yaml_lines.append(f"  allowed-ips: [{allowed_ips}]")

    if amz:
        yaml_lines.append("  amnezia-wg-option:")
        for k, v in amz.items():
            yaml_lines.append(f"    {k}: {v}")

    yaml = "\n".join(yaml_lines) + "\n"
    return ProxyParseResult(name=name, yaml=yaml)


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
        if group_has_proxies or not group_has_include_all:
            return
        indent = group_include_indent or "    "
        quoted = proxy_name if (proxy_name.startswith('"') or proxy_name.startswith("'")) else f'"{proxy_name}"'
        out2.append(f"{indent}proxies:")
        out2.append(f"{indent}  - {quoted}")

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

def _inject_proxy_before_leave(out_lines: List[str], proxy_name: str) -> None:
    """Append '- proxy_name' to the current proxies: list if not there yet."""
    # Determine current indent from last non-empty line
    if not out_lines:
        return
    # Scan backwards to find the last proxies entry indent
    indent = '      '
    for line in reversed(out_lines):
        if line.strip().startswith('-') and not line.strip().startswith('- name:'):
            indent = line[: len(line) - len(line.lstrip())]
            break

    quoted = proxy_name if (proxy_name.startswith('"') or proxy_name.startswith("'")) else f'"{proxy_name}"'

    # Avoid duplicates: if already present in recent proxies lines, skip
    for line in out_lines[::-1][:30]:
        if quoted in line:
            return

    out_lines.append(f"{indent}- {quoted}")


def replace_proxy_block(content: str, target_name: str, new_yaml_block: str) -> str:
    """Replace existing proxy block with new one (by name).

    * Looks inside `proxies:` section.
    * target_name is matched ignoring surrounding quotes.
    * new_yaml_block should be a valid YAML snippet starting with `- name:`.
    """
    lines = content.splitlines()
    new_lines = new_yaml_block.splitlines()

    in_proxies = False
    start_idx = None
    found_name = None

    def flush_block(i: int) -> None:
        nonlocal lines
        if start_idx is None:
            return
        # Replace [start_idx, i) with new_lines
        lines = lines[:start_idx] + new_lines + lines[i:]

    i = 0
    while i < len(lines):
        stripped = lines[i].lstrip()
        if stripped.startswith('proxies:'):
            in_proxies = True
            i += 1
            continue

        if in_proxies and stripped.startswith('- name:'):
            # If we were inside previous block -> end of previous block
            if start_idx is not None and found_name is not None:
                flush_block(i)
                return "\n".join(lines) + "\n"

            # new block begins
            start_idx = i
            found_name = stripped.split(':', 1)[1].strip().strip('"\'')

        if in_proxies and stripped and not stripped.startswith('-') and not stripped.startswith('#'):
            # possibly other keys under the block; we just move on
            pass

        # if we reached end of proxies section
        if in_proxies and stripped and not lines[i].startswith('  '):
            if start_idx is not None and found_name is not None:
                flush_block(i)
                return "\n".join(lines) + "\n"
            in_proxies = False

        if in_proxies and found_name == target_name and i + 1 == len(lines):
            # block goes until end of file
            flush_block(i + 1)
            return "\n".join(lines) + "\n"

        i += 1

    return "\n".join(lines) + "\n"


def rename_proxy_in_config(content: str, old_name: str, new_name: str) -> str:
    """Rename proxy and all its usages inside proxy-groups."""
    if old_name == new_name:
        return content

    # replace in proxies section name:
    pattern = re.compile(rf"(-\s+name:\s+)(['\"]?){re.escape(old_name)}(['\"]?)")
    content = pattern.sub(lambda m: f"{m.group(1)}\"{new_name}\"", content)

    # replace inside proxy-groups lists
    def repl_group(m: re.Match[str]) -> str:
        before, name, after = m.groups()
        if name == old_name:
            name = new_name
        return f"{before}{name}{after}"

    content = re.sub(r'(\-\s+)([\"\']?)(%s)([\"\']?)' % re.escape(old_name), repl_group, content)
    return content



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
            # Insert new block directly under "proxies:"
            for rel_i, block_line in enumerate(yaml_block_lines):
                lines.insert(idx + 1 + rel_i, f"{base_indent}  {block_line}")
            inserted = True
            break

    # 2) If there is no top-level section yet – create it right before
    #    the subscription header block in the template, so that manual VLESS
    #    proxies live under the "Пример VLESS..." block and do not visually
    #    mix into the subscription header.
    if not inserted:
        marker = "Подключение С использованием подписки"
        for idx, line in enumerate(lines):
            if marker in line:
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


# === 3. PROFILE AND BACKUP MANAGEMENT ===

def ensure_mihomo_layout() -> None:
    """Ensure standard layouts: profiles/ + backup/ and symlink config.yaml -> profiles/default.yaml.

    This is an idempotent helper – safe to call on each startup.
    """
    MIHOMO_ROOT.mkdir(parents=True, exist_ok=True)
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    if CONFIG_PATH.is_symlink():
        # Already in the desired scheme, but we still ensure target exists.
        target = CONFIG_PATH.resolve()
        if not target.exists():
            # recreate default profile
            default_path = PROFILES_DIR / 'default.yaml'
            if not default_path.exists():
                default_path.write_text('proxies: []\n', encoding='utf-8')
            if CONFIG_PATH.exists() or CONFIG_PATH.is_symlink():
                CONFIG_PATH.unlink()
            CONFIG_PATH.symlink_to(default_path)
        return

    # If config.yaml exists and is a regular file -> move it to profiles/default.yaml
    default_profile = PROFILES_DIR / 'default.yaml'
    if CONFIG_PATH.exists() and CONFIG_PATH.is_file():
        if not default_profile.exists():
            shutil.move(str(CONFIG_PATH), str(default_profile))
        else:
            # Already have default. Keep existing default, rename original.
            backup_orig = PROFILES_DIR / 'imported_from_config.yaml'
            shutil.move(str(CONFIG_PATH), str(backup_orig))

    # If there's no default profile at all – create minimal one.
    if not default_profile.exists():
        default_profile.write_text('proxies: []\n', encoding='utf-8')

    # Create symlink CONFIG_PATH -> default_profile if not present.
    if CONFIG_PATH.exists() or CONFIG_PATH.is_symlink():
        try:
            CONFIG_PATH.unlink()
        except FileNotFoundError:
            pass
    CONFIG_PATH.symlink_to(default_profile)


def _active_profile_path() -> Path:
    """Return the path of the currently active profile (target of config.yaml symlink)."""
    if CONFIG_PATH.is_symlink():
        return CONFIG_PATH.resolve()
    # Fallback: treat config.yaml itself as active, create layout.
    ensure_mihomo_layout()
    return CONFIG_PATH.resolve()


def get_active_profile_name() -> str:
    path = _active_profile_path()
    if path.parent != PROFILES_DIR:
        return path.name
    return path.name


def list_profiles() -> List[ProfileInfo]:
    ensure_mihomo_layout()
    active = _active_profile_path().name
    profiles: List[ProfileInfo] = []
    for p in sorted(PROFILES_DIR.glob('*.yaml')):
        profiles.append(ProfileInfo(name=p.name, path=p, is_active=(p.name == active)))
    return profiles


def get_profile_content(name: str) -> str:
    p = PROFILES_DIR / name
    if not p.exists():
        raise FileNotFoundError(name)
    return p.read_text(encoding='utf-8')


def create_profile(name: str, content: str) -> None:
    ensure_mihomo_layout()
    if not name.endswith('.yaml'):
        name += '.yaml'
    p = PROFILES_DIR / name
    if p.exists():
        raise FileExistsError(name)
    p.write_text(content, encoding='utf-8')


def delete_profile(name: str) -> None:
    ensure_mihomo_layout()
    p = PROFILES_DIR / name
    if not p.exists():
        return
    if p.resolve() == _active_profile_path():
        raise RuntimeError('Cannot delete active profile')
    p.unlink()


def switch_active_profile(name: str) -> None:
    ensure_mihomo_layout()
    p = PROFILES_DIR / name
    if not p.exists():
        raise FileNotFoundError(name)
    if CONFIG_PATH.exists() or CONFIG_PATH.is_symlink():
        try:
            CONFIG_PATH.unlink()
        except FileNotFoundError:
            pass
    CONFIG_PATH.symlink_to(p)


def _parse_backup_filename(path: Path) -> Optional[BackupInfo]:
    # Pattern: <base>_YYYYMMDD_HHMMSS.yaml, где <base> может быть как "Тест", так и "Тест.yaml"
    m = re.match(r'(.+?)_(\d{8})_(\d{6})\.yaml$', path.name)
    if not m:
        return None

    base = m.group(1)

    # Для старых файлов base уже "profile.yaml", для новых – "profile".
    if base.endswith('.yaml'):
        profile = base
    else:
        profile = base + '.yaml'

    dt = datetime.strptime(m.group(2) + m.group(3), '%Y%m%d%H%M%S')
    return BackupInfo(filename=path.name, path=path, profile=profile, created_at=dt)



def list_backups(profile: Optional[str] = None) -> List[BackupInfo]:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    infos: List[BackupInfo] = []
    for p in BACKUP_DIR.glob('*.yaml'):
        info = _parse_backup_filename(p)
        if not info:
            continue
        if profile and info.profile != profile:
            continue
        infos.append(info)
    infos.sort(key=lambda x: x.created_at, reverse=True)
    return infos


def create_backup_for_active_profile() -> BackupInfo:
    ensure_mihomo_layout()
    active_path = _active_profile_path()
    # Имя профиля (как в списке профилей, с .yaml)
    profile_name = active_path.name
    # База для имени файла бэкапа – без расширения .yaml
    profile_base = active_path.stem

    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    # Итоговый файл бэкапа: <base>_YYYYMMDD_HHMMSS.yaml, например: Тест_20251201_204037.yaml
    backup_name = f"{profile_base}_{ts}.yaml"
    backup_path = BACKUP_DIR / backup_name
    shutil.copy2(active_path, backup_path)

    # best-effort limit backups per profile
    # Ограничиваем количество бэкапов на профиль по полному имени профиля (с .yaml),
    # чтобы учитывать и старые, и новые имена файлов.
    infos = [b for b in list_backups(profile_name) if b.filename != backup_name]
    if len(infos) >= MAX_BACKUPS_PER_PROFILE:
        for old in infos[MAX_BACKUPS_PER_PROFILE - 1:]:
            try:
                old.path.unlink()
            except FileNotFoundError:
                pass

    return _parse_backup_filename(backup_path)  # type: ignore[return-value]



def delete_backup(filename: str) -> None:
    p = BACKUP_DIR / filename
    if p.exists():
        p.unlink()


def read_backup(filename: str) -> str:
    p = BACKUP_DIR / filename
    if not p.exists():
        raise FileNotFoundError(filename)
    return p.read_text(encoding='utf-8')


def restore_backup(filename: str) -> None:
    """Restore backup file into active profile (overwriting its content).

    Безопасность: бэкап можно применить только к тому профилю,
    из которого он был создан.
    """
    ensure_mihomo_layout()

    src = BACKUP_DIR / filename
    if not src.exists():
        raise FileNotFoundError(filename)

    info = _parse_backup_filename(src)
    if not info:
        # Не даём восстановить файл с неожиданным именем
        raise ValueError(f"Invalid backup filename: {filename!r}")

    active_path = _active_profile_path()
    active_name = active_path.name  # например, "default.yaml"

    # Бэкап "принадлежит" профилю info.profile (например, "default.yaml")
    if info.profile != active_name:
        raise RuntimeError(
            f"Backup {filename} belongs to profile {info.profile}, "
            f"but active profile is {active_name}. "
            "Switch active profile to the matching one and try again."
        )

    shutil.copy2(src, active_path)


def clean_backups(limit: int = 5, profile: Optional[str] = None) -> List[BackupInfo]:
    """Remove older backup files, keeping at most `limit` newest ones.

    If *profile* is provided, only backups whose profile name matches are
    considered. Otherwise all backups in BACKUP_DIR are taken into account.

    Returns a list of remaining backups (newest first).
    """
    ensure_mihomo_layout()

    if limit < 0:
        raise ValueError("limit must be non-negative")

    backups = list_backups(profile)

    if limit == 0:
        keep: List[BackupInfo] = []
        to_delete = backups
    else:
        keep = backups[:limit]
        to_delete = backups[limit:]

    for b in to_delete:
        try:
            b.path.unlink()
        except FileNotFoundError:
            # Already removed (best-effort clean-up).
            pass

    return keep


# === 4. SAVE CONFIG + RESTART MIHOMO ===

def save_config(new_content: str) -> BackupInfo:
    """Save new content into active profile with an automatic backup beforehand."""
    ensure_mihomo_layout()
    backup_info = create_backup_for_active_profile()
    active_path = _active_profile_path()
    active_path.write_text(new_content, encoding='utf-8')
    return backup_info


def restart_mihomo_and_get_log(new_content: Optional[str] = None) -> str:
    """Optionally save new content, restart mihomo via RESTART_CMD, and return its log output."""
    if new_content is not None:
        save_config(new_content)

    env = os.environ.copy()
    env.setdefault('TERM', 'xterm-256color')  # for colored output, if any

    try:
        proc = subprocess.run(RESTART_CMD, shell=True, capture_output=True, text=True, env=env)
    except Exception as e:  # pragma: no cover - system-dependent
        return f'Failed to execute restart command: {e}'

    out = proc.stdout or ''
    err = proc.stderr or ''
    rc = proc.returncode

    log = []
    log.append(f'$ {RESTART_CMD}')
    if out:
        log.append(out)
    if err:
        log.append('--- STDERR ---')
        log.append(err)
    log.append(f'\n[exit code: {rc}]\n')

    return "\n".join(log)


# === 5. VALIDATE CONFIG VIA MIHOMO CORE (optional) ===

def validate_config(new_content: Optional[str] = None) -> str:
    """
    Validate a Mihomo config using external core (if configured).

    The command is taken from the MIHOMO_VALIDATE_CMD environment variable.

    It can contain placeholders:
      {config} - path to the config file that should be checked
      {root}   - MIHOMO_ROOT directory

    Examples (set in environment before starting the app):

      export MIHOMO_ROOT=/opt/etc/mihomo
      export MIHOMO_VALIDATE_CMD="mihomo -t -f {config}"

    If MIHOMO_VALIDATE_CMD is not set, this function will return
    a message describing how to configure validation.
    """
    ensure_mihomo_layout()

    validate_cmd_tpl = os.environ.get('MIHOMO_VALIDATE_CMD')
    root = MIHOMO_ROOT

    # Choose which config file to validate:
    # - if new_content is provided, we write it to a temp file;
    # - otherwise, we use the active profile.
    tmp_path: Optional[Path] = None
    try:
        if new_content is not None:
            tmp_path = root / 'config-validate.yaml'
            tmp_path.write_text(new_content, encoding='utf-8')
            cfg_path = tmp_path
        else:
            cfg_path = _active_profile_path()

        if not validate_cmd_tpl:
            return (
                "MIHOMO_VALIDATE_CMD is not set.\n"
                "Please set MIHOMO_VALIDATE_CMD in the environment, for example:\n"
                "  export MIHOMO_ROOT=/opt/etc/mihomo\n"
                "  export MIHOMO_VALIDATE_CMD='mihomo -t -f {config}'\n"
            )

        cmd = validate_cmd_tpl.format(config=str(cfg_path), root=str(root))

        env = os.environ.copy()
        env.setdefault('TERM', 'xterm-256color')

        try:
            proc = subprocess.run(cmd, shell=True, capture_output=True, text=True, env=env)
        except Exception as e:  # pragma: no cover - system-dependent
            return f'Failed to execute validation command: {e}'

        out = proc.stdout or ''
        err = proc.stderr or ''
        rc = proc.returncode

        log_lines = [f'$ {cmd}']
        if out:
            log_lines.append(out)
        if err:
            log_lines.append('--- STDERR ---')
            log_lines.append(err)
        log_lines.append(f'\n[exit code: {rc}]\n')

        return "\n".join(log_lines)
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink()
            except OSError:
                pass



__all__ = [
    # parsers
    'ProxyParseResult',
    'parse_vless',
    'parse_wireguard',
    # config manipulation
    'insert_proxy_into_groups',
    'replace_proxy_block',
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
