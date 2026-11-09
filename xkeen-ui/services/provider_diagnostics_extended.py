"""Bounded, opt-in transfer diagnostics using the node's actual proxy engine.

Only cached credentials are used. Transfer destinations are fixed public services;
responses, credentials and process logs are never returned to the browser.
"""

from __future__ import annotations

import copy
import re
import socket
import threading
import time

from services import provider_diagnostics as base


_SLOTS = threading.BoundedSemaphore(1)
_BUDGET_SECONDS = 90
_TRANSFER_BYTES = 262144
_CONTROLS = (
    ("Cloudflare", "speed.cloudflare.com", "/__down?bytes={size}", None),
    ("HTTPBingo / Fly.io", "httpbingo.org", "/bytes/{size}", "/drip?numbytes={size}&duration=6&delay=0&code=200"),
)


def _ports(value: object) -> list[int]:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        value = re.split(r"[,;\s]+", value.strip())
    if not isinstance(value, list) or len(value) > 4:
        raise ValueError("Укажите до четырёх портов, на которых заведомо работают сервисы.")
    ports = []
    for item in value:
        if isinstance(item, bool) or not re.fullmatch(r"\d{1,5}", str(item)) or not 1 <= int(item) <= 65535:
            raise ValueError("Порт должен быть целым числом от 1 до 65535.")
        if int(item) not in ports:
            ports.append(int(item))
    return ports


def _pin_entry(entry: dict, target: dict, ip: str) -> dict:
    """Pin only the server endpoint; preserve the original SNI/Host and secrets."""
    pinned = copy.deepcopy(entry)
    if pinned.get("_diagnostics_engine") == "mihomo":
        udp_tls = target["protocol"] in {"hysteria", "hysteria2", "hy2", "tuic", "anytls-quic"}
        tls_enabled = target["tls_mode"] != "none" or udp_tls
        proxy = pinned.get("proxy")
        if isinstance(proxy, dict):
            proxy["server"] = ip
            if tls_enabled and not proxy.get("servername") and not proxy.get("sni"):
                proxy["sni" if udp_tls else "servername"] = target["sni"] or target["host"]
            if proxy.get("network") == "ws":
                headers = proxy.setdefault("ws-opts", {}).setdefault("headers", {})
                if not any(str(key).lower() == "host" for key in headers):
                    headers["Host"] = target["host"]
        else:
            text = pinned.get("proxy_yaml", "")
            if re.search(r"(?m)^\s+network:\s*['\"]?ws['\"]?\s*$", text) and not re.search(r"(?mi)^\s+host:", text):
                raise ValueError("Для проверки WebSocket с закреплённым IP укажите Host в ws-opts.headers или установите поддержку YAML.")
            text, count = re.subn(r"(?m)^([ \t]+server:[ \t]*).*$", lambda m: m[1] + '"' + ip + '"', text)
            if count != 1:
                raise ValueError("Не удалось закрепить IP этого узла Mihomo. Используйте полный YAML или JSON.")
            if tls_enabled and not re.search(r"(?m)^[ \t]+(?:servername|sni):[ \t]*[^\s#]+", text):
                text = re.sub(r"(?m)^\s+(?:servername|sni):[^\n]*\n?", "\n", text)
                text += '\n    ' + ("sni" if udp_tls else "servername") + ': "' + (target["sni"] or target["host"]) + '"\n'
            pinned["proxy_yaml"] = text
        return pinned
    settings = pinned.get("settings") or {}
    def matches(value):
        try:
            return base._host(value) == target["host"]
        except ValueError:
            return False
    matched = False
    for field in ("vnext", "servers"):
        if isinstance(settings.get(field), list):
            endpoints = [item for item in settings[field] if isinstance(item, dict) and matches(item.get("address") or item.get("server")) and str(item.get("port")) == str(target["port"])]
            if endpoints:
                settings[field] = endpoints
                for endpoint in endpoints:
                    endpoint["address" if "address" in endpoint else "server"] = ip
                matched = True
    for container in (settings, pinned.get("hysteriaSettings"), pinned.get("wireguardSettings")):
        if isinstance(container, dict) and matches(container.get("address") or container.get("server")):
            container["address" if "address" in container else "server"] = ip
            matched = True
    if pinned.get("protocol") == "wireguard":
        peers = []
        for peer in settings.get("peers", []):
            try:
                endpoint = base.urlsplit("//" + peer.get("endpoint", ""))
                if matches(endpoint.hostname) and endpoint.port == target["port"]:
                    peer["endpoint"] = ("[" + ip + "]" if ":" in ip else ip) + ":" + str(target["port"])
                    peers.append(peer)
            except (ValueError, AttributeError):
                continue
        if peers:
            settings["peers"] = peers
            matched = True
    if not matched:
        raise ValueError("Для этого формата нельзя надёжно закрепить IP сервера; используйте обычную проверку прокси.")
    if target["tls_mode"] != "none":
        stream = pinned.setdefault("streamSettings", {})
        security = stream.setdefault("realitySettings" if target["tls_mode"] == "reality" else "tlsSettings", {})
        if not security.get("serverName"):
            security["serverName"] = target["sni"] or target["host"]
    stream = pinned.get("streamSettings") or {}
    if stream.get("network") in {"ws", "websocket"}:
        headers = stream.setdefault("wsSettings", {}).setdefault("headers", {})
        if not any(str(key).lower() == "host" for key in headers):
            headers["Host"] = target["host"]
    elif stream.get("network") in {"httpupgrade", "xhttp", "splithttp"}:
        settings_name = "httpupgradeSettings" if stream["network"] == "httpupgrade" else "xhttpSettings"
        transport = stream.setdefault(settings_name, {})
        if not transport.get("host"):
            transport["host"] = target["host"]
    return pinned


def _transfer(control: dict, size: int, *, deadline: float, proxy_port: int | None = None, bypass_mark: int = 0, paced: bool = False) -> dict:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {"status": "budget_exhausted", "requested_bytes": size, "bytes_received": 0}
    # Pace at the origin. Delaying reads locally would only fill socket buffers
    # and would not demonstrate a different traffic duration on the network.
    path = control["paced_path"] if paced else control["path"]
    parts = ("https", control["host"], 443, path.format(size=size))
    attempt_limit = 16 if paced else 12
    result = base._resource_http_request(parts, address=control["address"], proxy_port=proxy_port,
                                         bypass_mark=bypass_mark, transfer_bytes=size,
                                         duration=min(attempt_limit, remaining), paced=paced)
    result["budget_limited"] = remaining < attempt_limit
    return result


def _diagnose(tests: list[dict]) -> dict:
    successful = [test for test in tests if any(item.get("status") == "transfer_ok" for item in test["attempts"])]
    limited = []
    timed = []
    pace_sensitive = []
    for test in tests:
        attempts = test["attempts"]
        stalls = [item for item in attempts if not item.get("budget_limited") and item.get("stage") == "body" and item.get("status") in {"transfer_timeout", "transfer_reset", "transfer_short", "transfer_error"} and 8192 <= item.get("bytes_received", 0) <= 65536]
        if len(stalls) >= 2 and not any(item.get("status") == "transfer_ok" for item in attempts):
            counts = [item["bytes_received"] for item in stalls]
            paced = test.get("paced") or {}
            if test.get("paced_direct", {}).get("status") != "transfer_ok":
                paced = {}
            if max(counts) - min(counts) <= max(4096, min(counts) * 0.2):
                # A different byte count at a different rate contradicts a fixed byte threshold.
                if paced.get("status") == "transfer_ok" and paced.get("bytes_received", 0) > max(counts) * 1.5:
                    pace_sensitive.append(test)
                elif paced.get("stage") == "body" and 0 < paced.get("bytes_received", 0) < min(counts) * 0.5:
                    durations = [item.get("total_ms", 0) for item in stalls]
                    average = sum(durations) / len(durations)
                    if average and abs(paced.get("total_ms", 0) - average) <= max(500, average * 0.25):
                        timed.append(test)
                    else:
                        pace_sensitive.append(test)
                else:
                    limited.append((test, round(sum(counts) / len(counts))))
    if len(limited) >= 2:
        counts = [count for _, count in limited]
        if max(counts) - min(counts) <= max(4096, min(counts) * 0.25):
            corroborated = all(test.get("direct", {}).get("status") == "transfer_ok" for test, _ in limited)
            return {"verdict": "byte_limit_pattern", "confidence": "medium" if corroborated else "low", "approx_bytes": round(sum(counts) / len(counts)), "message": "На независимых площадках повторяется остановка после похожего объёма. Есть признаки ограничения передачи; причина не подтверждена."}
    if limited:
        return {"verdict": "repeatable_stall", "confidence": "low", "approx_bytes": limited[0][1], "message": "Остановка после похожего объёма повторяется на одной площадке. Возможен сбой площадки или пути к ней."}
    if timed:
        return {"verdict": "duration_sensitive", "confidence": "low", "message": "При замедленной передаче остановка происходит раньше по объёму. Фиксированный порог байтов не подтверждён; возможна зависимость от времени."}
    if pace_sensitive:
        return {"verdict": "pace_sensitive", "confidence": "low", "message": "Результат меняется при замедленной передаче. Фиксированный порог объёма не подтверждён; возможны потери пакетов или ограничения скорости."}
    if len(successful) == len(_CONTROLS):
        return {"verdict": "transfer_ok", "confidence": "medium", "message": "Через узел получено по 256 КБ с двух независимых площадок. Ограничение на проверенном объёме не обнаружено."}
    if successful:
        return {"verdict": "partial_success", "confidence": "low", "message": "Большая передача прошла только к части площадок. Общий вывод о блокировке узла не подтверждён."}
    return {"verdict": "undetermined", "confidence": "low", "message": "Передача не подтверждена. Смотрите этап и причину завершения каждого запроса."}


@base._needs_engines
def advanced_probe(raw: dict) -> dict:
    ports = _ports(raw.get("ports"))
    entry = None
    if raw.get("ref"):
        entry, target = base._proxy_context(raw.get("ref"), raw.get("index"))
        if not target:
            raise ValueError("Обновите список серверов перед расширенной проверкой.")
        # Never modify the cached target: other buttons share this context.
        target = base.make_target(**{key: value for key, value in target.items() if key in {"host", "port", "name", "protocol", "network", "tls_mode", "sni", "verify_tls", "source"}})
    else:
        supplied = raw.get("target")
        if not isinstance(supplied, dict) or "host" not in supplied or "port" not in supplied:
            raise ValueError("Выберите сервер для расширенной проверки.")
        target = base.make_target(**{key: value for key, value in supplied.items() if key in {"host", "port", "name", "protocol", "network", "tls", "tls_mode", "sni", "verify_tls", "source"}})
    if not _SLOTS.acquire(blocking=False):
        return {"status": "busy", "message": "Уже выполняется расширенная проверка. Дождитесь её завершения."}
    started = time.monotonic()
    deadline = started + _BUDGET_SECONDS
    try:
        try:
            addresses = base._distinct_addresses(socket.getaddrinfo(target["host"], target["port"], type=socket.SOCK_DGRAM if target["network"] == "udp" else socket.SOCK_STREAM), 2)
        except OSError:
            return {"status": "dns_error", "message": "Не удалось разрешить имя сервера."}
        if not addresses:
            return {"status": "dns_error", "message": "DNS не вернул пригодных адресов сервера."}
        mark = base._xkeen_direct_mark()
        controls = []
        if entry:
            for name, host, path, paced_path in _CONTROLS:
                control = {"name": name, "host": host, "path": path, "paced_path": paced_path, "direct": {"status": "dns_error"}}
                try:
                    resolved = base._resource_addresses(host, 443)
                except ValueError:
                    resolved = []
                if resolved:
                    control["address"] = resolved[0]
                    family_mark = base._address_direct_mark(resolved[0], mark)
                    control["direct"] = (_transfer(control, _TRANSFER_BYTES, deadline=deadline, bypass_mark=family_mark)
                                         if family_mark is not None else {"status": "route_unverified"})
                controls.append(control)
        results = []
        for address in addresses:
            ip = address[4][0]
            row = {"ip": ip, "family": "IPv6" if address[0] == socket.AF_INET6 else "IPv4", "ports": [], "tests": []}
            results.append(row)
            if target["network"] == "tcp":
                family_mark = base._address_direct_mark(address, mark)
                for port in dict.fromkeys([target["port"], *ports]):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    endpoint = (address[0], socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, port, *address[4][2:]))
                    check = (base._probe_address({**target, "tls": False}, endpoint, family_mark, timeout=min(2.5, remaining))
                             if family_mark is not None else {"status": "route_unverified"})
                    row["ports"].append({"port": port, **check})
            if entry and time.monotonic() < deadline:
                pinned = _pin_entry(entry, target, ip)
                with base._resource_proxy_session(pinned) as session:
                    row["core_status"] = session["status"]
                    if session["status"] == "ok":
                        for control in controls:
                            test = {"control": control["name"], "host": control["host"], "direct": control["direct"], "attempts": []}
                            row["tests"].append(test)
                            if "address" not in control:
                                test["status"] = "dns_error"
                                continue
                            test["destination_ip"] = control["address"][4][0]
                            test["small"] = _transfer(control, 8192, deadline=deadline, proxy_port=session["port"])
                            for _ in range(3):
                                if time.monotonic() >= deadline:
                                    break
                                attempt = _transfer(control, _TRANSFER_BYTES, deadline=deadline, proxy_port=session["port"])
                                test["attempts"].append(attempt)
                                if attempt["status"] == "transfer_ok":
                                    break
                            if control["paced_path"] and any(item.get("stage") == "body" and 0 < item.get("bytes_received", 0) < _TRANSFER_BYTES for item in test["attempts"]) and not any(item["status"] == "transfer_ok" for item in test["attempts"]):
                                # HTTPBingo writes /drip byte by byte. A modest
                                # response avoids mistaking its scheduler overhead
                                # for a stalled 64 KiB download.
                                if "paced_direct" not in control:
                                    family_mark = base._address_direct_mark(control["address"], mark)
                                    control["paced_direct"] = (_transfer(control, 8192, deadline=deadline, bypass_mark=family_mark, paced=True)
                                                               if family_mark is not None else {"status": "route_unverified"})
                                test["paced_direct"] = control["paced_direct"]
                                test["paced"] = _transfer(control, 8192, deadline=deadline, proxy_port=session["port"], paced=True)
            row["diagnosis"] = _diagnose(row["tests"]) if entry else {"verdict": "no_proxy_context", "confidence": "low", "message": "Без параметров узла проверены только TCP-порты. Для передачи данных загрузите конфигурацию или ссылку прокси."}
            row["transport_verified"] = any(test.get("small", {}).get("status") == "transfer_ok" or any(item.get("stage") == "body" and item.get("bytes_received", 0) > 0 for item in test["attempts"]) for test in row["tests"])
        return {"status": "ok", "network": target["network"], "engine": "mihomo" if entry and entry.get("_diagnostics_engine") == "mihomo" else "xray" if entry else None,
                "address_results": results, "budget_exhausted": time.monotonic() >= deadline,
                "total_ms": round((time.monotonic() - started) * 1000),
                "controls": [{key: value for key, value in item.items() if key in {"name", "host", "direct"}} for item in controls]}
    finally:
        _SLOTS.release()
