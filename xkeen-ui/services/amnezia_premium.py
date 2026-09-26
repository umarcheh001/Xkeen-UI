"""Import Amnezia Premium ``vpn://`` connection keys as Mihomo WireGuard configs.

Amnezia Premium keys are compact, URL-safe-base64 payloads. They carry the
subscription metadata and API key, not a ready-to-use peer configuration. An
explicit import requests one AmneziaWG/WireGuard client configuration from the
official gateway and keeps the connection key in memory only.
"""

from __future__ import annotations

import base64
import json
import secrets
import urllib.error
import urllib.request
import uuid
import zlib
from dataclasses import dataclass
from typing import Any, Callable, Mapping


AMNEZIA_PREMIUM_GATEWAY_URL = "https://gw.amnezia.org/v1/config"
AMNEZIA_PREMIUM_ACCOUNT_URL = "https://gw.amnezia.org/v1/account_info"
_CONNECTION_KEY_SIGNATURE = b"\x00\x00\x00\xff"
_MAX_CONNECTION_KEY_BYTES = 32 * 1024
_MAX_GATEWAY_RESPONSE_BYTES = 512 * 1024
_SUPPORTED_PROTOCOLS = {"awg", "wireguard"}

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

    private_key, public_key = generate_wireguard_keypair()
    payload = _gateway_payload(
        connection,
        public_key=public_key,
        server_country_code=server_country_code,
    )

    response = (gateway_post or _post_to_gateway)(payload)
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
    response = _post_to_gateway(
        _gateway_payload(connection),
        endpoint="account_info",
    )
    raw_locations = response.get("available_countries")
    if not isinstance(raw_locations, list):
        raw_locations = _mapping(response.get("api_config")).get("available_countries")
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
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
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
