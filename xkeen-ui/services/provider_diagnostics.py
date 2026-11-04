"""On-demand endpoint diagnostics for Xray and Mihomo configurations."""

from __future__ import annotations

import ipaddress
import json
import re
import socket
import threading
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from utils.jsonc import strip_json_comments_text


MAX_SOURCE_BYTES = 65_536
MAX_TARGETS = 24
_PROBE_SLOTS = threading.BoundedSemaphore(2)
_DNS_COMPARE_SLOTS = threading.BoundedSemaphore(1)
_LIST_LOOKUP_SLOTS = threading.BoundedSemaphore(1)
_UDP_PROTOCOLS = {"hysteria", "hysteria2", "hy2", "tuic", "wireguard", "anytls-quic"}
_SKIP_PROTOCOLS = {"direct", "freedom", "blackhole", "dns", "reject", "selector", "url-test", "fallback", "load-balance"}
_HOST_RE = re.compile(r"^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.?$")


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


def make_target(host: object, port: object, *, name: object = "", protocol: object = "", network: object = "tcp", tls: bool = False, source: object = "") -> dict:
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
    return {
        "name": clean_name,
        "host": clean_host,
        "port": clean_port,
        "protocol": str(protocol or "").strip().lower()[:32],
        "network": clean_network,
        "tls": bool(tls) and clean_network == "tcp",
        "source": str(source or "").strip()[:100],
    }


def _add(targets: list[dict], target: dict) -> None:
    key = (target["host"], target["port"], target["network"])
    if len(targets) < MAX_TARGETS and not any((item["host"], item["port"], item["network"]) == key for item in targets):
        targets.append(target)


def xray_outbound_targets(obj: object, *, source: str = "Xray") -> list[dict]:
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
        for endpoint in endpoints:
            try:
                _add(targets, make_target(endpoint.get("address") or endpoint.get("server"), endpoint.get("port"), name=name, protocol=protocol, network=network, source=source))
            except ValueError:
                continue
    return targets


def current_xray_targets(configs_dir: str) -> list[dict]:
    root = Path(configs_dir)
    targets: list[dict] = []
    if not root.is_dir():
        return targets
    for path in sorted(root.glob("*.json"))[:100]:
        try:
            if path.stat().st_size > 2_000_000:
                continue
            obj = json.loads(strip_json_comments_text(path.read_text(encoding="utf-8-sig")))
            for item in xray_outbound_targets(obj, source=path.name):
                _add(targets, item)
        except (OSError, UnicodeError, ValueError):
            continue
    return targets


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
                if key in {"name", "type", "server", "port"} and value.strip():
                    current[key] = _yaml_scalar(value)
        elif section == "proxy-providers":
            if indent <= 2 and stripped.endswith(":"):
                current = {"name": _yaml_scalar(stripped[:-1])}
                providers.append(current)
            elif current is not None and (stripped.startswith("url:") or stripped.startswith("path:")):
                key, value = stripped.split(":", 1)
                current[key] = _yaml_scalar(value)
    return proxies, providers


def mihomo_text_targets(text: str, *, source: str = "config.yaml") -> list[dict]:
    try:
        import yaml  # Optional on the router.

        obj = yaml.safe_load(text)
    except ImportError:
        obj = None
    except Exception:
        obj = None
    if isinstance(obj, dict):
        proxies = obj.get("proxies") if isinstance(obj.get("proxies"), list) else []
        raw_providers = obj.get("proxy-providers")
        providers = [{"name": name, **item} for name, item in raw_providers.items() if isinstance(item, dict)] if isinstance(raw_providers, dict) else []
    else:
        proxies, providers = _mihomo_blocks(text)
    targets: list[dict] = []
    for item in proxies:
        if not isinstance(item, dict):
            continue
        protocol = str(item.get("type") or "").lower()
        if protocol in _SKIP_PROTOCOLS:
            continue
        network = "udp" if protocol in _UDP_PROTOCOLS else "tcp"
        try:
            _add(targets, make_target(item.get("server"), item.get("port"), name=item.get("name"), protocol=protocol, network=network, source=source))
        except ValueError:
            continue
    for provider in providers:
        url = str(provider.get("url") or "")
        if url.startswith(("https://", "http://")):
            try:
                parsed = urlsplit(url)
                _add(targets, make_target(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), name=provider.get("name"), protocol="subscription", tls=parsed.scheme == "https", source=source))
            except ValueError:
                continue
    return targets


def current_mihomo_targets(config_file: str) -> list[dict]:
    path = Path(config_file)
    try:
        if path.stat().st_size > 2_000_000:
            return []
        text = path.read_text(encoding="utf-8-sig")
        targets = mihomo_text_targets(text, source=path.name)
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
                for item in mihomo_text_targets(provider_file.read_text(encoding="utf-8-sig"), source=provider_file.name):
                    _add(targets, item)
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


def parse_source(source: str, *, allow_fetch: bool = True) -> dict:
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
            for item in xray_outbound_targets(obj, source="Ввод"):
                _add(targets, item)
            if not targets:
                from services.xray_subscriptions import build_subscription_json_outbounds

                try:
                    outbounds, _, _ = build_subscription_json_outbounds(text, tag_prefix="diagnostics")
                    for item in xray_outbound_targets(outbounds, source="Подписка"):
                        _add(targets, item)
                except ValueError:
                    pass
            if isinstance(obj, dict) and ("proxies" in obj or "proxy-providers" in obj):
                for item in mihomo_text_targets(text, source="Ввод"):
                    _add(targets, item)
    if "proxies:" in text or "proxy-providers:" in text:
        for item in mihomo_text_targets(text, source="Ввод"):
            _add(targets, item)
    if not targets and ("[Interface]" in text or re.search(r"(?mi)^remote\s+\S+", text)):
        from services.mihomo_proxy_parsers import parse_openvpn, parse_wireguard

        parser = parse_wireguard if "[Interface]" in text else parse_openvpn
        parsed = parser(text)
        for item in mihomo_text_targets("proxies:\n" + parsed.yaml, source="Ввод"):
            _add(targets, item)

    links: list[str] = []
    if re.search(r"(?:vless|trojan|vmess|ss|hysteria2?|hy2)://", text, re.IGNORECASE) or (len(text) > 80 and "\n" not in text and not text.startswith(("http://", "https://", "vpn://"))):
        from services.xray_subscriptions import parse_subscription_links

        links = parse_subscription_links(text)
    if links:
        from services.xray_outbounds import build_proxy_outbound_from_link
        from services.mihomo_proxy_parsers import parse_proxy_uri

        truncated = len(links) > MAX_TARGETS
        for link in links[:MAX_TARGETS]:
            try:
                outbound = build_proxy_outbound_from_link(link, "Узел")
                parsed_targets = xray_outbound_targets(outbound, source="Ссылка")
            except ValueError:
                parsed_targets = []
            if not parsed_targets:
                try:
                    proxy = parse_proxy_uri(link)
                    parsed_targets = mihomo_text_targets("proxies:\n" + proxy.yaml, source="Ссылка")
                except ValueError:
                    parsed_targets = []
            for item in parsed_targets:
                _add(targets, item)
        if not targets:
            warnings.append("Ссылки распознаны, но адреса серверов извлечь не удалось.")

    if not targets and text.lower().startswith("vpn://"):
        from services.amnezia_premium import import_connection_key
        from services.mihomo_proxy_parsers import parse_wireguard

        try:
            config = import_connection_key(text)
            parsed = parse_wireguard(config)
            for item in mihomo_text_targets("proxies:\n" + parsed.yaml, source="Amnezia Premium"):
                _add(targets, item)
        except Exception:
            warnings.append("Не удалось получить конфигурацию Amnezia Premium. Проверьте ключ и доступ к сервису.")

    if not targets and (text.lower().startswith("tailscale://") or text.startswith("tskey-")):
        from services.mihomo_proxy_parsers import parse_tailscale

        parse_tailscale(text)
        warnings.append("Tailscale не задаёт отдельный адрес сервера в конфигурации. Проверьте его соединение в самом клиенте.")

    if not targets and allow_fetch and len(text.splitlines()) == 1 and text.lower().startswith(("https://", "http://", "happ://crypt")):
        from services.xray_subscriptions import fetch_subscription_body_for_xray

        try:
            body, _, _ = fetch_subscription_body_for_xray(text)
            if len(body.encode("utf-8")) > 2_000_000:
                raise ValueError("Подписка слишком большая для диагностики.")
            nested = parse_source(body, allow_fetch=False)
            targets = nested["targets"]
            warnings.extend(nested["warnings"])
        except Exception:
            warnings.append("Не удалось получить или разобрать подписку; проверьте её доступ и авторизацию.")
        if not targets and text.lower().startswith(("https://", "http://")):
            _add(targets, _plain_target(text))

    if not targets and not links and not text.lower().startswith(("happ://", "vpn://")):
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


def probe_target(raw: dict) -> dict:
    target = make_target(raw.get("host"), raw.get("port"), name=raw.get("name"), protocol=raw.get("protocol"), network=raw.get("network"), tls=raw.get("tls") is True, source=raw.get("source"))
    if not _PROBE_SLOTS.acquire(blocking=False):
        return {**target, "status": "busy", "message": "Идут другие проверки. Повторите чуть позже."}
    try:
        started = time.monotonic()
        try:
            addresses = socket.getaddrinfo(target["host"], target["port"], type=socket.SOCK_STREAM if target["network"] == "tcp" else socket.SOCK_DGRAM)
        except OSError:
            return {**target, "status": "dns_error", "message": "DNS не разрешил имя сервера."}
        unique: list[tuple] = []
        for item in addresses:
            if item[4][0] not in [entry[4][0] for entry in unique]:
                unique.append(item)
            if len(unique) >= 3:
                break
        dns_ms = round((time.monotonic() - started) * 1000)
        address_labels = [item[4][0] for item in unique]
        base = {**target, "addresses": address_labels, "dns_ms": dns_ms}
        if target["network"] == "udp":
            return {**base, "status": "udp_unknown", "message": "Адрес разрешён. Доступность UDP нельзя подтвердить без протокольного обмена."}
        failures: list[str] = []
        for family, socktype, proto, _, address in unique[:2]:
            try:
                with socket.socket(family, socktype, proto) as connection:
                    connection.settimeout(2.5)
                    connection_started = time.monotonic()
                    connection.connect(address)
                    tcp_ms = round((time.monotonic() - connection_started) * 1000)
                    if target["tls"]:
                        import ssl

                        try:
                            tls_started = time.monotonic()
                            with ssl.create_default_context().wrap_socket(connection, server_hostname=target["host"]):
                                pass
                        except OSError:
                            return {**base, "status": "tls_error", "tcp_ms": tcp_ms, "message": "TCP доступен, но стандартный TLS не прошёл. Проверьте SNI и сертификат."}
                        return {**base, "status": "reachable", "tcp_ms": tcp_ms, "tls_ms": round((time.monotonic() - tls_started) * 1000), "message": "TCP и стандартный TLS доступны."}
                    return {**base, "status": "reachable", "tcp_ms": tcp_ms, "message": "Соединение установлено."}
            except socket.timeout:
                failures.append("timeout")
            except ConnectionRefusedError:
                failures.append("refused")
            except OSError:
                failures.append("unreachable")
        status = "timeout" if "timeout" in failures else ("refused" if "refused" in failures else "unreachable")
        messages = {
            "timeout": "TCP не ответил вовремя. Возможна фильтрация, но это не доказательство блокировки.",
            "refused": "Сервер отклонил TCP-подключение. Порт может быть закрыт.",
            "unreachable": "Нет маршрута или соединение не удалось установить.",
        }
        return {**base, "status": status, "message": messages[status]}
    finally:
        _PROBE_SLOTS.release()


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
