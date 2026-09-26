"""Import Amnezia Premium ``vpn://`` keys as Mihomo WireGuard configs.

The key is accepted by the same authenticated control-panel API used by the
Amnezia web dashboard. On routers, those HTTPS requests go through Mihomo's
loopback mixed listener so the panel can use the router's working egress path.
"""

from __future__ import annotations

import base64
import http.cookiejar
import json
import os
import secrets
import urllib.error
import urllib.request
import uuid
import zlib
from dataclasses import dataclass
from typing import Any, Callable, Mapping


AMNEZIA_PREMIUM_GATEWAY_URL = "https://gw.amnezia.org/v1/config"
AMNEZIA_PREMIUM_ACCOUNT_URL = "https://gw.amnezia.org/v1/account_info"
AMNEZIA_PREMIUM_PANEL_URL = "https://cp.amnezia.org"
_CONNECTION_KEY_SIGNATURE = b"\x00\x00\x00\xff"
_MAX_CONNECTION_KEY_BYTES = 32 * 1024
_MAX_GATEWAY_RESPONSE_BYTES = 512 * 1024
_SUPPORTED_PROTOCOLS = {"awg", "wireguard"}
_DEFAULT_MIHOMO_CONFIG_PATH = "/opt/etc/mihomo/config.yaml"

GatewayPost = Callable[[Mapping[str, Any]], Mapping[str, Any]]


class AmneziaPremiumImportError(ValueError):
    """A connection key or its corresponding Premium configuration is invalid."""


@dataclass(frozen=True)
class AmneziaPremiumConnection:
    """Decoded metadata required to request an Amnezia Premium configuration."""

    name: str
    service_type: str
    service_protocol: str
    user_country_code: str
    api_key: str


def is_amnezia_premium_connection_key(value: str) -> bool:
    """Return whether *value* is an Amnezia's ``vpn://`` connection key."""
    return str(value or "").strip().lower().startswith("vpn://")


def import_connection_key(
    value: str,
    *,
    gateway_post: GatewayPost | None = None,
    server_country_code: str = "",
    display_name: str = "",
) -> str:
    """Resolve a ``vpn://`` key to a WireGuard/AmneziaWG ``.conf`` document.

    The caller is expected to pass the returned document immediately to the
    existing Mihomo WireGuard parser. The raw connection key is deliberately
    not returned or persisted.
    """
    connection = decode_connection_key(value)
    if connection.service_protocol not in _SUPPORTED_PROTOCOLS:
        raise AmneziaPremiumImportError(
            "Этот ключ Amnezia Premium использует неподдерживаемый протокол. "
            "Для Mihomo сейчас доступны AmneziaWG и WireGuard."
        )

    if gateway_post is None:
        country_code = str(server_country_code or "").strip().lower()
        if not country_code:
            locations = list_available_locations(value)
            if not locations:
                raise AmneziaPremiumImportError(
                    "Amnezia Premium не вернул доступных локаций."
                )
            country_code = str(locations[0]["code"]).strip().lower()
        return _download_panel_config(
            value,
            country_code=country_code,
            declared_country_code=_declared_country_code(connection),
        )

    private_key, public_key = generate_wireguard_keypair()
    payload = _gateway_payload(
        connection,
        public_key=public_key,
        server_country_code=server_country_code,
    )

    response = gateway_post(payload)
    server_config = _decode_gateway_config(response)
    return _render_wireguard_config(
        server_config,
        protocol=connection.service_protocol,
        private_key=private_key,
        fallback_name=display_name or connection.name,
    )


def list_available_locations(
    value: str,
) -> list[dict[str, Any]]:
    """Return the locations currently allowed by an Amnezia Premium key."""
    connection = decode_connection_key(value)
    if connection.service_protocol not in _SUPPORTED_PROTOCOLS:
        raise AmneziaPremiumImportError(
            "Этот ключ Amnezia Premium использует неподдерживаемый протокол."
        )
    response = _cp_request(
        value,
        "/api/account-info?appLanguage=ru",
    )
    account = _mapping(response.get("data")) or response
    raw_locations = account.get("available_countries")
    if not isinstance(raw_locations, list):
        raw_locations = _mapping(account.get("api_config")).get("available_countries")
    if not isinstance(raw_locations, list):
        raise AmneziaPremiumImportError(
            "Amnezia Premium не вернул список доступных локаций."
        )

    locations: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw_locations:
        if isinstance(item, str):
            code = _text(item).upper()
            name = code
            protocols: list[str] = []
        else:
            obj = _mapping(item)
            code = _text(
                obj.get("server_country_code")
                or obj.get("country_code")
                or obj.get("code")
            ).upper()
            name = _text(
                obj.get("server_country_name")
                or obj.get("server_country_code_l10n")
                or obj.get("name")
                or code
            )
            raw_protocols = obj.get("available_protocols")
            protocols = [
                _text(protocol).lower()
                for protocol in raw_protocols
                if _text(protocol)
            ] if isinstance(raw_protocols, list) else []
        if not code or code in seen:
            continue
        if protocols and connection.service_protocol not in protocols:
            continue
        seen.add(code)
        locations.append({"code": code, "name": name or code})
    if not locations:
        raise AmneziaPremiumImportError(
            "Для этого ключа Amnezia Premium не найдено доступных локаций Mihomo."
        )
    return locations


def _declared_country_code(connection: AmneziaPremiumConnection) -> str:
    value = _text(connection.user_country_code).lower()
    return value if value in {"ru", "ag"} else "ru"


def _cp_request(
    connection_key: str,
    path: str,
    payload: Mapping[str, Any] | None = None,
) -> Mapping[str, Any]:
    """Use the same authenticated panel API as the Amnezia web dashboard."""
    cookie_jar = http.cookiejar.CookieJar()
    handlers: list[Any] = [urllib.request.HTTPCookieProcessor(cookie_jar)]
    proxy_port = _mihomo_proxy_port()
    if proxy_port is not None:
        proxy_url = f"http://127.0.0.1:{proxy_port}"
        handlers.insert(
            0,
            urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}),
        )
    opener = urllib.request.build_opener(*handlers)
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Connection": "close",
        "User-Agent": "Xkeen-UI/Amnezia-Premium-Import",
    }

    def request_json(url: str, body: Mapping[str, Any] | None = None) -> bytes:
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
        try:
            with opener.open(request, timeout=20) as response:
                raw = response.read(_MAX_GATEWAY_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            raise AmneziaPremiumImportError(
                "Amnezia Premium не принял ключ. Проверьте подписку и попробуйте ещё раз."
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise AmneziaPremiumImportError(
                "Не удалось подключиться к панели Amnezia Premium. "
                "Проверьте подключение и попробуйте ещё раз."
            ) from exc
        if len(raw) > _MAX_GATEWAY_RESPONSE_BYTES:
            raise AmneziaPremiumImportError("Ответ Amnezia Premium слишком большой.")
        return raw

    login_raw = request_json(
        f"{AMNEZIA_PREMIUM_PANEL_URL}/api/login",
        {"vpnKey": str(connection_key or "").strip(), "remember": False},
    )
    try:
        login = json.loads(login_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AmneziaPremiumImportError("Панель Amnezia Premium вернула некорректный ответ.") from exc
    if not isinstance(login, Mapping) or _text(login.get("message")).lower() != "ok":
        raise AmneziaPremiumImportError("Amnezia Premium не подтвердил ключ.")

    raw = request_json(f"{AMNEZIA_PREMIUM_PANEL_URL}{path}", payload)
    try:
        decoded = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AmneziaPremiumImportError("Панель Amnezia Premium вернула некорректный список локаций.") from exc
    if not isinstance(decoded, Mapping):
        raise AmneziaPremiumImportError("Панель Amnezia Premium вернула некорректный ответ.")
    return decoded


def _download_panel_config(
    connection_key: str,
    *,
    country_code: str,
    declared_country_code: str,
) -> str:
    """Download one native AmneziaWG config through the authenticated panel."""
    cookie_jar = http.cookiejar.CookieJar()
    handlers: list[Any] = [urllib.request.HTTPCookieProcessor(cookie_jar)]
    proxy_port = _mihomo_proxy_port()
    if proxy_port is not None:
        proxy_url = f"http://127.0.0.1:{proxy_port}"
        handlers.insert(
            0,
            urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}),
        )
    opener = urllib.request.build_opener(*handlers)
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Connection": "close",
        "User-Agent": "Xkeen-UI/Amnezia-Premium-Import",
    }

    def post(url: str, body: Mapping[str, Any]) -> bytes:
        request = urllib.request.Request(
            url,
            data=json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with opener.open(request, timeout=30) as response:
                raw = response.read(_MAX_GATEWAY_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            raw = exc.read(_MAX_GATEWAY_RESPONSE_BYTES + 1)
            try:
                detail = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                detail = {}
            error_code = _text(detail.get("errorCode"))
            if error_code == "NO_PROTOCOL_COMPATIBLE_WORKER":
                raise AmneziaPremiumImportError(
                    "Для выбранной локации сейчас нет совместимого сервера Amnezia Premium."
                ) from exc
            if error_code in {"CONFIG_LIMIT", "MAX_DEVICES_REACHED"}:
                raise AmneziaPremiumImportError(
                    "Достигнут лимит конфигураций Amnezia Premium."
                ) from exc
            raise AmneziaPremiumImportError(
                "Amnezia Premium не выдал конфигурацию для выбранной локации."
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise AmneziaPremiumImportError(
                "Не удалось скачать конфигурацию Amnezia Premium."
            ) from exc
        if len(raw) > _MAX_GATEWAY_RESPONSE_BYTES:
            raise AmneziaPremiumImportError("Конфигурация Amnezia Premium слишком большая.")
        return raw

    login_raw = post(
        f"{AMNEZIA_PREMIUM_PANEL_URL}/api/login",
        {"vpnKey": str(connection_key or "").strip(), "remember": False},
    )
    try:
        login = json.loads(login_raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AmneziaPremiumImportError("Панель Amnezia Premium вернула некорректный ответ.") from exc
    if not isinstance(login, Mapping) or _text(login.get("message")).lower() != "ok":
        raise AmneziaPremiumImportError("Amnezia Premium не подтвердил ключ.")

    raw = post(
        f"{AMNEZIA_PREMIUM_PANEL_URL}/api/download-config",
        {
            "countryCode": _text(country_code).lower(),
            "declaredCountryCode": _text(declared_country_code).lower(),
        },
    )
    if raw.lstrip().startswith(b"{"):
        try:
            error = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            error = {}
        raise AmneziaPremiumImportError(
            _text(error.get("message")) or "Amnezia Premium не выдал конфигурацию."
        )
    try:
        config = raw.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        raise AmneziaPremiumImportError("Конфигурация Amnezia Premium имеет неверную кодировку.") from exc
    if "[interface]" not in config.lower() or "[peer]" not in config.lower():
        raise AmneziaPremiumImportError("Amnezia Premium вернул неподдерживаемую конфигурацию.")
    return config + "\n"


def decode_connection_key(value: str) -> AmneziaPremiumConnection:
    """Decode and validate an Amnezia Premium key without calling the gateway."""
    raw = _decode_urlsafe_base64(value, label="Ключ Amnezia Premium")
    if not raw.startswith(_CONNECTION_KEY_SIGNATURE):
        raise AmneziaPremiumImportError("Некорректный ключ Amnezia Premium.")

    metadata = _decode_json_payload(
        raw[len(_CONNECTION_KEY_SIGNATURE) :],
        label="Ключ Amnezia Premium",
        compressed_without_size_prefix=True,
    )
    api_config = _mapping(metadata.get("api_config"))
    auth_data = _mapping(metadata.get("auth_data"))

    service_type = _text(api_config.get("service_type"))
    service_protocol = _text(api_config.get("service_protocol")).lower()
    user_country_code = _text(api_config.get("user_country_code"))
    api_key = _text(auth_data.get("api_key"))
    if not all((service_type, service_protocol, user_country_code, api_key)):
        raise AmneziaPremiumImportError("Ключ Amnezia Premium не содержит данных подписки.")

    return AmneziaPremiumConnection(
        name=_connection_name(metadata),
        service_type=service_type,
        service_protocol=service_protocol,
        user_country_code=user_country_code,
        api_key=api_key,
    )


def generate_wireguard_keypair() -> tuple[str, str]:
    """Generate a standard Curve25519 WireGuard key pair without dependencies."""
    private_raw = _clamp_x25519_scalar(secrets.token_bytes(32))
    public_raw = _x25519(private_raw, b"\x09" + (b"\x00" * 31))
    return (
        base64.b64encode(private_raw).decode("ascii"),
        base64.b64encode(public_raw).decode("ascii"),
    )


def _post_to_gateway(
    payload: Mapping[str, Any],
    *,
    endpoint: str = "config",
) -> Mapping[str, Any]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        (
            AMNEZIA_PREMIUM_GATEWAY_URL
            if endpoint == "config"
            else AMNEZIA_PREMIUM_ACCOUNT_URL
        ),
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Xkeen-UI/Amnezia-Premium-Import",
        },
        method="POST",
    )
    opener = urllib.request.build_opener()
    proxy_port = _mihomo_proxy_port()
    if proxy_port is not None:
        proxy_url = f"http://127.0.0.1:{proxy_port}"
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
        )

    try:
        with opener.open(request, timeout=20) as response:
            raw = response.read(_MAX_GATEWAY_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        if exc.code in {401, 403}:
            raise AmneziaPremiumImportError(
                "Amnezia Premium не принял ключ. Проверьте подписку и попробуйте ещё раз."
            ) from exc
        raise AmneziaPremiumImportError(
            "Не удалось получить конфигурацию Amnezia Premium. Попробуйте позже."
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise AmneziaPremiumImportError(
            "Не удалось подключиться к шлюзу Amnezia Premium. Проверьте интернет и повторите попытку."
        ) from exc

    if len(raw) > _MAX_GATEWAY_RESPONSE_BYTES:
        raise AmneziaPremiumImportError("Ответ шлюза Amnezia Premium слишком большой.")
    try:
        payload_obj = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AmneziaPremiumImportError("Шлюз Amnezia Premium вернул некорректный ответ.") from exc
    if not isinstance(payload_obj, Mapping):
        raise AmneziaPremiumImportError("Шлюз Amnezia Premium вернул некорректный ответ.")
    return payload_obj


def _mihomo_proxy_port() -> int | None:
    """Return the loopback Mihomo proxy used for router-originated HTTPS.

    On some router uplinks direct connections to Amnezia's gateway time out,
    while the same destination is reachable through Mihomo's configured
    loopback mixed listener. Local development and test environments simply
    fall back to a direct request when no listener is configured.
    """
    raw_port = str(
        os.environ.get("XKEEN_AMNEZIA_PREMIUM_MIHOMO_PROXY_PORT")
        or os.environ.get("XKEEN_SUBSCRIPTION_MIHOMO_PROXY_PORT")
        or ""
    ).strip()
    if raw_port:
        try:
            port = int(raw_port)
        except (TypeError, ValueError):
            return None
        return port if 1 <= port <= 65535 else None

    config_path = str(os.environ.get("XKEEN_MIHOMO_CONFIG_FILE") or "").strip() or _DEFAULT_MIHOMO_CONFIG_PATH
    try:
        from services.mihomo_egress_setup import configured_egress_proxy_port
        from utils.fs import load_text

        return configured_egress_proxy_port(load_text(config_path, default="") or "")
    except Exception:
        return None


def _decode_gateway_config(response: Mapping[str, Any]) -> Mapping[str, Any]:
    encoded = _text(response.get("config"))
    if not encoded:
        raise AmneziaPremiumImportError("Шлюз Amnezia Premium не вернул конфигурацию.")
    raw = _decode_urlsafe_base64(encoded, label="Конфигурация Amnezia Premium")
    return _decode_json_payload(
        raw,
        label="Конфигурация Amnezia Premium",
        compressed_without_size_prefix=False,
    )


def _gateway_payload(
    connection: AmneziaPremiumConnection,
    *,
    public_key: str = "",
    server_country_code: str = "",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "user_country_code": connection.user_country_code,
        "service_type": connection.service_type,
        "service_protocol": connection.service_protocol,
        "auth_data": {"api_key": connection.api_key},
        # The gateway requires client metadata, but Xkeen does not expose the
        # user's account email or retain the Premium key.
        "os_version": "openwrt",
        "app_version": "xkeen-ui",
        "cli_name": "Xkeen-UI",
        "app_language": "ru",
        "installation_uuid": str(uuid.uuid4()),
    }
    if public_key:
        payload["public_key"] = public_key
    if server_country_code:
        payload["server_country_code"] = _text(server_country_code).upper()
    return payload


def _decode_urlsafe_base64(value: str, *, label: str) -> bytes:
    token = str(value or "").strip()
    if token.lower().startswith("vpn://"):
        token = token[6:]
    if not token or len(token) > _MAX_CONNECTION_KEY_BYTES:
        raise AmneziaPremiumImportError(f"{label} имеет некорректный размер.")
    if any(char.isspace() for char in token):
        raise AmneziaPremiumImportError(f"{label} содержит недопустимые символы.")
    token += "=" * (-len(token) % 4)
    try:
        return base64.b64decode(token.encode("ascii"), altchars=b"-_", validate=True)
    except (UnicodeEncodeError, ValueError) as exc:
        raise AmneziaPremiumImportError(f"{label} имеет некорректный формат.") from exc


def _decode_json_payload(
    raw: bytes,
    *,
    label: str,
    compressed_without_size_prefix: bool,
) -> Mapping[str, Any]:
    candidates = [raw]
    if not compressed_without_size_prefix and len(raw) > 4:
        # Qt's qCompress prepends the uncompressed length before the zlib stream.
        candidates.insert(0, raw[4:])

    for candidate in candidates:
        decoded = _try_zlib_decompress(candidate)
        if decoded is None:
            decoded = candidate
        try:
            data = json.loads(decoded.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(data, Mapping):
            return data
    raise AmneziaPremiumImportError(f"{label} имеет неподдерживаемый формат.")


def _try_zlib_decompress(payload: bytes) -> bytes | None:
    try:
        decompressor = zlib.decompressobj()
        data = decompressor.decompress(payload, _MAX_GATEWAY_RESPONSE_BYTES + 1)
        if len(data) > _MAX_GATEWAY_RESPONSE_BYTES or decompressor.unconsumed_tail:
            return None
        data += decompressor.flush(_MAX_GATEWAY_RESPONSE_BYTES + 1 - len(data))
        if len(data) > _MAX_GATEWAY_RESPONSE_BYTES or not decompressor.eof:
            return None
        return data
    except zlib.error:
        return None


def _render_wireguard_config(
    server_config: Mapping[str, Any],
    *,
    protocol: str,
    private_key: str,
    fallback_name: str,
) -> str:
    protocol_config = _find_protocol_config(server_config, protocol)
    client_config = _last_client_config(protocol_config)
    native_config = _text(client_config.get("config"))
    if "[interface]" in native_config.lower() and "[peer]" in native_config.lower():
        return native_config.replace("$WIREGUARD_CLIENT_PRIVATE_KEY", private_key).strip() + "\n"

    def field(key: str) -> str:
        return _text(client_config.get(key)) or _text(protocol_config.get(key))

    host = field("hostName")
    port = field("port")
    client_ip = field("client_ip")
    server_public_key = field("server_pub_key")
    if not all((host, port, client_ip, server_public_key)):
        raise AmneziaPremiumImportError(
            "Шлюз Amnezia Premium вернул неполную конфигурацию AmneziaWG."
        )

    name = _safe_name(fallback_name) or "Amnezia Premium"
    lines = [
        "[Interface]",
        f"Name = {name}",
        f"PrivateKey = {private_key}",
        f"Address = {client_ip}",
    ]
    _append_field(lines, "DNS", field("dns"))
    _append_field(lines, "MTU", field("mtu"))
    _append_field(lines, "ClientId", field("client_id"))

    for key in (
        "Jc",
        "Jmin",
        "Jmax",
        "S1",
        "S2",
        "S3",
        "S4",
        "H1",
        "H2",
        "H3",
        "H4",
        "I1",
        "I2",
        "I3",
        "I4",
        "I5",
        "HeaderProtectionKey",
        "ContentPaddingAddition",
        "RekeyAfterTime",
        "RekeyTimeout",
        "RejectAfterTime",
        "KeepaliveTimeout",
        "MaxHandshakeAttempts",
        "RandomTrailers",
        "DisableCookies",
    ):
        _append_field(lines, key, field(key))
    _append_field(lines, "Version", field("protocol_version"))

    lines.extend(("", "[Peer]", f"PublicKey = {server_public_key}"))
    _append_field(lines, "PresharedKey", field("psk_key"))
    allowed_ips = client_config.get("allowed_ips")
    if isinstance(allowed_ips, list):
        allowed = ", ".join(_text(item) for item in allowed_ips if _text(item))
    else:
        allowed = field("allowed_ips")
    _append_field(lines, "AllowedIPs", allowed or "0.0.0.0/0, ::/0")
    _append_field(lines, "Endpoint", f"{host}:{port}")
    _append_field(lines, "PersistentKeepalive", field("persistent_keep_alive"))
    return "\n".join(lines) + "\n"


def _find_protocol_config(server_config: Mapping[str, Any], protocol: str) -> Mapping[str, Any]:
    containers = server_config.get("containers")
    if isinstance(containers, list):
        for container in containers:
            if not isinstance(container, Mapping):
                continue
            candidate = _mapping(container.get(protocol))
            if candidate:
                return candidate
    candidate = _mapping(server_config.get(f"{protocol}_config_data"))
    if candidate:
        return candidate
    raise AmneziaPremiumImportError(
        "Шлюз Amnezia Premium не вернул конфигурацию AmneziaWG/WireGuard."
    )


def _last_client_config(protocol_config: Mapping[str, Any]) -> Mapping[str, Any]:
    raw = protocol_config.get("last_config")
    if isinstance(raw, Mapping):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise AmneziaPremiumImportError(
                "Шлюз Amnezia Premium вернул некорректные параметры клиента."
            ) from exc
        if isinstance(parsed, Mapping):
            return parsed
    raise AmneziaPremiumImportError(
        "Шлюз Amnezia Premium не вернул параметры клиента."
    )


def _append_field(lines: list[str], key: str, value: str) -> None:
    clean = _text(value)
    if clean:
        lines.append(f"{key} = {clean}")


def _connection_name(metadata: Mapping[str, Any]) -> str:
    return _safe_name(_text(metadata.get("name"))) or _safe_name(_text(metadata.get("description"))) or "Amnezia Premium"


def _safe_name(value: str) -> str:
    return " ".join(str(value or "").replace("\r", " ").replace("\n", " ").split())[:80]


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _clamp_x25519_scalar(value: bytes) -> bytes:
    scalar = bytearray(value)
    scalar[0] &= 248
    scalar[31] &= 127
    scalar[31] |= 64
    return bytes(scalar)


def _x25519(scalar: bytes, point: bytes) -> bytes:
    """RFC 7748 X25519 scalar multiplication."""
    prime = 2**255 - 19
    scalar_int = int.from_bytes(_clamp_x25519_scalar(scalar), "little")
    x1 = int.from_bytes(point, "little") % prime
    x2, z2, x3, z3, swap = 1, 0, x1, 1, 0
    for bit_index in range(254, -1, -1):
        bit = (scalar_int >> bit_index) & 1
        swap ^= bit
        if swap:
            x2, x3 = x3, x2
            z2, z3 = z3, z2
        swap = bit
        a = (x2 + z2) % prime
        aa = (a * a) % prime
        b = (x2 - z2) % prime
        bb = (b * b) % prime
        e = (aa - bb) % prime
        c = (x3 + z3) % prime
        d = (x3 - z3) % prime
        da = (d * a) % prime
        cb = (c * b) % prime
        x3 = ((da + cb) ** 2) % prime
        z3 = (x1 * ((da - cb) ** 2)) % prime
        x2 = (aa * bb) % prime
        z2 = (e * (aa + (121665 * e))) % prime
    if swap:
        x2, x3 = x3, x2
        z2, z3 = z3, z2
    result = (x2 * pow(z2, prime - 2, prime)) % prime
    return result.to_bytes(32, "little")


__all__ = [
    "AMNEZIA_PREMIUM_ACCOUNT_URL",
    "AMNEZIA_PREMIUM_GATEWAY_URL",
    "AmneziaPremiumConnection",
    "AmneziaPremiumImportError",
    "decode_connection_key",
    "generate_wireguard_keypair",
    "import_connection_key",
    "is_amnezia_premium_connection_key",
    "list_available_locations",
]
