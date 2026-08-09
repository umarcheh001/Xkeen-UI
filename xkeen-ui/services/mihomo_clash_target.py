"""Safe discovery of the local Mihomo Clash API target.

This module deliberately does *not* make network requests.  It reads the
server-owned active Mihomo config and resolves it to either a Unix socket
inside ``MIHOMO_ROOT`` or an allow-listed loopback TCP port.  Browser input is
never part of target selection.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

try:
    import yaml as _yaml
except Exception:  # pragma: no cover - optional on router installations
    _yaml = None


CLASH_API_ALLOWED_PORTS_ENV = "XKEEN_CLASH_API_ALLOWED_PORTS"
DEFAULT_CLASH_API_PORT = 9090
MAX_CLASH_CONFIG_BYTES = 2 * 1024 * 1024

_SENSITIVE_TOP_LEVEL_KEYS = {
    "external-controller",
    "external-controller-unix",
    "secret",
}
_TOP_LEVEL_KEY_RE = re.compile(r"^([A-Za-z0-9_.-]+)\s*:\s*(.*)$")


@dataclass(frozen=True)
class MihomoClashDiagnostic:
    """A safe, detail-free discovery diagnostic suitable for the UI."""

    code: str
    severity: str = "error"

    def public_dict(self) -> dict[str, str]:
        return {"code": self.code, "severity": self.severity}


@dataclass(frozen=True, repr=False)
class MihomoClashTarget:
    """Backend-only connection target.

    ``secret``, ``socket_path`` and ``loopback_host`` are intentionally absent
    from repr/str and from :meth:`public_dict`.
    """

    transport: str
    port: int | None = None
    socket_path: Path | None = field(default=None, repr=False)
    loopback_host: str | None = field(default=None, repr=False)
    secret: str = field(default="", repr=False, compare=False)

    def __repr__(self) -> str:
        return f"MihomoClashTarget(transport={self.transport!r})"

    __str__ = __repr__

    def public_dict(self) -> dict[str, Any]:
        return {
            "transport": self.transport,
            "secret_configured": bool(self.secret),
        }

    def authorization_header(self) -> str | None:
        return f"Bearer {self.secret}" if self.secret else None


@dataclass(frozen=True, repr=False)
class MihomoClashDiscovery:
    """Result of target discovery with a deliberately redacted public view."""

    configured: bool
    target: MihomoClashTarget | None = field(default=None, repr=False)
    diagnostics: tuple[MihomoClashDiagnostic, ...] = ()
    secret_configured: bool = False

    def __repr__(self) -> str:
        transport = self.target.transport if self.target else None
        return (
            "MihomoClashDiscovery("
            f"configured={self.configured!r}, target_ready={self.target is not None!r}, "
            f"transport={transport!r}, diagnostics={len(self.diagnostics)!r})"
        )

    __str__ = __repr__

    @property
    def target_ready(self) -> bool:
        return self.target is not None

    def public_dict(self) -> dict[str, Any]:
        return {
            "configured": bool(self.configured),
            "target_ready": self.target is not None,
            "transport": self.target.transport if self.target else None,
            "secret_configured": bool(self.secret_configured),
            "diagnostics": [item.public_dict() for item in self.diagnostics],
        }


def parse_allowed_clash_api_ports(environ: Mapping[str, Any] | None = None) -> frozenset[int]:
    """Return the configured TCP port allow-list.

    Missing/blank configuration uses port 9090.  A non-empty but malformed
    explicit value yields an empty set (fail closed instead of silently
    widening or falling back).
    """

    source = os.environ if environ is None else environ
    raw = source.get(CLASH_API_ALLOWED_PORTS_ENV)
    if raw is None or not str(raw).strip():
        return frozenset({DEFAULT_CLASH_API_PORT})

    ports: set[int] = set()
    for item in str(raw).split(","):
        token = item.strip()
        if not token or not token.isascii() or not token.isdigit():
            return frozenset()
        port = int(token)
        if not 1 <= port <= 65535:
            return frozenset()
        ports.add(port)
    return frozenset(ports)


def _is_within_root(path: Path, root: Path) -> bool:
    try:
        return os.path.commonpath([str(path), str(root)]) == str(root)
    except (OSError, ValueError):
        return False


def _strip_inline_comment(value: str) -> str:
    quote = ""
    escaped = False
    out: list[str] = []
    for char in value:
        if escaped:
            out.append(char)
            escaped = False
            continue
        if char == "\\" and quote == '"':
            out.append(char)
            escaped = True
            continue
        if quote:
            out.append(char)
            if char == quote:
                quote = ""
            continue
        if char in ("'", '"'):
            quote = char
            out.append(char)
            continue
        if char == "#":
            break
        out.append(char)
    return "".join(out).strip()


def _parse_fallback_scalar(raw: str) -> Any:
    value = _strip_inline_comment(raw)
    if not value:
        return None
    if value.startswith('"'):
        if not value.endswith('"'):
            raise ValueError("unterminated quoted scalar")
        return json.loads(value)
    if value.startswith("'"):
        if not value.endswith("'"):
            raise ValueError("unterminated quoted scalar")
        return value[1:-1].replace("''", "'")
    if value in ("null", "Null", "NULL", "~"):
        return None
    return value


def _parse_top_level_fallback(text: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for line in text.splitlines():
        if not line or line[0].isspace() or line.lstrip().startswith("#"):
            continue
        match = _TOP_LEVEL_KEY_RE.match(line)
        if not match:
            continue
        key = match.group(1)
        if key in _SENSITIVE_TOP_LEVEL_KEYS:
            result[key] = _parse_fallback_scalar(match.group(2))
    return result


def _duplicate_sensitive_keys(text: str) -> set[str]:
    counts: dict[str, int] = {}
    for line in text.splitlines():
        if not line or line[0].isspace() or line.lstrip().startswith("#"):
            continue
        match = _TOP_LEVEL_KEY_RE.match(line)
        if not match:
            continue
        key = match.group(1)
        if key in _SENSITIVE_TOP_LEVEL_KEYS:
            counts[key] = counts.get(key, 0) + 1
    return {key for key, count in counts.items() if count > 1}


def parse_mihomo_clash_config(text: str) -> dict[str, Any]:
    """Parse only the top-level values needed for Clash API discovery."""

    if _duplicate_sensitive_keys(text):
        raise ValueError("duplicate sensitive top-level keys")

    if _yaml is None:
        return _parse_top_level_fallback(text)

    parsed = _yaml.safe_load(text)
    if parsed is None:
        return {}
    if not isinstance(parsed, Mapping):
        raise ValueError("Mihomo config root must be a mapping")
    return {key: parsed.get(key) for key in _SENSITIVE_TOP_LEVEL_KEYS if key in parsed}


def _read_config(config_path: Path, mihomo_root: Path) -> tuple[str | None, str | None]:
    try:
        root = mihomo_root.expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return None, "mihomo_root_missing"

    try:
        resolved = config_path.expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return None, "config_missing"

    if not _is_within_root(resolved, root):
        return None, "config_outside_root"

    try:
        size = resolved.stat().st_size
        if size > MAX_CLASH_CONFIG_BYTES:
            return None, "config_too_large"
        raw = resolved.read_bytes()
    except OSError:
        return None, "config_read_failed"

    if len(raw) > MAX_CLASH_CONFIG_BYTES:
        return None, "config_too_large"
    try:
        return raw.decode("utf-8"), None
    except UnicodeDecodeError:
        return None, "config_encoding_invalid"


def _scalar_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        return str(value).strip()
    raise ValueError("expected scalar")


def _parse_tcp_binding(value: Any) -> tuple[str, int, str]:
    raw = _scalar_text(value)
    if not raw or "://" in raw or any(char in raw for char in ("/", "\\", "?", "#", "\x00")):
        raise ValueError("invalid controller binding")

    if raw.startswith("["):
        match = re.fullmatch(r"\[([^\]]+)]:(\d{1,5})", raw)
    else:
        match = re.fullmatch(r"([^:\s]+):(\d{1,5})", raw)
    if not match:
        raise ValueError("invalid controller binding")

    bind_host = match.group(1).strip()
    port = int(match.group(2))
    if not (1 <= port <= 65535):
        raise ValueError("invalid controller port")

    normalized_host = bind_host.strip("[]").lower()
    loopback_host = "127.0.0.1"
    try:
        ip = ipaddress.ip_address(normalized_host.split("%", 1)[0])
        if ip.version == 6:
            loopback_host = "::1"
    except ValueError:
        if normalized_host == "localhost":
            loopback_host = "127.0.0.1"
    return bind_host, port, loopback_host


def _bind_is_loopback(bind_host: str) -> bool:
    host = str(bind_host or "").strip().strip("[]").lower().split("%", 1)[0]
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _resolve_unix_path(value: Any, root: Path) -> tuple[Path | None, str | None]:
    try:
        raw = _scalar_text(value)
    except ValueError:
        return None, "unix_socket_invalid"
    if not raw or "\x00" in raw:
        return None, "unix_socket_invalid"

    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        resolved = candidate.resolve(strict=False)
    except (OSError, RuntimeError):
        return None, "unix_socket_invalid"
    if not _is_within_root(resolved, root):
        return None, "unix_socket_outside_root"
    return resolved, None


def _default_socket_probe(path: Path) -> bool:
    try:
        return stat.S_ISSOCK(path.stat().st_mode)
    except OSError:
        return False


def discover_mihomo_clash_target(
    config_path: str | os.PathLike[str],
    mihomo_root: str | os.PathLike[str],
    *,
    environ: Mapping[str, Any] | None = None,
    socket_probe: Callable[[Path], bool] | None = None,
) -> MihomoClashDiscovery:
    """Resolve the active config to a safe backend-only Clash API target."""

    diagnostics: list[MihomoClashDiagnostic] = []
    text, read_error = _read_config(Path(config_path), Path(mihomo_root))
    if read_error:
        diagnostics.append(MihomoClashDiagnostic(read_error))
        return MihomoClashDiscovery(configured=False, diagnostics=tuple(diagnostics))

    try:
        config = parse_mihomo_clash_config(text or "")
    except Exception:
        diagnostics.append(MihomoClashDiagnostic("config_parse_failed"))
        return MihomoClashDiscovery(configured=False, diagnostics=tuple(diagnostics))

    try:
        secret = _scalar_text(config.get("secret"))
    except ValueError:
        diagnostics.append(MihomoClashDiagnostic("secret_invalid"))
        secret = ""

    unix_configured = bool(config.get("external-controller-unix"))
    tcp_configured = bool(config.get("external-controller"))
    configured = unix_configured or tcp_configured

    try:
        root = Path(mihomo_root).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):  # already checked by _read_config
        diagnostics.append(MihomoClashDiagnostic("mihomo_root_missing"))
        return MihomoClashDiscovery(
            configured=configured,
            diagnostics=tuple(diagnostics),
            secret_configured=bool(secret),
        )

    unix_target: MihomoClashTarget | None = None
    if unix_configured:
        socket_path, unix_error = _resolve_unix_path(config.get("external-controller-unix"), root)
        if unix_error:
            diagnostics.append(MihomoClashDiagnostic(unix_error))
        elif socket_path is not None:
            probe = socket_probe or _default_socket_probe
            try:
                socket_ready = bool(probe(socket_path))
            except Exception:
                socket_ready = False
            if socket_ready:
                unix_target = MihomoClashTarget(
                    transport="unix",
                    socket_path=socket_path,
                    secret=secret,
                )
            else:
                diagnostics.append(MihomoClashDiagnostic("unix_socket_missing", "warning"))

    tcp_target: MihomoClashTarget | None = None
    if tcp_configured:
        try:
            bind_host, port, loopback_host = _parse_tcp_binding(config.get("external-controller"))
        except (TypeError, ValueError):
            diagnostics.append(MihomoClashDiagnostic("controller_invalid"))
        else:
            if not _bind_is_loopback(bind_host) and not secret:
                diagnostics.append(MihomoClashDiagnostic("secret_missing_on_lan_bind", "warning"))
            if port not in parse_allowed_clash_api_ports(environ):
                diagnostics.append(MihomoClashDiagnostic("port_not_allowed"))
            else:
                tcp_target = MihomoClashTarget(
                    transport="tcp",
                    port=port,
                    loopback_host=loopback_host,
                    secret=secret,
                )

    target = unix_target or tcp_target
    if not configured:
        diagnostics.append(MihomoClashDiagnostic("controller_missing"))

    return MihomoClashDiscovery(
        configured=configured,
        target=target,
        diagnostics=tuple(diagnostics),
        secret_configured=bool(secret),
    )


__all__ = [
    "CLASH_API_ALLOWED_PORTS_ENV",
    "DEFAULT_CLASH_API_PORT",
    "MAX_CLASH_CONFIG_BYTES",
    "MihomoClashDiagnostic",
    "MihomoClashDiscovery",
    "MihomoClashTarget",
    "discover_mihomo_clash_target",
    "parse_allowed_clash_api_ports",
    "parse_mihomo_clash_config",
]
