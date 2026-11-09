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
_TLS_PROFILE_SLOTS = threading.BoundedSemaphore(1)
_BUDGET_SECONDS = 90
_TRANSFER_STEPS = (8192, 16384, 20480, 32768, 65536, 131072, 262144)
_TRANSFER_BYTES = _TRANSFER_STEPS[-1]
_TLS_PROFILE_BUDGET = 90
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


def _configured_tls_profile(entry: dict) -> dict:
    """Return safe TLS settings without exposing credentials or raw config."""
    profile = {}
    if entry.get("_diagnostics_engine") == "mihomo":
        proxy = entry.get("proxy") or {}
        if isinstance(proxy, dict):
            for source, target in (("client-fingerprint", "fingerprint"), ("servername", "server_name"), ("sni", "server_name"), ("alpn", "alpn")):
                value = proxy.get(source)
                if value and target not in profile:
                    profile[target] = value
        text = entry.get("proxy_yaml", "")
        for pattern, target in ((r"(?mi)^\s*client-fingerprint:\s*([^#\s]+)", "fingerprint"), (r"(?mi)^\s*(?:servername|sni):\s*['\"]?([^'\"#\s]+)", "server_name")):
            match = re.search(pattern, text)
            if match and target not in profile:
                profile[target] = match.group(1)
    else:
        stream = entry.get("streamSettings") or {}
        security = stream.get("realitySettings") if stream.get("security") == "reality" else stream.get("tlsSettings")
        security = security or {}
        for source, target in (("fingerprint", "fingerprint"), ("serverName", "server_name"), ("alpn", "alpn")):
            if security.get(source):
                profile[target] = security[source]
    return profile


def _with_tls_fingerprint(entry: dict, fingerprint: str) -> dict:
    variant = copy.deepcopy(entry)
    if variant.get("_diagnostics_engine") == "mihomo":
        proxy = variant.get("proxy")
        if isinstance(proxy, dict):
            proxy["client-fingerprint"] = fingerprint
        else:
            text = variant.get("proxy_yaml", "")
            if re.search(r"(?mi)^\s*client-fingerprint:", text):
                text = re.sub(r"(?mi)^(\s*client-fingerprint:)\s*[^#\n]*", rf"\1 {fingerprint}", text, count=1)
            else:
                text += f"\n    client-fingerprint: {fingerprint}\n"
            variant["proxy_yaml"] = text
        return variant
    stream = variant.setdefault("streamSettings", {})
    security_name = "realitySettings" if stream.get("security") == "reality" else "tlsSettings"
    stream.setdefault(security_name, {})["fingerprint"] = fingerprint
    return variant


def _tls_profile_attempt(entry: dict, address: tuple, *, fingerprint: str | None, deadline: float) -> dict:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {"status": "budget_exhausted"}
    variant = _with_tls_fingerprint(entry, fingerprint) if fingerprint is not None else copy.deepcopy(entry)
    with base._resource_proxy_session(variant) as session:
        if session["status"] != "ok":
            return session
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {"status": "budget_exhausted"}
        result = base._resource_http_request(
            ("https", "speed.cloudflare.com", 443, "/__down?bytes=8192"),
            address=address, proxy_port=session["port"], transfer_bytes=8192,
            duration=min(12, remaining),
        )
        result["budget_limited"] = remaining < 12
        return result


@base._needs_engines
def tls_profile_probe(raw: dict) -> dict:
    token, index = raw.get("ref"), raw.get("index")
    if not isinstance(token, str) or len(token) > 100 or not isinstance(index, int):
        raise ValueError("Выберите сервер для проверки TLS-профиля.")
    entry, target = base._proxy_context(token, index)
    if not entry or not target:
        raise ValueError("Данные прокси устарели. Загрузите список серверов заново.")
    if target.get("network") != "tcp" or target.get("tls_mode") == "none":
        raise ValueError("Проверка TLS-профиля доступна для TCP-серверов с TLS.")
    if not _TLS_PROFILE_SLOTS.acquire(blocking=False):
        return {"status": "busy", "message": "Уже выполняется проверка TLS-профиля."}
    started = time.monotonic()
    try:
        addresses = base._resource_addresses("speed.cloudflare.com", 443)
        if not addresses:
            return {"status": "dns_error", "message": "Не удалось разрешить контрольную TLS-площадку."}
        configured = _configured_tls_profile(entry)
        fingerprints = [None, "chrome", "firefox"]
        try:
            endpoints = base._distinct_addresses(socket.getaddrinfo(target["host"], target["port"], type=socket.SOCK_STREAM), 1)
        except OSError:
            endpoints = []
        if not endpoints:
            return {"status": "dns_error", "message": "Не удалось разрешить имя сервера."}
        pinned = _pin_entry(entry, target, endpoints[0][4][0])
        deadline = started + _TLS_PROFILE_BUDGET
        profiles = [{"fingerprint": fingerprint or "configured", "attempts": []} for fingerprint in fingerprints]
        # Reverse the second round so a temporary path failure is less likely
        # to be mistaken for a difference between ClientHello profiles.
        for order in (range(3), range(2, -1, -1)):
            for i in order:
                result = _tls_profile_attempt(pinned, addresses[0], fingerprint=fingerprints[i], deadline=deadline)
                profiles[i]["attempts"].append(result)
        for profile in profiles:
            attempts = profile["attempts"]
            statuses = {item["status"] for item in attempts}
            profile["status"] = attempts[-1]["status"] if len(statuses) == 1 else "inconsistent"
            last = attempts[-1] if attempts else {}
            for key in ("bytes_received", "requested_bytes", "tls_ms", "total_ms"):
                profile[key] = last.get(key)
        successful = [item for item in profiles if item["status"] == "transfer_ok"]
        failures = {"transfer_timeout", "transfer_reset", "transfer_short", "transfer_error", "proxy_error", "tls_error", "tls_timeout", "tls_cert_error", "tcp_error", "unexpected_response"}
        failed = [profile for profile in profiles if profile["status"] in failures and all(not attempt.get("budget_limited") for attempt in profile["attempts"])]
        if len(successful) == len(profiles):
            verdict = "profile_not_sensitive"
            message = "Все профили ядра дважды прошли передачу 8 КБ. Зависимость от fingerprint в этой проверке не обнаружена."
        elif successful and failed:
            verdict = "profile_sensitive"
            message = "Разница между TLS-профилями повторилась в двух раундах. Возможна фильтрация или несовместимость сервера с профилем; причина не подтверждена."
        else:
            verdict = "undetermined"
            message = "Устойчивая разница между TLS-профилями не подтверждена. Смотрите результаты попыток и запуска ядра."
        return {"status": "ok", "engine": "Mihomo" if entry.get("_diagnostics_engine") == "mihomo" else "Xray",
                "configured": configured, "profiles": profiles, "control": "speed.cloudflare.com", "server_ip": endpoints[0][4][0],
                "verdict": verdict, "message": message, "budget_exhausted": time.monotonic() >= deadline,
                "total_ms": round((time.monotonic() - started) * 1000)}
    finally:
        _TLS_PROFILE_SLOTS.release()


def _diagnose(tests: list[dict]) -> dict:
    successful = [test for test in tests if any(item.get("status") == "transfer_ok" and item.get("requested_bytes", _TRANSFER_BYTES) == _TRANSFER_BYTES for item in test["attempts"])]
    limited = []
    timed = []
    pace_sensitive = []
    for test in tests:
        attempts = test.get("attempts") or test.get("steps", [])
        stalls = [item for item in attempts if not item.get("budget_limited") and item.get("stage") == "body" and item.get("status") in {"transfer_timeout", "transfer_reset", "transfer_short", "transfer_error"} and 8192 <= item.get("bytes_received", 0) <= 65536]
        failed_size = min((item.get("requested_bytes", _TRANSFER_BYTES) for item in stalls), default=_TRANSFER_BYTES)
        if len(stalls) >= 2 and not any(item.get("status") == "transfer_ok" and item.get("requested_bytes", _TRANSFER_BYTES) >= failed_size for item in attempts):
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


def _step_transfers(control: dict, *, deadline: float, proxy_port: int | None = None, bypass_mark: int = 0) -> list[dict]:
    """Probe increasing response sizes and repeat the first failed size twice."""
    results = []
    for size in _TRANSFER_STEPS:
        if time.monotonic() >= deadline:
            break
        attempt = _transfer(control, size, deadline=deadline, proxy_port=proxy_port, bypass_mark=bypass_mark)
        results.append(attempt)
        if attempt.get("status") != "transfer_ok":
            for _ in range(2):
                if time.monotonic() >= deadline:
                    break
                results.append(_transfer(control, size, deadline=deadline, proxy_port=proxy_port, bypass_mark=bypass_mark))
            break
    return results


def _step_boundary(steps: list[dict]) -> dict:
    successful = [item["requested_bytes"] for item in steps if item.get("status") == "transfer_ok"]
    failures = [item for item in steps if item.get("stage") == "body" and item.get("status") in {"transfer_timeout", "transfer_reset", "transfer_short", "transfer_error"} and not item.get("budget_limited")]
    if not failures:
        return {"last_complete_bytes": max(successful, default=0)}
    size = min(item["requested_bytes"] for item in failures)
    attempts = [item for item in steps if item.get("requested_bytes") == size]
    return {"last_complete_bytes": max(successful, default=0), "first_incomplete_bytes": size,
            "repeatable": len(attempts) >= 2 and all(item in failures for item in attempts)}


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
                            test["steps"] = _step_transfers(control, deadline=deadline, proxy_port=session["port"])
                            test["small"] = test["steps"][0] if test["steps"] else {"status": "budget_exhausted", "requested_bytes": 8192, "bytes_received": 0}
                            test["attempts"] = test["steps"]
                            test["size_boundary"] = _step_boundary(test["steps"])
                            if control["paced_path"] and test["size_boundary"].get("repeatable"):
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
