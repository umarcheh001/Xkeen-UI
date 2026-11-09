"""On-demand endpoint diagnostics for Xray and Mihomo configurations."""

from __future__ import annotations

import functools
from contextlib import contextmanager
import ipaddress
import http.client
import json
import subprocess
import re
import secrets
import shlex
import socket
import ssl
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from utils.jsonc import strip_json_comments_text


MAX_SOURCE_BYTES = 65_536
MAX_TARGETS = 200
MAX_SAVED_XRAY_PAGE_SIZE = 200
_PROBE_SLOTS = threading.BoundedSemaphore(2)
_DNS_COMPARE_SLOTS = threading.BoundedSemaphore(1)
_LIST_LOOKUP_SLOTS = threading.BoundedSemaphore(1)
_COMPARE_PROBE_SLOTS = threading.BoundedSemaphore(1)
_PROXY_PROBE_SLOTS = threading.BoundedSemaphore(2)
_RESOURCE_PROBE_SLOTS = threading.BoundedSemaphore(2)
_PROXY_CONTEXT_LOCK = threading.Lock()
_PROXY_CONTEXTS: OrderedDict[str, tuple[float, list[dict | None], list[dict]]] = OrderedDict()
_PROXY_CONTEXT_TTL = 600
_PROXY_CONTEXT_LIMIT = 32
_TLS_CONTROLS = (("1.1.1.1", "cloudflare-dns.com"), ("8.8.8.8", "dns.google"))
_TLS_COMPARE_IP_LIMIT = 2
_TLS_COMPARE_ROUNDS = 2
_UDP_PROTOCOLS = {"hysteria", "hysteria2", "hy2", "tuic", "wireguard", "anytls-quic"}
_SKIP_PROTOCOLS = {"direct", "freedom", "blackhole", "dns", "reject", "selector", "url-test", "fallback", "load-balance"}
_HOST_RE = re.compile(r"^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?$")


class EngineUnavailable(ValueError):
    """A check needs the code of an engine module that is not installed."""


def _needs_engines(function):
    """Turn a missing engine module into a clear refusal instead of a crash.

    The module depends only on core, while parsing a link or probing a proxy
    borrows the code of the Xray or Mihomo module. The routes answer 400 to a
    ValueError, so the window shows what to install.
    """

    @functools.wraps(function)
    def wrapper(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except ImportError as error:
            name = str(getattr(error, "name", "") or "")
            if not name.startswith("services."):
                raise
            engine = "Mihomo" if "mihomo" in name else "Xray" if "xray" in name else "Xray или Mihomo"
            raise EngineUnavailable(f"Для этой проверки нужен модуль {engine}.") from error

    return wrapper


def _host(value: object) -> str:
    host = str(value or "").strip().strip("[]")
    if not host or len(host) > 253 or any(char.isspace() for char in host):
        raise ValueError("Некорректное имя сервера.")
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    try:
        ascii_host = host.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise ValueError("Некорректное имя сервера.") from exc
    if not _HOST_RE.fullmatch(ascii_host):
        raise ValueError("Некорректное имя сервера.")
    return ascii_host


def make_target(host: object, port: object, *, name: object = "", protocol: object = "", network: object = "tcp", tls: bool = False, sni: object = "", tls_mode: str = "", verify_tls: bool = True, source: object = "") -> dict:
    clean_host = _host(host)
    try:
        clean_port = int(port)
    except (TypeError, ValueError) as exc:
        raise ValueError("Укажите порт от 1 до 65535.") from exc
    if not 1 <= clean_port <= 65535:
        raise ValueError("Укажите порт от 1 до 65535.")
    clean_network = str(network or "tcp").lower()
    if clean_network not in {"tcp", "udp"}:
        raise ValueError("Неизвестный сетевой протокол.")
    clean_name = str(name or clean_host).strip()[:100]
    clean_mode = str(tls_mode or ("standard" if tls else "none")).lower()
    if clean_mode not in {"none", "standard", "reality"}:
        raise ValueError("Неизвестный режим TLS.")
    clean_sni = _host(sni) if sni else ""
    return {
        "name": clean_name,
        "host": clean_host,
        "port": clean_port,
        "protocol": str(protocol or "").strip().lower()[:32],
        "network": clean_network,
        "tls": clean_mode == "standard" and clean_network == "tcp",
        "tls_mode": clean_mode if clean_network == "tcp" else "none",
        "sni": clean_sni if clean_network == "tcp" and clean_mode != "none" else "",
        "verify_tls": bool(verify_tls),
        "source": str(source or "").strip()[:100],
    }


def _add(targets: list[dict], target: dict, *, limit: int = MAX_TARGETS) -> None:
    key = (target["host"], target["port"], target["network"], target["tls_mode"], target["sni"], target["verify_tls"])
    if len(targets) < limit and not any((item["host"], item["port"], item["network"], item["tls_mode"], item["sni"], item["verify_tls"]) == key for item in targets):
        targets.append(target)


def xray_outbound_targets(obj: object, *, source: str = "Xray", limit: int = MAX_TARGETS, keep_outbounds: bool = False, probe_outbounds: list[dict | None] | None = None) -> list[dict]:
    if isinstance(obj, list):
        outbounds = obj
    elif isinstance(obj, dict):
        outbounds = obj.get("outbounds") or [obj]
    else:
        return []
    targets: list[dict] = []
    for outbound in outbounds if isinstance(outbounds, list) else []:
        if not isinstance(outbound, dict):
            continue
        protocol = str(outbound.get("protocol") or "").lower()
        if protocol in _SKIP_PROTOCOLS:
            continue
        settings = outbound.get("settings") if isinstance(outbound.get("settings"), dict) else {}
        stream = outbound.get("streamSettings") if isinstance(outbound.get("streamSettings"), dict) else {}
        security = str(stream.get("security") or "none").lower()
        tls_mode = "standard" if security == "tls" else "reality" if security == "reality" else "none"
        security_settings = stream.get("realitySettings" if tls_mode == "reality" else "tlsSettings")
        security_settings = security_settings if isinstance(security_settings, dict) else {}
        sni = security_settings.get("serverName") or security_settings.get("server_name") or ""
        network = "udp" if protocol in _UDP_PROTOCOLS or str(stream.get("network") or "").lower() in {"quic", "kcp"} else "tcp"
        name = outbound.get("tag") or protocol or "Узел Xray"
        endpoints: list[dict] = []
        for field in ("vnext", "servers"):
            values = settings.get(field)
            if isinstance(values, list):
                endpoints.extend(item for item in values if isinstance(item, dict))
        for container in (settings, outbound.get("hysteriaSettings"), outbound.get("wireguardSettings")):
            if isinstance(container, dict) and (container.get("address") or container.get("server")):
                endpoints.append(container)
        if protocol == "wireguard":
            for peer in settings.get("peers", []) if isinstance(settings.get("peers"), list) else []:
                if isinstance(peer, dict) and isinstance(peer.get("endpoint"), str):
                    try:
                        endpoint = urlsplit("//" + peer["endpoint"])
                        if endpoint.hostname and endpoint.port:
                            endpoints.append({"address": endpoint.hostname, "port": endpoint.port})
                    except ValueError:
                        pass
        for endpoint in endpoints:
            try:
                target = make_target(endpoint.get("address") or endpoint.get("server"), endpoint.get("port"), name=name, protocol=protocol, network=network, tls_mode=tls_mode, sni=sni, verify_tls=security_settings.get("allowInsecure") is not True, source=source)
                if keep_outbounds:
                    targets.append(target)
                    if probe_outbounds is not None:
                        probe_outbounds.append(outbound)
                else:
                    previous_count = len(targets)
                    _add(targets, target, limit=limit)
                    if probe_outbounds is not None and len(targets) > previous_count:
                        probe_outbounds.append(outbound)
            except ValueError:
                continue
            if len(targets) >= limit:
                break
        if len(targets) >= limit:
            break
    return targets


def read_current_xray_targets(configs_dir: str, *, offset: int = 0, probe_outbounds: list[dict | None] | None = None) -> dict:
    root = Path(configs_dir)
    targets: list[dict] = []
    if not root.is_dir():
        return {"targets": [], "has_more": False, "next_offset": offset}
    needed = offset + MAX_SAVED_XRAY_PAGE_SIZE + 1
    for path in sorted(root.glob("*.json"))[:100]:
        try:
            if path.stat().st_size > 2_000_000:
                continue
            obj = json.loads(strip_json_comments_text(path.read_text(encoding="utf-8-sig")))
            targets.extend(xray_outbound_targets(obj, source=path.name, limit=needed - len(targets), keep_outbounds=True, probe_outbounds=probe_outbounds))
        except (OSError, UnicodeError, ValueError):
            continue
        if len(targets) >= needed:
            break
    page = targets[offset:offset + MAX_SAVED_XRAY_PAGE_SIZE]
    if probe_outbounds is not None:
        probe_outbounds[:] = probe_outbounds[offset:offset + MAX_SAVED_XRAY_PAGE_SIZE]
    return {"targets": page, "has_more": len(targets) > offset + len(page), "next_offset": offset + len(page)}


def current_xray_targets(configs_dir: str) -> list[dict]:
    return read_current_xray_targets(configs_dir)["targets"]


def _yaml_scalar(value: str) -> str:
    text = value.strip()
    if " #" in text and not text.startswith(("'", '"')):
        text = text.split(" #", 1)[0].strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        text = text[1:-1]
    return text.replace("''", "'")


def _mihomo_blocks(text: str) -> tuple[list[dict], list[dict]]:
    """Read only endpoint fields when PyYAML is absent on small routers."""
    proxies: list[dict] = []
    providers: list[dict] = []
    section = ""
    current: dict | None = None
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if indent == 0:
            section = stripped.split(":", 1)[0] if ":" in stripped else ""
            current = None
            continue
        if section == "proxies":
            if stripped.startswith("- "):
                current = {}
                proxies.append(current)
                stripped = stripped[2:]
            if current is not None and ":" in stripped:
                key, value = stripped.split(":", 1)
                if key in {"name", "type", "server", "port", "tls", "servername", "sni", "reality-opts", "skip-cert-verify"} and (value.strip() or key == "reality-opts"):
                    current[key] = _yaml_scalar(value)
        elif section == "proxy-providers":
            if indent <= 2 and stripped.endswith(":"):
                current = {"name": _yaml_scalar(stripped[:-1])}
                providers.append(current)
            elif current is not None and (stripped.startswith("url:") or stripped.startswith("path:")):
                key, value = stripped.split(":", 1)
                current[key] = _yaml_scalar(value)
    return proxies, providers


def _mihomo_proxy_yaml_blocks(text: str) -> list[str]:
    blocks: list[str] = []
    in_proxies = False
    item_indent: int | None = None
    current: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        if stripped and not line.lstrip().startswith("#") and indent == 0:
            if current:
                blocks.append("\n".join(current))
                current = []
            in_proxies = stripped == "proxies:"
            item_indent = None
            continue
        if not in_proxies:
            continue
        if stripped.startswith("- ") and (item_indent is None or indent == item_indent):
            if current:
                blocks.append("\n".join(current))
            item_indent = indent
            current = [line]
        elif current:
            current.append(line)
    if current:
        blocks.append("\n".join(current))
    return blocks


def mihomo_text_targets(text: str, *, source: str = "config.yaml", probe_proxies: list[dict | None] | None = None) -> list[dict]:
    obj = None
    if text.lstrip().startswith(("{", "[")):
        try:
            obj = json.loads(text)
        except ValueError:
            pass
    if obj is None:
        try:
            import yaml  # Optional on the router.

            obj = yaml.safe_load(text)
        except ImportError:
            pass
        except Exception:
            pass
    if isinstance(obj, dict):
        proxies = obj.get("proxies") if isinstance(obj.get("proxies"), list) else []
        raw_providers = obj.get("proxy-providers")
        providers = [{"name": name, **item} for name, item in raw_providers.items() if isinstance(item, dict)] if isinstance(raw_providers, dict) else []
    else:
        proxies, providers = _mihomo_blocks(text)
    raw_proxy_blocks = _mihomo_proxy_yaml_blocks(text) if not isinstance(obj, dict) else []
    targets: list[dict] = []
    for proxy_index, item in enumerate(proxies):
        if not isinstance(item, dict):
            continue
        protocol = str(item.get("type") or "").lower()
        if protocol in _SKIP_PROTOCOLS:
            continue
        network = "udp" if protocol in _UDP_PROTOCOLS else "tcp"
        reality = bool(item.get("reality-opts")) or "reality-opts" in item
        tls_value = item.get("tls")
        tls_enabled = (protocol == "trojan" if tls_value is None else str(tls_value).lower() == "true")
        tls_mode = "reality" if reality else "standard" if tls_enabled else "none"
        try:
            previous_count = len(targets)
            _add(targets, make_target(item.get("server"), item.get("port"), name=item.get("name"), protocol=protocol, network=network, tls_mode=tls_mode, sni=item.get("servername") or item.get("sni") or "", verify_tls=str(item.get("skip-cert-verify") or "").lower() != "true", source=source))
            if probe_proxies is not None and len(targets) > previous_count and isinstance(obj, dict):
                probe_proxies.append({"_diagnostics_engine": "mihomo", "proxy": item})
            elif probe_proxies is not None and len(targets) > previous_count:
                raw_block = raw_proxy_blocks[proxy_index] if proxy_index < len(raw_proxy_blocks) else ""
                probe_proxies.append({"_diagnostics_engine": "mihomo", "proxy_yaml": raw_block, "name": item.get("name")} if raw_block else None)
        except ValueError:
            continue
    for provider in providers:
        url = str(provider.get("url") or "")
        if url.startswith(("https://", "http://")):
            try:
                parsed = urlsplit(url)
                previous_count = len(targets)
                _add(targets, make_target(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), name=provider.get("name"), protocol="subscription", tls=parsed.scheme == "https", source=source))
                if probe_proxies is not None and len(targets) > previous_count:
                    probe_proxies.append(None)
            except ValueError:
                continue
    return targets


def current_mihomo_targets(config_file: str, *, probe_proxies: list[dict | None] | None = None) -> list[dict]:
    path = Path(config_file)
    try:
        if path.stat().st_size > 2_000_000:
            return []
        text = path.read_text(encoding="utf-8-sig")
        targets = mihomo_text_targets(text, source=path.name, probe_proxies=probe_proxies)
        root = path.parent.resolve()
        _, providers = _mihomo_blocks(text)
        for provider in providers[:20]:
            cached = str(provider.get("path") or "").strip()
            if not cached:
                continue
            try:
                provider_file = (root / cached).resolve()
                if not provider_file.is_relative_to(root) or not provider_file.is_file() or provider_file.stat().st_size > 2_000_000:
                    continue
                cached_proxies: list[dict | None] = []
                for index, item in enumerate(mihomo_text_targets(provider_file.read_text(encoding="utf-8-sig"), source=provider_file.name, probe_proxies=cached_proxies)):
                    previous_count = len(targets)
                    _add(targets, item)
                    if probe_proxies is not None and len(targets) > previous_count:
                        probe_proxies.append(cached_proxies[index] if index < len(cached_proxies) else None)
            except (OSError, UnicodeError):
                continue
        return targets
    except (OSError, UnicodeError):
        return []


def _plain_target(line: str) -> dict:
    if line.startswith(("https://", "http://")):
        parsed = urlsplit(line)
        if parsed.username or parsed.password:
            raise ValueError("URL с логином и паролем не поддерживается.")
        return make_target(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), tls=parsed.scheme == "https", protocol="web", source="Ввод")
    if line.startswith("[") and "]:" in line:
        host, port = line[1:].split("]:", 1)
        return make_target(host, port, source="Ввод")
    if line.count(":") == 1:
        host, port = line.rsplit(":", 1)
        if port.isdigit():
            return make_target(host, port, source="Ввод")
    return make_target(line, 443, tls=True, protocol="web", source="Ввод")


@_needs_engines
def parse_source(source: str, *, allow_fetch: bool = True, probe_outbounds: list[dict | None] | None = None, core: str = "xray") -> dict:
    if len(source.encode("utf-8")) > (MAX_SOURCE_BYTES if allow_fetch else 2_000_000):
        raise ValueError("Слишком большой источник для диагностики.")
    text = source.strip()
    if not text:
        raise ValueError("Введите адрес, ссылку, конфигурацию или подписку.")
    targets: list[dict] = []
    warnings: list[str] = []
    truncated = False

    if text.startswith(("{", "[")):
        try:
            obj = json.loads(strip_json_comments_text(text))
        except ValueError:
            obj = None
        if isinstance(obj, (dict, list)):
            parsed_outbounds: list[dict | None] = []
            for item, outbound in zip(xray_outbound_targets(obj, source="Ввод", probe_outbounds=parsed_outbounds), parsed_outbounds):
                previous_count = len(targets)
                _add(targets, item)
                if probe_outbounds is not None and len(targets) > previous_count:
                    probe_outbounds.append(outbound)
            if not targets:
                from services.xray_subscriptions import build_subscription_json_outbounds

                try:
                    outbounds, _, _ = build_subscription_json_outbounds(text, tag_prefix="diagnostics")
                    parsed_outbounds = []
                    for item, outbound in zip(xray_outbound_targets(outbounds, source="Подписка", probe_outbounds=parsed_outbounds), parsed_outbounds):
                        previous_count = len(targets)
                        _add(targets, item)
                        if probe_outbounds is not None and len(targets) > previous_count:
                            probe_outbounds.append(outbound)
                except ValueError:
                    pass
            if isinstance(obj, dict) and ("proxies" in obj or "proxy-providers" in obj):
                parsed_proxies: list[dict | None] = []
                for index, item in enumerate(mihomo_text_targets(text, source="Ввод", probe_proxies=parsed_proxies)):
                    previous_count = len(targets)
                    _add(targets, item)
                    if probe_outbounds is not None and len(targets) > previous_count:
                        probe_outbounds.append(parsed_proxies[index] if index < len(parsed_proxies) else None)
    if "proxies:" in text or "proxy-providers:" in text:
        parsed_proxies = []
        for index, item in enumerate(mihomo_text_targets(text, source="Ввод", probe_proxies=parsed_proxies)):
            previous_count = len(targets)
            _add(targets, item)
            if probe_outbounds is not None and len(targets) > previous_count:
                probe_outbounds.append(parsed_proxies[index] if index < len(parsed_proxies) else None)
    if not targets and ("[Interface]" in text or re.search(r"(?mi)^remote\s+\S+", text)):
        from services.mihomo_proxy_parsers import parse_openvpn, parse_wireguard

        parser = parse_wireguard if "[Interface]" in text else parse_openvpn
        parsed = parser(text)
        parsed_proxies = []
        for index, item in enumerate(mihomo_text_targets("proxies:\n" + parsed.yaml, source="Ввод", probe_proxies=parsed_proxies)):
            previous_count = len(targets)
            _add(targets, item)
            if probe_outbounds is not None and len(targets) > previous_count:
                probe_outbounds.append(parsed_proxies[index] if index < len(parsed_proxies) else None)

    links: list[str] = []
    subscription_url = bool(re.search(
        r"/(?:sub|subscription|subscribe)(?:/|$)",
        urlsplit(text).path.lower(),
    )) if text.lower().startswith(("https://", "http://")) and len(text.splitlines()) == 1 else False
    if re.search(r"(?:vless|trojan|vmess|ss|hysteria2?|hy2)://", text, re.IGNORECASE) or (len(text) > 80 and "\n" not in text and not text.startswith(("http://", "https://", "vpn://"))):
        from services.xray_subscriptions import parse_subscription_links

        links = parse_subscription_links(text)
    if links:
        from services.xray_outbounds import build_proxy_outbound_from_link
        from services.mihomo_proxy_parsers import parse_proxy_uri

        truncated = len(links) > MAX_TARGETS
        for link in links[:MAX_TARGETS]:
            parsed_outbound = None
            try:
                outbound = build_proxy_outbound_from_link(link, "Узел")
                parsed_targets = xray_outbound_targets(outbound, source="Ссылка")
                if parsed_targets:
                    parsed_outbound = outbound
            except ValueError:
                parsed_targets = []
            if core == "mihomo":
                try:
                    proxy = parse_proxy_uri(link)
                    parsed_outbound = {"_diagnostics_engine": "mihomo", "proxy_yaml": proxy.yaml, "name": proxy.name}
                except ValueError:
                    pass
            if not parsed_targets:
                try:
                    proxy = parse_proxy_uri(link)
                    parsed_targets = mihomo_text_targets("proxies:\n" + proxy.yaml, source="Ссылка")
                    parsed_outbound = {"_diagnostics_engine": "mihomo", "proxy_yaml": proxy.yaml, "name": proxy.name}
                except ValueError:
                    parsed_targets = []
            for item in parsed_targets:
                previous_count = len(targets)
                _add(targets, item)
                if probe_outbounds is not None and len(targets) > previous_count:
                    probe_outbounds.append(parsed_outbound)
        if not targets:
            warnings.append("Ссылки распознаны, но адреса серверов извлечь не удалось.")

    if not targets and text.lower().startswith("vpn://"):
        from services.amnezia_premium import import_connection_key
        from services.mihomo_proxy_parsers import parse_wireguard

        try:
            config = import_connection_key(text)
            parsed = parse_wireguard(config)
            parsed_proxies = []
            for index, item in enumerate(mihomo_text_targets("proxies:\n" + parsed.yaml, source="Amnezia Premium", probe_proxies=parsed_proxies)):
                previous_count = len(targets)
                _add(targets, item)
                if probe_outbounds is not None and len(targets) > previous_count:
                    probe_outbounds.append(parsed_proxies[index] if index < len(parsed_proxies) else None)
        except Exception:
            warnings.append("Не удалось получить конфигурацию Amnezia Premium. Проверьте ключ и доступ к сервису.")

    if not targets and (text.lower().startswith("tailscale://") or text.startswith("tskey-")):
        from services.mihomo_proxy_parsers import parse_tailscale

        parse_tailscale(text)
        warnings.append("Tailscale не задаёт отдельный адрес сервера в конфигурации. Проверьте его соединение в самом клиенте.")

    if not targets and allow_fetch and len(text.splitlines()) == 1 and text.lower().startswith(("https://", "http://", "happ://crypt")):
        from services.xray_subscriptions import fetch_subscription_body_for_xray

        try:
            body, _, fetch_meta = fetch_subscription_body_for_xray(
                text, timeout_seconds=6, max_request_variants=2
            )
            if len(body.encode("utf-8")) > 2_000_000:
                raise ValueError("Подписка слишком большая для диагностики.")
            nested_outbounds: list[dict | None] = []
            nested = parse_source(body, allow_fetch=False, probe_outbounds=nested_outbounds, core=core)
            targets = nested["targets"]
            if probe_outbounds is not None:
                probe_outbounds.extend(nested_outbounds)
            warnings.extend(nested["warnings"])
            warnings.extend(fetch_meta.get("warnings") or [])
            truncated = nested["truncated"]
        except Exception:
            warnings.append("Не удалось получить или разобрать подписку; проверьте её доступ и авторизацию.")
        if not targets and text.lower().startswith(("https://", "http://")) and not subscription_url:
            _add(targets, _plain_target(text))

    if not targets and not links and not subscription_url and not text.lower().startswith(("happ://", "vpn://")):
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        truncated = len(lines) > MAX_TARGETS
        if not any(line.startswith(("{", "- ", "#")) for line in lines[:MAX_TARGETS]):
            for line in lines[:MAX_TARGETS]:
                try:
                    _add(targets, _plain_target(line))
                except ValueError:
                    warnings.append("Один или несколько адресов не распознаны.")
    if not targets and not warnings:
        warnings.append("Адреса серверов не найдены. Проверьте формат входных данных.")
    return {"targets": targets, "warnings": warnings, "truncated": truncated}


def register_proxy_context(outbounds: list[dict | None], target_count: int, targets: list[dict] | None = None) -> str:
    if not any(isinstance(item, dict) for item in outbounds):
        return ""
    token = secrets.token_urlsafe(32)
    now = time.monotonic()
    entries = (outbounds[:target_count] + [None] * target_count)[:target_count]
    with _PROXY_CONTEXT_LOCK:
        for key, cached in list(_PROXY_CONTEXTS.items()):
            expires_at = cached[0]
            if expires_at <= now:
                del _PROXY_CONTEXTS[key]
        while len(_PROXY_CONTEXTS) >= _PROXY_CONTEXT_LIMIT:
            _PROXY_CONTEXTS.popitem(last=False)
        _PROXY_CONTEXTS[token] = (now + _PROXY_CONTEXT_TTL, entries, targets or [])
    return token


def _proxy_context(token: str, index: int) -> tuple[dict, dict | None]:
    if not isinstance(token, str) or len(token) > 100 or type(index) is not int:
        raise ValueError("Некорректная проверка прокси.")
    with _PROXY_CONTEXT_LOCK:
        cached = _PROXY_CONTEXTS.get(token)
        if cached is None or cached[0] <= time.monotonic() or not 0 <= index < len(cached[1]):
            raise ValueError("Данные прокси устарели. Загрузите список серверов заново.")
        entry = cached[1][index]
        target = cached[2][index] if index < len(cached[2]) else None
    if not isinstance(entry, dict):
        raise ValueError("Для этого сервера проверка через прокси недоступна.")
    return entry, target


def _mihomo_probe_config(entry: dict, port: int) -> str:
    from services.mihomo_proxy_parsers import _yaml_append_list_item, _yaml_str

    proxy = entry.get("proxy")
    proxy_yaml = entry.get("proxy_yaml")
    name = str(entry.get("name") or (proxy.get("name") if isinstance(proxy, dict) else "") or "diagnostics-node")
    lines = [
        f"mixed-port: {port}",
        "allow-lan: false",
        "mode: rule",
        "log-level: warning",
        "proxies:",
    ]
    if isinstance(proxy, dict):
        _yaml_append_list_item(lines, 2, {**proxy, "name": name})
    elif isinstance(proxy_yaml, str) and proxy_yaml.strip():
        lines.extend(proxy_yaml.rstrip().splitlines())
    else:
        raise ValueError("Параметры прокси Mihomo не найдены.")
    lines.extend([
        "proxy-groups:",
        "  - name: xkeen-diagnostics",
        "    type: select",
        "    proxies:",
        f"      - {_yaml_str(name)}",
        "rules:",
        "  - MATCH,xkeen-diagnostics",
    ])
    return "\n".join(lines) + "\n"


def _probe_mihomo_proxy(entry: dict) -> dict:
    from services.mihomo_runtime import _mihomo_binary
    from services.xray_observatory import DEFAULT_PROBE_URL
    from services.xray_subscriptions import (
        _probe_once_via_local_proxy,
        _reserve_local_port,
        _terminate_process,
        _wait_for_local_port,
    )

    binary = _mihomo_binary()
    if not binary:
        return {"status": "unavailable", "message": "Для проверки прокси на панели нужен установленный Mihomo."}
    with tempfile.TemporaryDirectory(prefix="xkeen-mihomo-diagnostics-") as temp_dir:
        port = _reserve_local_port()
        config_path = Path(temp_dir) / "probe.yaml"
        config_path.write_text(_mihomo_probe_config(entry, port), encoding="utf-8")
        process = subprocess.Popen(
            [binary, "-d", temp_dir, "-f", str(config_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            if not _wait_for_local_port(port, process, 4):
                return {"status": "unavailable", "message": "Временный Mihomo не запустился с параметрами этого узла."}
            delay_ms, _ = _probe_once_via_local_proxy(port, DEFAULT_PROBE_URL, 4.0)
            if delay_ms is None:
                delay_ms, _ = _probe_once_via_local_proxy(port, "https://cp.cloudflare.com/generate_204", 4.0)
            if delay_ms is not None:
                return {"status": "ok", "delay_ms": delay_ms, "message": "Прокси передал HTTPS-запрос к контрольному адресу."}
            return {"status": "failed", "message": "Запрос через прокси не прошёл. Проверьте параметры узла и маршрут панели."}
        finally:
            _terminate_process(process)


@_needs_engines
def probe_proxy_context(token: str, index: int) -> dict:
    if not isinstance(token, str) or len(token) > 100 or not isinstance(index, int):
        raise ValueError("Некорректная проверка прокси.")
    with _PROXY_CONTEXT_LOCK:
        cached = _PROXY_CONTEXTS.get(token)
        if cached is None or cached[0] <= time.monotonic() or not 0 <= index < len(cached[1]):
            raise ValueError("Данные прокси устарели. Загрузите список серверов заново.")
        outbound = cached[1][index]
    if not isinstance(outbound, dict):
        return {"status": "unsupported", "message": "Для этого формата протокольная проверка пока недоступна."}
    if not _PROXY_PROBE_SLOTS.acquire(blocking=False):
        return {"status": "busy", "message": "Уже выполняются проверки прокси. Повторите через несколько секунд."}
    try:
        if outbound.get("_diagnostics_engine") == "mihomo":
            return _probe_mihomo_proxy(outbound)
        from services.xray_observatory import DEFAULT_PROBE_URL
        from services.xray_subscriptions import _find_xray_binary, _probe_outbounds_batch

        binary = _find_xray_binary()
        if not binary:
            return {"status": "unavailable", "message": "Для проверки прокси на панели нужен установленный Xray."}
        result = _probe_outbounds_batch(
            xray_bin=binary,
            targets=[{"key": "diagnostics", "tag": "diagnostics", "outbound": {**outbound, "tag": "diagnostics"}}],
            probe_url=DEFAULT_PROBE_URL,
            timeout_value=4.0,
            concurrency=1,
        ).get("diagnostics") or {}
        if result.get("delay_ms") is not None:
            return {
                "status": "ok",
                "delay_ms": result["delay_ms"],
                "message": "Прокси передал HTTPS-запрос к контрольному адресу.",
            }
        failure_messages = {
            "timeout": "Запрос через прокси превысил время ожидания.",
            "connection_refused": "Соединение через прокси отклонено.",
            "connection_reset": "Соединение через прокси было сброшено.",
            "network_unreachable": "Маршрут к серверу прокси недоступен.",
            "dns_error": "Через прокси не удалось разрешить имя контрольного адреса.",
            "tls_certificate_error": "Сертификат при запросе через прокси не прошёл проверку.",
            "tls_access_denied": "TLS-запрос через прокси был отклонён.",
        }
        return {
            "status": "failed",
            "message": failure_messages.get(result.get("error_code"), "Запрос через прокси не прошёл. Проверьте параметры узла и маршрут панели."),
        }
    except ImportError:
        # The code of an engine module is missing: a retry never helps, the
        # guard of the entry point names the module instead.
        raise
    except Exception:
        return {"status": "unavailable", "message": "Проверка прокси не выполнена. Повторите запрос позже."}
    finally:
        _PROXY_PROBE_SLOTS.release()


def _resource_url(raw: object) -> tuple[str, str, int, str]:
    value = str(raw or "").strip()
    if not value or len(value) > 2048 or any(ord(char) < 32 for char in value):
        raise ValueError("Введите публичный URL длиной до 2048 символов.")
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError
        host = _host(parsed.hostname)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise ValueError("Укажите публичный HTTP или HTTPS URL без логина и пароля.") from exc
    if host == "localhost" or ("." not in host and not _is_ip_address(host)) or host.endswith((".local", ".lan", ".home", ".internal", ".test", ".invalid", ".example")):
        raise ValueError("Локальные адреса нельзя проверять через диагностический прокси.")
    if _is_ip_address(host) and not ipaddress.ip_address(host).is_global:
        raise ValueError("Локальные адреса нельзя проверять через диагностический прокси.")
    path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
    if parsed.query:
        path += "?" + quote(parsed.query, safe="/?%:@!$&'()*+,;=-._~")
    return parsed.scheme, host, port, path


def _resource_addresses(host: str, port: int) -> list[tuple]:
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        return []
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError("DNS вернул локальный или служебный адрес; проверка отменена.")
    return addresses[:4]


def _xkeen_direct_mark(*, ipv6: bool = False) -> int | None:
    # Only mark the probe after confirming XKeen returns that mark before REDIRECT.
    if not sys.platform.startswith("linux"):
        return 0
    tool = "ip6tables" if ipv6 else "iptables"
    for binary in ("/opt/sbin/" + tool, tool):
        try:
            output = subprocess.run([binary, "-t", "nat", "-S", "OUTPUT"], capture_output=True, text=True, timeout=2)
        except FileNotFoundError:
            continue
        except (OSError, subprocess.TimeoutExpired):
            return None
        if output.returncode:
            return None
        rules = [shlex.split(line) for line in output.stdout.splitlines()]
        if not any(rule[:2] == ["-A", "OUTPUT"] and "-j" in rule and rule[rule.index("-j") + 1:] == ["xkeen_out"] for rule in rules):
            return 0
        try:
            chain = subprocess.run([binary, "-t", "nat", "-S", "xkeen_out"], capture_output=True, text=True, timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            return None
        if chain.returncode:
            return None
        for line in chain.stdout.splitlines():
            rule = shlex.split(line)
            if rule[:2] != ["-A", "xkeen_out"] or "-j" not in rule:
                continue
            target = rule[rule.index("-j") + 1]
            if target == "RETURN" and "--mark" in rule and rule[rule.index("--mark") + 1].lower() == "0xff":
                return 0xff
            if target != "RETURN":
                return None
        return None
    return None


def _address_direct_mark(address: tuple, ipv4_mark: int | None) -> int | None:
    # IPv4 OUTPUT exclusions say nothing about the IPv6 firewall.
    if address[0] == socket.AF_INET6 and sys.platform.startswith("linux"):
        return _xkeen_direct_mark(ipv6=True)
    return ipv4_mark


def _mark_direct_socket(connection: socket.socket, bypass_mark: int) -> bool:
    if not bypass_mark:
        return True
    try:
        connection.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_MARK", 36), bypass_mark)
        return True
    except OSError:
        return False


def _resource_http_request(parts: tuple[str, str, int, str], *, address: tuple | None = None, proxy_port: int | None = None, bypass_mark: int = 0, transfer_bytes: int = 0, duration: float = 12, paced: bool = False) -> dict:
    scheme, host, port, path = parts
    started = time.monotonic()
    result: dict = {"status": "tcp_error", "dns": "через прокси" if proxy_port else "локальный", "tcp_ms": None, "tls_ms": None, "http_status": None}
    sock = None
    timer = None
    expired = threading.Event()
    stage = "tcp"
    if transfer_bytes:
        result.update(requested_bytes=transfer_bytes, bytes_received=0, first_byte_ms=None, last_progress_ms=None, checkpoints=[])

    def expire():
        expired.set()
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    try:
        endpoint = ("127.0.0.1", proxy_port) if proxy_port else address[4]
        if proxy_port:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(4)
        else:
            sock = socket.socket(address[0], address[1], address[2])
            sock.settimeout(4)
            if not _mark_direct_socket(sock, bypass_mark):
                result["status"] = "route_unverified"
                return result
        if transfer_bytes:
            timer = threading.Timer(duration, expire)
            timer.daemon = True
            timer.start()
        sock.connect(endpoint)
        result["tcp_ms"] = round((time.monotonic() - started) * 1000)
        pinned_ip = address[4][0]
        result["connected_ip"] = pinned_ip
        host_authority = f"[{host}]" if ":" in host else host
        if port != (443 if scheme == "https" else 80):
            host_authority += f":{port}"
        if proxy_port and scheme == "https":
            stage = "proxy_connect"
            connect_authority = f"[{pinned_ip}]:{port}" if ":" in pinned_ip else f"{pinned_ip}:{port}"
            sock.sendall(f"CONNECT {connect_authority} HTTP/1.1\r\nHost: {host_authority}\r\n\r\n".encode("ascii"))
            tunnel = http.client.HTTPResponse(sock)
            tunnel.begin()
            if tunnel.status != 200:
                result.update(status="proxy_error", http_status=tunnel.status)
                return result
        if scheme == "https":
            stage = "tls"
            tls_started = time.monotonic()
            try:
                context = ssl.create_default_context()
                if transfer_bytes:
                    sock = context.wrap_socket(sock, server_hostname=host, do_handshake_on_connect=False)
                    sock.do_handshake()
                else:
                    sock = context.wrap_socket(sock, server_hostname=host)
            except ssl.SSLCertVerificationError:
                result["status"] = "tls_cert_error"
                return result
            except TimeoutError:
                result["status"] = "tls_timeout"
                return result
            except (ssl.SSLError, OSError):
                result["status"] = "tls_error"
                return result
            result["tls_ms"] = round((time.monotonic() - tls_started) * 1000)
            certificate = sock.getpeercert()
            names = [value for kind, value in certificate.get("subjectAltName", ()) if kind == "DNS"]
            if names:
                result["certificate_name"] = str(names[0])[:253]
        pinned_authority = f"[{pinned_ip}]" if ":" in pinned_ip else pinned_ip
        request_path = f"http://{pinned_authority}:{port}{path}" if proxy_port and scheme == "http" else path
        stage = "http_headers"
        sock.sendall(f"GET {request_path} HTTP/1.1\r\nHost: {host_authority}\r\nUser-Agent: Xkeen-UI-Diagnostics/1\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n".encode("ascii"))
        response = http.client.HTTPResponse(sock)
        response.begin()
        result.update(status="http_response", http_status=response.status)
        location = response.getheader("Location")
        if location:
            result["redirect_host"] = urlsplit(location).hostname or host
        if transfer_bytes:
            if response.status != 200 or response.getheader("Content-Encoding", "identity").lower() != "identity":
                result["status"] = "unexpected_response"
                return result
            stage = "body"
            while result["bytes_received"] < transfer_bytes:
                chunk = response.read1(min(4096, transfer_bytes - result["bytes_received"]))
                if not chunk:
                    result["status"] = "transfer_timeout" if expired.is_set() else "transfer_short"
                    break
                elapsed = round((time.monotonic() - started) * 1000)
                if result["first_byte_ms"] is None:
                    result["first_byte_ms"] = elapsed
                before = result["bytes_received"]
                result["bytes_received"] += len(chunk)
                result["last_progress_ms"] = elapsed
                for threshold in (4096, 8192, 16384, 20480, 32768, 65536, 131072, 262144):
                    if before < threshold <= result["bytes_received"]:
                        result["checkpoints"].append({"bytes": threshold, "ms": elapsed})
                if expired.is_set():
                    result["status"] = "transfer_timeout"
                    break
            else:
                result["status"] = "transfer_ok"
            return result
        sample = response.read(4096)
        text = sample.decode("utf-8", errors="ignore").lower()
        result["block_page_hint"] = response.status == 451 or any(marker in text for marker in (
            "роскомнадзор", "доступ к информационному ресурсу ограничен",
            "доступ к сайту ограничен", "this site is blocked", "access to this site has been restricted",
        ))
    except socket.gaierror:
        result["status"] = "dns_error"
    except (OSError, http.client.HTTPException) as error:
        result["status"] = "http_error" if result["tcp_ms"] is not None else "tcp_error"
        if transfer_bytes:
            result["status"] = ("transfer_timeout" if expired.is_set() or isinstance(error, TimeoutError)
                                else "transfer_reset" if isinstance(error, ConnectionResetError)
                                else "transfer_error")
    finally:
        if timer is not None:
            timer.cancel()
        if sock is not None:
            sock.close()
        result["total_ms"] = round((time.monotonic() - started) * 1000)
        if transfer_bytes:
            result["stage"] = stage
            result["paced"] = paced
    return result


@contextmanager
def _resource_proxy_session(entry: dict):
    from services.xray_subscriptions import _reserve_local_port, _start_probe_process, _terminate_process, _wait_for_local_port, _build_batch_probe_config, _find_xray_binary
    mihomo = entry.get("_diagnostics_engine") == "mihomo"
    if mihomo:
        from services.mihomo_runtime import _mihomo_binary
    binary = _mihomo_binary() if mihomo else _find_xray_binary()
    if not binary:
        yield {"status": "core_unavailable"}
        return
    with tempfile.TemporaryDirectory(prefix="xkeen-resource-diagnostics-") as temp_dir:
        port = _reserve_local_port()
        process = None
        try:
            if mihomo:
                config_path = Path(temp_dir) / "probe.yaml"
                config_path.write_text(_mihomo_probe_config(entry, port), encoding="utf-8")
                process = subprocess.Popen([binary, "-d", temp_dir, "-f", str(config_path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                ready = _wait_for_local_port(port, process, 4)
            else:
                config_path = Path(temp_dir) / "probe.json"
                config = _build_batch_probe_config([{"port": port, "outbound": {**entry, "tag": "diagnostics"}}])
                config_path.write_text(json.dumps(config), encoding="utf-8")
                process, _ = _start_probe_process(xray_bin=binary, config_path=str(config_path), wait_ports=[port])
                ready = process is not None
        except (OSError, subprocess.SubprocessError):
            if process is not None:
                _terminate_process(process)
            yield {"status": "core_start_failed"}
            return
        if not ready:
            if mihomo:
                _terminate_process(process)
            yield {"status": "core_start_failed"}
            return
        try:
            yield {"status": "ok", "port": port}
        finally:
            _terminate_process(process)


def _resource_via_proxy(entry: dict, parts: tuple[str, str, int, str], address: tuple) -> dict:
    with _resource_proxy_session(entry) as session:
        if session["status"] != "ok":
            return session
        return _resource_http_request(parts, address=address, proxy_port=session["port"])


@_needs_engines
def compare_resource_paths(raw: dict) -> dict:
    parts = _resource_url(raw.get("url"))
    token, index = raw.get("ref"), raw.get("index")
    if not isinstance(token, str) or len(token) > 100 or not isinstance(index, int):
        raise ValueError("Выберите сервер для проверки ресурса.")
    with _PROXY_CONTEXT_LOCK:
        cached = _PROXY_CONTEXTS.get(token)
        if cached is None or cached[0] <= time.monotonic() or not 0 <= index < len(cached[1]):
            raise ValueError("Данные прокси устарели. Загрузите список серверов заново.")
        entry = cached[1][index]
    if not isinstance(entry, dict):
        raise ValueError("Для этого сервера проверка через прокси недоступна.")
    if not _RESOURCE_PROBE_SLOTS.acquire(blocking=False):
        return {"status": "busy", "message": "Идут другие проверки ресурсов."}
    try:
        scheme, host, port, _ = parts
        addresses = _resource_addresses(host, port)
        local_dns_failed = not addresses
        dns_source = "local"
        if local_dns_failed and not _is_ip_address(host):
            public_dns = compare_public_dns({"host": host})
            public_ips = [ip for ip in public_dns.get("public", []) if _is_ip_address(ip) and ipaddress.ip_address(ip).is_global]
            if public_ips:
                addresses = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (public_ips[0], port))]
                dns_source = "public_fallback"
        if addresses:
            bypass_mark = _address_direct_mark(addresses[0], _xkeen_direct_mark())
            direct = (_resource_http_request(parts, address=addresses[0], bypass_mark=bypass_mark)
                      if bypass_mark is not None else {"status": "route_unverified"})
        else:
            direct = {"status": "dns_error"}
        direct["dns_ips"] = [item[4][0] for item in addresses]
        direct["dns_source"] = dns_source
        proxy = _resource_via_proxy(entry, parts, addresses[0]) if addresses else {"status": "skipped_dns"}
        direct_response = direct["status"] == "http_response"
        proxy_response = proxy["status"] == "http_response"
        direct_ok = direct_response and 200 <= direct["http_status"] < 300 and not direct.get("block_page_hint")
        proxy_ok = proxy_response and 200 <= proxy["http_status"] < 300 and not proxy.get("block_page_hint")
        if direct["status"] == "route_unverified":
            network = {"verdict": "direct_unverified", "confidence": "low"}
        elif local_dns_failed and addresses and direct_ok and proxy_ok:
            network = {"verdict": "local_dns_failure", "confidence": "medium"}
        elif direct_response and proxy_response and direct.get("block_page_hint") and not proxy.get("block_page_hint"):
            network = {"verdict": "direct_block_page", "confidence": "medium"}
        elif direct_response and proxy_response and direct_ok and proxy_ok and direct.get("http_status") == proxy.get("http_status"):
            network = {"verdict": "both_reachable", "confidence": "high"}
        elif direct_response and proxy_response and 300 <= direct["http_status"] < 400 and 300 <= proxy["http_status"] < 400:
            network = {"verdict": "both_redirects", "confidence": "low"}
        elif not direct_response and proxy_response and 300 <= proxy["http_status"] < 400:
            network = {"verdict": "proxy_redirect_only", "confidence": "low"}
        elif direct_response and proxy_response and direct.get("http_status") == proxy.get("http_status"):
            network = {"verdict": "both_http_errors", "confidence": "low"}
        elif direct_response and proxy_response:
            network = {"verdict": "different_response", "confidence": "low"}
        elif proxy_ok and not direct_ok:
            network = {"verdict": "proxy_only", "confidence": "medium"}
        elif direct_ok:
            network = {"verdict": "direct_only", "confidence": "medium"}
        else:
            network = {"verdict": "undetermined", "confidence": "low"}
        registry = lookup_public_lists({"host": host})
        registry_result = {"status": registry.get("status"), "listed": registry.get("listed") is True,
                           "match": registry.get("registry_domain") or ", ".join(registry.get("blocked_subnets") or [])}
        return {"status": "ok", "resource_host": host, "scheme": scheme, "port": port,
                "direct": direct, "proxy": proxy, "network": network, "registry": registry_result}
    finally:
        _RESOURCE_PROBE_SLOTS.release()


def _distinct_addresses(addresses: list, limit: int = 4) -> list:
    """Keep both IP families even when a resolver lists all IPv4 addresses first."""
    families = {socket.AF_INET: [], socket.AF_INET6: []}
    seen = set()
    for item in addresses:
        if item[0] in families and item[4][0] not in seen:
            families[item[0]].append(item)
            seen.add(item[4][0])
    ordered = []
    for index in range(limit):
        for items in families.values():
            if index < len(items):
                ordered.append(items[index])
    return ordered[:limit]


def _probe_address(target: dict, address: tuple, bypass_mark: int, *, timeout: float = 2.5) -> dict:
    family, socktype, proto, _, endpoint = address
    result = {"ip": endpoint[0], "family": "IPv6" if family == socket.AF_INET6 else "IPv4", "stage": "tcp"}
    started = time.monotonic()
    try:
        with socket.socket(family, socktype, proto) as connection:
            connection.settimeout(timeout)
            if not _mark_direct_socket(connection, bypass_mark):
                return {**result, "status": "route_unverified"}
            connection.connect(endpoint)
            result.update(tcp_ms=round((time.monotonic() - started) * 1000), connected_ip=endpoint[0], source_ip=connection.getsockname()[0])
            if target["tls"]:
                result["stage"] = "tls"
                tls_started = time.monotonic()
                tls_name = target["sni"] or target["host"]
                result["sni_sent"] = not _is_ip_address(tls_name)
                context = ssl.create_default_context()
                if not target["verify_tls"]:
                    context.check_hostname = False
                    context.verify_mode = ssl.CERT_NONE
                try:
                    with context.wrap_socket(connection, server_hostname=tls_name):
                        pass
                except ssl.SSLCertVerificationError:
                    return {**result, "status": "tls_cert_error"}
                except TimeoutError:
                    return {**result, "status": "tls_timeout"}
                except ConnectionResetError:
                    return {**result, "status": "tls_reset"}
                except OSError:
                    return {**result, "status": "tls_error"}
                result["tls_ms"] = round((time.monotonic() - tls_started) * 1000)
            return {**result, "status": "reachable", "stage": "complete"}
    except TimeoutError:
        return {**result, "status": "timeout"}
    except ConnectionRefusedError:
        return {**result, "status": "refused"}
    except ConnectionResetError:
        return {**result, "status": "reset"}
    except OSError:
        return {**result, "status": "unreachable"}


def probe_target(raw: dict) -> dict:
    target = make_target(raw.get("host"), raw.get("port"), name=raw.get("name"), protocol=raw.get("protocol"), network=raw.get("network"), tls=raw.get("tls") is True, tls_mode=raw.get("tls_mode") or "", sni=raw.get("sni") or "", verify_tls=raw.get("verify_tls") is not False, source=raw.get("source"))
    if not _PROBE_SLOTS.acquire(blocking=False):
        return {**target, "status": "busy", "message": "Идут другие проверки. Повторите чуть позже."}
    try:
        started = time.monotonic()
        try:
            addresses = socket.getaddrinfo(target["host"], target["port"], type=socket.SOCK_STREAM if target["network"] == "tcp" else socket.SOCK_DGRAM)
        except OSError:
            return {**target, "status": "dns_error", "stage": "dns", "message": "DNS не разрешил имя сервера."}
        unique = _distinct_addresses(addresses)
        base = {**target, "addresses": [item[4][0] for item in unique], "dns_ms": round((time.monotonic() - started) * 1000)}
        if target["network"] == "udp":
            return {**base, "status": "udp_unknown", "message": "Адрес разрешён. Доступность UDP нельзя подтвердить без протокольного обмена."}
        bypass_mark = _xkeen_direct_mark()
        if bypass_mark is None:
            return {**base, "status": "route_unverified", "message": "Прямой путь не проверен: обход правил роутера недоступен."}
        attempts = []
        for address in unique:
            family_mark = _address_direct_mark(address, bypass_mark)
            attempts.append(_probe_address(target, address, family_mark) if family_mark is not None else {"ip": address[4][0], "family": "IPv6" if address[0] == socket.AF_INET6 else "IPv4", "status": "route_unverified", "stage": "tcp"})
            if attempts[-1]["status"] == "route_unverified":
                return {**base, "status": "route_unverified", "address_results": attempts, "message": "Прямой путь не проверен: метку сокета установить не удалось."}
        priority = ("reachable", "tls_cert_error", "tls_timeout", "tls_reset", "tls_error", "timeout", "refused", "reset", "unreachable")
        primary = next((item for status in priority for item in attempts if item["status"] == status), {"status": "unreachable"})
        messages = {
            "reachable": "TCP и стандартный TLS доступны. Работа прокси не проверялась." if target["tls"] else "TCP доступен. REALITY и работа прокси не проверялись." if target["tls_mode"] == "reality" else "TCP доступен. Работа прокси не проверялась.",
            "tls_cert_error": "TLS ответил, но сертификат не прошёл проверку. Это не указывает на блокировку.",
            "tls_timeout": "TCP доступен, но TLS-рукопожатие не ответило вовремя. Причина не установлена.",
            "tls_reset": "TCP доступен, соединение сброшено на этапе TLS. Причина не установлена.",
            "tls_error": "TCP доступен, но стандартный TLS не прошёл. Проверьте SNI и сертификат; фильтрация не подтверждена.",
            "timeout": "TCP не ответил вовремя. Возможна фильтрация, но это не доказательство блокировки.",
            "refused": "Сервер отклонил TCP-подключение. Порт может быть закрыт.",
            "reset": "TCP-соединение сброшено. Причина не установлена.",
            "unreachable": "Нет маршрута или соединение не удалось установить.",
        }
        message = messages[primary["status"]]
        mixed = len({item["status"] for item in attempts}) > 1
        if mixed:
            message += " Адреса ответили по-разному; смотрите результаты по IP."
        if primary["status"] == "reachable" and target["tls"] and not target["verify_tls"]:
            message += " Сертификат не проверялся по настройке узла."
        return {**base, **primary, "address_results": attempts, "mixed_addresses": mixed, "message": message}
    finally:
        _PROBE_SLOTS.release()


def _tls_comparison_attempt(address: tuple, *, server_name: str | None, bypass_mark: int = 0) -> str:
    family, socktype, proto, _, endpoint = address
    try:
        with socket.socket(family, socktype, proto) as connection:
            connection.settimeout(2)
            if not _mark_direct_socket(connection, bypass_mark):
                return "route_unverified"
            try:
                connection.connect(endpoint)
            except TimeoutError:
                return "tcp_timeout"
            except ConnectionRefusedError:
                return "refused"
            except OSError:
                return "unreachable"
            try:
                context = ssl.create_default_context()
                context.check_hostname = False
                context.verify_mode = ssl.CERT_NONE
                with context.wrap_socket(connection, server_hostname=server_name):
                    return "tls_ok"
            except TimeoutError:
                return "tls_timeout"
            except (ssl.SSLError, OSError):
                return "tls_error"
    except OSError:
        return "unreachable"


def _tls_trials_pattern(trials: dict[str, list[str]]) -> str:
    with_sni, without_sni = trials["with_sni"], trials["without_sni"]
    if all(item in {"tls_error", "tls_timeout"} for item in with_sni) and all(item == "tls_ok" for item in without_sni):
        return "sni_only_failure"
    if all(item == "tls_ok" for item in with_sni):
        return "tls_reachable"
    if all(item in {"tcp_timeout", "timeout"} for item in with_sni + without_sni):
        return "tcp_unresponsive"
    if all(item == "tls_timeout" for item in with_sni + without_sni):
        return "tls_stalled"
    return "mixed"


def compare_tls_path(raw: dict) -> dict:
    target = make_target(raw.get("host"), raw.get("port"), network=raw.get("network"), tls=raw.get("tls") is True, tls_mode=raw.get("tls_mode") or "", sni=raw.get("sni") or "")
    if target["network"] != "tcp" or target["tls_mode"] != "standard":
        raise ValueError("Сравнение SNI доступно только для стандартного TLS поверх TCP.")
    sni = target["sni"] or target["host"]
    if _is_ip_address(sni):
        raise ValueError("Для сравнения нужен домен SNI.")
    if not _COMPARE_PROBE_SLOTS.acquire(blocking=False):
        return {"status": "busy", "message": "Идёт другая сравнительная проверка."}
    try:
        bypass_mark = _xkeen_direct_mark()
        if bypass_mark is None:
            return {"status": "route_unverified", "message": "Прямой путь не проверен: обход правил роутера недоступен."}
        controls = []
        for ip, name in _TLS_CONTROLS:
            control_address = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, 443))
            control = _tls_comparison_attempt(control_address, server_name=name, bypass_mark=bypass_mark)
            if control == "route_unverified":
                return {"status": "route_unverified", "message": "Прямой путь не проверен: метку сокета установить не удалось."}
            controls.append({"ip": ip, "sni": name, "result": control})
        control_ok = any(item["result"] == "tls_ok" for item in controls)
        addresses = []
        try:
            addresses = _distinct_addresses(socket.getaddrinfo(target["host"], target["port"], type=socket.SOCK_STREAM), _TLS_COMPARE_IP_LIMIT)
        except OSError:
            pass
        address_results = []
        for address in addresses:
            family_mark = _address_direct_mark(address, bypass_mark)
            if family_mark is None:
                return {"status": "route_unverified", "message": "Прямой IPv6-путь не проверен: исключение в межсетевом экране недоступно."}
            trials = {"with_sni": [], "without_sni": []}
            for _ in range(_TLS_COMPARE_ROUNDS):
                with_sni = _tls_comparison_attempt(address, server_name=sni, bypass_mark=family_mark)
                without_sni = _tls_comparison_attempt(address, server_name=None, bypass_mark=family_mark)
                if "route_unverified" in {with_sni, without_sni}:
                    return {"status": "route_unverified", "message": "Прямой путь не проверен: метку сокета установить не удалось."}
                trials["with_sni"].append(with_sni)
                trials["without_sni"].append(without_sni)
                pattern = _tls_trials_pattern(trials)
                if pattern not in {"sni_only_failure", "tcp_unresponsive", "tls_stalled"}:
                    break
            address_results.append({"ip": address[4][0], **trials, "pattern": pattern})
        rounds_per_ip = max((len(item["with_sni"]) for item in address_results), default=0)
        attempts_total = len(controls) + sum(len(item["with_sni"]) + len(item["without_sni"]) for item in address_results)

        dns_comparison = {"status": "skipped"}
        if not addresses and not _is_ip_address(target["host"]):
            try:
                dns_comparison = compare_public_dns({"host": target["host"]})
            except ValueError:
                pass
        try:
            registry = lookup_public_lists({"host": sni})
        except ValueError:
            registry = {"status": "skipped"}
        patterns = [item["pattern"] for item in address_results]
        if not addresses and control_ok and dns_comparison.get("status") == "ok" and dns_comparison.get("public"):
            verdict, confidence, reason = "dns_failure", "medium", "local_dns_failed"
        elif control_ok and patterns and all(item == "sni_only_failure" for item in patterns):
            verdict, confidence, reason = "tls_sni_filtering", "medium" if len(patterns) > 1 else "low", "consistent_sni_pattern"
        elif control_ok and patterns and all(item == "tcp_unresponsive" for item in patterns):
            verdict, confidence, reason = "tcp_unresponsive", "low", "all_ips_tcp_timeout"
        elif control_ok and patterns and all(item == "tls_stalled" for item in patterns):
            verdict, confidence, reason = "tls_stalled", "low", "all_ips_tls_timeout"
        elif patterns and all(item == "tls_reachable" for item in patterns):
            verdict, confidence, reason = "tls_reachable", "medium", "tls_succeeded"
        else:
            reason = "control_failed" if not control_ok else "different_ip_results" if len(set(patterns)) > 1 else "insufficient_evidence"
            verdict, confidence = "undetermined", "low"
        primary = address_results[0] if address_results else {"with_sni": [], "without_sni": []}
        return {
            "status": "ok", "verdict": verdict, "confidence": confidence, "reason": reason,
            "target_ip": addresses[0][4][0] if addresses else None, "port": target["port"], "sni": sni,
            "trials": {"with_sni": primary["with_sni"], "without_sni": primary["without_sni"]},
            "address_results": address_results, "rounds_per_ip": rounds_per_ip, "attempts_total": attempts_total,
            "control": controls[0], "controls": controls,
            "dns_comparison": {"status": dns_comparison.get("status"), "public": dns_comparison.get("public") or []},
            "registry": {"status": registry.get("status"), "target": sni,
                         "listed": registry.get("listed") is True,
                         "domain": registry.get("registry_domain") or "", "subnets": registry.get("blocked_subnets") or []},
        }
    finally:
        _COMPARE_PROBE_SLOTS.release()


def compare_public_dns(raw: dict) -> dict:
    host = _host(raw.get("host"))
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ValueError("Для IP-адреса сравнение DNS не требуется.")
    if "." not in host or host.endswith((".local", ".lan", ".home", ".internal", ".test", ".invalid", ".example")):
        raise ValueError("Локальное имя нельзя отправлять публичному DNS.")
    if not _DNS_COMPARE_SLOTS.acquire(blocking=False):
        return {"host": host, "status": "busy", "message": "Идёт другое DNS-сравнение."}
    try:
        try:
            local = sorted({item[4][0] for item in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM) if item[0] == socket.AF_INET})[:8]
            local_error = False
        except OSError:
            local = []
            local_error = True
        query = urlencode({"name": host, "type": "A"})
        req = Request(f"https://dns.google/resolve?{query}", headers={"Accept": "application/dns-json", "User-Agent": "Xkeen-UI-Diagnostics/1"})
        with urlopen(req, timeout=3) as response:
            data = json.loads(response.read(16_384))
        public = sorted({str(item.get("data")) for item in data.get("Answer", []) if item.get("type") == 1 and _is_ip_address(item.get("data"))})[:8]
        return {"host": host, "status": "ok", "local": local, "public": public, "local_error": local_error, "different": bool(local and public and not set(local).intersection(public))}
    except (OSError, ValueError, TypeError, AttributeError):
        return {"host": host, "status": "unavailable", "message": "Публичный DNS сейчас недоступен; сравнение не выполнено."}
    finally:
        _DNS_COMPARE_SLOTS.release()


def _is_ip_address(value: object) -> bool:
    try:
        ipaddress.ip_address(str(value))
        return True
    except ValueError:
        return False


def lookup_public_lists(raw: dict) -> dict:
    host = _host(raw.get("host"))
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if "." not in host or host.endswith((".local", ".lan", ".home", ".internal", ".test", ".invalid", ".example")):
            raise ValueError("Локальное имя нельзя отправлять во внешний сервис.")
    else:
        if not address.is_global:
            raise ValueError("Локальный IP-адрес нельзя отправлять во внешний сервис.")
    if not _LIST_LOOKUP_SLOTS.acquire(blocking=False):
        return {"status": "busy", "message": "Идёт другая проверка по спискам."}
    try:
        query = urlencode({"target": host})
        request = Request(f"https://cheburcheck.ru/api/v1/check?{query}", headers={"Accept": "application/json", "User-Agent": "Xkeen-UI-Diagnostics/1"})
        with urlopen(request, timeout=5) as response:
            body = response.read(32_769)
        if len(body) > 32_768:
            raise ValueError("Ответ внешнего сервиса слишком большой.")
        data = json.loads(body)
        if not isinstance(data, dict):
            raise ValueError("Некорректный ответ внешнего сервиса.")
        cdn = data.get("cdn_providers") or {}
        geo = data.get("geo") or {}
        if not isinstance(cdn, dict) or not isinstance(geo, dict):
            raise ValueError("Некорректный ответ внешнего сервиса.")
        providers = []
        for name, networks in list(cdn.items())[:4]:
            if not isinstance(networks, list):
                continue
            cidrs = [str(item.get("cidr") or "")[:64] for item in networks[:3] if isinstance(item, dict)]
            providers.append({"name": str(name)[:60], "networks": [item for item in cidrs if item]})
        subnets = data.get("blocked_subnets") or []
        ips = data.get("ips") or []
        registry_domain = str(data.get("rkn_domain") or "")[:253]
        return {
            "status": "ok",
            "host": host,
            "listed": data.get("blocked") is True,
            "registry_domain": registry_domain,
            "blocked_subnets": [str(item)[:64] for item in subnets[:4]] if isinstance(subnets, list) else [],
            "cdn_providers": providers,
            "ips": [str(item) for item in ips[:4] if _is_ip_address(item)] if isinstance(ips, list) else [],
            "organization": str(geo.get("organisation") or "")[:100],
            "asn": str(geo.get("asn") or "")[:24],
            "location": str(geo.get("location") or "")[:100],
        }
    except HTTPError as exc:
        if exc.code == 429:
            return {"status": "rate_limited", "message": "Сервис ограничил частоту запросов. Повторите позже."}
        return {"status": "unavailable", "message": "Не удалось получить данные внешнего сервиса."}
    except (OSError, ValueError, TypeError, AttributeError):
        return {"status": "unavailable", "message": "Не удалось получить данные внешнего сервиса."}
    finally:
        _LIST_LOOKUP_SLOTS.release()
