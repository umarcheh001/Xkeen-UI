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
import re
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Optional

from services.cores import detect_running_core
from services.io.atomic import _atomic_write_json, _atomic_write_text
from services.xray_config_files import jsonc_path_for
from utils.firmware import ndmc_path as _resolve_ndmc, run_ndmc
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
DNS_PROBE_ATTEMPTS = 3

_LOCK = threading.RLock()

# Watchdog: while the feature is on, the firmware resolver is disabled and Xray
# owns port 53.  If the core dies, nothing else answers DNS for the whole LAN,
# so a background check restarts the core and, if that keeps failing, hands
# port 53 back to KeeneticOS instead of leaving the network without DNS.
WATCHDOG_INTERVAL = 30.0
WATCHDOG_FAIL_THRESHOLD = 3
WATCHDOG_RESTART_ATTEMPTS = 2
_WATCHDOG_LOCK = threading.Lock()
_WATCHDOG_STARTED = False


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
    # tag -> inboundTag a loopback outbound re-injects traffic with, so a
    # fallback chain can be followed across the loopback hop.
    loopback_targets: Dict[str, str] = {}
    # subjectSelector entries of observatory/burstObservatory: leastPing only
    # works for outbounds an observatory actually probes.
    observatory_selectors: list[str] = []

    for name, obj in _iter_json_fragments(configs_dir):
        dns = obj.get("dns")
        if isinstance(dns, dict) and dns:
            dns_fragments.append(name)
        for key in ("observatory", "burstObservatory"):
            section = obj.get(key)
            if not isinstance(section, dict):
                continue
            raw = section.get("subjectSelector")
            for value in raw if isinstance(raw, list) else []:
                prefix = str(value).strip()
                if prefix:
                    observatory_selectors.append(prefix)
        for item in obj.get("outbounds") if isinstance(obj.get("outbounds"), list) else []:
            if not isinstance(item, dict):
                continue
            tag = _clean_tag(item.get("tag"))
            protocol = _clean_tag(item.get("protocol")).lower()
            if tag:
                outbounds.append({"tag": tag, "protocol": protocol, "file": name})
            if tag and protocol == "loopback":
                settings = item.get("settings") if isinstance(item.get("settings"), dict) else {}
                loopback_targets[tag] = _clean_tag(settings.get("inboundTag"))
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
        "loopback_targets": loopback_targets,
        "observatory_selectors": observatory_selectors,
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


def _find_balancer(runtime: Dict[str, Any], tag: str) -> Optional[Dict[str, Any]]:
    wanted = _clean_tag(tag)
    for item in runtime.get("balancers", []):
        if isinstance(item, dict) and _clean_tag(item.get("tag")) == wanted:
            return item
    return None


def _usable_selector(balancer: Dict[str, Any], proxy_tags: Iterable[str]) -> list[str]:
    """Selector prefixes of ``balancer`` that still resolve to a live proxy."""
    reserved_exact = {"direct", "block", DNS_OUT_TAG, "dns", "api", "xray-api", "metrics"}
    tags = list(proxy_tags)
    raw = balancer.get("selector") if isinstance(balancer.get("selector"), list) else []
    selector: list[str] = []
    for value in raw:
        prefix = str(value).strip()
        if not prefix or prefix.lower() in reserved_exact:
            continue
        if any(tag.startswith(prefix) for tag in tags):
            selector.append(prefix)
    return selector


def list_candidates(
    runtime: Dict[str, Any], routing: Optional[Dict[str, Any]] = None
) -> list[Dict[str, Any]]:
    """Every route DNS can be sent through, balancers first.

    The previous implementation guessed this list away: it looked for a
    balancer literally tagged ``proxy``, otherwise took whichever balancer came
    first in the file and, when that one's selector matched nothing, silently
    pinned DNS to the first proxy outbound.  With several balancers -- the
    panel's own mobile-whitelist scenario ships three -- the DNS route depended
    on JSON ordering.  Enumerate the options instead and let the caller pick.
    """
    proxies = _proxy_outbounds(runtime)
    proxy_tags = [item["tag"] for item in proxies]
    candidates: list[Dict[str, Any]] = []

    for item in runtime.get("balancers", []):
        tag = _clean_tag(item.get("tag"))
        if not tag or tag == BALANCER_TAG:
            continue
        selector = _usable_selector(item, proxy_tags)
        strategy = item.get("strategy") if isinstance(item.get("strategy"), dict) else {}
        candidates.append(
            {
                "kind": "balancer",
                "tag": tag,
                "label": f"балансировщик {tag}",
                "selector": selector,
                "selector_count": len(selector),
                "strategy_type": _clean_tag(strategy.get("type")),
                "fallback_tag": _clean_tag(item.get("fallbackTag")),
                "fallback": _fallback_plan(runtime, routing if isinstance(routing, dict) else {}, item),
                "usable": bool(selector),
                "reason": "" if selector else "ни один outbound не соответствует selector",
            }
        )

    for item in proxies:
        tag = item["tag"]
        candidates.append(
            {
                "kind": "outbound",
                "tag": tag,
                "label": f"прокси {tag}",
                "selector": [],
                "selector_count": 0,
                "strategy_type": "",
                "fallback_tag": "",
                "fallback": {"tag": "", "kept": False, "verdict": "none", "reason": "одиночный прокси, резерва нет"},
                "usable": True,
                "reason": "",
            }
        )
    return candidates


def _usable_candidates(candidates: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    return [item for item in candidates if item.get("usable")]


def default_candidate_tag(candidates: list[Dict[str, Any]]) -> str:
    """Tag the UI preselects.  Only ever a suggestion, never applied silently."""
    usable = _usable_candidates(candidates)
    if not usable:
        return ""
    named = next(
        (item for item in usable if item["kind"] == "balancer" and item["tag"] == "proxy"),
        None,
    )
    if named:
        return named["tag"]
    balancer = next((item for item in usable if item["kind"] == "balancer"), None)
    return (balancer or usable[0])["tag"]


LEAK_PROTOCOLS = {"freedom"}
DEAD_END_PROTOCOLS = {"blackhole"}


def _resolve_outbound_refs(runtime: Dict[str, Any], ref: str) -> list[Dict[str, str]]:
    """Outbounds a fallback reference points at: exact tag, else tag prefix."""
    wanted = _clean_tag(ref)
    if not wanted:
        return []
    items = [item for item in runtime.get("outbounds", []) if isinstance(item, dict)]
    exact = [item for item in items if _clean_tag(item.get("tag")) == wanted]
    if exact:
        return exact
    return [item for item in items if _clean_tag(item.get("tag")).startswith(wanted)]


def _combine_verdicts(verdicts: set[str]) -> str:
    if not verdicts:
        return "unknown"
    if "leak" in verdicts:
        return "leak"
    if "unknown" in verdicts:
        return "unknown"
    return "safe"


def _fallback_verdict(
    runtime: Dict[str, Any],
    routing: Dict[str, Any],
    ref: str,
    seen: Optional[set[str]] = None,
) -> str:
    """Follow a fallback reference until it terminates.

    ``safe``    stays inside proxies, or dead-ends in blackhole/nothing;
    ``leak``    reaches a freedom outbound, i.e. DNS would go to the provider;
    ``unknown`` cannot be resolved from the config alone.

    The original code assumed every fallbackTag meant ``direct`` and dropped it
    outright.  That holds for the subscription auto-balancer, but the panel's
    own scenario chains balancers through loopback outbounds, where discarding
    the fallback silently removes the user's DNS redundancy for no safety gain.
    """
    seen = set() if seen is None else seen
    key = _clean_tag(ref)
    if not key:
        return "safe"
    if key in seen:
        # A cycle cannot introduce a new exit; whoever opened it decides.
        return "safe"
    seen.add(key)

    matches = _resolve_outbound_refs(runtime, key)
    if not matches:
        return "unknown"
    verdicts: set[str] = set()
    for item in matches:
        protocol = _clean_tag(item.get("protocol")).lower()
        if protocol in LEAK_PROTOCOLS:
            verdicts.add("leak")
        elif protocol in DEAD_END_PROTOCOLS:
            verdicts.add("safe")
        elif protocol == "loopback":
            verdicts.add(_loopback_verdict(runtime, routing, _clean_tag(item.get("tag")), seen))
        else:
            verdicts.add("safe")
    return _combine_verdicts(verdicts)


def _loopback_verdict(
    runtime: Dict[str, Any], routing: Dict[str, Any], loopback_tag: str, seen: set[str]
) -> str:
    """Where routing sends traffic that a loopback outbound re-injects."""
    inbound = _clean_tag(runtime.get("loopback_targets", {}).get(loopback_tag))
    if not inbound:
        return "unknown"
    model = routing.get("routing") if isinstance(routing.get("routing"), dict) else {}
    rules = model.get("rules") if isinstance(model.get("rules"), list) else []
    verdicts: set[str] = set()
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        raw = rule.get("inboundTag")
        tags = raw if isinstance(raw, list) else ([raw] if raw else [])
        if inbound not in [_clean_tag(value) for value in tags]:
            continue
        outbound_tag = _clean_tag(rule.get("outboundTag"))
        balancer_tag = _clean_tag(rule.get("balancerTag"))
        if outbound_tag:
            verdicts.add(_fallback_verdict(runtime, routing, outbound_tag, seen))
        elif balancer_tag:
            verdicts.add(_balancer_verdict(runtime, routing, balancer_tag, seen))
    return _combine_verdicts(verdicts)


def _balancer_verdict(
    runtime: Dict[str, Any], routing: Dict[str, Any], balancer_tag: str, seen: set[str]
) -> str:
    balancer = _find_balancer(runtime, balancer_tag)
    if not balancer:
        return "unknown"
    raw = balancer.get("selector") if isinstance(balancer.get("selector"), list) else []
    verdicts = {_fallback_verdict(runtime, routing, value, seen) for value in raw}
    fallback = _clean_tag(balancer.get("fallbackTag"))
    if fallback:
        verdicts.add(_fallback_verdict(runtime, routing, fallback, seen))
    return _combine_verdicts(verdicts)


def _fallback_plan(
    runtime: Dict[str, Any], routing: Dict[str, Any], balancer: Dict[str, Any]
) -> Dict[str, Any]:
    """Decide whether the source balancer's fallback may be carried over."""
    tag = _clean_tag(balancer.get("fallbackTag"))
    if not tag:
        return {"tag": "", "kept": False, "verdict": "none", "reason": "у балансировщика нет резервного маршрута"}
    verdict = _fallback_verdict(runtime, routing, tag)
    if verdict == "safe":
        return {"tag": tag, "kept": True, "verdict": verdict, "reason": f"резервный маршрут «{tag}» остаётся внутри прокси"}
    if verdict == "leak":
        reason = f"резервный маршрут «{tag}» ведёт напрямую — DNS утёк бы провайдеру"
    else:
        reason = f"резервный маршрут «{tag}» не удалось проследить по конфигурации"
    return {"tag": tag, "kept": False, "verdict": verdict, "reason": reason}


def _build_target(
    candidate: Dict[str, Any], runtime: Dict[str, Any], routing: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    tag = candidate["tag"]
    if candidate["kind"] == "outbound":
        return {
            "kind": "outbound",
            "tag": tag,
            "source": tag,
            "sources": [tag],
            "label": candidate["label"],
            "fallback": {"tag": "", "kept": False, "verdict": "none", "reason": "одиночный прокси, резерва нет"},
            "managed_balancer": None,
        }
    source = _find_balancer(runtime, tag) or {}
    managed = {
        "tag": BALANCER_TAG,
        "selector": list(candidate["selector"]),
        "strategy": copy.deepcopy(source.get("strategy") or {"type": "random"}),
    }
    # Carry the fallback over only when the whole chain stays inside proxies.
    # A fallback that ends at a freedom outbound would send 127.0.0.53 back to
    # the router and can create a DNS loop/leak, so that one is still dropped.
    plan = _fallback_plan(runtime, routing if isinstance(routing, dict) else {}, source)
    if plan["kept"]:
        managed["fallbackTag"] = plan["tag"]
    return {
        "kind": "balancer",
        "tag": BALANCER_TAG,
        "source": tag,
        "sources": [tag],
        "label": candidate["label"],
        "fallback": plan,
        "managed_balancer": managed,
    }


def _stored_selection(state: Dict[str, Any]) -> list[str]:
    stored = state.get("target") if isinstance(state.get("target"), dict) else {}
    return normalize_target_request(stored.get("sources") or stored.get("source") or "")


def _combined_drift(
    runtime: Dict[str, Any], routing: Dict[str, Any], tags: list[str]
) -> Optional[Dict[str, Any]]:
    """A balancer built here drifts when one of its chosen proxies disappears."""
    managed = _find_managed_clone(routing)
    if not managed:
        return None
    live = {item["tag"] for item in _proxy_outbounds(runtime)}
    current = [tag for tag in tags if tag in live]
    snapshot = [str(value).strip() for value in managed.get("selector", []) if str(value).strip()]
    if current == snapshot:
        return None
    return {
        "source": ", ".join(tags),
        "managed": snapshot,
        "current": current,
        "managed_fallback": _clean_tag(managed.get("fallbackTag")),
        "current_fallback": "",
    }


def _find_managed_clone(routing: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    model = routing.get("routing") if isinstance(routing.get("routing"), dict) else {}
    balancers = model.get("balancers") if isinstance(model.get("balancers"), list) else []
    return next(
        (
            item
            for item in balancers
            if isinstance(item, dict) and _clean_tag(item.get("tag")) == BALANCER_TAG
        ),
        None,
    )


def _route_drift(runtime: Dict[str, Any], routing: Dict[str, Any], source_tag: str) -> Optional[Dict[str, Any]]:
    """Report a managed clone that no longer matches the balancer it came from.

    The clone is a snapshot taken at enable time.  Editing the original
    balancer afterwards leaves DNS on the stale selector, and an enable/disable
    round-trip is currently the only way to resync -- so at least say so.
    """
    source = _find_balancer(runtime, source_tag)
    if not source:
        return None
    managed = _find_managed_clone(routing)
    if not managed:
        return None
    current = _usable_selector(source, [item["tag"] for item in _proxy_outbounds(runtime)])
    snapshot = [str(value).strip() for value in managed.get("selector", []) if str(value).strip()]
    managed_fallback = _clean_tag(managed.get("fallbackTag"))
    plan = _fallback_plan(runtime, routing, source)
    current_fallback = plan["tag"] if plan["kept"] else ""
    if current == snapshot and current_fallback == managed_fallback:
        return None
    return {
        "source": source_tag,
        "managed": snapshot,
        "current": current,
        "managed_fallback": managed_fallback,
        "current_fallback": current_fallback,
    }


def normalize_target_request(requested: Any) -> list[str]:
    """Accept a single tag or a list of them, keeping order and dropping dupes."""
    values = requested if isinstance(requested, (list, tuple, set)) else [requested]
    result: list[str] = []
    for value in values:
        tag = _clean_tag(value)
        if tag and tag not in result:
            result.append(tag)
    return result


def _observatory_covers(runtime: Dict[str, Any], tags: Iterable[str]) -> bool:
    prefixes = [
        _clean_tag(value) for value in runtime.get("observatory_selectors", []) if _clean_tag(value)
    ]
    if not prefixes:
        return False
    return all(any(str(tag).startswith(prefix) for prefix in prefixes) for tag in tags)


def _build_combined_target(
    chosen: list[Dict[str, Any]], runtime: Dict[str, Any]
) -> Dict[str, Any]:
    """Balance DNS across several plain outbounds the user picked.

    Xray routes a rule to exactly one outbound or one balancer, so several
    proxies can only be combined by creating a balancer -- one the user does
    not otherwise have.  ``leastPing`` needs an observatory that actually
    probes these outbounds; without that coverage it would never pick a node,
    so fall back to ``random``.
    """
    tags = [item["tag"] for item in chosen]
    strategy = {"type": "leastPing"} if _observatory_covers(runtime, tags) else {"type": "random"}
    return {
        "kind": "balancer",
        "tag": BALANCER_TAG,
        "source": "",
        "sources": tags,
        "label": "прокси: " + ", ".join(tags),
        # Nothing to inherit: this balancer is created here, not cloned.
        "fallback": {"tag": "", "kept": False, "verdict": "none", "reason": "собственный балансировщик, резерва нет"},
        "managed_balancer": {
            "tag": BALANCER_TAG,
            "selector": list(tags),
            "strategy": strategy,
        },
    }


def _select_target(
    runtime: Dict[str, Any],
    requested_tag: Any = "",
    routing: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    candidates = list_candidates(runtime, routing)
    usable = _usable_candidates(candidates)
    if not usable:
        raise DnsOverVlessError(
            "Не найден рабочий proxy-outbound или балансировщик Xray.",
            code="proxy_target_missing",
        )
    wanted = normalize_target_request(requested_tag)

    if not wanted:
        if len(usable) == 1:
            return _build_target(usable[0], runtime, routing)
        # Ambiguous: refuse rather than resurrect the old file-order guess.
        raise DnsOverVlessError(
            "Выберите маршрут для DNS: доступно несколько балансировщиков или прокси.",
            code="target_choice_required",
            details={"candidates": candidates, "default": default_candidate_tag(candidates)},
        )

    chosen: list[Dict[str, Any]] = []
    for tag in wanted:
        match = next((item for item in usable if item["tag"] == tag), None)
        if match is None:
            raise DnsOverVlessError(
                f"Маршрут «{tag}» недоступен для DNS-over-VLESS.",
                code="target_unavailable",
                details={"candidates": candidates},
            )
        chosen.append(match)

    if len(chosen) == 1:
        return _build_target(chosen[0], runtime, routing)

    balancers = [item["tag"] for item in chosen if item["kind"] == "balancer"]
    if balancers:
        raise DnsOverVlessError(
            "Балансировщик нельзя объединять с другими маршрутами — выберите либо один "
            "балансировщик, либо несколько прокси.",
            code="mixed_target_selection",
            details={"balancers": balancers, "candidates": candidates},
        )
    return _build_combined_target(chosen, runtime)


def _managed_fragment() -> Dict[str, Any]:
    return {
        "dns": {
            # Use an explicit public upstream; the DNS outbound carries these
            # UDP requests through the selected VLESS route.
            "servers": ["8.8.8.8"],
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
    runtime = _collect_runtime(configs_dir, routing)
    proxies = _proxy_outbounds(runtime)
    proxy_tags = {item["tag"] for item in proxies}
    selector = [str(value).strip() for value in (balancer_obj or {}).get("selector", []) if str(value).strip()]
    # The clone may keep a fallback, but only one that cannot reach ``direct``.
    managed_fallback = _clean_tag((balancer_obj or {}).get("fallbackTag"))
    safe_fallback = (not managed_fallback) or _fallback_verdict(runtime, routing, managed_fallback) == "safe"
    safe_balancer = bool(
        balancer_obj
        and selector
        and safe_fallback
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
    return _resolve_ndmc()


def _dns_override_status() -> tuple[Optional[bool], str]:
    if not _ndmc_path():
        return None, "ndmc не найден"
    try:
        run = run_ndmc("show running-config", timeout=10)
    except Exception as exc:
        return None, str(exc)
    if run.rc != 0:
        return None, (run.output or "ndmc error").strip()
    # ndmc emits terminal erase-prefixes (``\x1b[K``) even when stdout is not
    # a TTY.  Normalize those control sequences before inspecting the config.
    clean = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", str(run.stdout or ""))
    lines = [line.strip().lower() for line in clean.splitlines()]
    if any(line == "no opkg dns-override" or line.startswith("no opkg dns-override ") for line in lines):
        return False, "running-config"
    if any(line == "opkg dns-override" or line.startswith("opkg dns-override ") for line in lines):
        return True, "running-config"
    # Keenetic normally omits default/disabled commands from running-config.
    return False, "running-config (команда отсутствует)"


def _set_dns_override(enabled: bool) -> None:
    if not _ndmc_path():
        raise DnsOverVlessError("Не найден ndmc; настройка Keenetic недоступна.", code="ndmc_missing")
    command = "opkg dns-override" if enabled else "no opkg dns-override"

    # ``ndmc -c`` accepts exactly one command.  Passing a newline-separated
    # command stream (as the first implementation did) is parsed as a single
    # malformed argument on KeeneticOS 5.x and returns error 7405602.  Apply
    # the setting and persist it as two independent invocations instead.
    try:
        run = run_ndmc(command, timeout=15)
    except Exception as exc:
        raise DnsOverVlessError("Не удалось изменить DNS override Keenetic.", code="ndmc_failed", details=str(exc)) from exc
    output = run.output
    if run.rc != 0 or "% error" in output.lower() or "error:" in output.lower() or "command::base error" in output.lower():
        raise DnsOverVlessError("Keenetic отклонил команду DNS override.", code="ndmc_failed", details=output)

    try:
        save_run = run_ndmc("system configuration save", timeout=15)
    except Exception as exc:
        raise DnsOverVlessError(
            "Не удалось сохранить настройку DNS override Keenetic.",
            code="ndmc_failed",
            details=str(exc),
        ) from exc
    save_output = save_run.output
    if (
        save_run.rc != 0
        or "% error" in save_output.lower()
        or "error:" in save_output.lower()
        or "command::base error" in save_output.lower()
    ):
        raise DnsOverVlessError(
            "Не удалось сохранить настройку DNS override Keenetic.",
            code="ndmc_failed",
            details=save_output,
        )


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
    """Probe the new listener with short retries while Xray warms up.

    Large configs with observatory/balancers can take several seconds after
    the service process appears before their inbounds accept packets.  A
    single query sent immediately after ``_wait_for_xray`` was therefore
    dropped on real routers even though the listener became healthy moments
    later.  Keep the operation fail-closed, but retry the exact same local DNS
    health check within the existing seven-second budget.
    """

    started = time.monotonic()
    deadline = started + max(1.0, float(timeout or 0))
    labels = [label.encode("ascii") for label in domain.strip(".").split(".") if label]
    qname = b"".join(bytes([len(label)]) + label for label in labels) + b"\x00"
    attempts = 0
    last_error = "timeout"
    last_response: Dict[str, Any] = {}

    # Keenetic's Xray listener may bind the LAN address (and IPv6 wildcard)
    # rather than loopback.  Discover the local source address without sending
    # traffic so the health check works on both variants.
    probe_hosts: list[str] = []
    configured_host = str(os.environ.get("XKEEN_DNS_PROBE_HOST") or "").strip()
    if configured_host:
        probe_hosts.append(configured_host)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as route_sock:
            route_sock.connect(("8.8.8.8", 53))
            local_host = str(route_sock.getsockname()[0] or "").strip()
            if local_host:
                probe_hosts.append(local_host)
    except Exception:
        pass
    probe_hosts.extend(("127.0.0.1", "127.0.0.53"))
    probe_hosts = list(dict.fromkeys(host for host in probe_hosts if host))

    while attempts < DNS_PROBE_ATTEMPTS and time.monotonic() < deadline:
        attempts += 1
        txid = random.randint(0, 65535)
        packet = struct.pack("!HHHHHH", txid, 0x0100, 1, 0, 0, 0) + qname + struct.pack("!HH", 1, 1)
        remaining = max(0.2, deadline - time.monotonic())
        attempt_timeout = min(2.25, remaining)
        data = b""
        for host in probe_hosts:
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.settimeout(min(0.8, attempt_timeout))
                    sock.sendto(packet, (host, 53))
                    data, _peer = sock.recvfrom(4096)
                break
            except Exception as exc:
                last_error = str(exc)
                continue
        if not data:
            if attempts < DNS_PROBE_ATTEMPTS:
                time.sleep(min(0.35, max(0.0, deadline - time.monotonic())))
            continue
        if len(data) < 12:
            last_error = "короткий DNS-ответ"
            continue
        rid, flags, _qd, answers, _ns, _ar = struct.unpack("!HHHHHH", data[:12])
        rcode = flags & 0x000F
        last_response = {"answers": answers, "rcode": rcode}
        if rid == txid and rcode == 0 and answers > 0:
            return {
                "ok": True,
                "answers": answers,
                "rcode": rcode,
                "attempts": attempts,
                "latency_ms": round((time.monotonic() - started) * 1000),
            }
        last_error = f"некорректный DNS-ответ (rcode={rcode}, answers={answers})"

    return {
        "ok": False,
        "error": last_error,
        "attempts": attempts,
        "latency_ms": round((time.monotonic() - started) * 1000),
        **last_response,
    }


def _emergency_release(
    *, configs_dir: str, routing_file: str, ui_state_dir: str, restart_xkeen: Callable[..., Any], reason: str
) -> Dict[str, Any]:
    """Give port 53 back to KeeneticOS after the core stayed down.

    Unlike :func:`apply_action` this path never rolls back.  Its whole purpose
    is to restore name resolution for the LAN, so a partial failure must not
    put the DNS override back on.  Order matters: drop the managed config
    first, because a core that recovers while ndnproxy already holds port 53
    would fail to bind and stay down.
    """
    steps: list[str] = []
    routing, _raw = _read_routing_with_raw(routing_file)
    managed_path = os.path.join(configs_dir, MANAGED_FRAGMENT)

    try:
        _write_routing_preserving_comments(routing_file, _build_disabled_routing(routing))
        steps.append("routing_cleared")
    except Exception as exc:  # noqa: BLE001
        steps.append(f"routing_failed:{exc}")
    try:
        os.remove(managed_path)
        steps.append("fragment_removed")
    except FileNotFoundError:
        steps.append("fragment_absent")
    except Exception as exc:  # noqa: BLE001
        steps.append(f"fragment_failed:{exc}")

    state = _load_state(ui_state_dir)
    desired = bool(state.get("original_dns_override", False))
    try:
        _set_dns_override(desired)
        steps.append("dns_override_restored")
    except Exception as exc:  # noqa: BLE001
        steps.append(f"dns_override_failed:{exc}")

    try:
        restart_xkeen(source="dns-over-vless-watchdog-release")
        steps.append("core_restart_requested")
    except Exception as exc:  # noqa: BLE001
        steps.append(f"core_restart_failed:{exc}")

    released = {
        "released_at": int(time.time()),
        "reason": reason,
        "steps": steps,
    }
    state["enabled"] = False
    state["watchdog"] = released
    try:
        _save_state(ui_state_dir, state)
    except Exception:
        pass
    return released


def _watchdog_healthy() -> bool:
    if detect_running_core() != "xray":
        return False
    return bool(_dns_probe().get("ok"))


def watchdog_tick(
    *,
    configs_dir: str,
    routing_file: str,
    ui_state_dir: str,
    restart_xkeen: Callable[..., Any],
    counters: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Run one health check and return the updated counters plus the action.

    Actions: ``idle`` (feature off), ``ok``, ``watching`` (a failure seen, still
    below the threshold), ``restarted`` (core restart attempted) and
    ``released`` (gave DNS back to the firmware).
    """
    result = dict(counters or {})
    result.setdefault("fails", 0)
    result.setdefault("restarts", 0)
    result.setdefault("released", False)

    # A health check waits seconds on the DNS probe and a core restart takes
    # longer still.  Holding _LOCK across them would stall the user's own
    # enable/disable, so the lock only covers state reads and the mutating step.
    with _LOCK:
        state = _load_state(ui_state_dir)
    if not state.get("enabled"):
        # Either never enabled, or already released/disabled by someone.
        result.update({"fails": 0, "restarts": 0, "action": "idle"})
        return result
    if result.get("released"):
        result["action"] = "released"
        return result

    if _watchdog_healthy():
        result.update({"fails": 0, "restarts": 0, "action": "ok"})
        return result

    result["fails"] = int(result["fails"]) + 1
    if result["fails"] < WATCHDOG_FAIL_THRESHOLD:
        result["action"] = "watching"
        return result

    if int(result["restarts"]) < WATCHDOG_RESTART_ATTEMPTS:
        result["restarts"] = int(result["restarts"]) + 1
        result["fails"] = 0
        try:
            restart_xkeen(source="dns-over-vless-watchdog")
        except Exception:
            pass
        result["action"] = "restarted"
        return result

    reason = "Xray не поднялся после %d попыток; DNS возвращён прошивке." % int(result["restarts"])
    with _LOCK:
        # The user may have switched the feature off while we were probing;
        # releasing on top of that would fight their decision.
        if not _load_state(ui_state_dir).get("enabled"):
            result.update({"fails": 0, "restarts": 0, "action": "idle"})
            return result
        result["release"] = _emergency_release(
            configs_dir=configs_dir,
            routing_file=routing_file,
            ui_state_dir=ui_state_dir,
            restart_xkeen=restart_xkeen,
            reason=reason,
        )
    result.update({"released": True, "action": "released"})
    return result


def start_watchdog(
    *,
    configs_dir: str,
    routing_file: str,
    ui_state_dir: str,
    restart_xkeen: Callable[..., Any],
    interval: float = WATCHDOG_INTERVAL,
    audit: Optional[Callable[..., None]] = None,
) -> bool:
    """Start the background health check once per process."""
    global _WATCHDOG_STARTED
    with _WATCHDOG_LOCK:
        if _WATCHDOG_STARTED:
            return False
        _WATCHDOG_STARTED = True

    def _loop() -> None:
        counters: Dict[str, Any] = {}
        while True:
            time.sleep(max(5.0, float(interval or WATCHDOG_INTERVAL)))
            try:
                counters = watchdog_tick(
                    configs_dir=configs_dir,
                    routing_file=routing_file,
                    ui_state_dir=ui_state_dir,
                    restart_xkeen=restart_xkeen,
                    counters=counters,
                )
                action = counters.get("action")
                if action in {"restarted", "released"} and audit is not None:
                    # The watchdog acts unattended; leave a trace in the log.
                    try:
                        audit(
                            action == "restarted",
                            source="dns-over-vless-watchdog",
                            summary=(
                                "DNS-over-VLESS: перезапуск Xray сторожем"
                                if action == "restarted"
                                else "DNS-over-VLESS отключён сторожем, DNS возвращён прошивке"
                            ),
                        )
                    except Exception:
                        pass
                if action == "released":
                    # Nothing left to guard; a new enable restarts the cycle.
                    counters = {}
            except Exception:
                counters = {}

    thread = threading.Thread(target=_loop, name="xkeen-dns-over-vless-watchdog", daemon=True)
    thread.start()
    return True


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
    candidates = list_candidates(runtime, routing)
    default_tag = default_candidate_tag(candidates)
    # A choice made earlier survives in the state file, so an install that
    # predates the picker keeps its route instead of being re-guessed.
    state_tags = _stored_selection(state)
    # The picker may only preselect routes that are still usable; drift
    # detection deliberately works off the raw stored tags, because a source
    # that went unusable is exactly what needs reporting.
    selected_tags = [
        tag
        for tag in state_tags
        if any(item["tag"] == tag and item.get("usable") for item in candidates)
    ]
    selected_tag = selected_tags[0] if len(selected_tags) == 1 else ""
    if not enabled:
        blockers.extend(_conflicts(runtime, routing))
        try:
            target = _select_target(runtime, selected_tags or default_tag, routing)
        except DnsOverVlessError as exc:
            blockers.append(str(exc))
        if core != "xray":
            blockers.append("Для активации переключите активное ядро на Xray.")
        if override is None:
            blockers.append("Не удалось прочитать настройку DNS override Keenetic: " + override_detail)
    drift = None
    # Do not gate this on ``enabled``: a proxy that vanished from the selector
    # is exactly what makes the managed config look incomplete, and the drift
    # message explains that far better than "неполная настройка".
    if state_tags and _find_managed_clone(routing):
        drift = (
            _route_drift(runtime, routing, state_tags[0])
            if len(state_tags) == 1
            else _combined_drift(runtime, routing, state_tags)
        )
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
        "candidates": candidates,
        "route_drift": drift,
        "watchdog": state.get("watchdog") if isinstance(state.get("watchdog"), dict) else None,
        "selected_target": selected_tag,
        "selected_targets": selected_tags,
        "default_target": default_tag,
        "choice_required": bool(len(_usable_candidates(candidates)) > 1 and not selected_tags),
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
    target_tag: Any = "",
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
                    # An explicit request wins; otherwise reuse the route this
                    # install already chose.  With neither, _select_target
                    # refuses instead of guessing by file order.
                    requested = normalize_target_request(target_tag) or _stored_selection(
                        previous_state
                    )
                    target = _select_target(runtime, requested, routing)
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
