"""Transactional, one-click DNS protection for Mihomo on Keenetic.

The assistant deliberately owns only one top-level ``dns`` block and the
Keenetic ``opkg dns-override`` switch.  Public DoH queries are addressed by IP
and explicitly sent through an existing Mihomo proxy group, so resolving the
resolver itself cannot create a bootstrap loop.

Every change is validated before it is written, backed up, restarted and
tested with a real DNS query.  The exact previous config is kept outside the
active profile and is restored on disable or on any failed enable.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import random
import re
import shlex
import shutil
import socket
import stat
import struct
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from services.cores import detect_running_core
from services.io.atomic import _atomic_write_json, _atomic_write_text
from services.xkeen_commands_catalog import resolve_xkeen_init_script
from utils.firmware import ndmc_path as _resolve_ndmc, run_ndmc


STATE_FILENAME = "mihomo_dns.json"
# The guard's own trace.  It lives beside the assistant state instead of inside
# it because a release *clears* that state, and every "is this assistant
# configured?" check keys off the state file being there.
RELEASE_FILENAME = "mihomo_dns_watchdog.json"
MANAGED_BEGIN = "# BEGIN XKeen UI Mihomo DNS (managed)"
MANAGED_END = "# END XKeen UI Mihomo DNS (managed)"
DNS_LISTEN = "0.0.0.0:53"
PROBE_DOMAIN = "example.com"
DEFAULT_FAKE_IP_RANGE = "198.18.0.1/16"
DEFAULT_FAKE_IP_FILTER_MODE = "blacklist"
DEFAULT_FAKE_IP_FILTERS = ("*.lan", "*.local")
DEFAULT_FAKE_IP_EXTRA_FILTERS = ("+.tsarea.tv",)
DEFAULT_GEOSITE_URL = "https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat"
# Domain rule-sets are a GeoSite-free alternative for Fake-IP filters.  Keep
# the names stable: they are referenced by ``rule-set:...`` values in the
# generated DNS block and can also be reused by the user's routing rules.
DEFAULT_DOMAIN_RULE_PROVIDERS = {
    "category_ru@domain": "https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/category-ru.mrs",
    "geosite_private@domain": "https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/private.mrs",
    # MetaCubeX does not publish a category-ai.mrs file.  Keep the provider
    # name requested by the UI profile, but point it at the maintained
    # non-China AI/chat category which covers ChatGPT, Claude, Gemini, etc.
    "category-ai@domain": "https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/category-ai-chat-!cn.mrs",
}
DEFAULT_REDIR_BOOTSTRAP = ("77.88.8.8", "1.1.1.1")
DEFAULT_REDIR_ROUTED_NAMESERVERS = (
    ("https://8.8.8.8/dns-query", "dns.google"),
    ("https://1.1.1.1/dns-query", "cloudflare-dns.com"),
)
DEFAULT_FAKE_IP_BOOTSTRAP = ("77.88.8.8", "77.88.8.1")
DEFAULT_FAKE_IP_NAMESERVERS = (
    "https://geohide.ru/dns-query",
    "quic://dns.comss.one",
    "https://dns.alidns.com/dns-query",
    "https://xbox-dns.ru/dns-query",
)
DEFAULT_FAKE_IP_ROUTED_NAMESERVERS = (
    ("https://cloudflare-dns.com/dns-query", "cloudflare-dns.com"),
    ("https://dns.google/dns-query", "dns.google"),
    ("tls://8.8.8.8", "dns.google"),
    ("tls://1.1.1.1", "cloudflare-dns.com"),
)
DEFAULT_FAKE_IP_DNS_POLICY = {
    "rule-set:category_ru@domain": DEFAULT_FAKE_IP_BOOTSTRAP,
    "rule-set:category-ai@domain": ("https://xbox-dns.ru/dns-query",),
}
DNS_SELECTOR_NAME = "DNS Proxy"
DNS_SELECTOR_ICON = "https://img.icons8.com/fluency/96/dns.png"
DNS_MODES = ("redir-host", "fake-ip")
FAKE_IP_FILTER_MODES = ("blacklist", "whitelist", "rule")
IPTABLES_BINARIES = ("/opt/sbin/iptables", "iptables")
XKEEN_FIREWALL_CHAIN = "xkeen"
XKEEN_INIT_SCRIPT = "/opt/etc/init.d/S05xkeen"
LEGACY_FAKE_IP_EXCLUSION = "198.18.0.0/15"
_LOCK = threading.RLock()


class MihomoDnsError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "mihomo_dns_failed",
        details: Any = None,
        rolled_back: bool = False,
    ):
        super().__init__(message)
        self.code = code
        self.details = details
        self.rolled_back = bool(rolled_back)


def _sha256(text: str) -> str:
    return hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()


def _read_text(path: str, default: Optional[str] = None) -> Optional[str]:
    try:
        return Path(path).read_text(encoding="utf-8")
    except OSError:
        return default


def _state_dir(ui_state_dir: str, config_file: str) -> str:
    root = str(ui_state_dir or "").strip()
    if root:
        return os.path.join(root, "mihomo-dns")
    return os.path.join(os.path.dirname(os.path.abspath(config_file)), ".xkeen-ui-state", "mihomo-dns")


def _state_path(ui_state_dir: str, config_file: str) -> str:
    return os.path.join(_state_dir(ui_state_dir, config_file), STATE_FILENAME)


def _load_state(ui_state_dir: str, config_file: str) -> dict[str, Any]:
    path = _state_path(ui_state_dir, config_file)
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def _save_state(ui_state_dir: str, config_file: str, state: dict[str, Any]) -> None:
    path = _state_path(ui_state_dir, config_file)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    _atomic_write_json(path, state)


def _clear_state(ui_state_dir: str, config_file: str) -> None:
    try:
        os.remove(_state_path(ui_state_dir, config_file))
    except FileNotFoundError:
        pass


def _release_path(ui_state_dir: str, config_file: str) -> str:
    return os.path.join(_state_dir(ui_state_dir, config_file), RELEASE_FILENAME)


def read_release(*, config_file: str, ui_state_dir: str) -> Optional[dict[str, Any]]:
    """The last time the shared guard handed DNS back, if it has not been read away.

    The panel shows this instead of a plain "off": protection that switched
    itself off is not the same thing as protection nobody turned on.
    """

    try:
        value = json.loads(Path(_release_path(ui_state_dir, config_file)).read_text(encoding="utf-8"))
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def _record_release(ui_state_dir: str, config_file: str, released: dict[str, Any]) -> None:
    path = _release_path(ui_state_dir, config_file)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _atomic_write_json(path, released)
    except Exception:
        pass


def _clear_release(ui_state_dir: str, config_file: str) -> None:
    """Forget the guard's trace once the operator acts on the protection again."""

    try:
        os.remove(_release_path(ui_state_dir, config_file))
    except FileNotFoundError:
        pass
    except Exception:
        pass


_TOP_LEVEL_KEY_RE = re.compile(r"^(?P<key>[A-Za-z0-9_.-]+)[ \t]*:(?P<tail>[^\r\n]*)$", re.MULTILINE)


def _top_level_section(text: str, key: str) -> Optional[tuple[int, int, str]]:
    """Return the complete top-level YAML section without parsing user YAML."""

    matches = list(_TOP_LEVEL_KEY_RE.finditer(str(text or "")))
    for index, match in enumerate(matches):
        if match.group("key") != key:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        # Include at most the blank lines immediately preceding the next key in
        # the replacement.  This avoids joining the following section to the
        # managed END marker when a user config has no trailing newline.
        return match.start(), end, text[match.start():end]
    return None


def _strip_yaml_scalar(value: str) -> str:
    raw = str(value or "").strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {"'", '"'}:
        raw = raw[1:-1]
    return raw.replace("''", "'").strip()


def _dns_runtime_config(text: str) -> dict[str, Any]:
    """Inspect the user-visible DNS section without claiming ownership of it.

    The managed comments are intentionally not required here.  YAML formatters
    and manual edits may remove comments while leaving the complete, working
    ``dns`` mapping in place.  Ownership/rollback still uses the transaction
    hash below, but runtime status must be based on the actual configuration.
    """

    section = _top_level_section(text, "dns")
    if section is None:
        return {
            "present": False,
            "enabled": False,
            "listen": "",
            "listener_configured": False,
            "mode": "",
            "fake_ip_range": "",
        }

    body = section[2]

    def nested_scalar(key: str) -> str:
        match = re.search(rf"^[ \t]+{re.escape(key)}[ \t]*:[ \t]*([^#\r\n]+)", body, re.MULTILINE)
        return _strip_yaml_scalar(match.group(1)) if match else ""

    enabled_value = nested_scalar("enable").lower()
    dns_enabled = enabled_value in {"true", "yes", "on", "1"}
    listen = nested_scalar("listen")
    mode = nested_scalar("enhanced-mode").lower()
    fake_ip_range = nested_scalar("fake-ip-range")
    normalized_listen = listen.rsplit("/", 1)[0].strip().lower()
    listener_configured = bool(
        dns_enabled
        and re.search(r"(?:^|:)(?:53)$", normalized_listen)
    )
    return {
        "present": True,
        "enabled": dns_enabled,
        "listen": listen,
        "listener_configured": listener_configured,
        "mode": mode,
        "fake_ip_range": fake_ip_range,
    }


def _with_dns_disabled(text: str) -> tuple[str, bool]:
    """Disable Mihomo DNS without deleting the user's ``dns`` mapping.

    ``no opkg dns-override`` only asks KeeneticOS to start its own resolver; it
    does not make Mihomo ignore a listener that is still configured on port 53.
    A restart with that listener intact leaves the two processes racing for the
    same socket.  For a config edited after the assistant ran (or a completely
    user-owned config), preserve the mapping and change only its direct
    ``enable`` key instead of restoring an old whole-file snapshot.

    The assistant already inspects this small part of YAML textually so that it
    never reformats the rest of a profile.  Use the least-indented ``enable``
    key in the section: nested mappings may legally contain keys with the same
    name, but the direct DNS switch is the shallow one.
    """

    source = str(text or "")
    section = _top_level_section(source, "dns")
    if section is None:
        return source, False
    start, _end, body = section
    first_line, separator, tail = body.partition("\n")
    # Flow-style mappings cannot be patched byte-for-byte with this narrow
    # helper.  Refuse to guess; the emergency path will still restore the
    # firmware switch and record that the listener could not be parked.
    if first_line.partition(":")[2].strip():
        return source, False

    matches = list(re.finditer(
        r"(?m)^(?P<indent>[ \t]+)enable(?P<colon>[ \t]*:[ \t]*)"
        r"(?P<value>[^#\r\n]*?)(?P<comment>[ \t]*(?:#.*)?)$",
        body,
    ))
    if matches:
        match = min(matches, key=lambda item: len(item.group("indent").expandtabs(8)))
        value = _strip_yaml_scalar(match.group("value")).lower()
        if value in {"false", "no", "off", "0"}:
            return source, False
        replacement = (
            f'{match.group("indent")}enable{match.group("colon")}false'
            f'{match.group("comment")}'
        )
        patched_body = body[:match.start()] + replacement + body[match.end():]
    else:
        # A missing enable key means Mihomo's DNS is not active, but inserting
        # an explicit false makes the parked state unambiguous on later edits.
        indent_match = re.search(r"(?m)^([ \t]+)[A-Za-z0-9_.-]+[ \t]*:", tail)
        indent = indent_match.group(1) if indent_match else "  "
        patched_body = first_line + "\n" + indent + "enable: false"
        if separator:
            patched_body += "\n" + tail

    return source[:start] + patched_body + source[start + len(body):], True


def _proxy_groups(text: str) -> list[str]:
    section = _top_level_section(text, "proxy-groups")
    if not section:
        return []
    body = section[2]
    names: list[str] = []
    for line in body.splitlines()[1:]:
        match = re.match(r"^[ \t]+-[ \t]*(?:\{[ \t]*)?name[ \t]*:[ \t]*(.+?)(?:,[ \t]*|\}[ \t]*|[ \t]+#.*)?$", line)
        if not match:
            continue
        name = _strip_yaml_scalar(match.group(1).rstrip(" }").strip())
        if name and name not in names:
            names.append(name)
    return names


def _select_proxy_group(text: str) -> Optional[str]:
    names = _proxy_groups(text)
    if not names:
        return None
    preferred = (
        "Заблок. сервисы",
        "PROXY",
        "Proxy",
        "Прокси",
        "GLOBAL",
        "Global",
        "Auto",
        "Авто",
    )
    for candidate in preferred:
        if candidate in names:
            return candidate
    ignored = {"direct", "reject", "pass", "compatible"}
    return next((name for name in names if name.strip().lower() not in ignored), None)


def _yaml_single_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _with_dns_selector(text: str, upstream: str) -> str:
    """Append the optional DNS route switch without replacing user groups."""

    source = str(text or "")
    target = str(upstream or "").strip()
    if not target:
        raise MihomoDnsError("Не выбран основной маршрут DNS.", code="proxy_group_missing")
    names = _proxy_groups(source)
    if DNS_SELECTOR_NAME in names:
        raise MihomoDnsError(
            f"Proxy-группа «{DNS_SELECTOR_NAME}» уже существует; панель не будет её перезаписывать.",
            code="dns_selector_conflict",
        )
    if target not in names:
        raise MihomoDnsError("Выбранная proxy-группа отсутствует в config.yaml.", code="proxy_group_invalid")
    section = _top_level_section(source, "proxy-groups")
    if not section:
        raise MihomoDnsError("В config.yaml отсутствует раздел proxy-groups.", code="proxy_group_missing")
    start, _end, body = section
    rendered = (
        f"  - name: {_yaml_single_quote(DNS_SELECTOR_NAME)}\n"
        "    type: select\n"
        f"    icon: {_yaml_single_quote(DNS_SELECTOR_ICON)}\n"
        "    proxies:\n"
        f"      - {_yaml_single_quote(target)}\n"
        "      - DIRECT\n"
    )
    replacement = body.rstrip("\r\n") + "\n" + rendered
    return source[:start] + replacement + source[start + len(body):]


def _top_level_scalar(text: str, key: str) -> str:
    """Read a simple top-level scalar without parsing/rewriting the YAML."""

    match = re.search(rf"(?im)^{re.escape(key)}[ \t]*:[ \t]*([^#\r\n]+)", str(text or ""))
    return _strip_yaml_scalar(match.group(1)) if match else ""


def _section_scalar(section: Optional[tuple[int, int, str]], key: str) -> str:
    """Read a nested scalar from a top-level mapping section."""

    if not section:
        return ""
    body = section[2]
    match = re.search(rf"^[ \t]+{re.escape(key)}[ \t]*:[ \t]*([^#\r\n]+)", body, re.MULTILINE)
    if match:
        return _strip_yaml_scalar(match.group(1))
    # Also accept the compact form: ``geox-url: { geosite: ... }``.
    first_line = body.splitlines()[0] if body else ""
    compact = re.search(rf"[{{,][ \t]*{re.escape(key)}[ \t]*:[ \t]*([^,}}#\r\n]+)", first_line)
    return _strip_yaml_scalar(compact.group(1)) if compact else ""


def _yaml_bool(value: str) -> Optional[bool]:
    normalized = str(value or "").strip().lower()
    if normalized in {"true", "yes", "on", "1"}:
        return True
    if normalized in {"false", "no", "off", "0"}:
        return False
    return None


def _geodata_runtime_config(config_text: str) -> dict[str, Any]:
    """Describe GeoSite availability without assuming a DAT is installed.

    Mihomo supports two different kinds of private-domain sources:

    * a ``rule-providers`` entry (usually ``geosite-private``) with
      ``behavior: domain``/``classical``; and
    * a GeoSite DAT selected through ``geodata-mode`` + ``geox-url.geosite``,
      referenced from Fake-IP filters as ``geosite:private``.

    These are deliberately kept separate.  An ``ipcidr`` provider such as
    ``private@ip`` is useful for routing but cannot filter DNS names.
    """

    mode_raw = _top_level_scalar(config_text, "geodata-mode")
    mode = _yaml_bool(mode_raw)
    geosite_url = _section_scalar(_top_level_section(config_text, "geox-url"), "geosite")
    domain_provider_names = _domain_rule_provider_names(config_text)
    domain_providers = _domain_rule_provider_status(config_text)
    private_provider = next(
        (name for name in domain_provider_names if "private" in name.lower()),
        "",
    )
    category_ru_provider = next(
        (name for name in domain_provider_names if name.lower() in {"category_ru@domain", "category-ru@domain"}),
        "",
    )
    # An explicit false always wins.  If geodata-mode is omitted, a geosite
    # source is still useful in Mihomo's normal geodata loader; the preflight
    # remains the final authority for the concrete binary/version.
    # ``geodata-mode: true`` and an explicit geox-url are both required before
    # the UI calls ``geosite:private`` available.  A URL without the mode may
    # be ignored by Mihomo, while the mode without a URL may refer to a missing
    # local geosite.dat.  Keep the warning actionable in both cases.
    geodata_enabled = mode is True and bool(geosite_url)
    geosite_configured = bool(geosite_url)
    if private_provider:
        private_filter = f"rule-set:{private_provider}"
        private_source = "rule-provider"
    elif geodata_enabled:
        private_filter = "geosite:private"
        private_source = "geodata"
    else:
        private_filter = ""
        private_source = ""

    if private_provider:
        notice = (
            f"Найден доменный rule-provider «{private_provider}». Для Fake-IP можно "
            f"использовать фильтр {private_filter}; provider с behavior: ipcidr для этого не подходит."
        )
        if category_ru_provider:
            notice += f" Также доступен {category_ru_provider} для российских доменов."
    elif category_ru_provider:
        notice = (
            f"Найден доменный rule-provider «{category_ru_provider}», но provider private не найден. "
            "Для локальных зон добавьте geosite_private@domain или используйте только category-ru."
        )
    elif geodata_enabled:
        source = geosite_url
        notice = (
            f"GeoSite настроен ({source}). Для Fake-IP можно использовать geosite:private, "
            "если выбранная база содержит тег private; это не проверяется до запуска Mihomo."
        )
    elif mode is True and not geosite_url:
        notice = (
            "geodata-mode включён, но источник GeoSite не указан. "
            "Добавьте geox-url.geosite, например URL V2Fly из подсказки ниже, "
            "и перезапустите Mihomo."
        )
    elif geosite_url and mode is not True:
        notice = (
            "Источник GeoSite указан, но geodata-mode не включён явно. Добавьте "
            "geodata-mode: true и перезапустите Mihomo, иначе geosite:private "
            "может быть недоступен."
        )
    elif geosite_configured and mode is False:
        notice = (
            "В config.yaml указана GeoSite-база, но geodata-mode отключён. "
            "Включите geodata-mode: true или используйте доменный rule-provider."
        )
    else:
        notice = (
            "GeoSite или доменный provider private не настроен — фильтр geosite:private "
            "работать не будет. Для V2Fly добавьте в config.yaml geodata-mode: true и "
            "geox-url.geosite: https://github.com/v2fly/domain-list-community/releases/latest/download/dlc.dat."
        )

    return {
        "mode": mode,
        "enabled": geodata_enabled,
        "geosite_url": geosite_url or None,
        "geosite_configured": geosite_configured,
        "private_provider": private_provider or None,
        "category_ru_provider": category_ru_provider or None,
        "private_filter": private_filter or None,
        "private_source": private_source or None,
        "private_available": bool(private_filter),
        "domain_providers": domain_providers,
        # Alias kept in the status payload for callers that group all
        # GeoSite-free sources under ``rule_providers``.
        "rule_providers": domain_providers,
        "notice": notice,
    }


def _domain_rule_provider_names(config_text: str) -> list[str]:
    """Return configured domain/classical rule-provider names.

    A ``rule-set:...`` fake-IP filter can only refer to a provider that is
    actually declared in this config.  In particular, ``private@ip`` is not
    a domain provider and must not be used for DNS name filtering.
    """

    section = _top_level_section(config_text, "rule-providers")
    if not section:
        return []
    body = section[2]
    entries: list[tuple[str, list[str]]] = []
    current_name = ""
    current: list[str] = []
    for line in body.splitlines()[1:]:
        match = re.match(r"^  ([^\s:#][^:]*):(?:\s*(.*))?$", line)
        if match:
            if current_name:
                entries.append((current_name.strip(), current))
            current_name = match.group(1).strip()
            current = [str(match.group(2) or "")]
        elif current_name:
            current.append(line)
    if current_name:
        entries.append((current_name, current))
    names: list[str] = []
    for name, lines in entries:
        joined = "\n".join(lines).lower()
        # The stock templates use ``name@domain: { <<: *domain, ... }``.  In
        # that compact form the behavior lives in the YAML anchor, outside
        # this entry, so the key suffix is the reliable signal.  For ordinary
        # expanded entries retain the behavior check as well.
        if re.search(r"(?:^|[\s,{])behavior\s*:\s*ipcidr\b", joined):
            continue
        if name.lower().endswith("@domain") or re.search(r"(?:^|[\s,{])behavior\s*:\s*(?:domain|classical)\b", joined):
            names.append(name)
    return names


def _rule_provider_entry_names(config_text: str) -> list[str]:
    """Return every top-level provider key, including compact YAML entries."""

    section = _top_level_section(config_text, "rule-providers")
    if not section:
        return []
    names: list[str] = []
    # Provider keys are indented exactly one level below rule-providers.  This
    # deliberately does not parse nested fields, so arbitrary user YAML is
    # preserved byte-for-byte by the assistant.
    for line in section[2].splitlines()[1:]:
        match = re.match(r"^  ([^\s:#][^:]*):", line)
        if match:
            name = match.group(1).strip()
            if name and name not in names:
                names.append(name)
    return names


def _normalize_domain_rule_providers(value: Any) -> list[str]:
    """Normalize the UI's provider selection to known, safe provider IDs."""

    if value is True or value is None:
        raw: list[Any] = list(DEFAULT_DOMAIN_RULE_PROVIDERS)
    elif value is False:
        raw = []
    elif isinstance(value, str):
        raw = [item.strip() for item in value.split(",")]
    elif isinstance(value, (list, tuple, set)):
        raw = list(value)
    elif isinstance(value, dict):
        raw = [key for key, enabled in value.items() if enabled]
    else:
        raw = []

    aliases = {
        "category-ru": "category_ru@domain",
        "category_ru": "category_ru@domain",
        "private": "geosite_private@domain",
        "geosite-private": "geosite_private@domain",
        "geosite_private": "geosite_private@domain",
        "category_ai": "category-ai@domain",
        "category-ai": "category-ai@domain",
    }
    known = {name.lower(): name for name in DEFAULT_DOMAIN_RULE_PROVIDERS}
    selected: list[str] = []
    for item in raw:
        key = str(item or "").strip()
        canonical = known.get(key.lower()) or aliases.get(key.lower())
        if canonical and canonical not in selected:
            selected.append(canonical)
    # Keep output stable for snapshots and generated YAML.  The category list
    # precedes private, matching the recommended fake-ip-filter order.
    return [name for name in DEFAULT_DOMAIN_RULE_PROVIDERS if name in selected]


def _domain_rule_provider_status(config_text: str) -> dict[str, dict[str, Any]]:
    domain_names = {name.lower(): name for name in _domain_rule_provider_names(config_text)}
    aliases = {
        "category_ru@domain": ("category-ru@domain",),
        "geosite_private@domain": ("geosite-private@domain",),
        "category-ai@domain": ("category_ai@domain",),
    }
    return {
        name: {
            "configured": name.lower() in domain_names or any(alias.lower() in domain_names for alias in aliases.get(name, ())),
            "filter": f"rule-set:{domain_names.get(name.lower()) or next((alias for alias in aliases.get(name, ()) if alias.lower() in domain_names), name)}",
            "url": url,
        }
        for name, url in DEFAULT_DOMAIN_RULE_PROVIDERS.items()
    }


def _render_domain_rule_provider(name: str, url: str, *, use_anchor: bool) -> str:
    if use_anchor:
        return f"  {name}: {{ <<: *domain, url: {url} }}"
    return (
        f"  {name}:\n"
        "    type: http\n"
        "    behavior: domain\n"
        "    format: mrs\n"
        "    interval: 86400\n"
        f"    url: {url}"
    )


def _with_domain_rule_provider_defaults(text: str, providers: Any = None) -> str:
    """Add selected GeoSite-free MRS providers without replacing user entries."""

    selected = _normalize_domain_rule_providers(providers)
    if not selected:
        return str(text or "")
    source = str(text or "")
    existing = {name.lower() for name in _rule_provider_entry_names(source)}
    aliases = {
        "category_ru@domain": ("category-ru@domain",),
        "geosite_private@domain": ("geosite-private@domain",),
        "category-ai@domain": ("category_ai@domain",),
    }
    missing = [
        name for name in selected
        if name.lower() not in existing and not any(alias.lower() in existing for alias in aliases.get(name, ()))
    ]
    if not missing:
        return source
    use_anchor = bool(re.search(r"(?m)&domain\b", source))
    rendered = "\n".join(_render_domain_rule_provider(name, DEFAULT_DOMAIN_RULE_PROVIDERS[name], use_anchor=use_anchor) for name in missing)
    section = _top_level_section(source, "rule-providers")
    if section:
        start, _end, body = section
        body_without_trailing = body.rstrip("\r\n")
        insertion = "\n" + rendered + "\n"
        return source[:start] + body_without_trailing + insertion + source[start + len(body):]

    # Put a newly created provider map alongside the other top-level runtime
    # sections.  This keeps the generated config readable and leaves scalar
    # settings at the top untouched.
    insertion_at = len(source)
    for match in _TOP_LEVEL_KEY_RE.finditer(source):
        if match.group("key") in _DNS_INSERT_BEFORE_SECTIONS:
            insertion_at = match.start()
            break
    before = source[:insertion_at].rstrip("\r\n")
    after = source[insertion_at:].lstrip("\r\n")
    block = "rule-providers:\n" + rendered
    return f"{before}\n\n{block}\n\n{after}" if after else f"{before}\n\n{block}\n"


def _fake_ip_default_filters(config_text: str = "") -> list[str]:
    """Build safe defaults, adding private-domain source only when available."""

    geodata = _geodata_runtime_config(config_text)
    providers = _domain_rule_provider_status(config_text)
    provider_filters = [
        details["filter"]
        for details in providers.values()
        if details["configured"]
    ]
    if provider_filters:
        # The MRS profile keeps local/private names real and also preserves
        # the user's TorrServer hostname outside the downloaded lists.
        if not providers["geosite_private@domain"]["configured"]:
            provider_filters.extend(DEFAULT_FAKE_IP_FILTERS)
        return provider_filters + list(DEFAULT_FAKE_IP_EXTRA_FILTERS)
    if geodata["private_filter"]:
        filters = [str(geodata["private_filter"])]
        if geodata["private_source"] == "geodata":
            filters.append("geosite:category-ru")
        return filters + list(DEFAULT_FAKE_IP_EXTRA_FILTERS)
    return list(DEFAULT_FAKE_IP_FILTERS)


def _normalize_fake_ip_options(fake_ip: Any = None, *, config_text: str = "") -> dict[str, Any]:
    """Validate the user-controlled Fake-IP options before rendering YAML."""

    raw = fake_ip if isinstance(fake_ip, dict) else {}
    value = str(raw.get("range") or DEFAULT_FAKE_IP_RANGE).strip()
    try:
        network = ipaddress.ip_network(value, strict=False)
    except ValueError as exc:
        raise MihomoDnsError("Некорректный диапазон Fake-IP.", code="fake_ip_range_invalid") from exc
    if network.version != 4 or network.prefixlen > 24 or network.prefixlen < 8:
        raise MihomoDnsError("Диапазон Fake-IP должен быть IPv4-сетью от /8 до /24.", code="fake_ip_range_invalid")
    # Never allow the synthetic range to overlap common LAN/VPN/reserved
    # networks.  Deployments can add their own networks through an env var.
    reserved = ["10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]
    reserved.extend(str(item).strip() for item in str(os.environ.get("XKEEN_FAKE_IP_RESERVED_NETWORKS") or "").split(",") if str(item).strip())
    for item in reserved:
        try:
            if network.overlaps(ipaddress.ip_network(item, strict=False)):
                raise MihomoDnsError("Диапазон Fake-IP пересекается с локальной сетью.", code="fake_ip_range_overlap", details=item)
        except ValueError:
            continue
    filter_mode = str(raw.get("filter_mode") or DEFAULT_FAKE_IP_FILTER_MODE).strip().lower()
    if filter_mode not in FAKE_IP_FILTER_MODES:
        raise MihomoDnsError("Неизвестный режим фильтра Fake-IP.", code="fake_ip_filter_mode_invalid")
    filters = raw.get("filters") if "filters" in raw else _fake_ip_default_filters(config_text)
    if isinstance(filters, str):
        filters = [line.strip() for line in filters.splitlines() if line.strip()]
    if not isinstance(filters, (list, tuple)):
        raise MihomoDnsError("Список фильтров Fake-IP имеет неверный формат.", code="fake_ip_filters_invalid")
    clean_filters = []
    for item in filters:
        text = str(item or "").strip()
        if text and len(text) <= 255 and "\n" not in text and "\r" not in text:
            clean_filters.append(text)
    if not clean_filters:
        raise MihomoDnsError("Для Fake-IP укажите хотя бы один фильтр.", code="fake_ip_filters_invalid")
    if filter_mode == "rule":
        invalid = [item for item in clean_filters if not re.search(r",(?:fake-ip|real-ip)\s*$", item, re.IGNORECASE)]
        if invalid:
            raise MihomoDnsError(
                "В режиме rule фильтры должны быть правилами с действием fake-ip или real-ip.",
                code="fake_ip_rules_invalid",
                details=invalid[:8],
            )
    return {"range": value, "filter_mode": filter_mode, "filters": clean_filters, "network": network}


def _normalize_mode(mode: Any = None) -> str:
    value = str(mode or "redir-host").strip().lower()
    if value not in DNS_MODES:
        raise MihomoDnsError("Неизвестный режим DNS Mihomo.", code="dns_mode_invalid")
    return value


def _transparent_ports(text: str) -> tuple[int, int]:
    """Return the configured TProxy and Redirect listeners, if any."""

    source = str(text or "")
    tproxy = re.search(r"(?im)^tproxy-port\s*:\s*([1-9]\d*)\s*$", source)
    redirect = re.search(r"(?im)^redir-port\s*:\s*([1-9]\d*)\s*$", source)
    return (int(tproxy.group(1)) if tproxy else 0, int(redirect.group(1)) if redirect else 0)


def _fake_ip_route_configured(text: str) -> bool:
    """Whether YAML contains a possible transparent entry point."""

    tun = _top_level_section(text, "tun")
    if tun and re.search(r"(?im)^\s+enable\s*:\s*(?:true|yes|on|1)\b", tun[2]):
        return True
    return bool(_transparent_ports(text)[0])


def _iptables_table_rules(table: str) -> tuple[str, str]:
    """Read one live IPv4 firewall table without changing it."""

    last_error = ""
    for binary in IPTABLES_BINARIES:
        try:
            proc = subprocess.run(
                # Keenetic currently ships iptables 1.4.21.  It supports
                # ``-w`` but not the optional seconds argument added later,
                # so ``-w 2`` is parsed as a stray rule argument.  The Python
                # timeout still bounds an indefinitely held xtables lock.
                [binary, "-w", "-t", table, "-S"],
                capture_output=True,
                text=True,
                timeout=4,
            )
        except FileNotFoundError:
            last_error = "iptables не найден"
            continue
        except Exception as exc:  # noqa: BLE001 - status reports the failure
            last_error = str(exc)
            continue
        if proc.returncode == 0:
            return proc.stdout or "", ""
        detail = (proc.stderr or proc.stdout or "").strip()
        last_error = detail[-300:] if detail else f"iptables вернул код {proc.returncode}"
    return "", last_error or "не удалось прочитать iptables"


def _iptables_rules(text: str) -> dict[str, list[list[str]]]:
    """Parse ``iptables -S`` into ordered rules grouped by chain."""

    result: dict[str, list[list[str]]] = {}
    for raw in str(text or "").splitlines():
        try:
            tokens = shlex.split(raw, comments=False, posix=True)
        except ValueError:
            continue
        if len(tokens) < 3 or tokens[0] not in {"-A", "--append"}:
            continue
        result.setdefault(tokens[1], []).append(tokens[2:])
    return result


def _rule_value(tokens: list[str], *names: str) -> str:
    for index, token in enumerate(tokens[:-1]):
        if token in names:
            return tokens[index + 1]
    return ""


def _rule_protocol_matches(tokens: list[str], protocol: str) -> bool:
    value = _rule_value(tokens, "-p", "--protocol").lower()
    if not value or value == "all":
        return True
    index = next((i for i, token in enumerate(tokens) if token in {"-p", "--protocol"}), -1)
    inverted = index > 0 and tokens[index - 1] == "!"
    return (value != protocol) if inverted else (value == protocol)


def _rule_covers_network(tokens: list[str], network: ipaddress.IPv4Network) -> bool:
    """Whether a destination selector matches every address in ``network``."""

    index = next((i for i, token in enumerate(tokens[:-1]) if token in {"-d", "--destination"}), -1)
    if index < 0:
        return True
    try:
        destination = ipaddress.ip_network(tokens[index + 1], strict=False)
    except ValueError:
        return False
    if destination.version != 4:
        return False
    inverted = index > 0 and tokens[index - 1] == "!"
    return not network.overlaps(destination) if inverted else network.subnet_of(destination)


def _network_return(tokens: list[str], network: ipaddress.IPv4Network, protocol: str) -> str:
    """Return the CIDR of an unconditional range exclusion, or nothing."""

    target = _rule_value(tokens, "-j", "--jump").upper()
    destination = _rule_value(tokens, "-d", "--destination")
    if target != "RETURN" or not destination:
        return ""
    # A policy/port/state-specific RETURN is not proof that the whole Fake-IP
    # range is excluded. XKeen's inherited RFC 2544 rule has only a
    # destination, comment and RETURN target, which is the case of interest.
    conditional = {
        "--dport", "--dports", "--sport", "--sports", "--mark", "--ctstate",
        "--dscp", "--match-set", "--mac-source", "-i", "--in-interface",
    }
    if any(token in conditional for token in tokens):
        return ""
    if not _rule_protocol_matches(tokens, protocol):
        return ""
    try:
        excluded = ipaddress.ip_network(destination, strict=False)
    except ValueError:
        return ""
    index = next((i for i, token in enumerate(tokens[:-1]) if token in {"-d", "--destination"}), -1)
    inverted = index > 0 and tokens[index - 1] == "!"
    if inverted or excluded.version != 4 or not network.overlaps(excluded):
        return ""
    return str(excluded)


def _firewall_path(
    rules_text: str,
    *,
    network: ipaddress.IPv4Network,
    protocol: str,
    target: str,
    port: int,
) -> dict[str, Any]:
    """Inspect XKeen's PREROUTING -> xkeen -> transparent-target path."""

    rules = _iptables_rules(rules_text)
    jump_present = any(
        _rule_value(rule, "-j", "--jump") == XKEEN_FIREWALL_CHAIN
        and _rule_protocol_matches(rule, protocol)
        and _rule_covers_network(rule, network)
        for rule in rules.get("PREROUTING", [])
    )
    expected_port_option = ("--on-port",) if target == "TPROXY" else ("--to-port", "--to-ports")
    for rule in rules.get(XKEEN_FIREWALL_CHAIN, []):
        exclusion = _network_return(rule, network, protocol)
        if exclusion:
            return {
                "captured": False,
                "blocked": True,
                "exclusion": exclusion,
                "chain": XKEEN_FIREWALL_CHAIN,
            }
        if (
            _rule_value(rule, "-j", "--jump").upper() == target
            and _rule_protocol_matches(rule, protocol)
            and _rule_covers_network(rule, network)
            and _rule_value(rule, *expected_port_option) == str(port)
        ):
            return {
                "captured": bool(jump_present),
                "blocked": False,
                "chain": XKEEN_FIREWALL_CHAIN,
                "jump_present": bool(jump_present),
            }
    return {
        "captured": False,
        "blocked": False,
        "chain": XKEEN_FIREWALL_CHAIN,
        "jump_present": bool(jump_present),
    }


def _fake_ip_route_available(text: str, fake_ip_range: str = DEFAULT_FAKE_IP_RANGE) -> bool:
    """Whether a live transparent route handles the selected synthetic CIDR."""

    return bool(_fake_ip_route_info(text, fake_ip_range)["available"])


def _fake_ip_route_info(text: str, fake_ip_range: str = DEFAULT_FAKE_IP_RANGE) -> dict[str, Any]:
    """Describe and verify the transparent route used by Fake-IP.

    A ``tproxy-port`` only proves that Mihomo can listen there. For TProxy we
    additionally require the active XKeen firewall path and reject the legacy
    ``RETURN ... 198.18.0.0/15`` rule old installations can retain on upgrade.
    """

    requested_range = str(fake_ip_range or DEFAULT_FAKE_IP_RANGE).strip()
    try:
        network = ipaddress.ip_network(requested_range, strict=False)
    except ValueError:
        network = ipaddress.ip_network(DEFAULT_FAKE_IP_RANGE, strict=False)
        requested_range = DEFAULT_FAKE_IP_RANGE
    route_base = {"range": requested_range, "network": str(network)}

    tun = _top_level_section(text, "tun")
    if tun and re.search(r"(?im)^\s+enable\s*:\s*(?:true|yes|on|1)\b", tun[2]):
        return {
            **route_base,
            "kind": "tun",
            "available": True,
            "confidence": "confirmed",
            "message": f"TUN включён для маршрутизации Fake-IP {network}.",
        }

    tproxy_port, redirect_port = _transparent_ports(text)
    if not tproxy_port:
        return {
            **route_base,
            "kind": "none",
            "available": False,
            "confidence": "missing",
            "message": "Нужен включённый TUN или подтверждённый TProxy-маршрут для Fake-IP.",
        }

    mangle_text, mangle_error = _iptables_table_rules("mangle")
    nat_text, nat_error = _iptables_table_rules("nat") if redirect_port else ("", "")
    if mangle_error or nat_error:
        detail = mangle_error or nat_error
        return {
            **route_base,
            "kind": "tproxy",
            "mode": "hybrid" if redirect_port else "tproxy",
            "port": tproxy_port,
            "redirect_port": redirect_port or None,
            "available": False,
            "confidence": "unknown",
            "firewall_error": detail,
            "message": f"TProxy-порт {tproxy_port} указан, но firewall XKeen не удалось проверить: {detail}.",
        }

    required = [
        (
            "mangle",
            "udp",
            _firewall_path(
                mangle_text,
                network=network,
                protocol="udp",
                target="TPROXY",
                port=tproxy_port,
            ),
        )
    ]
    if redirect_port:
        required.append(
            (
                "nat",
                "tcp",
                _firewall_path(
                    nat_text,
                    network=network,
                    protocol="tcp",
                    target="REDIRECT",
                    port=redirect_port,
                ),
            )
        )
    else:
        required.append(
            (
                "mangle",
                "tcp",
                _firewall_path(
                    mangle_text,
                    network=network,
                    protocol="tcp",
                    target="TPROXY",
                    port=tproxy_port,
                ),
            )
        )

    blocked = next(((table, protocol, path) for table, protocol, path in required if path.get("blocked")), None)
    if blocked:
        table, protocol, path = blocked
        exclusion = str(path.get("exclusion") or "")
        return {
            **route_base,
            "kind": "tproxy",
            "mode": "hybrid" if redirect_port else "tproxy",
            "port": tproxy_port,
            "redirect_port": redirect_port or None,
            "available": False,
            "confidence": "blocked",
            "firewall": {
                "table": table,
                "chain": path.get("chain") or XKEEN_FIREWALL_CHAIN,
                "protocol": protocol,
                "exclusion": exclusion,
            },
            "message": (
                f"Firewall XKeen исключает Fake-IP {network}: правило RETURN для {exclusion} "
                f"в цепочке {XKEEN_FIREWALL_CHAIN}. Уберите старое исключение из настроек XKeen "
                "или выполните чистую установку актуальной версии, затем перезапустите XKeen."
            ),
        }

    missing = [f"{protocol.upper()} ({table})" for table, protocol, path in required if not path.get("captured")]
    if missing:
        return {
            **route_base,
            "kind": "tproxy",
            "mode": "hybrid" if redirect_port else "tproxy",
            "port": tproxy_port,
            "redirect_port": redirect_port or None,
            "available": False,
            "confidence": "unverified",
            "missing_paths": missing,
            "message": (
                f"TProxy-порт {tproxy_port} указан, но firewall XKeen не подтвердил перехват "
                f"Fake-IP {network}: не найден путь {', '.join(missing)}."
            ),
        }

    route_label = (
        f"TCP → REDIRECT {redirect_port}, UDP → TProxy {tproxy_port}"
        if redirect_port
        else f"TCP/UDP → TProxy {tproxy_port}"
    )
    return {
        **route_base,
        "kind": "tproxy",
        "mode": "hybrid" if redirect_port else "tproxy",
        "port": tproxy_port,
        "redirect_port": redirect_port or None,
        "available": True,
        "confidence": "confirmed",
        "message": f"Firewall XKeen перехватывает Fake-IP {network}: {route_label}.",
    }


def _wait_for_fake_ip_route(
    text: str,
    fake_ip_range: str,
    timeout: float = 6.0,
) -> dict[str, Any]:
    """Allow XKeen's netfilter hook to restore chains after a restart."""

    deadline = time.monotonic() + max(0.2, float(timeout or 0))
    result = _fake_ip_route_info(text, fake_ip_range)
    while not result.get("available") and result.get("confidence") != "blocked" and time.monotonic() < deadline:
        time.sleep(0.2)
        result = _fake_ip_route_info(text, fake_ip_range)
    return result


def _xkeen_init_script_path(path: str = "") -> str:
    return os.path.abspath(str(path or resolve_xkeen_init_script() or XKEEN_INIT_SCRIPT))


def _legacy_xkeen_repair_plan(path: str = "") -> dict[str, Any]:
    """Prepare an exact, side-effect-free repair for an old XKeen script.

    This intentionally understands only the known static ``ipv4_exclude``
    assignment.  Shell expressions, duplicate assignments and non-CIDR values
    are refused instead of trying to rewrite an unfamiliar init script.
    """

    script_path = _xkeen_init_script_path(path)
    try:
        metadata = os.lstat(script_path)
    except OSError as exc:
        raise MihomoDnsError(
            f"Стартовый скрипт XKeen не найден: {script_path}.",
            code="fake_ip_repair_script_missing",
            details=str(exc),
        ) from exc
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise MihomoDnsError(
            "Автоисправление доступно только для обычного файла стартового скрипта XKeen.",
            code="fake_ip_repair_script_unsupported",
        )
    try:
        original = Path(script_path).read_bytes()
        source = original.decode("utf-8")
    except (OSError, UnicodeError) as exc:
        raise MihomoDnsError(
            "Не удалось безопасно прочитать стартовый скрипт XKeen как UTF-8.",
            code="fake_ip_repair_script_unreadable",
            details=str(exc),
        ) from exc
    if len(original) > 2 * 1024 * 1024:
        raise MihomoDnsError(
            "Стартовый скрипт XKeen имеет неожиданный размер; автоисправление остановлено.",
            code="fake_ip_repair_script_unsupported",
        )
    if not re.search(r"(?m)^name_app=(?:\"XKeen\"|'XKeen')\s*$", source) or not re.search(
        r"(?m)^name_chain=(?:\"xkeen\"|'xkeen')\s*$", source
    ):
        raise MihomoDnsError(
            "Формат стартового скрипта XKeen не распознан; файл не изменён.",
            code="fake_ip_repair_script_unsupported",
        )

    assignment = re.compile(
        r"(?m)^(?P<prefix>ipv4_exclude[ \t]*=[ \t]*)(?P<quote>[\"'])(?P<value>[^\"'\r\n]*)(?P=quote)(?P<suffix>[ \t]*(?:#[^\r\n]*)?)(?P<eol>\r?)$"
    )
    matches = list(assignment.finditer(source))
    if len(matches) != 1:
        raise MihomoDnsError(
            "Переменная ipv4_exclude в стартовом скрипте имеет неизвестный формат; файл не изменён.",
            code="fake_ip_repair_script_unsupported",
        )
    match = matches[0]
    value = match.group("value")
    tokens = value.split()
    if tokens.count(LEGACY_FAKE_IP_EXCLUSION) != 1:
        raise MihomoDnsError(
            f"Стартовый скрипт не содержит единственного исключения {LEGACY_FAKE_IP_EXCLUSION}; файл не изменён.",
            code="fake_ip_repair_exclusion_not_found",
        )
    try:
        parsed = [ipaddress.ip_network(token, strict=False) for token in tokens]
    except ValueError as exc:
        raise MihomoDnsError(
            "ipv4_exclude содержит не только статические CIDR; автоисправление остановлено.",
            code="fake_ip_repair_script_unsupported",
            details=str(exc),
        ) from exc
    if any(network.version != 4 for network in parsed):
        raise MihomoDnsError(
            "ipv4_exclude имеет неожиданный состав; автоисправление остановлено.",
            code="fake_ip_repair_script_unsupported",
        )

    next_tokens = [token for token in tokens if token != LEGACY_FAKE_IP_EXCLUSION]
    patched_value = " ".join(next_tokens)
    patched_source = (
        source[: match.start()]
        + match.group("prefix")
        + match.group("quote")
        + patched_value
        + match.group("quote")
        + match.group("suffix")
        + match.group("eol")
        + source[match.end() :]
    )
    patched = patched_source.encode("utf-8")
    if patched == original or LEGACY_FAKE_IP_EXCLUSION in patched_value.split():
        raise MihomoDnsError(
            "Не удалось подготовить однозначное исправление ipv4_exclude; файл не изменён.",
            code="fake_ip_repair_script_unsupported",
        )
    return {
        "path": script_path,
        "original": original,
        "patched": patched,
        "mode": stat.S_IMODE(metadata.st_mode),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
    }


def _fake_ip_repair_status(route: dict[str, Any], path: str = "") -> dict[str, Any]:
    firewall = route.get("firewall") if isinstance(route.get("firewall"), dict) else {}
    needed = bool(
        route.get("confidence") == "blocked"
        and firewall.get("exclusion") == LEGACY_FAKE_IP_EXCLUSION
    )
    base = {
        "needed": needed,
        "can_repair": False,
        "requires_confirmation": needed,
        "script": _xkeen_init_script_path(path),
        "exclusion": LEGACY_FAKE_IP_EXCLUSION,
    }
    if not needed:
        return base
    try:
        _legacy_xkeen_repair_plan(path)
    except MihomoDnsError as exc:
        return {
            **base,
            "code": exc.code,
            "message": str(exc),
        }
    return {
        **base,
        "can_repair": True,
        "message": (
            f"Панель может сохранить резервную копию {_xkeen_init_script_path(path)}, удалить только "
            f"{LEGACY_FAKE_IP_EXCLUSION}, перезапустить XKeen и повторно проверить маршрут."
        ),
    }


def _atomic_replace_bytes(path: str, content: bytes, *, mode: int, uid: int, gid: int) -> None:
    """Replace a regular file without ever exposing partially written data."""

    tmp = f"{path}.xkeen-ui-{uuid.uuid4().hex}.tmp"
    try:
        with open(tmp, "xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        try:
            os.chown(tmp, uid, gid)
        except (AttributeError, PermissionError):
            # Desktop tests and non-root development runs cannot chown.  The
            # production panel runs as root and preserves the original owner.
            pass
        os.replace(tmp, path)
    finally:
        try:
            os.remove(tmp)
        except FileNotFoundError:
            pass


def _snapshot_xkeen_init_script(ui_state_dir: str, config_file: str, plan: dict[str, Any]) -> str:
    txid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    directory = os.path.join(_state_dir(ui_state_dir, config_file), "xkeen-init-repairs", txid)
    os.makedirs(directory, mode=0o700, exist_ok=False)
    backup = os.path.join(directory, os.path.basename(str(plan["path"])) + ".before")
    _atomic_replace_bytes(
        backup,
        bytes(plan["original"]),
        mode=0o600,
        uid=int(plan["uid"]),
        gid=int(plan["gid"]),
    )
    return backup


def _apply_legacy_xkeen_repair(
    plan: dict[str, Any],
    *,
    ui_state_dir: str,
    config_file: str,
) -> dict[str, Any]:
    backup = _snapshot_xkeen_init_script(ui_state_dir, config_file, plan)
    path = str(plan["path"])
    try:
        _atomic_replace_bytes(
            path,
            bytes(plan["patched"]),
            mode=int(plan["mode"]),
            uid=int(plan["uid"]),
            gid=int(plan["gid"]),
        )
        if Path(path).read_bytes() != bytes(plan["patched"]):
            raise OSError("проверка записанного файла не совпала")
    except Exception as exc:
        restore_error = ""
        try:
            _atomic_replace_bytes(
                path,
                bytes(plan["original"]),
                mode=int(plan["mode"]),
                uid=int(plan["uid"]),
                gid=int(plan["gid"]),
            )
        except Exception as rollback_exc:  # noqa: BLE001 - preserve both causes
            restore_error = str(rollback_exc)
        raise MihomoDnsError(
            "Не удалось безопасно исправить стартовый скрипт XKeen.",
            code="fake_ip_repair_write_failed",
            details={"cause": str(exc), "backup": backup, "restore": restore_error},
        ) from exc
    return {
        "applied": True,
        "script": path,
        "backup": backup,
        "exclusion": LEGACY_FAKE_IP_EXCLUSION,
    }


def _restore_legacy_xkeen_repair(plan: dict[str, Any]) -> None:
    _atomic_replace_bytes(
        str(plan["path"]),
        bytes(plan["original"]),
        mode=int(plan["mode"]),
        uid=int(plan["uid"]),
        gid=int(plan["gid"]),
    )


def _with_geodata_defaults(text: str) -> str:
    """Add optional V2Fly GeoSite settings without touching existing values."""
    source = str(text or "")
    additions: list[str] = []
    if _top_level_section(source, "geodata-mode") is None and not re.search(r"(?im)^geodata-mode\s*:", source):
        additions.append("geodata-mode: true")
    geox = _top_level_section(source, "geox-url")
    if geox is None:
        additions.extend(["geox-url:", f"  geosite: {_yaml_single_quote(DEFAULT_GEOSITE_URL)}"])
    elif not _section_scalar(geox, "geosite"):
        # Preserve existing geox-url keys while adding the missing geosite
        # sibling at the end of that top-level mapping.
        start, end, body = geox
        insertion = body.rstrip("\r\n") + f"\n  geosite: {_yaml_single_quote(DEFAULT_GEOSITE_URL)}\n"
        source = source[:start] + insertion + source[end:]
        geox = _top_level_section(source, "geox-url")
    if not additions:
        return source
    prefix = "\n".join(additions) + "\n\n"
    return prefix + source.lstrip("\r\n")


def _managed_dns_block(group: str, *, mode: str = "redir-host", fake_ip: Any = None) -> str:
    target = str(group or "").strip()
    if not target:
        raise MihomoDnsError("Не найдена proxy-группа для защищённого DNS.", code="proxy_group_missing")
    normalized_mode = _normalize_mode(mode)
    fake = _normalize_fake_ip_options(fake_ip) if normalized_mode == "fake-ip" else None
    fake_block = ""
    policy_block = ""
    if fake:
        filter_comments = {
            "rule-set:category_ru@domain": "Российские сайты",
            "rule-set:geosite_private@domain": "Локальные устройства и приватные доменные зоны",
            "rule-set:category-ai@domain": "Список доменов AI-сервисов",
            "+.tsarea.tv": "TorrServer",
        }
        fake_block = (
            f"  fake-ip-range: {fake['range']}\n"
            f"  fake-ip-filter-mode: {fake['filter_mode']}\n"
            "  fake-ip-filter:\n"
            + "".join(
                f"    - {_yaml_single_quote(item)}"
                f"  # {filter_comments[item]}\n" if item in filter_comments
                else f"    - {_yaml_single_quote(item)}\n"
                for item in fake["filters"]
            )
        )
        policy_lines = []
        fake_filters = {str(item).strip() for item in fake["filters"]}
        for policy_name, servers in DEFAULT_FAKE_IP_DNS_POLICY.items():
            if policy_name not in fake_filters:
                continue
            policy_lines.append(f"    {_yaml_single_quote(policy_name)}:\n")
            policy_lines.extend(
                f"      - {_yaml_single_quote(server) if str(server).startswith(('http://', 'https://', 'quic://', 'tls://')) else server}\n"
                for server in servers
            )
        if policy_lines:
            policy_block = "  nameserver-policy:\n" + "".join(policy_lines)
    bootstrap = DEFAULT_FAKE_IP_BOOTSTRAP if fake else DEFAULT_REDIR_BOOTSTRAP
    plain_nameservers = DEFAULT_FAKE_IP_NAMESERVERS if fake else ()
    routed_nameservers = DEFAULT_FAKE_IP_ROUTED_NAMESERVERS if fake else DEFAULT_REDIR_ROUTED_NAMESERVERS
    return (
        f"{MANAGED_BEGIN}\n"
        "dns:\n"
        "  enable: true\n"
        f"  listen: {DNS_LISTEN}\n"
        "  ipv6: false\n"
        f"  enhanced-mode: {normalized_mode}\n"
        "  cache-algorithm: arc\n"
        "  prefer-h3: false\n"
        f"{fake_block}"
        "  use-hosts: true\n"
        "  use-system-hosts: true\n"
        "  default-nameserver:\n"
        + "".join(f"    - {server}\n" for server in bootstrap)
        + "  proxy-server-nameserver:\n"
        + "".join(f"    - {server}\n" for server in bootstrap)
        + "  nameserver:\n"
        + "".join(f"    - {_yaml_single_quote(server)}\n" for server in plain_nameservers)
        + "".join(
            f"    - {_yaml_single_quote(url + '#' + target + '&name-cert-verify=' + verify)}\n"
            for url, verify in routed_nameservers
        )
        + policy_block
        + f"{MANAGED_END}\n"
    )


def _remove_store_fake_ip(text: str) -> str:
    """Drop only ``profile.store-fake-ip`` while preserving the surrounding YAML."""

    section = _top_level_section(text, "profile")
    if not section:
        return text
    start, end, body = section
    first_line, separator, remainder = body.partition("\n")
    tail = first_line.split(":", 1)[1].strip()
    if tail.startswith("{") and "}" in tail:
        inner, suffix = tail[1:].split("}", 1)
        items = [item.strip() for item in inner.split(",") if item.strip()]
        kept = [item for item in items if item.split(":", 1)[0].strip() != "store-fake-ip"]
        replacement = "profile: { " + ", ".join(kept) + " }" + suffix
        if separator:
            replacement += "\n" + remainder
        return text[:start] + replacement + text[end:]

    lines = body.splitlines(keepends=True)
    kept_lines = [
        line for line in lines
        if not re.match(r"^[ \t]+store-fake-ip[ \t]*:", line)
    ]
    return text[:start] + "".join(kept_lines) + text[end:]


_DNS_INSERT_BEFORE_SECTIONS = (
    # These are the large, data-oriented sections that normally follow the
    # scalar/runtime settings in a Mihomo config.  If ``profile`` is absent,
    # placing DNS immediately before the first one keeps it in the same upper
    # part of the document as the user-facing examples instead of appending it
    # after providers and rules.
    "sniffer",
    "tun",
    "hosts",
    "proxies",
    "proxy-providers",
    "proxy-groups",
    "listeners",
    "rule-providers",
    "rules",
)


def _insert_managed_dns_block(text: str, block: str) -> str:
    """Insert the managed DNS section near the config's top-level settings.

    Mihomo accepts top-level keys in any order, but keeping ``dns`` beside
    ``profile``/``sniffer`` makes generated configs readable and matches the
    conventional examples.  The previous implementation always appended the
    block, which put it below proxy providers, groups and rules (often hundreds
    of lines down).  Existing text is otherwise left untouched.
    """

    source = str(text or "")
    managed = str(block or "").strip("\r\n")

    # ``profile`` is the conventional anchor and is present in XKeen's stock
    # templates.  ``_top_level_section`` gives us the start of the next
    # top-level key, so inserting at its end preserves the whole profile block.
    anchor = _top_level_section(source, "profile")
    if anchor is None:
        # Custom configs are allowed to omit profile.  Use the first structural
        # section as a fallback; this still keeps DNS near the top while
        # retaining the user's scalar settings above it.
        sections = list(_TOP_LEVEL_KEY_RE.finditer(source))
        for match in sections:
            if match.group("key") in _DNS_INSERT_BEFORE_SECTIONS:
                insertion_at = match.start()
                break
        else:
            # A config containing only scalar settings has no better semantic
            # anchor; append in that uncommon case.
            insertion_at = len(source)
    else:
        insertion_at = anchor[1]

    before = source[:insertion_at].rstrip("\r\n")
    after = source[insertion_at:].lstrip("\r\n")
    if after:
        return f"{before}\n\n{managed}\n\n{after}"
    return f"{before}\n\n{managed}\n"


def build_enabled_config(
    text: str,
    group: Optional[str] = None,
    *,
    mode: str = "redir-host",
    fake_ip: Any = None,
    geodata: bool = False,
    rule_providers: Any = None,
    dns_selector: bool = False,
) -> tuple[str, str]:
    original = str(text or "")
    if not original.strip():
        raise MihomoDnsError("Активный config.yaml пуст.", code="config_empty")
    if MANAGED_BEGIN in original or MANAGED_END in original:
        raise MihomoDnsError("Обнаружен неполный служебный DNS-блок.", code="managed_block_partial")
    if _top_level_section(original, "dns") is not None:
        raise MihomoDnsError(
            "В config.yaml уже есть раздел dns. Панель не будет его перезаписывать.",
            code="dns_conflict",
        )
    normalized_mode = _normalize_mode(mode)
    if normalized_mode == "fake-ip" and not _fake_ip_route_configured(original):
        raise MihomoDnsError("Fake-IP требует включённый TUN или TProxy-маршрут.", code="fake_ip_route_missing")
    source = _with_geodata_defaults(original) if (geodata and normalized_mode == "fake-ip") else original
    # GeoSite DAT and domain MRS providers are alternative sources.  Never add
    # both for one activation: the selected source determines the generated
    # fake-ip filters and avoids duplicate downloads at runtime.
    if normalized_mode == "fake-ip" and not geodata:
        source = _with_domain_rule_provider_defaults(source, rule_providers)
    fake_options = _normalize_fake_ip_options(fake_ip, config_text=source) if normalized_mode == "fake-ip" else None
    selected = str(group or _select_proxy_group(original) or "").strip()
    if not selected:
        raise MihomoDnsError(
            "Не найдена proxy-группа Mihomo. Сначала добавьте узел и группу.",
            code="proxy_group_missing",
        )
    if group and selected not in _proxy_groups(original):
        raise MihomoDnsError("Выбранная proxy-группа отсутствует в config.yaml.", code="proxy_group_invalid")
    dns_target = selected
    if dns_selector:
        source = _with_dns_selector(source, selected)
        dns_target = DNS_SELECTOR_NAME
    # Keep the managed block near the top-level runtime settings (normally
    # immediately after ``profile``), rather than at EOF after all providers,
    # groups and rules.
    patched = _insert_managed_dns_block(
        _remove_store_fake_ip(source),
        _managed_dns_block(dns_target, mode=normalized_mode, fake_ip=fake_options),
    )
    return patched, selected


def _ndmc_path() -> str:
    return _resolve_ndmc()


def _ndmc(command: str, *, timeout: int = 15) -> str:
    if not _ndmc_path():
        raise MihomoDnsError("Не найден ndmc; настройка Keenetic недоступна.", code="ndmc_missing")
    try:
        run = run_ndmc(command, timeout=timeout)
    except Exception as exc:
        raise MihomoDnsError("Не удалось выполнить команду Keenetic.", code="ndmc_failed", details=str(exc)) from exc
    output = run.output
    lowered = output.lower()
    if run.rc != 0 or "% error" in lowered or "command::base error" in lowered:
        raise MihomoDnsError("Keenetic отклонил настройку DNS.", code="ndmc_failed", details=output)
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output)


def _dns_override_status() -> tuple[Optional[bool], str]:
    try:
        output = _ndmc("show running-config", timeout=10)
    except MihomoDnsError as exc:
        return None, str(exc.details or exc)
    lines = [line.strip().lower() for line in output.splitlines()]
    if any(line == "no opkg dns-override" or line.startswith("no opkg dns-override ") for line in lines):
        return False, "running-config"
    if any(line == "opkg dns-override" or line.startswith("opkg dns-override ") for line in lines):
        return True, "running-config"
    return False, "running-config (команда отсутствует)"


def _set_dns_override(enabled: bool) -> None:
    _ndmc("opkg dns-override" if enabled else "no opkg dns-override")
    _ndmc("system configuration save")


def _port_53_in_use() -> bool:
    for sock_type in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
        with socket.socket(socket.AF_INET, sock_type) as sock:
            try:
                sock.bind(("0.0.0.0", 53))
            except OSError:
                return True
    return False


def _wait_for_port_53(*, should_be_free: bool, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + max(0.2, float(timeout or 0))
    while time.monotonic() < deadline:
        if _port_53_in_use() == (not should_be_free):
            return True
        time.sleep(0.2)
    return _port_53_in_use() == (not should_be_free)


def _wait_for_mihomo(timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + max(0.2, float(timeout or 0))
    while time.monotonic() < deadline:
        if detect_running_core() == "mihomo":
            return True
        time.sleep(0.3)
    return detect_running_core() == "mihomo"


def _wait_for_core(core: str, timeout: float = 15.0) -> bool:
    expected = str(core or "").strip().lower()
    if expected == "mihomo":
        return _wait_for_mihomo(timeout)
    deadline = time.monotonic() + max(0.2, float(timeout or 0))
    while time.monotonic() < deadline:
        if detect_running_core() == expected:
            return True
        time.sleep(0.3)
    return detect_running_core() == expected


def _configured_xkeen_core() -> str:
    """Read the core selected by XKeen without requiring it to be running."""

    candidates = (
        str(os.environ.get("XKEEN_CONFIG_FILE") or "").strip(),
        "/opt/etc/xkeen/config.json",
        "/opt/etc/xkeen/config.yaml",
        "/opt/etc/xkeen/config.yml",
        "/opt/etc/xkeen/xkeen.json",
    )
    for path in candidates:
        if not path or not os.path.isfile(path):
            continue
        raw = _read_text(path, "") or ""
        match = re.search(r'(?im)["\']?(?:core|engine)["\']?\s*[:=]\s*["\']?(xray|mihomo)\b', raw)
        if match:
            return match.group(1).lower()
    return ""


def _mihomo_selected_for_restart() -> bool:
    """Fail closed when another core is active or explicitly selected."""

    running = detect_running_core() or ""
    if running:
        return running == "mihomo"
    configured = _configured_xkeen_core()
    return not configured or configured == "mihomo"


def _local_probe_hosts() -> list[str]:
    hosts: list[str] = []
    configured = str(os.environ.get("XKEEN_MIHOMO_DNS_PROBE_HOST") or "").strip()
    if configured:
        hosts.append(configured)
    try:
        output = _ndmc("show interface Home", timeout=10)
        match = re.search(r"^[ \t]*address:[ \t]*(\d+(?:\.\d+){3})[ \t]*$", output, re.MULTILINE)
        if match:
            hosts.append(match.group(1))
    except Exception:
        pass
    hosts.extend(("127.0.0.1", "192.168.1.1"))
    return list(dict.fromkeys(host for host in hosts if host))


def _dns_probe(domain: str = PROBE_DOMAIN, timeout: float = 12.0) -> dict[str, Any]:
    started = time.monotonic()
    deadline = started + max(1.0, float(timeout or 0))
    labels = [label.encode("ascii") for label in domain.strip(".").split(".") if label]
    qname = b"".join(bytes([len(label)]) + label for label in labels) + b"\0"
    attempts = 0
    last_error = "timeout"
    while attempts < 4 and time.monotonic() < deadline:
        attempts += 1
        txid = random.randint(0, 65535)
        packet = struct.pack("!HHHHHH", txid, 0x0100, 1, 0, 0, 0) + qname + struct.pack("!HH", 1, 1)
        for host in _local_probe_hosts():
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.settimeout(min(1.4, max(0.2, deadline - time.monotonic())))
                    sock.sendto(packet, (host, 53))
                    data, _peer = sock.recvfrom(4096)
                if len(data) < 12:
                    last_error = "короткий DNS-ответ"
                    continue
                rid, flags, _qd, answers, _ns, _ar = struct.unpack("!HHHHHH", data[:12])
                rcode = flags & 0x000F
                if rid == txid and rcode == 0 and answers > 0:
                    return {
                        "ok": True,
                        "answers": answers,
                        "rcode": rcode,
                        "attempts": attempts,
                        "latency_ms": round((time.monotonic() - started) * 1000),
                    }
                last_error = f"некорректный DNS-ответ (rcode={rcode}, answers={answers})"
            except Exception as exc:
                last_error = str(exc)
        if attempts < 4:
            time.sleep(min(0.45, max(0.0, deadline - time.monotonic())))
    return {
        "ok": False,
        "error": last_error,
        "attempts": attempts,
        "latency_ms": round((time.monotonic() - started) * 1000),
    }


def _validation_ok(log: str) -> bool:
    match = re.search(r"\[exit code:\s*(-?\d+)\]", str(log or ""))
    return bool(match and int(match.group(1)) == 0)


def _snapshot_original(ui_state_dir: str, config_file: str, text: str) -> str:
    txid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    directory = os.path.join(_state_dir(ui_state_dir, config_file), "transactions", txid)
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, "config.before.yaml")
    _atomic_write_text(path, text)
    return path


def get_status(*, config_file: str, ui_state_dir: str = "") -> dict[str, Any]:
    text = _read_text(config_file, "") or ""
    state = _load_state(ui_state_dir, config_file)
    override, override_detail = _dns_override_status()
    core = detect_running_core() or ""
    has_begin = MANAGED_BEGIN in text
    has_end = MANAGED_END in text
    dns_runtime = _dns_runtime_config(text)
    geodata = _geodata_runtime_config(text)
    has_dns = bool(dns_runtime["present"])
    managed = bool(has_begin and has_end and has_dns)
    applied_hash = str(state.get("applied_sha256") or "")
    exact = bool(managed and applied_hash and _sha256(text) == applied_hash)
    # ``exact`` answers whether an automatic rollback is safe.  It must not be
    # used to decide whether DNS is actually configured: a manual save or YAML
    # formatter can remove the managed comments while preserving a working DNS
    # block.  Keep those two concepts separate.
    # Runtime ownership is a property of the live DNS listener and Keenetic's
    # switch, not of our transaction marker.  This also lets the panel and the
    # shared guard help with a fully user-authored Mihomo DNS section.
    enabled = bool(
        core == "mihomo"
        and dns_runtime["listener_configured"]
        and override is True
    )
    tampered = bool(state and not exact)
    partial = bool((has_begin or has_end) and not exact)
    group = str(state.get("proxy_group") or "") if exact else str(_select_proxy_group(text) or "")
    mode = str(state.get("mode") or dns_runtime.get("mode") or "redir-host").strip().lower()
    state_fake_ip = state.get("fake_ip") if isinstance(state.get("fake_ip"), dict) else {}
    state_dns_selector = state.get("dns_selector") if isinstance(state.get("dns_selector"), dict) else {}
    dns_selector_requested = bool(state_dns_selector.get("enabled"))
    dns_selector_present = DNS_SELECTOR_NAME in _proxy_groups(text)
    dns_selector_enabled = bool(dns_selector_requested and dns_selector_present)
    dns_selector_conflict = bool(dns_selector_present and not dns_selector_requested)
    fake_ip_range = str(
        state_fake_ip.get("range")
        or dns_runtime.get("fake_ip_range")
        or DEFAULT_FAKE_IP_RANGE
    )
    fake_ip_route = _fake_ip_route_info(text, fake_ip_range)
    fake_ip_repair = _fake_ip_repair_status(fake_ip_route)
    # A user may remove the complete managed block manually.  If Keenetic's
    # DNS override is already off, never restore the old snapshot over those
    # unrelated edits; offer a metadata-only recovery instead.
    can_recover = bool(
        state
        and tampered
        and not has_dns
        and not has_begin
        and not has_end
        and override is False
    )
    # Once the current file differs from our applied hash, restoring the old
    # full snapshot could erase legitimate user work.  Offer a soft release
    # instead: retain the DNS mapping, park it with ``enable: false`` and hand
    # port 53 back to KeeneticOS.  The same escape hatch is useful for a DNS
    # mapping that was authored without the assistant and has no state file.
    can_release = bool(
        override is True
        and not exact
        and (
            bool(state)
            or (core in {"", "mihomo"} and bool(dns_runtime["listener_configured"]))
        )
    )
    blockers: list[str] = []
    if not enabled and not state:
        if core != "mihomo":
            blockers.append("Однокнопочная настройка доступна только при активном ядре Mihomo.")
        if has_dns:
            blockers.append("В config.yaml уже есть раздел dns; пользовательские настройки не перезаписываются.")
        if not group:
            blockers.append("Не найдена proxy-группа для защищённых DNS-запросов.")
        if override is None:
            blockers.append("Не удалось прочитать DNS override Keenetic: " + override_detail)
    if tampered and can_release:
        blockers.append(
            "Конфигурация изменена после включения DNS; полный снимок не будет восстановлен. "
            "Можно сохранить текущий блок и вернуть DNS прошивке Keenetic."
        )
    elif tampered and not can_recover:
        blockers.append("Конфигурация изменена после включения DNS; автоматическое восстановление остановлено.")
    elif can_recover:
        blockers.append("DNS-блок уже удалён вручную, а DNS override Keenetic выключен; текущий config.yaml можно сохранить без возврата старого снимка.")
    if enabled and not state:
        blockers.append(
            "Обнаружен пользовательский DNS Mihomo на порту 53. Полного снимка нет; "
            "панель может сохранить блок и вернуть DNS прошивке Keenetic."
        )
    if partial and not state:
        blockers.append("Обнаружен неполный служебный DNS-блок.")
    can_disable = bool(exact and state)
    can_enable = bool(not state and not has_dns and not has_begin and not has_end and core == "mihomo" and group and override is not None)
    return {
        "ok": True,
        "enabled": enabled,
        "prepared": exact,
        "partial": partial,
        "tampered": tampered,
        "can_recover": can_recover,
        "can_release": can_release,
        "can_enable": can_enable,
        "can_disable": can_disable,
        "active_core": core,
        "proxy_group": group or None,
        "proxy_groups": _proxy_groups(text),
        "dns_override": override,
        "dns_present": has_dns,
        "dns_enabled": bool(dns_runtime["enabled"]),
        "dns_listener_configured": bool(dns_runtime["listener_configured"]),
        "listen": str(dns_runtime["listen"] or DNS_LISTEN),
        "mode": mode if mode in DNS_MODES else "redir-host",
        "fake_ip": state_fake_ip or None,
        "rule_providers": state.get("rule_providers") if isinstance(state.get("rule_providers"), list) else [],
        # Keep the boolean for API compatibility. Unlike the old value it is
        # true for TProxy only after the selected CIDR reaches the live target.
        "fake_ip_available": bool(fake_ip_route["available"]),
        "fake_ip_route": fake_ip_route,
        "fake_ip_repair": fake_ip_repair,
        "dns_selector": {
            "enabled": dns_selector_enabled,
            "name": DNS_SELECTOR_NAME,
            "icon": DNS_SELECTOR_ICON,
            "upstream": str(state_dns_selector.get("upstream") or group or ""),
            "can_create": not dns_selector_present,
            "conflict": dns_selector_conflict,
            "missing": bool(dns_selector_requested and not dns_selector_present),
        },
        "geodata": geodata,
        "blockers": blockers,
        # The port-53 guard is shared with DNS-over-VLESS, so this window says
        # the same things about it that the Xray one does.
        "watchdog": read_release(config_file=config_file, ui_state_dir=ui_state_dir),
        "safety": {
            "preflight": True,
            "backup": True,
            "rollback": True,
            "dns_probe": True,
            "routed_doh": True,
        },
    }


def _release_current_dns(
    *,
    config_file: str,
    ui_state_dir: str,
    validate_config: Callable[..., str],
    save_config: Callable[[str], Any],
    restart_xkeen: Callable[..., Any],
) -> dict[str, Any]:
    """Park the current DNS mapping and return port 53 to KeeneticOS.

    This is deliberately different from restoring the assistant's snapshot.
    It is used only when the file is user-owned or was edited after activation,
    so every setting except the top-level ``dns.enable`` value is retained.
    """

    current = _read_text(config_file, "") or ""
    runtime = _dns_runtime_config(current)
    parked, changed = _with_dns_disabled(current)
    if runtime.get("listener_configured") and not changed:
        raise MihomoDnsError(
            "Пользовательский DNS-блок нельзя безопасно отключить автоматически; "
            "задайте dns.enable: false и повторите возврат DNS Keenetic.",
            code="dns_soft_release_unsupported",
        )
    if changed:
        validation = validate_config(new_content=parked) or ""
        if not _validation_ok(validation):
            raise MihomoDnsError(
                "Mihomo не подтвердил конфигурацию с отключённым DNS; текущий файл не изменён.",
                code="dns_soft_release_preflight_failed",
                details=validation[-4000:],
            )

    backup = None
    saved = False
    override_changed = False
    restart_ok = True
    try:
        if changed:
            backup = save_config(parked)
            saved = True
            # Mihomo must reread ``enable: false`` and let go of the socket;
            # toggling dns-override alone cannot disable its listener.
            try:
                restart_ok = bool(restart_xkeen(source="mihomo-dns-soft-release"))
            except Exception:
                restart_ok = False
            if not restart_ok:
                raise MihomoDnsError(
                    "Mihomo не перезапустился с отключённым DNS; возврат прошивке отменён.",
                    code="dns_soft_release_restart_failed",
                )
        _set_dns_override(False)
        override_changed = True
        if not _wait_for_port_53(should_be_free=False):
            raise MihomoDnsError(
                "Системный DNS Keenetic не занял порт 53.",
                code="firmware_dns_failed",
            )
    except Exception as exc:
        # An explicit button remains transactional.  If the firmware cannot
        # take over, put the active user config and override back as they were.
        rollback_errors: list[str] = []
        if saved:
            try:
                save_config(current)
            except Exception as rollback_exc:  # noqa: BLE001
                rollback_errors.append(str(rollback_exc))
        if override_changed:
            try:
                _set_dns_override(True)
            except Exception as rollback_exc:  # noqa: BLE001
                rollback_errors.append(str(rollback_exc))
        if saved:
            try:
                restart_xkeen(source="mihomo-dns-soft-release-rollback")
            except Exception as rollback_exc:  # noqa: BLE001
                rollback_errors.append(str(rollback_exc))
        if isinstance(exc, MihomoDnsError):
            if rollback_errors:
                exc.details = {"cause": exc.details, "rollback": rollback_errors}
            raise
        raise MihomoDnsError(
            "Не удалось вернуть DNS прошивке; текущая конфигурация восстановлена.",
            code="dns_soft_release_failed",
            details={"cause": str(exc), "rollback": rollback_errors},
        ) from exc

    _clear_state(ui_state_dir, config_file)
    released = {
        "released_at": int(time.time()),
        "source": "user",
        "reason": "DNS возвращён прошивке Keenetic без восстановления старого снимка.",
        "steps": [
            "dns_disabled_in_place" if changed else "dns_listener_absent",
            "core_restarted" if restart_ok else "core_restart_failed",
            "dns_override_disabled",
        ],
    }
    _record_release(ui_state_dir, config_file, released)
    return {
        "ok": True,
        "enabled": False,
        "released": True,
        "preserved_current": True,
        "dns_block_preserved": bool(runtime.get("present")),
        "dns_disabled": changed,
        "dns_override": False,
        "core_restarted": restart_ok,
        "backup": str(getattr(backup, "filename", "") or "") or None,
    }


def apply_action(
    action: str,
    *,
    config_file: str,
    ui_state_dir: str,
    validate_config: Callable[..., str],
    save_config: Callable[[str], Any],
    restart_xkeen: Callable[..., Any],
    mode: str = "redir-host",
    fake_ip: Any = None,
    geodata: bool = False,
    rule_providers: Any = None,
    proxy_group: Optional[str] = None,
    dns_selector: bool = False,
    repair_legacy_exclusion: bool = False,
) -> dict[str, Any]:
    normalized = str(action or "").strip().lower()
    if normalized not in {"enable", "disable", "release"}:
        raise MihomoDnsError("Неизвестное действие DNS Mihomo.", code="invalid_action")

    with _LOCK:
        status = get_status(config_file=config_file, ui_state_dir=ui_state_dir)
        current = _read_text(config_file, "") or ""
        state = _load_state(ui_state_dir, config_file)
        original_override, _detail = _dns_override_status()

        if normalized == "enable":
            if not status.get("can_enable"):
                raise MihomoDnsError(
                    "Защищённый DNS нельзя включить в текущей конфигурации.",
                    code="enable_blocked",
                    details=status.get("blockers"),
                )
            normalized_mode = _normalize_mode(mode)
            fake_options = (
                _normalize_fake_ip_options(fake_ip, config_text=current)
                if normalized_mode == "fake-ip"
                else None
            )
            repair_plan = None
            repair_result = None
            if fake_options is not None:
                route = _fake_ip_route_info(current, fake_options["range"])
                if not route.get("available"):
                    repair = _fake_ip_repair_status(route)
                    if repair.get("needed") and repair_legacy_exclusion is True:
                        if not repair.get("can_repair"):
                            raise MihomoDnsError(
                                str(repair.get("message") or "Стартовый скрипт XKeen нельзя исправить автоматически."),
                                code=str(repair.get("code") or "fake_ip_repair_unavailable"),
                                details=repair,
                            )
                        repair_plan = _legacy_xkeen_repair_plan(str(repair.get("script") or ""))
                    else:
                        code = (
                            "fake_ip_repair_confirmation_required"
                            if repair.get("needed") and repair.get("can_repair")
                            else (
                                "fake_ip_firewall_excluded"
                                if route.get("confidence") == "blocked"
                                else "fake_ip_route_unverified"
                            )
                        )
                        message = (
                            "Подтвердите исправление устаревшего исключения XKeen и включение Fake-IP."
                            if code == "fake_ip_repair_confirmation_required"
                            else str(route.get("message") or "Маршрут Fake-IP не подтверждён.")
                        )
                        raise MihomoDnsError(
                            message,
                            code=code,
                            details={"route": route, "repair": repair} if code == "fake_ip_repair_confirmation_required" else route,
                        )
            prepared, group = build_enabled_config(
                current,
                str(proxy_group or status.get("proxy_group") or ""),
                mode=mode,
                fake_ip=fake_ip,
                geodata=geodata,
                rule_providers=rule_providers,
                dns_selector=dns_selector is True,
            )
            validation = validate_config(new_content=prepared) or ""
            if not _validation_ok(validation):
                raise MihomoDnsError(
                    "Mihomo не подтвердил подготовленную конфигурацию; ничего не изменено.",
                    code="mihomo_preflight_failed",
                    details=validation[-4000:],
                )
            snapshot = _snapshot_original(ui_state_dir, config_file, current)
            saved = False
            override_changed = False
            repair_applied = False
            try:
                if repair_plan is not None:
                    repair_result = _apply_legacy_xkeen_repair(
                        repair_plan,
                        ui_state_dir=ui_state_dir,
                        config_file=config_file,
                    )
                    repair_applied = True
                    if not bool(restart_xkeen(source="mihomo-dns-fake-ip-repair")):
                        raise MihomoDnsError(
                            "XKeen не перезапустился после исправления исключения Fake-IP.",
                            code="fake_ip_repair_restart_failed",
                            details=repair_result,
                        )
                    repaired_route = _wait_for_fake_ip_route(current, fake_options["range"])
                    if not repaired_route.get("available"):
                        raise MihomoDnsError(
                            str(repaired_route.get("message") or "После исправления маршрут Fake-IP не появился."),
                            code="fake_ip_repair_route_failed",
                            details={"repair": repair_result, "route": repaired_route},
                        )
                backup = save_config(prepared)
                saved = True
                if not _mihomo_selected_for_restart():
                    raise MihomoDnsError(
                        "XKeen сейчас настроен на другое ядро; DNS Mihomo не применён.",
                        code="active_core_changed",
                    )
                _set_dns_override(True)
                override_changed = original_override is not True
                if not _wait_for_port_53(should_be_free=True):
                    raise MihomoDnsError(
                        "Keenetic не освободил порт 53 для Mihomo.",
                        code="dns_port_busy",
                    )
                if not bool(restart_xkeen(source="mihomo-dns")):
                    raise MihomoDnsError("Mihomo не запустился с новой конфигурацией.", code="mihomo_restart_failed")
                if not _wait_for_mihomo() or not _wait_for_port_53(should_be_free=False):
                    raise MihomoDnsError("DNS-слушатель Mihomo не запустился на порту 53.", code="dns_listener_failed")
                applied_route = None
                if fake_options is not None:
                    applied_route = _wait_for_fake_ip_route(prepared, fake_options["range"])
                    if not applied_route.get("available"):
                        raise MihomoDnsError(
                            str(applied_route.get("message") or "После перезапуска маршрут Fake-IP не подтверждён."),
                            code=(
                                "fake_ip_firewall_excluded"
                                if applied_route.get("confidence") == "blocked"
                                else "fake_ip_route_unverified"
                            ),
                            details=applied_route,
                        )
                probe = _dns_probe()
                if not probe.get("ok"):
                    raise MihomoDnsError(
                        "Mihomo запущен, но защищённый DNS не ответил.",
                        code="dns_probe_failed",
                        details=probe,
                    )
                next_state = {
                    "enabled": True,
                    "created_at": int(time.time()),
                    "config_file": os.path.abspath(config_file),
                    "original_config": snapshot,
                    "original_sha256": _sha256(current),
                    "applied_sha256": _sha256(prepared),
                    "original_dns_override": original_override,
                    "proxy_group": group,
                    "listen": DNS_LISTEN,
                    "mode": normalized_mode,
                    "fake_ip": ({k: v for k, v in fake_options.items() if k != "network"} if fake_options else None),
                    "dns_selector": {
                        "enabled": True,
                        "name": DNS_SELECTOR_NAME,
                        "upstream": group,
                    } if dns_selector is True else None,
                    "rule_providers": _normalize_domain_rule_providers(rule_providers) if normalized_mode == "fake-ip" and not geodata else [],
                    "xkeen_repair": repair_result,
                }
                _save_state(ui_state_dir, config_file, next_state)
                _clear_release(ui_state_dir, config_file)
                return {
                    "ok": True,
                    "enabled": True,
                    "proxy_group": group,
                    "listen": DNS_LISTEN,
                    "mode": normalized_mode,
                    "fake_ip": ({k: v for k, v in fake_options.items() if k != "network"} if fake_options else None),
                    "fake_ip_route": applied_route,
                    "dns_selector": {
                        "enabled": True,
                        "name": DNS_SELECTOR_NAME,
                        "upstream": group,
                    } if dns_selector is True else None,
                    "rule_providers": _normalize_domain_rule_providers(rule_providers) if normalized_mode == "fake-ip" and not geodata else [],
                    "xkeen_repair": repair_result,
                    "backup": str(getattr(backup, "filename", "") or "") or None,
                    "probe": probe,
                }
            except Exception as exc:
                rollback_errors: list[str] = []
                if saved:
                    try:
                        save_config(current)
                    except Exception as rollback_exc:
                        rollback_errors.append(str(rollback_exc))
                if original_override is not None and (override_changed or original_override is not True):
                    try:
                        _set_dns_override(bool(original_override))
                    except Exception as rollback_exc:
                        rollback_errors.append(str(rollback_exc))
                if repair_applied and repair_plan is not None:
                    try:
                        _restore_legacy_xkeen_repair(repair_plan)
                    except Exception as rollback_exc:
                        rollback_errors.append(str(rollback_exc))
                if saved or repair_applied:
                    try:
                        restart_xkeen(source="mihomo-dns-rollback")
                    except Exception as rollback_exc:
                        rollback_errors.append(str(rollback_exc))
                _clear_state(ui_state_dir, config_file)
                if isinstance(exc, MihomoDnsError):
                    exc.rolled_back = bool(saved or override_changed or repair_applied)
                    if rollback_errors:
                        exc.details = {"cause": exc.details, "rollback": rollback_errors}
                    raise
                raise MihomoDnsError(
                    "Не удалось включить DNS Mihomo; предыдущая конфигурация восстановлена.",
                    code="apply_failed",
                    details={"cause": str(exc), "rollback": rollback_errors},
                    rolled_back=bool(saved or override_changed or repair_applied),
                ) from exc

        if normalized == "release":
            if not status.get("can_release"):
                raise MihomoDnsError(
                    "Возврат DNS прошивке недоступен в текущей конфигурации.",
                    code="dns_soft_release_blocked",
                    details=status.get("blockers"),
                )
            return _release_current_dns(
                config_file=config_file,
                ui_state_dir=ui_state_dir,
                validate_config=validate_config,
                save_config=save_config,
                restart_xkeen=restart_xkeen,
            )

        if status.get("can_recover"):
            # The managed DNS block is already gone.  Do not restore the
            # pre-enable snapshot because that would discard the user's
            # unrelated edits.  A preflight still protects against clearing
            # the transaction marker while the current YAML is broken.
            validation = validate_config(new_content=current) or ""
            if not _validation_ok(validation):
                raise MihomoDnsError(
                    "Mihomo не подтвердил текущую конфигурацию; состояние DNS не очищено.",
                    code="recover_preflight_failed",
                    details=validation[-4000:],
                )
            current_override, override_detail = _dns_override_status()
            if current_override is not False:
                raise MihomoDnsError(
                    "Состояние DNS override Keenetic изменилось; сначала верните системный DNS роутера.",
                    code="recover_override_changed",
                    details=override_detail,
                )
            previous_core = detect_running_core() or ""
            backup = save_config(current)
            if not bool(restart_xkeen(source="mihomo-dns-recover")):
                raise MihomoDnsError(
                    "Mihomo не запустился с текущей конфигурацией; состояние DNS не очищено.",
                    code="recover_restart_failed",
                )
            expected_core = previous_core if previous_core in {"xray", "mihomo"} else ""
            if expected_core and not _wait_for_core(expected_core):
                raise MihomoDnsError(
                    "Сервис не запустился с текущей конфигурацией; состояние DNS не очищено.",
                    code="recover_restart_failed",
                )
            if not _wait_for_port_53(should_be_free=False):
                raise MihomoDnsError(
                    "Системный DNS Keenetic не вернул порт 53 после перезапуска Mihomo.",
                    code="recover_firmware_dns_failed",
                )
            _clear_state(ui_state_dir, config_file)
            _clear_release(ui_state_dir, config_file)
            return {
                "ok": True,
                "enabled": False,
                "recovered": True,
                "preserved_current": True,
                "dns_override": False,
                "backup": str(getattr(backup, "filename", "") or "") or None,
            }

        if not status.get("can_disable") or not state:
            raise MihomoDnsError(
                "Автоматическое восстановление недоступно: конфигурация изменена или снимок отсутствует.",
                code="disable_blocked",
                details=status.get("blockers"),
            )
        original_path = str(state.get("original_config") or "")
        original = _read_text(original_path, None)
        if original is None or _sha256(original) != str(state.get("original_sha256") or ""):
            raise MihomoDnsError("Снимок исходной конфигурации повреждён.", code="snapshot_invalid")
        validation = validate_config(new_content=original) or ""
        if not _validation_ok(validation):
            raise MihomoDnsError(
                "Mihomo не подтвердил исходную конфигурацию; восстановление остановлено.",
                code="restore_preflight_failed",
                details=validation[-4000:],
            )

        previous_core = detect_running_core() or ""
        try:
            backup = save_config(original)
            if not bool(restart_xkeen(source="mihomo-dns")):
                raise MihomoDnsError("Сервис не запустился после восстановления.", code="restore_restart_failed")
            expected_core = previous_core if previous_core in {"xray", "mihomo"} else ""
            if expected_core and not _wait_for_core(expected_core):
                raise MihomoDnsError("Сервис не запустился после восстановления.", code="restore_restart_failed")
            restore_override = bool(state.get("original_dns_override"))
            _set_dns_override(restore_override)
            # A restored config without a port-53 listener must never leave the
            # LAN without DNS merely because an earlier, unrelated assistant
            # had already enabled dns-override.
            override_adjusted = False
            if restore_override and not _wait_for_port_53(should_be_free=False, timeout=2.0):
                _set_dns_override(False)
                restore_override = False
                override_adjusted = True
            if not restore_override and not _wait_for_port_53(should_be_free=False):
                raise MihomoDnsError("Системный DNS Keenetic не вернул порт 53.", code="firmware_dns_failed")
            _clear_state(ui_state_dir, config_file)
            _clear_release(ui_state_dir, config_file)
            return {
                "ok": True,
                "enabled": False,
                "restored": True,
                "dns_override": restore_override,
                "override_adjusted": override_adjusted,
                "backup": str(getattr(backup, "filename", "") or "") or None,
            }
        except Exception as exc:
            # Put the known-good managed config back if disable could not
            # complete; this mirrors the enable transaction in reverse.
            try:
                save_config(current)
                _set_dns_override(True)
                restart_xkeen(source="mihomo-dns-rollback")
            except Exception:
                pass
            if isinstance(exc, MihomoDnsError):
                raise
            raise MihomoDnsError(
                "Не удалось отключить DNS Mihomo; включённая конфигурация восстановлена.",
                code="restore_failed",
                details=str(exc),
            ) from exc


def is_enabled(*, config_file: str, ui_state_dir: str) -> bool:
    """Does Mihomo currently own router DNS, including user-authored setups?"""

    try:
        state = _load_state(ui_state_dir, config_file)
    except Exception:
        state = {}
    override, _detail = _dns_override_status()
    # A confirmed disabled switch means Keenetic already owns DNS; stale panel
    # state must not keep the guard active forever.  If ndmc is temporarily
    # unreadable, retain the transaction marker as the conservative fallback.
    if override is False:
        return False
    if state.get("enabled"):
        return True
    if override is not True:
        return False
    # Without our transaction marker, a running Xray proves that this inactive
    # profile does not own port 53.  An empty result can instead mean Mihomo has
    # just crashed -- exactly when the guard must keep watching and give DNS
    # back -- so it remains eligible together with a running Mihomo.
    if detect_running_core() not in {"", "mihomo"}:
        return False
    text = _read_text(config_file, "") or ""
    return bool(_dns_runtime_config(text).get("listener_configured"))


def emergency_release(
    *,
    config_file: str,
    ui_state_dir: str,
    save_config: Callable[[str], Any],
    restart_xkeen: Callable[..., Any],
    reason: str,
) -> dict[str, Any]:
    """Give port 53 back to KeeneticOS after the guarded core stopped serving.

    The counterpart of :func:`apply_action` for the unattended path.  Unlike a
    user-driven disable this never rolls back and never fails closed: its only
    job is to make the LAN resolve names again.  A corrupted snapshot therefore
    skips the config restore but still hands the port back, because leaving
    ``dns-override`` on would keep every client without DNS.
    """

    steps: list[str] = []
    state = _load_state(ui_state_dir, config_file)

    current = _read_text(config_file, "") or ""
    applied_sha = str(state.get("applied_sha256") or "")
    current_is_exact = bool(applied_sha and _sha256(current) == applied_sha)
    snapshot_path = str(state.get("original_config") or "")
    original = _read_text(snapshot_path, None) if snapshot_path else None
    expected_sha = str(state.get("original_sha256") or "")
    if original is None:
        steps.append("snapshot_missing")
    elif expected_sha and _sha256(original) != expected_sha:
        # A damaged snapshot must not overwrite a working config.
        steps.append("snapshot_corrupt")
        original = None

    # A whole-file snapshot is safe only while the current file is still the
    # exact output we applied.  Once a user edits or replaces its DNS mapping,
    # keep those changes and park only the listener instead of overwriting the
    # profile with an older snapshot.
    restore_snapshot = bool(current_is_exact and original is not None)
    config_releases_port = False
    if restore_snapshot:
        try:
            save_config(original)
            steps.append("config_restored")
            config_releases_port = True
        except Exception as exc:  # noqa: BLE001
            steps.append(f"config_failed:{exc}")
    else:
        if original is not None and not current_is_exact:
            steps.append("snapshot_skipped_current_modified")
        parked, changed = _with_dns_disabled(current)
        if changed:
            try:
                save_config(parked)
                steps.extend(("current_config_preserved", "dns_disabled_in_place"))
                config_releases_port = True
            except Exception as exc:  # noqa: BLE001
                steps.append(f"config_failed:{exc}")
        elif not _dns_runtime_config(current).get("listener_configured"):
            steps.extend(("current_config_preserved", "dns_listener_absent"))
            config_releases_port = True
        else:
            steps.append("dns_disable_unsupported")

    # Make Mihomo reread the restored/parked config before asking the firmware
    # resolver to bind port 53.  Otherwise a recovered Mihomo can race ndnproxy
    # while both still believe they own the same socket.
    try:
        restart_xkeen(source="mihomo-dns-guard-release")
        steps.append("core_restart_requested")
    except Exception as exc:  # noqa: BLE001
        steps.append(f"core_restart_failed:{exc}")

    # A modified/user-owned config has no trustworthy previous ownership state:
    # the purpose of this fallback is explicitly to restore Keenetic DNS.  For
    # an exact transaction retain the original switch value as before.
    desired = bool(state.get("original_dns_override", False)) if restore_snapshot else False
    try:
        _set_dns_override(desired)
        steps.append("dns_override_restored" if desired else "dns_override_disabled")
    except Exception as exc:  # noqa: BLE001
        steps.append(f"dns_override_failed:{exc}")

    if not _wait_for_port_53(should_be_free=False):
        steps.append("port_53_still_free")

    released = {
        "released_at": int(time.time()),
        "source": "guard",
        "reason": reason,
        "steps": steps,
        "preserved_current": not restore_snapshot,
        "dns_config_parked": bool(config_releases_port and not restore_snapshot),
    }
    try:
        _clear_state(ui_state_dir, config_file)
    except Exception:
        pass
    # Clearing the state is what makes the assistant look untouched again, so
    # the trace has to be written afterwards and separately: without it the
    # panel would show a plain "ready" and never tell the operator that the
    # protection stood down on its own.
    _record_release(ui_state_dir, config_file, released)
    return released


__all__ = [
    "DNS_LISTEN",
    "MANAGED_BEGIN",
    "MANAGED_END",
    "MihomoDnsError",
    "apply_action",
    "build_enabled_config",
    "emergency_release",
    "get_status",
    "is_enabled",
    "read_release",
]
