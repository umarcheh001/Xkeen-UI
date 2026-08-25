"""Transactional DNS-over-VLESS setup for Xray on Keenetic.

The feature deliberately owns as little configuration as possible:

* one dedicated Xray fragment (``02_dns_over_vless.json``);
* two tagged routing rules and, when an existing balancer is reused, one
  dedicated fail-closed balancer without a ``direct`` fallback;
* the Keenetic ``opkg dns-override`` switch.

Every mutating operation is staged in a temporary Xray confdir, validated by
``xray -test``, snapshotted, and rolled back on a restart/DNS health failure.
It never rewrites proxy outbounds or unrelated routing rules.
"""

from __future__ import annotations

import copy
import json
import os
import random
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Optional

from services.cores import detect_running_core
from services.io.atomic import _atomic_write_json, _atomic_write_text
from services.xray_config_files import jsonc_path_for
from utils.jsonc import strip_json_comments_text


MANAGED_FRAGMENT = "02_dns_over_vless.json"
STATE_FILENAME = "dns_over_vless.json"
LISTENER_TAG = "xk-dns-listener"
DNS_IN_TAG = "dns-in"
DNS_OUT_TAG = "dns-out"
PROXY_RULE_TAG = "xk_dns_over_vless_proxy"
CAPTURE_RULE_TAG = "xk_dns_over_vless_capture"
BALANCER_TAG = "xk-dns-over-vless"
PROBE_DOMAIN = "example.com"

_LOCK = threading.RLock()


class DnsOverVlessError(RuntimeError):
    def __init__(self, message: str, *, code: str = "dns_over_vless_failed", details: Any = None):
        super().__init__(message)
        self.code = code
        self.details = details


def _read_json(path: str, default: Any = None) -> Any:
    try:
        text = Path(path).read_text(encoding="utf-8")
        return json.loads(strip_json_comments_text(text))
    except Exception:
        return copy.deepcopy(default)


def _read_routing_with_raw(path: str) -> tuple[Dict[str, Any], str]:
    raw_path = jsonc_path_for(path)
    raw = ""
    try:
        # The runtime JSON is authoritative.  The JSONC sidecar exists only to
        # preserve comments for the editor and may briefly lag behind after a
        # save performed outside that editor.
        raw = Path(path).read_text(encoding="utf-8")
    except Exception:
        try:
            raw = Path(raw_path).read_text(encoding="utf-8")
        except Exception:
            raw = ""
    try:
        obj = json.loads(strip_json_comments_text(raw))
    except Exception:
        obj = _read_json(path, {})
    return (obj if isinstance(obj, dict) else {}), raw


def _state_path(ui_state_dir: str) -> str:
    return os.path.join(ui_state_dir, STATE_FILENAME)


def _load_state(ui_state_dir: str) -> Dict[str, Any]:
    value = _read_json(_state_path(ui_state_dir), {})
    return value if isinstance(value, dict) else {}


def _save_state(ui_state_dir: str, value: Dict[str, Any]) -> None:
    os.makedirs(ui_state_dir, exist_ok=True)
    _atomic_write_json(_state_path(ui_state_dir), value)


def _clean_tag(value: Any) -> str:
    return str(value or "").strip()


def _iter_json_fragments(configs_dir: str) -> Iterable[tuple[str, Dict[str, Any]]]:
    try:
        names = sorted(os.listdir(configs_dir))
    except Exception:
        return []
    result: list[tuple[str, Dict[str, Any]]] = []
    for name in names:
        if not name.lower().endswith(".json") or name == MANAGED_FRAGMENT:
            continue
        path = os.path.join(configs_dir, name)
        if not os.path.isfile(path):
            continue
        obj = _read_json(path, None)
        if isinstance(obj, dict):
            result.append((name, obj))
    return result


def _collect_runtime(configs_dir: str, routing: Dict[str, Any]) -> Dict[str, Any]:
    outbounds: list[Dict[str, str]] = []
    inbound_tags: set[str] = set()
    inbound_ports: list[Dict[str, Any]] = []
    dns_fragments: list[str] = []

    for name, obj in _iter_json_fragments(configs_dir):
        dns = obj.get("dns")
        if isinstance(dns, dict) and dns:
            dns_fragments.append(name)
        for item in obj.get("outbounds") if isinstance(obj.get("outbounds"), list) else []:
            if not isinstance(item, dict):
                continue
            tag = _clean_tag(item.get("tag"))
            protocol = _clean_tag(item.get("protocol")).lower()
            if tag:
                outbounds.append({"tag": tag, "protocol": protocol, "file": name})
        for item in obj.get("inbounds") if isinstance(obj.get("inbounds"), list) else []:
            if not isinstance(item, dict):
                continue
            tag = _clean_tag(item.get("tag"))
            if tag:
                inbound_tags.add(tag)
            try:
                port = int(item.get("port"))
            except Exception:
                port = 0
            if port:
                inbound_ports.append({"port": port, "tag": tag, "file": name})

    routing_obj = routing.get("routing") if isinstance(routing.get("routing"), dict) else {}
    balancers = [item for item in routing_obj.get("balancers", []) if isinstance(item, dict)]
    return {
        "outbounds": outbounds,
        "inbound_tags": inbound_tags,
        "inbound_ports": inbound_ports,
        "dns_fragments": dns_fragments,
        "balancers": balancers,
    }


def _proxy_outbounds(runtime: Dict[str, Any]) -> list[Dict[str, str]]:
    ignored = {"blackhole", "dns", "freedom", "loopback"}
    reserved = {"direct", "block", DNS_OUT_TAG, "dns", "api", "xray-api", "metrics"}
    result: list[Dict[str, str]] = []
    seen: set[str] = set()
    for item in runtime.get("outbounds", []):
        tag = _clean_tag(item.get("tag"))
        protocol = _clean_tag(item.get("protocol")).lower()
        if not tag or tag in seen or tag.lower() in reserved or protocol in ignored:
            continue
        seen.add(tag)
        result.append(item)
    return result


def _select_target(runtime: Dict[str, Any]) -> Dict[str, Any]:
    proxies = _proxy_outbounds(runtime)
    proxy_tags = [item["tag"] for item in proxies]
    reserved_exact = {"direct", "block", DNS_OUT_TAG, "dns", "api", "xray-api", "metrics"}
    balancers = runtime.get("balancers") if isinstance(runtime.get("balancers"), list) else []
    preferred = None
    for item in balancers:
        if _clean_tag(item.get("tag")) == "proxy":
            preferred = item
            break
    if preferred is None:
        preferred = next((item for item in balancers if _clean_tag(item.get("tag")) != BALANCER_TAG), None)

    if isinstance(preferred, dict):
        selector = []
        for value in preferred.get("selector", []) if isinstance(preferred.get("selector"), list) else []:
            prefix = str(value).strip()
            if not prefix:
                continue
            if any(tag.startswith(prefix) for tag in proxy_tags) and prefix.lower() not in reserved_exact:
                selector.append(prefix)
        if selector:
            managed = {
                "tag": BALANCER_TAG,
                "selector": selector,
                "strategy": copy.deepcopy(preferred.get("strategy") or {"type": "random"}),
            }
            # Intentionally omit fallbackTag: a direct fallback would send
            # 127.0.0.53 back to the router and can create a DNS loop/leak.
            return {
                "kind": "balancer",
                "tag": BALANCER_TAG,
                "source": _clean_tag(preferred.get("tag")),
                "label": f"балансировщик {_clean_tag(preferred.get('tag'))}",
                "managed_balancer": managed,
            }

    if proxies:
        item = proxies[0]
        return {
            "kind": "outbound",
            "tag": item["tag"],
            "source": item["tag"],
            "label": f"прокси {item['tag']}",
            "managed_balancer": None,
        }
    raise DnsOverVlessError(
        "Не найден рабочий proxy-outbound или балансировщик Xray.",
        code="proxy_target_missing",
    )


def _managed_fragment() -> Dict[str, Any]:
    return {
        "dns": {
            "servers": ["127.0.0.53"],
            "queryStrategy": "UseIP",
            "disableFallback": True,
            "tag": DNS_IN_TAG,
        },
        "inbounds": [
            {
                "tag": LISTENER_TAG,
                "protocol": "dokodemo-door",
                "port": 53,
                "settings": {"network": "tcp,udp"},
            }
        ],
        "outbounds": [{"tag": DNS_OUT_TAG, "protocol": "dns"}],
    }


def _owned_rule(rule: Any) -> bool:
    return isinstance(rule, dict) and _clean_tag(rule.get("ruleTag")) in {
        PROXY_RULE_TAG,
        CAPTURE_RULE_TAG,
    }


def _build_enabled_routing(routing: Dict[str, Any], target: Dict[str, Any]) -> Dict[str, Any]:
    result = copy.deepcopy(routing if isinstance(routing, dict) else {})
    model = result.get("routing")
    if not isinstance(model, dict):
        model = {}
        result["routing"] = model
    rules = [item for item in model.get("rules", []) if not _owned_rule(item)]
    proxy_rule: Dict[str, Any] = {
        "type": "field",
        "inboundTag": [DNS_IN_TAG],
        "ruleTag": PROXY_RULE_TAG,
    }
    proxy_rule["balancerTag" if target["kind"] == "balancer" else "outboundTag"] = target["tag"]
    capture_rule = {
        "type": "field",
        "network": "tcp,udp",
        "port": "53",
        "outboundTag": DNS_OUT_TAG,
        "ruleTag": CAPTURE_RULE_TAG,
    }
    model["rules"] = [proxy_rule, capture_rule, *rules]

    balancers = [
        item
        for item in model.get("balancers", [])
        if not (isinstance(item, dict) and _clean_tag(item.get("tag")) == BALANCER_TAG)
    ]
    if target.get("managed_balancer"):
        balancers.append(copy.deepcopy(target["managed_balancer"]))
    if balancers or "balancers" in model:
        model["balancers"] = balancers
    return result


def _build_disabled_routing(routing: Dict[str, Any]) -> Dict[str, Any]:
    result = copy.deepcopy(routing if isinstance(routing, dict) else {})
    model = result.get("routing")
    if not isinstance(model, dict):
        return result
    if isinstance(model.get("rules"), list):
        model["rules"] = [item for item in model["rules"] if not _owned_rule(item)]
    if isinstance(model.get("balancers"), list):
        model["balancers"] = [
            item
            for item in model["balancers"]
            if not (isinstance(item, dict) and _clean_tag(item.get("tag")) == BALANCER_TAG)
        ]
    return result


def _conflicts(runtime: Dict[str, Any], routing: Dict[str, Any]) -> list[str]:
    conflicts: list[str] = []
    for item in runtime.get("inbound_ports", []):
        if int(item.get("port") or 0) == 53:
            conflicts.append(f"Порт 53 уже занят inbound {item.get('tag') or 'без тега'} ({item.get('file')}).")
    if DNS_IN_TAG in runtime.get("inbound_tags", set()) or LISTENER_TAG in runtime.get("inbound_tags", set()):
        conflicts.append("Теги DNS inbound уже используются в другом фрагменте.")
    outbound_tags = {_clean_tag(item.get("tag")) for item in runtime.get("outbounds", [])}
    if DNS_OUT_TAG in outbound_tags:
        conflicts.append(f"Outbound {DNS_OUT_TAG} уже существует в другом фрагменте.")
    if runtime.get("dns_fragments"):
        conflicts.append("В Xray уже настроен DNS-блок: " + ", ".join(runtime["dns_fragments"]) + ".")

    model = routing.get("routing") if isinstance(routing.get("routing"), dict) else {}
    for rule in model.get("rules", []) if isinstance(model.get("rules"), list) else []:
        if _owned_rule(rule) or not isinstance(rule, dict):
            continue
        if str(rule.get("port") or "").replace(" ", "") == "53" or DNS_IN_TAG in (
            rule.get("inboundTag") if isinstance(rule.get("inboundTag"), list) else []
        ):
            conflicts.append("В routing уже есть пользовательское правило DNS/port 53.")
            break
    return conflicts


def _managed_presence(configs_dir: str, routing: Dict[str, Any]) -> Dict[str, bool]:
    managed_path = os.path.join(configs_dir, MANAGED_FRAGMENT)
    fragment = _read_json(managed_path, None)
    exact_fragment = fragment == _managed_fragment()
    model = routing.get("routing") if isinstance(routing.get("routing"), dict) else {}
    rules = model.get("rules") if isinstance(model.get("rules"), list) else []
    proxy_rule_obj = next((item for item in rules if _clean_tag(item.get("ruleTag")) == PROXY_RULE_TAG), None)
    capture_rule_obj = next((item for item in rules if _clean_tag(item.get("ruleTag")) == CAPTURE_RULE_TAG), None)
    balancer_obj = next(
        (
            item
            for item in model.get("balancers", []) if isinstance(model.get("balancers"), list)
            if isinstance(item, dict) and _clean_tag(item.get("tag")) == BALANCER_TAG
        ),
        None,
    )
    proxies = _proxy_outbounds(_collect_runtime(configs_dir, routing))
    proxy_tags = {item["tag"] for item in proxies}
    selector = [str(value).strip() for value in (balancer_obj or {}).get("selector", []) if str(value).strip()]
    safe_balancer = bool(
        balancer_obj
        and selector
        and not _clean_tag(balancer_obj.get("fallbackTag"))
        and all(any(tag.startswith(prefix) for tag in proxy_tags) for prefix in selector)
        and not any(prefix.lower() in {"direct", "block", DNS_OUT_TAG, "dns"} for prefix in selector)
    )
    safe_proxy_rule = bool(
        isinstance(proxy_rule_obj, dict)
        and proxy_rule_obj.get("type") == "field"
        and proxy_rule_obj.get("inboundTag") == [DNS_IN_TAG]
        and (
            (_clean_tag(proxy_rule_obj.get("balancerTag")) == BALANCER_TAG and safe_balancer and not proxy_rule_obj.get("outboundTag"))
            or (_clean_tag(proxy_rule_obj.get("outboundTag")) in proxy_tags and not proxy_rule_obj.get("balancerTag"))
        )
    )
    safe_capture_rule = capture_rule_obj == {
        "type": "field",
        "network": "tcp,udp",
        "port": "53",
        "outboundTag": DNS_OUT_TAG,
        "ruleTag": CAPTURE_RULE_TAG,
    }
    return {
        "fragment": exact_fragment,
        "fragment_owned": os.path.isfile(managed_path),
        "proxy_rule": safe_proxy_rule,
        "proxy_rule_owned": proxy_rule_obj is not None,
        "capture_rule": safe_capture_rule,
        "capture_rule_owned": capture_rule_obj is not None,
        "balancer": safe_balancer,
        "balancer_owned": balancer_obj is not None,
    }


def _managed_config_complete(presence: Dict[str, bool]) -> bool:
    if not (presence.get("fragment") and presence.get("proxy_rule") and presence.get("capture_rule")):
        return False
    # BALANCER_TAG is optional when the assistant could route straight to one
    # proxy outbound.
    return True


def _managed_config_present(presence: Dict[str, bool]) -> bool:
    return any(
        presence.get(key)
        for key in ("fragment_owned", "proxy_rule_owned", "capture_rule_owned", "balancer_owned")
    )


def _managed_config_recognized(presence: Dict[str, bool]) -> bool:
    return any(presence.get(key) for key in ("fragment", "proxy_rule", "capture_rule", "balancer"))


def _managed_config_tampered(presence: Dict[str, bool]) -> bool:
    return any(
        presence.get(owned) and not presence.get(valid)
        for owned, valid in (
            ("fragment_owned", "fragment"),
            ("proxy_rule_owned", "proxy_rule"),
            ("capture_rule_owned", "capture_rule"),
            ("balancer_owned", "balancer"),
        )
    )


def _ndmc_path() -> str:
    return str(shutil.which("ndmc") or "")


def _dns_override_status() -> tuple[Optional[bool], str]:
    ndmc = _ndmc_path()
    if not ndmc:
        return None, "ndmc не найден"
    try:
        proc = subprocess.run(
            [ndmc, "-c", "show running-config"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except Exception as exc:
        return None, str(exc)
    if proc.returncode != 0:
        return None, str(proc.stderr or proc.stdout or "ndmc error").strip()
    lines = [line.strip().lower() for line in str(proc.stdout or "").splitlines()]
    if "opkg dns-override" in lines:
        return True, "running-config"
    if "no opkg dns-override" in lines:
        return False, "running-config"
    # Keenetic normally omits default/disabled commands from running-config.
    return False, "running-config (команда отсутствует)"


def _set_dns_override(enabled: bool) -> None:
    ndmc = _ndmc_path()
    if not ndmc:
        raise DnsOverVlessError("Не найден ndmc; настройка Keenetic недоступна.", code="ndmc_missing")
    command = "opkg dns-override" if enabled else "no opkg dns-override"
    payload = command + "\nsystem configuration save\n"
    try:
        proc = subprocess.run(
            [ndmc, "-c", payload],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except Exception as exc:
        raise DnsOverVlessError("Не удалось изменить DNS override Keenetic.", code="ndmc_failed", details=str(exc)) from exc
    output = f"{proc.stdout or ''}\n{proc.stderr or ''}".strip()
    if proc.returncode != 0 or "% error" in output.lower() or "error:" in output.lower():
        raise DnsOverVlessError("Keenetic отклонил команду DNS override.", code="ndmc_failed", details=output)


def _wait_for_port_53(*, should_be_free: bool, timeout: float = 8.0) -> bool:
    """Wait until the firmware resolver releases (or reclaims) port 53.

    ``opkg dns-override`` is applied asynchronously by KeeneticOS.  Starting
    Xray before ndnproxy has released the socket would make the restart fail,
    while restoring the firmware resolver before Xray stops would race in the
    opposite direction.
    """
    deadline = time.monotonic() + max(0.2, float(timeout or 0))
    while time.monotonic() < deadline:
        in_use = False
        for sock_type in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
            with socket.socket(socket.AF_INET, sock_type) as sock:
                try:
                    sock.bind(("0.0.0.0", 53))
                except OSError:
                    in_use = True
                    break
        if in_use == (not should_be_free):
            return True
        time.sleep(0.2)
    return False


def _xray_binary() -> str:
    if os.path.exists("/opt/sbin/xray"):
        return "/opt/sbin/xray"
    return str(shutil.which("xray") or "")


def _stage_and_test(configs_dir: str, replacements: Dict[str, Optional[Dict[str, Any]]]) -> Dict[str, Any]:
    xray = _xray_binary()
    if not xray:
        raise DnsOverVlessError("Не найден бинарник Xray для обязательной проверки.", code="xray_missing")
    try:
        with tempfile.TemporaryDirectory(prefix="xkeen-dns-vless-") as tmpdir:
            for name in os.listdir(configs_dir):
                src = os.path.join(configs_dir, name)
                dst = os.path.join(tmpdir, name)
                if os.path.isdir(src) and not os.path.islink(src):
                    # Backups are not part of the Xray confdir model.
                    if name == "backups":
                        continue
                    shutil.copytree(src, dst, symlinks=True)
                else:
                    shutil.copy2(src, dst, follow_symlinks=False)
            for name, obj in replacements.items():
                path = os.path.join(tmpdir, os.path.basename(name))
                if obj is None:
                    try:
                        os.remove(path)
                    except FileNotFoundError:
                        pass
                else:
                    _atomic_write_json(path, obj)
            env = os.environ.copy()
            asset_dir = str(os.environ.get("XRAY_LOCATION_ASSET") or "/opt/etc/xray/dat")
            if os.path.isdir(asset_dir):
                env["XRAY_LOCATION_ASSET"] = asset_dir
                env["xray.location.asset"] = asset_dir
            proc = subprocess.run(
                [xray, "-test", "-confdir", tmpdir],
                capture_output=True,
                text=True,
                timeout=max(10, int(os.environ.get("XKEEN_XRAY_TEST_TIMEOUT", "30"))),
                check=False,
                env=env,
            )
            if proc.returncode != 0:
                raise DnsOverVlessError(
                    "Xray отклонил подготовленную конфигурацию; ничего не изменено.",
                    code="xray_preflight_failed",
                    details=(proc.stderr or proc.stdout or "").strip()[-4000:],
                )
            return {"ok": True, "stdout": (proc.stdout or "").strip()[-1000:]}
    except DnsOverVlessError:
        raise
    except subprocess.TimeoutExpired as exc:
        raise DnsOverVlessError("Проверка Xray превысила таймаут; ничего не изменено.", code="xray_preflight_timeout") from exc
    except Exception as exc:
        raise DnsOverVlessError("Не удалось проверить подготовленную конфигурацию Xray.", code="xray_preflight_failed", details=str(exc)) from exc


def _write_routing_preserving_comments(path: str, obj: Dict[str, Any]) -> None:
    # Reuse the same semantic JSONC comment preservation path as subscription
    # routing sync. This keeps user comments attached to their rules.
    from services.xray_subscriptions import _write_jsonc_sidecar_if_changed

    _write_jsonc_sidecar_if_changed(
        path,
        obj,
        header="// DNS-over-VLESS managed by XKeen UI",
        preserve_existing_comments=True,
    )
    _atomic_write_json(path, obj)


def _snapshot(paths: Iterable[str], ui_state_dir: str) -> tuple[str, Dict[str, Any]]:
    txid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8]
    directory = os.path.join(ui_state_dir, "dns-over-vless", "transactions", txid)
    os.makedirs(directory, exist_ok=True)
    manifest: Dict[str, Any] = {"id": txid, "created_at": int(time.time()), "files": []}
    for idx, path in enumerate(paths):
        exists = os.path.isfile(path)
        item: Dict[str, Any] = {"path": path, "exists": exists, "backup": ""}
        if exists:
            backup = os.path.join(directory, f"{idx:02d}-{os.path.basename(path)}")
            shutil.copy2(path, backup)
            item["backup"] = backup
        manifest["files"].append(item)
    _atomic_write_json(os.path.join(directory, "manifest.json"), manifest)
    return directory, manifest


def _restore_snapshot(manifest: Dict[str, Any]) -> None:
    for item in manifest.get("files", []):
        path = str(item.get("path") or "")
        if not path:
            continue
        if item.get("exists"):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            shutil.copy2(str(item.get("backup") or ""), path)
        else:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass


def _wait_for_xray(timeout: float = 12.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if detect_running_core() == "xray":
            return True
        time.sleep(0.35)
    return detect_running_core() == "xray"


def _dns_probe(domain: str = PROBE_DOMAIN, timeout: float = 7.0) -> Dict[str, Any]:
    txid = random.randint(0, 65535)
    labels = [label.encode("ascii") for label in domain.strip(".").split(".") if label]
    qname = b"".join(bytes([len(label)]) + label for label in labels) + b"\x00"
    packet = struct.pack("!HHHHHH", txid, 0x0100, 1, 0, 0, 0) + qname + struct.pack("!HH", 1, 1)
    started = time.monotonic()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(timeout)
            sock.sendto(packet, ("127.0.0.1", 53))
            data, _peer = sock.recvfrom(4096)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "latency_ms": round((time.monotonic() - started) * 1000)}
    if len(data) < 12:
        return {"ok": False, "error": "короткий DNS-ответ"}
    rid, flags, _qd, answers, _ns, _ar = struct.unpack("!HHHHHH", data[:12])
    rcode = flags & 0x000F
    return {
        "ok": rid == txid and rcode == 0 and answers > 0,
        "answers": answers,
        "rcode": rcode,
        "latency_ms": round((time.monotonic() - started) * 1000),
    }


def get_status(*, configs_dir: str, routing_file: str, ui_state_dir: str) -> Dict[str, Any]:
    routing, _raw = _read_routing_with_raw(routing_file)
    runtime = _collect_runtime(configs_dir, routing)
    presence = _managed_presence(configs_dir, routing)
    override, override_detail = _dns_override_status()
    core = detect_running_core() or ""
    state = _load_state(ui_state_dir)
    complete_config = _managed_config_complete(presence)
    tampered = _managed_config_tampered(presence)
    enabled = bool(complete_config and override is True)
    partial = bool(_managed_config_present(presence) and not complete_config)
    blockers: list[str] = []
    target: Optional[Dict[str, Any]] = None
    if not enabled:
        blockers.extend(_conflicts(runtime, routing))
        try:
            target = _select_target(runtime)
        except DnsOverVlessError as exc:
            blockers.append(str(exc))
        if core != "xray":
            blockers.append("Для активации переключите активное ядро на Xray.")
        if override is None:
            blockers.append("Не удалось прочитать настройку DNS override Keenetic: " + override_detail)
    if partial:
        blockers.append("Обнаружена неполная предыдущая настройка DNS-over-VLESS; сначала выполните восстановление/отключение.")
    if tampered:
        blockers.append("Служебные объекты DNS-over-VLESS изменены вручную; автоматическое удаление отключено.")
    return {
        "ok": True,
        "enabled": enabled,
        "prepared": bool(complete_config and not enabled),
        "partial": partial,
        "tampered": tampered,
        "presence": presence,
        "dns_override": override,
        "dns_override_detail": override_detail,
        "active_core": core or "unknown",
        "can_enable": not blockers,
        "can_disable": not tampered and (_managed_config_present(presence) or bool(state.get("enabled"))),
        "blockers": blockers,
        "target": ({k: v for k, v in target.items() if k != "managed_balancer"} if target else None),
        "managed_fragment": MANAGED_FRAGMENT,
        "articles": ["https://jameszero.net/4773.htm", "https://jameszero.net/3398.htm"],
        "safety": {
            "preflight": True,
            "backup": True,
            "rollback": True,
            "dns_probe": True,
            "fail_closed": True,
        },
    }


def apply_action(
    action: str,
    *,
    configs_dir: str,
    routing_file: str,
    ui_state_dir: str,
    restart_xkeen: Callable[..., Any],
) -> Dict[str, Any]:
    normalized = str(action or "").strip().lower()
    if normalized not in {"enable", "disable"}:
        raise DnsOverVlessError("Неизвестное действие DNS-over-VLESS.", code="invalid_action")

    with _LOCK:
        before_override, detail = _dns_override_status()
        if before_override is None:
            raise DnsOverVlessError(
                "Не удалось определить текущую настройку DNS override; изменения отменены.",
                code="dns_override_unknown",
                details=detail,
            )
        if detect_running_core() != "xray":
            raise DnsOverVlessError(
                "DNS-over-VLESS можно менять только при активном ядре Xray.",
                code="xray_not_active",
            )

        routing, _raw = _read_routing_with_raw(routing_file)
        runtime = _collect_runtime(configs_dir, routing)
        managed_path = os.path.join(configs_dir, MANAGED_FRAGMENT)
        routing_raw_path = jsonc_path_for(routing_file)
        state_path = _state_path(ui_state_dir)
        snapshot_dir, manifest = _snapshot(
            [managed_path, routing_file, routing_raw_path, state_path],
            ui_state_dir,
        )
        previous_state = _load_state(ui_state_dir)
        original_override_for_state = (
            bool(previous_state.get("original_dns_override"))
            if previous_state.get("enabled")
            else bool(before_override)
        )
        desired_override = before_override
        router_changed = False

        try:
            if normalized == "enable":
                presence = _managed_presence(configs_dir, routing)
                if _managed_config_complete(presence):
                    # Idempotent recovery path: configuration is already
                    # prepared, so only revalidate it and claim DNS override.
                    target = None
                    next_routing = routing
                    next_fragment = _read_json(managed_path, _managed_fragment())
                else:
                    if _managed_config_present(presence):
                        raise DnsOverVlessError(
                            "Обнаружена неполная предыдущая настройка DNS-over-VLESS; безопаснее сначала отключить её.",
                            code="partial_managed_config",
                        )
                    conflicts = _conflicts(runtime, routing)
                    if conflicts:
                        raise DnsOverVlessError("Безопасная активация остановлена: " + " ".join(conflicts), code="config_conflict")
                    target = _select_target(runtime)
                    next_routing = _build_enabled_routing(routing, target)
                    next_fragment = _managed_fragment()
                desired_override = True
            else:
                presence = _managed_presence(configs_dir, routing)
                if not _managed_config_present(presence) and not previous_state.get("enabled"):
                    return {
                        "ok": True,
                        "action": normalized,
                        "enabled": False,
                        "restarted": False,
                        "probe": {"ok": True, "skipped": True},
                        "backup": os.path.basename(snapshot_dir),
                        "target": None,
                    }
                if _managed_config_tampered(presence) or (
                    _managed_config_present(presence) and not _managed_config_recognized(presence)
                ):
                    raise DnsOverVlessError(
                        "Служебные объекты DNS-over-VLESS были изменены вручную; автоматическое удаление остановлено.",
                        code="managed_config_modified",
                    )
                target = None
                next_routing = _build_disabled_routing(routing)
                next_fragment = None
                # Preserve a setting that existed before this feature claimed it.
                desired_override = bool(previous_state.get("original_dns_override", False))

            _stage_and_test(
                configs_dir,
                {
                    os.path.basename(routing_file): next_routing,
                    MANAGED_FRAGMENT: next_fragment,
                },
            )

            if normalized == "enable":
                _atomic_write_json(managed_path, next_fragment)
                _write_routing_preserving_comments(routing_file, next_routing)
                if before_override is not True:
                    _set_dns_override(True)
                    router_changed = True
                if not _wait_for_port_53(should_be_free=True):
                    raise DnsOverVlessError(
                        "Keenetic не освободил порт 53 после включения DNS override.",
                        code="dns_port_busy",
                    )
            else:
                try:
                    os.remove(managed_path)
                except FileNotFoundError:
                    pass
                _write_routing_preserving_comments(routing_file, next_routing)

            restarted = bool(restart_xkeen(source="dns-over-vless"))
            if not restarted or not _wait_for_xray():
                raise DnsOverVlessError("Xray не запустился с новой конфигурацией.", code="restart_failed")

            # On disable, stop listening on 53 before asking KeeneticOS to
            # reclaim it.  Reversing this order creates an ndnproxy/Xray race.
            if normalized == "disable" and before_override != desired_override:
                _set_dns_override(desired_override)
                router_changed = True
                if desired_override is False and not _wait_for_port_53(should_be_free=False):
                    raise DnsOverVlessError(
                        "Keenetic не восстановил штатный DNS-сервер на порту 53.",
                        code="dns_port_restore_failed",
                    )

            probe: Dict[str, Any] = {"ok": True, "skipped": True}
            if normalized == "enable":
                probe = _dns_probe()
                if not probe.get("ok"):
                    raise DnsOverVlessError(
                        "Тестовый DNS-запрос через VLESS не получил ответ.",
                        code="dns_probe_failed",
                        details=probe,
                    )

            if normalized == "enable":
                _save_state(
                    ui_state_dir,
                    {
                        "version": 1,
                        "enabled": True,
                        "enabled_at": int(time.time()),
                        "original_dns_override": original_override_for_state,
                        "target": ({k: v for k, v in target.items() if k != "managed_balancer"} if target else previous_state.get("target")),
                        "last_transaction": snapshot_dir,
                    },
                )
            else:
                try:
                    os.remove(state_path)
                except FileNotFoundError:
                    pass

            return {
                "ok": True,
                "action": normalized,
                "enabled": normalized == "enable",
                "restarted": True,
                "probe": probe,
                "backup": os.path.basename(snapshot_dir),
                "target": ({k: v for k, v in target.items() if k != "managed_balancer"} if target else None),
            }
        except Exception as exc:
            rollback_error = ""
            try:
                _restore_snapshot(manifest)
                if router_changed:
                    _set_dns_override(bool(before_override))
                restart_xkeen(source="dns-over-vless-rollback")
            except Exception as rollback_exc:  # noqa: BLE001
                rollback_error = str(rollback_exc)
            if isinstance(exc, DnsOverVlessError):
                if rollback_error:
                    exc.details = {"cause": exc.details, "rollback_error": rollback_error}
                raise
            raise DnsOverVlessError(
                "Не удалось применить DNS-over-VLESS; предыдущая конфигурация восстановлена.",
                details={"cause": str(exc), "rollback_error": rollback_error},
            ) from exc
