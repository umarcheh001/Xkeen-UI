"""Safe config patch for the loopback-only Xkeen egress-check listener."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any, Mapping

try:
    import yaml as _yaml
except Exception:  # pragma: no cover - optional on minimal router images
    _yaml = None


LISTENER_NAME = "xkeen-ui-egress-check"
DEFAULT_PORT = 17890
MAX_PORT = 17909
_LISTENERS_RE = re.compile(r"^(?P<indent>[ \t]*)listeners[ \t]*:(?P<tail>[^\r\n]*)$", re.MULTILINE)
_XKEEN_ITEM_RE = re.compile(
    rf"^(?P<indent>[ \t]*)-[ \t]*name[ \t]*:[ \t]*{re.escape(LISTENER_NAME)}[ \t]*(?:#.*)?$"
    r"(?P<body>(?:\r?\n(?P=indent)[ \t]+[^\r\n]*)*)",
    re.MULTILINE,
)
_TOP_LEVEL_PROXY_PORT_RE = re.compile(
    r"^(?:mixed-port|port)[ \t]*:[ \t]*(?P<port>\d+)[ \t]*(?:#.*)?$",
    re.MULTILINE,
)
# Keep the generated private listener in the small top-level API/UI settings
# block, rather than silently appending it after a potentially long rules list.
_API_UI_SETTING_RE = re.compile(
    r"^(?:external-controller-unix|external-controller|secret|external-ui|external-ui-url|profile)[ \t]*:.*$",
    re.MULTILINE,
)
_RULES_RE = re.compile(r"^rules[ \t]*:.*$", re.MULTILINE)


class MihomoEgressSetupError(ValueError):
    pass


@dataclass(frozen=True)
class MihomoEgressSetupPreview:
    content: str
    port: int
    changes: tuple[str, ...]

    @property
    def preview_id(self) -> str:
        digest = hashlib.sha256()
        digest.update(str(self.port).encode("ascii"))
        digest.update(b"\0")
        digest.update(self.content.encode("utf-8"))
        return digest.hexdigest()

    def public_dict(self) -> dict[str, Any]:
        return {
            "preview_id": self.preview_id,
            "port": self.port,
            "listener": LISTENER_NAME,
            "listen": "127.0.0.1",
            "changes": list(self.changes),
        }


def _loaded(text: str) -> Mapping[str, Any]:
    if _yaml is None:
        return {}
    try:
        value = _yaml.safe_load(str(text or ""))
    except Exception as exc:
        raise MihomoEgressSetupError("egress_setup_yaml_invalid") from exc
    return value if isinstance(value, Mapping) else {}


def _valid_port(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        port = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return port if 1 <= port <= 65535 else None


def _listeners(config: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    value = config.get("listeners")
    if value is None:
        return []
    if not isinstance(value, list):
        raise MihomoEgressSetupError("egress_setup_listeners_invalid")
    return [item for item in value if isinstance(item, Mapping)]


def configured_egress_proxy_port(
    text: str,
    runtime_config: Mapping[str, Any] | None = None,
) -> int | None:
    """Prefer Xkeen's private listener, then an existing global proxy port."""

    config = _loaded(text)
    for item in _listeners(config):
        if str(item.get("name") or "") != LISTENER_NAME:
            continue
        if str(item.get("type") or "").lower() != "mixed":
            return None
        listen = str(item.get("listen") or "").strip().lower()
        if listen not in {"127.0.0.1", "localhost", "::1"}:
            return None
        return _valid_port(item.get("port"))

    # Router builds may omit PyYAML. Recognize the narrowly generated block
    # without attempting to interpret arbitrary YAML.
    text_match = _XKEEN_ITEM_RE.search(str(text or ""))
    if text_match:
        body = text_match.group("body") or ""
        type_match = re.search(r"^[ \t]+type[ \t]*:[ \t]*mixed[ \t]*(?:#.*)?$", body, re.MULTILINE | re.IGNORECASE)
        listen_match = re.search(r"^[ \t]+listen[ \t]*:[ \t]*(?:127\.0\.0\.1|localhost|::1)[ \t]*(?:#.*)?$", body, re.MULTILINE | re.IGNORECASE)
        port_match = re.search(r"^[ \t]+port[ \t]*:[ \t]*(\d+)[ \t]*(?:#.*)?$", body, re.MULTILINE)
        if type_match and listen_match and port_match:
            return _valid_port(port_match.group(1))
        return None

    runtime = runtime_config if isinstance(runtime_config, Mapping) else {}
    for source in (runtime, config):
        for key in ("mixed-port", "port"):
            port = _valid_port(source.get(key))
            if port:
                return port
    text_port = _TOP_LEVEL_PROXY_PORT_RE.search(str(text or ""))
    if text_port:
        return _valid_port(text_port.group("port"))
    return None


def _declared_ports(value: Any, found: set[int]) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            if str(key).lower() in {"port", "mixed-port", "socks-port", "redir-port", "tproxy-port"}:
                port = _valid_port(child)
                if port:
                    found.add(port)
            _declared_ports(child, found)
    elif isinstance(value, list):
        for child in value:
            _declared_ports(child, found)


def _choose_port(config: Mapping[str, Any]) -> int:
    used: set[int] = set()
    _declared_ports(config, used)
    for port in range(DEFAULT_PORT, MAX_PORT + 1):
        if port not in used:
            return port
    raise MihomoEgressSetupError("egress_setup_no_free_port")


def _choose_port_from_text(config: Mapping[str, Any], text: str) -> int:
    used: set[int] = set()
    _declared_ports(config, used)
    for match in re.finditer(
        r"^(?:[ \t-]*)(?:port|mixed-port|socks-port|redir-port|tproxy-port)[ \t]*:[ \t]*(\d+)",
        str(text or ""),
        re.MULTILINE,
    ):
        port = _valid_port(match.group(1))
        if port:
            used.add(port)
    for port in range(DEFAULT_PORT, MAX_PORT + 1):
        if port not in used:
            return port
    raise MihomoEgressSetupError("egress_setup_no_free_port")


def _listener_yaml(port: int, *, indent: str = "") -> str:
    child = indent + "  "
    return (
        f"{indent}- name: {LISTENER_NAME}\n"
        f"{child}type: mixed\n"
        f"{child}port: {port}\n"
        f"{child}listen: 127.0.0.1\n"
        f"{child}udp: false\n"
        f"{child}users: []\n"
    )


def _insert_listeners_block(text: str, block: str) -> str:
    """Place a new listeners block after the active API/UI settings when known."""

    matches = list(_API_UI_SETTING_RE.finditer(text))
    if matches:
        anchor = matches[-1]
        return text[: anchor.end()] + "\n\n" + block + text[anchor.end() :]
    rules = _RULES_RE.search(text)
    if rules:
        return text[: rules.start()].rstrip() + "\n\n" + block + "\n" + text[rules.start() :]
    return text.rstrip() + "\n\n" + block


def build_mihomo_egress_setup(text: str) -> MihomoEgressSetupPreview:
    original = str(text or "")
    config = _loaded(original)
    existing = configured_egress_proxy_port(original)
    if existing:
        return MihomoEgressSetupPreview(original, existing, ())

    for item in _listeners(config):
        if str(item.get("name") or "") == LISTENER_NAME:
            raise MihomoEgressSetupError("egress_setup_listener_conflict")
    if _XKEEN_ITEM_RE.search(original):
        raise MihomoEgressSetupError("egress_setup_listener_conflict")

    port = _choose_port_from_text(config, original)
    match = _LISTENERS_RE.search(original)
    if match:
        if match.group("indent"):
            raise MihomoEgressSetupError("egress_setup_listeners_not_top_level")
        tail = match.group("tail").strip()
        if tail and not tail.startswith("#") and tail != "[]":
            raise MihomoEgressSetupError("egress_setup_listeners_inline_unsupported")
        prefix = original[: match.start()]
        suffix = original[match.end() :]
        replacement = "listeners:\n" + _listener_yaml(port, indent="  ")
        content = prefix + replacement + suffix.lstrip("\r\n")
    else:
        content = _insert_listeners_block(
            original,
            "listeners:\n" + _listener_yaml(port, indent="  "),
        )

    # Validate the generated document when PyYAML is available and ensure the
    # exact listener can be found again before any caller writes it.
    if configured_egress_proxy_port(content) != port:
        raise MihomoEgressSetupError("egress_setup_generated_config_invalid")
    return MihomoEgressSetupPreview(
        content,
        port,
        (
            "Создать локальный mixed-listener только на 127.0.0.1",
            "Запретить UDP и доступ без loopback-интерфейса",
        ),
    )


__all__ = [
    "LISTENER_NAME",
    "MihomoEgressSetupError",
    "MihomoEgressSetupPreview",
    "build_mihomo_egress_setup",
    "configured_egress_proxy_port",
]
