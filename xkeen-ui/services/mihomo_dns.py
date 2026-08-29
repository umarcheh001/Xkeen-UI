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
import json
import os
import random
import re
import shutil
import socket
import struct
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from services.cores import detect_running_core
from services.io.atomic import _atomic_write_json, _atomic_write_text
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
_LOCK = threading.RLock()


class MihomoDnsError(RuntimeError):
    def __init__(self, message: str, *, code: str = "mihomo_dns_failed", details: Any = None):
        super().__init__(message)
        self.code = code
        self.details = details


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
        return {"present": False, "enabled": False, "listen": "", "listener_configured": False}

    body = section[2]

    def nested_scalar(key: str) -> str:
        match = re.search(rf"^[ \t]+{re.escape(key)}[ \t]*:[ \t]*([^#\r\n]+)", body, re.MULTILINE)
        return _strip_yaml_scalar(match.group(1)) if match else ""

    enabled_value = nested_scalar("enable").lower()
    dns_enabled = enabled_value in {"true", "yes", "on", "1"}
    listen = nested_scalar("listen")
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
    }


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


def _managed_dns_block(group: str) -> str:
    target = str(group or "").strip()
    if not target:
        raise MihomoDnsError("Не найдена proxy-группа для защищённого DNS.", code="proxy_group_missing")
    google = f"https://8.8.8.8/dns-query#{target}&name-cert-verify=dns.google"
    cloudflare = f"https://1.1.1.1/dns-query#{target}&name-cert-verify=cloudflare-dns.com"
    return (
        f"{MANAGED_BEGIN}\n"
        "dns:\n"
        "  enable: true\n"
        f"  listen: {DNS_LISTEN}\n"
        "  ipv6: false\n"
        "  enhanced-mode: redir-host\n"
        "  cache-algorithm: arc\n"
        "  prefer-h3: false\n"
        "  use-hosts: true\n"
        "  use-system-hosts: true\n"
        "  default-nameserver:\n"
        "    - 77.88.8.8\n"
        "    - 1.1.1.1\n"
        "  proxy-server-nameserver:\n"
        "    - 77.88.8.8\n"
        "    - 1.1.1.1\n"
        "  nameserver:\n"
        f"    - {_yaml_single_quote(google)}\n"
        f"    - {_yaml_single_quote(cloudflare)}\n"
        f"{MANAGED_END}\n"
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


def build_enabled_config(text: str, group: Optional[str] = None) -> tuple[str, str]:
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
    selected = str(group or _select_proxy_group(original) or "").strip()
    if not selected:
        raise MihomoDnsError(
            "Не найдена proxy-группа Mihomo. Сначала добавьте узел и группу.",
            code="proxy_group_missing",
        )
    # Keep the managed block near the top-level runtime settings (normally
    # immediately after ``profile``), rather than at EOF after all providers,
    # groups and rules.
    patched = _insert_managed_dns_block(_remove_store_fake_ip(original), _managed_dns_block(selected))
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
    has_dns = bool(dns_runtime["present"])
    managed = bool(has_begin and has_end and has_dns)
    applied_hash = str(state.get("applied_sha256") or "")
    exact = bool(managed and applied_hash and _sha256(text) == applied_hash)
    # ``exact`` answers whether an automatic rollback is safe.  It must not be
    # used to decide whether DNS is actually configured: a manual save or YAML
    # formatter can remove the managed comments while preserving a working DNS
    # block.  Keep those two concepts separate.
    enabled = bool(
        state
        and core == "mihomo"
        and dns_runtime["listener_configured"]
        and override is True
    )
    tampered = bool(state and not exact)
    partial = bool((has_begin or has_end) and not exact)
    group = str(state.get("proxy_group") or "") if exact else str(_select_proxy_group(text) or "")
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
    if tampered and not can_recover:
        blockers.append("Конфигурация изменена после включения DNS; автоматическое восстановление остановлено.")
    elif can_recover:
        blockers.append("DNS-блок уже удалён вручную, а DNS override Keenetic выключен; текущий config.yaml можно сохранить без возврата старого снимка.")
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
        "can_enable": can_enable,
        "can_disable": can_disable,
        "active_core": core,
        "proxy_group": group or None,
        "dns_override": override,
        "dns_present": has_dns,
        "dns_enabled": bool(dns_runtime["enabled"]),
        "dns_listener_configured": bool(dns_runtime["listener_configured"]),
        "listen": str(dns_runtime["listen"] or DNS_LISTEN),
        "mode": "redir-host",
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


def apply_action(
    action: str,
    *,
    config_file: str,
    ui_state_dir: str,
    validate_config: Callable[..., str],
    save_config: Callable[[str], Any],
    restart_xkeen: Callable[..., Any],
) -> dict[str, Any]:
    normalized = str(action or "").strip().lower()
    if normalized not in {"enable", "disable"}:
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
            prepared, group = build_enabled_config(current, str(status.get("proxy_group") or ""))
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
            try:
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
                }
                _save_state(ui_state_dir, config_file, next_state)
                _clear_release(ui_state_dir, config_file)
                return {
                    "ok": True,
                    "enabled": True,
                    "proxy_group": group,
                    "listen": DNS_LISTEN,
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
                if saved:
                    try:
                        restart_xkeen(source="mihomo-dns-rollback")
                    except Exception as rollback_exc:
                        rollback_errors.append(str(rollback_exc))
                _clear_state(ui_state_dir, config_file)
                if isinstance(exc, MihomoDnsError):
                    if rollback_errors:
                        exc.details = {"cause": exc.details, "rollback": rollback_errors}
                    raise
                raise MihomoDnsError(
                    "Не удалось включить DNS Mihomo; предыдущая конфигурация восстановлена.",
                    code="apply_failed",
                    details={"cause": str(exc), "rollback": rollback_errors},
                ) from exc

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
    """Cheap check for the shared DNS guard: did this assistant take port 53?"""

    try:
        state = _load_state(ui_state_dir, config_file)
    except Exception:
        return False
    return bool(state.get("enabled"))


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

    snapshot_path = str(state.get("original_config") or "")
    original = _read_text(snapshot_path, None) if snapshot_path else None
    expected_sha = str(state.get("original_sha256") or "")
    if original is None:
        steps.append("snapshot_missing")
    elif expected_sha and _sha256(original) != expected_sha:
        # A damaged snapshot must not overwrite a working config.
        steps.append("snapshot_corrupt")
        original = None

    if original is not None:
        try:
            save_config(original)
            steps.append("config_restored")
        except Exception as exc:  # noqa: BLE001
            steps.append(f"config_failed:{exc}")

    # The port has to be released before the firmware can bind it, so the
    # override is flipped after the config that owned :53 is gone.
    desired = bool(state.get("original_dns_override", False))
    try:
        _set_dns_override(desired)
        steps.append("dns_override_restored")
    except Exception as exc:  # noqa: BLE001
        steps.append(f"dns_override_failed:{exc}")

    try:
        restart_xkeen(source="mihomo-dns-guard-release")
        steps.append("core_restart_requested")
    except Exception as exc:  # noqa: BLE001
        steps.append(f"core_restart_failed:{exc}")

    if not _wait_for_port_53(should_be_free=False):
        steps.append("port_53_still_free")

    released = {"released_at": int(time.time()), "reason": reason, "steps": steps}
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
