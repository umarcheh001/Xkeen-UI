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
import ipaddress
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
from services import dns_client_capture
from utils.firmware import ndmc_path as _resolve_ndmc, run_ndmc
from utils.jsonc import strip_json_comments_text


MANAGED_FRAGMENT = "02_dns_over_vless.json"
# Written above the routing while the feature is on, and taken back off it
# when the feature is switched off.
MANAGED_JSONC_HEADER = "// DNS-over-VLESS managed by XKeen UI"
STATE_FILENAME = "dns_over_vless.json"
LISTENER_TAG = "xk-dns-listener"
DNS_IN_TAG = "dns-in"
DNS_OUT_TAG = "dns-out"
# The port the managed listener takes over.  A resolver pointed back at it
# would ask this very service for the name it is trying to resolve, so the
# parser refuses such an address instead of building a loop.
LISTENER_PORT = 53
PROXY_RULE_TAG = "xk_dns_over_vless_proxy"
CAPTURE_RULE_TAG = "xk_dns_over_vless_capture"
BALANCER_TAG = "xk-dns-over-vless"
DEFAULT_UPSTREAMS = ["8.8.8.8"]
# The stub resolver systemd ships with: on a Debian or Ubuntu VPS it is
# already listening, which makes it the address to suggest first.
DEFAULT_REMOTE_UPSTREAM = "127.0.0.53"
LOCAL_RULE_TAG = "xk_dns_over_vless_local"
# Domains the user already routes past the tunnel: their names are resolved by
# a resolver of the user's choosing, not through VLESS, so the address they get
# is the near one instead of one next to the exit point.
DIRECT_RULE_TAG = "xk_dns_over_vless_direct"
# Zones that must never be answered from the other side of the tunnel: the
# router's own names, home network names, and reverse lookups for private
# ranges (a PTR for 192.168.x.x tells a public resolver about your LAN).
# Zones that are local by definition: none of them is delegated on the public
# internet, so a query for them has no business leaving the house.
LOCAL_ZONES = [
    "domain:lan",
    "domain:local",
    "domain:home",
    "domain:home.arpa",
    "domain:internal",
    "domain:localdomain",
]

# Reverse zones for private ranges only.  A blanket ``in-addr.arpa`` would also
# capture PTR lookups for public addresses, which are not local at all.
PRIVATE_PTR_ZONES = [
    "domain:10.in-addr.arpa",
    "domain:168.192.in-addr.arpa",
    "domain:254.169.in-addr.arpa",
    "domain:d.f.ip6.arpa",
    "domain:8.e.f.ip6.arpa",
]

# 172.16.0.0/12 spans sixteen reverse zones and is rare in home networks, so it
# is offered as a preset instead of sitting in the default list.
PTR_172_ZONES = [f"domain:{octet}.172.in-addr.arpa" for octet in range(16, 32)]

# Router vendor zones.  These are real public domains, listed because the
# router resolves them for itself: the local web interface, the DDNS name the
# box registers, and the redirect target used when opening it from the LAN.
KEENETIC_ZONES = [
    "domain:keenetic.net",
    "domain:keenetic.io",
    "domain:keenetic.pro",
    "domain:keenetic.name",
    "domain:keenetic.link",
]
NETCRAZE_ZONES = [
    "domain:netcraze.net",
    "domain:netcraze.pro",
]

DEFAULT_LOCAL_DOMAINS = [
    *LOCAL_ZONES,
    *PRIVATE_PTR_ZONES,
    *KEENETIC_ZONES,
    *NETCRAZE_ZONES,
]

# Zones that do not exist on the public internet: asking a public resolver
# about them returns NXDOMAIN anyway and hands it the names of the machines in
# your house.  Everything else on the local list — the vendor zones below, and
# whatever the user adds — is a real delegated domain, so a silent LAN resolver
# must not be the end of the story for it.
STRICT_LOCAL_ZONES = frozenset([*LOCAL_ZONES, *PRIVATE_PTR_ZONES, *PTR_172_ZONES])

ZONE_PRESETS = {
    "local": LOCAL_ZONES,
    "ptr": PRIVATE_PTR_ZONES,
    "ptr172": PTR_172_ZONES,
    "keenetic": KEENETIC_ZONES,
    "netcraze": NETCRAZE_ZONES,
}
# These caps are not Xray limits — it handles far longer lists.  They only
# stop an accidental paste from bloating the config into something nobody can
# read back, so they sit well above any realistic home setup.
MAX_UPSTREAMS = 8
MAX_LOCAL_RESOLVERS = 16
MAX_LOCAL_DOMAINS = 64
# Same caps for the bypass group: different numbers here would only be a
# question the user has to answer twice.
MAX_DIRECT_RESOLVERS = 16
MAX_DIRECT_DOMAINS = 64
UPSTREAM_SCHEMES = ("https://", "tls://", "tcp://", "quic://")
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
# Setups differ: a slow router needs a longer restart window, an always-on link
# tolerates a tighter check.  The defaults above stay, the environment tunes them
# within bounds that keep the guard a guard: it must still check, still retry a
# little, and still be able to give DNS back.
WATCHDOG_INTERVAL_BOUNDS = (5.0, 3600.0)
WATCHDOG_FAIL_THRESHOLD_BOUNDS = (1, 100)
WATCHDOG_RESTART_ATTEMPTS_BOUNDS = (0, 20)
_WATCHDOG_LOCK = threading.Lock()
_WATCHDOG_STARTED = False


def _env_number(name: str, default, bounds, cast):
    raw = str(os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = cast(raw)
    except Exception:
        return default
    low, high = bounds
    return max(low, min(high, value))


def watchdog_enabled() -> bool:
    """``XKEEN_DNS_OVER_VLESS_WATCHDOG=0`` turns the background check off."""
    raw = str(os.environ.get("XKEEN_DNS_OVER_VLESS_WATCHDOG") or "").strip().lower()
    if not raw:
        return True
    return raw in {"1", "true", "yes", "on"}


def watchdog_settings() -> Dict[str, Any]:
    """Effective watchdog knobs: defaults unless the environment overrides them."""
    return {
        "enabled": watchdog_enabled(),
        "interval": _env_number(
            "XKEEN_DNS_OVER_VLESS_WATCHDOG_INTERVAL",
            WATCHDOG_INTERVAL,
            WATCHDOG_INTERVAL_BOUNDS,
            float,
        ),
        "fail_threshold": _env_number(
            "XKEEN_DNS_OVER_VLESS_WATCHDOG_FAILS",
            WATCHDOG_FAIL_THRESHOLD,
            WATCHDOG_FAIL_THRESHOLD_BOUNDS,
            int,
        ),
        "restart_attempts": _env_number(
            "XKEEN_DNS_OVER_VLESS_WATCHDOG_RESTARTS",
            WATCHDOG_RESTART_ATTEMPTS,
            WATCHDOG_RESTART_ATTEMPTS_BOUNDS,
            int,
        ),
    }


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
    # The reason is shown to the user as a whole sentence: nobody outside the
    # config knows what a fallbackTag is, or that we clone their balancer, so
    # the text says what happens when every proxy is down instead.
    if verdict == "safe":
        return {
            "tag": tag,
            "kept": True,
            "verdict": verdict,
            "reason": (
                f"Если все выбранные прокси разом откажут, DNS уйдёт на запасной прокси «{tag}» — "
                "мимо провайдера, так что защита сохранится."
            ),
        }
    if verdict == "leak":
        reason = (
            "Если все выбранные прокси разом откажут, DNS просто перестанет отвечать. "
            "В вашем балансировщике на такой случай стоит запасной путь в обход VPN, но для DNS "
            "панель его не использует: запросы пошли бы к провайдеру, и он снова видел бы, "
            "какие сайты вы открываете."
        )
    else:
        reason = (
            "Если все выбранные прокси разом откажут, DNS просто перестанет отвечать. "
            "Куда ведёт запасной путь вашего балансировщика, панель проследить не смогла, "
            "а вслепую пускать по нему DNS нельзя: он может выйти мимо VPN, к провайдеру."
        )
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


def _pass_node_options(
    runtime: Dict[str, Any], routing: Optional[Dict[str, Any]], selection: list[str]
) -> list[str]:
    """Plain outbounds that may carry the other record types, in route order.

    ``proxySettings`` names one outbound handler, so a balancer is spelled out
    into the outbounds it selects.  With no usable route to go on, every live
    proxy is offered rather than nothing: the caller still has to pick one.
    """
    candidates = list_candidates(runtime, routing if isinstance(routing, dict) else {})
    by_tag = {item["tag"]: item for item in candidates}
    live = [item["tag"] for item in candidates if item["kind"] == "outbound"]
    picked: list[str] = []

    def _add(tag: str) -> None:
        if tag in live and tag not in picked:
            picked.append(tag)

    for tag in selection:
        item = by_tag.get(_clean_tag(tag))
        if item is None:
            continue
        if item["kind"] == "outbound":
            _add(item["tag"])
            continue
        # A selector holds prefixes, not finished tags; spell them out into the
        # proxies they actually match, keeping the order the outbounds have.
        for prefix in item["selector"]:
            for node in live:
                if node.startswith(prefix):
                    _add(node)
    return picked or live


def _pick_pass_node(
    requested: Any,
    stored: Any,
    runtime: Dict[str, Any],
    routing: Optional[Dict[str, Any]],
    selection: list[str],
) -> str:
    """Which node carries the record types the built-in DNS cannot answer.

    The choice is remembered rather than recomputed on every write: the first
    node of a balancer changes whenever the user reorders their own selector,
    and a fragment that quietly followed along would read back as drift against
    a config this panel had itself written.
    """
    options = _pass_node_options(runtime, routing, selection)
    wanted = _clean_tag(requested)
    if wanted:
        if wanted not in options:
            raise DnsOverVlessError(
                f"Узел «{wanted}» не подходит для прочих типов записей: нужен прокси из выбранного маршрута.",
                code="pass_node_unavailable",
                details={"options": options},
            )
        return wanted
    kept = _clean_tag(stored)
    if kept and kept in options:
        return kept
    if not options:
        raise DnsOverVlessError(
            "Для прочих типов записей нужен хотя бы один прокси-outbound; балансировщик здесь указать нельзя.",
            code="pass_node_missing",
        )
    return options[0]


def _split_upstream(value: str) -> tuple[str, int]:
    """Address and port of an upstream; port is 0 when it is not spelled out.

    An IPv6 literal is full of colons, so a port only counts when it is either
    bracketed (``[::1]:5353``) or the single colon of an IPv4 address.
    """
    text = str(value or "").strip()
    for scheme in UPSTREAM_SCHEMES:
        if text.lower().startswith(scheme):
            # Inside a URL the port belongs to the scheme's own transport; the
            # panel keeps such upstreams as written and does not take it apart.
            rest = text[len(scheme):].split("/", 1)[0]
            if rest.startswith("["):
                return rest[1:].split("]", 1)[0], 0
            if rest.count(":") == 1:
                rest = rest.split(":", 1)[0]
            return rest, 0
    if text.startswith("["):
        host, _, tail = text[1:].partition("]")
        port = tail[1:] if tail.startswith(":") else ""
        return host, int(port) if port.isdigit() else 0
    if text.count(":") == 1:
        host, _, port = text.partition(":")
        return host, int(port) if port.isdigit() else 0
    return text, 0


def _upstream_host(value: str) -> str:
    """Host part of an upstream: bare address, or the host inside a URL."""
    return _split_upstream(value)[0]


def _upstream_port(value: str) -> int:
    """Port an upstream names, or 0 when it uses the default one."""
    return _split_upstream(value)[1]


def _upstream_text(item: Any) -> str:
    """A server entry as the user writes it, whatever form it has in the file."""
    if isinstance(item, dict):
        port = item.get("port")
        address = str(item.get("address") or "")
        return f"{address}:{int(port)}" if port and int(port) != LISTENER_PORT else address
    return str(item or "")


def _upstream_problem(value: str, allow_remote: bool = False) -> str:
    """Reason this upstream is unusable, or an empty string when it is fine.

    Only literal addresses are accepted: a hostname would itself need to be
    resolved before the resolver works.

    A loopback or private address is refused by default, because the address
    people type there by mistake is their own home resolver -- which belongs in
    the local-resolvers field instead.  ``allow_remote`` is the user saying
    they meant the other end: every server in this list is asked *through* the
    tunnel, so ``127.0.0.53`` is the exit node's own resolver, not ours.
    """
    text = str(value or "").strip()
    if not text:
        return "пустой адрес"
    if len(text) > 200:
        return "слишком длинный адрес"
    host, port = _split_upstream(text)
    if not host:
        return f"«{text}»: не удалось разобрать адрес"
    if ":" in text and not text.lower().startswith(UPSTREAM_SCHEMES) and not text.startswith("["):
        # One colon and no digits after it is a typo, not an IPv6 literal.
        if text.count(":") == 1 and not port:
            return f"«{text}»: после двоеточия нужен номер порта"
    if port and not (1 <= port <= 65535):
        return f"«{text}»: недопустимый порт"
    try:
        parsed = ipaddress.ip_address(host)
    except ValueError:
        return f"«{text}»: нужен IP-адрес, имя хоста пришлось бы резолвить до запуска DNS"
    if parsed.is_loopback and not allow_remote:
        return (
            f"«{text}»: адрес петли. Если это резолвер на выходном узле, "
            "отметьте «DNS-сервер на стороне выходного узла»"
        )
    if (parsed.is_private or parsed.is_link_local) and not allow_remote:
        return (
            f"«{text}»: локальный адрес. Домашний резолвер укажите в поле "
            "локальных DNS; резолвер на выходном узле — отметьте галочкой"
        )
    # ``::1`` counts as reserved as well as loopback; the loopback answer
    # above is the one that fits it, so it must not be condemned here.
    if parsed.is_multicast or parsed.is_unspecified or (parsed.is_reserved and not parsed.is_loopback):
        return f"«{text}»: адрес нельзя использовать как DNS-сервер"
    return ""


def normalize_upstreams(value: Any) -> list[str]:
    """Accept a list or a comma/space separated string, keeping order.

    A list read back from a fragment may hold server objects rather than
    strings -- that is how a port is written -- so those are folded back into
    the text form the user typed.
    """
    if isinstance(value, (list, tuple, set)):
        parts = [_upstream_text(item) for item in value]
    else:
        parts = re.split(r"[,;\s]+", str(value or ""))
    result: list[str] = []
    for part in parts:
        text = part.strip()
        if text and text not in result:
            result.append(text)
    return result


def validate_upstreams(value: Any, allow_remote: bool = False) -> list[str]:
    """Normalize and check upstreams, falling back to the default when empty."""
    upstreams = normalize_upstreams(value)
    if not upstreams:
        return list(DEFAULT_UPSTREAMS)
    if len(upstreams) > MAX_UPSTREAMS:
        raise DnsOverVlessError(
            f"Слишком много DNS-серверов: не больше {MAX_UPSTREAMS}.",
            code="upstreams_invalid",
        )
    problems = [
        problem
        for problem in (_upstream_problem(item, allow_remote) for item in upstreams)
        if problem
    ]
    if problems:
        raise DnsOverVlessError(
            "Проверьте список DNS-серверов: " + "; ".join(problems) + ".",
            code="upstreams_invalid",
            details={"problems": problems},
        )
    return upstreams


def _safe_upstreams(value: Any, allow_remote: bool = True) -> Optional[list[str]]:
    """Same check without raising: ``None`` when the list is not usable.

    Reading is permissive on purpose.  This is used to read back what is
    already written -- in the fragment or in this install's own notes -- and
    that was checked when it was written; refusing it now would report a
    config the panel wrote itself as edited by somebody else.
    """
    try:
        upstreams = normalize_upstreams(value)
        if not upstreams or len(upstreams) > MAX_UPSTREAMS:
            return None
        if any(_upstream_problem(item, allow_remote) for item in upstreams):
            return None
        return upstreams
    except Exception:
        return None


def _address_is_ours(parsed: Any) -> bool:
    """Does this address belong to the machine the panel runs on?

    The listener binds every interface, so a resolver at the router's own LAN
    address loops just as surely as one at 127.0.0.1.  Binding a throwaway
    socket is the cheapest honest answer: it succeeds only for an address that
    is actually assigned here.  When the probe cannot run we stay permissive —
    refusing a legitimate resolver would be worse than missing a loop.
    """
    if parsed.is_loopback:
        return True
    family = socket.AF_INET6 if parsed.version == 6 else socket.AF_INET
    try:
        with socket.socket(family, socket.SOCK_DGRAM) as probe:
            probe.bind((str(parsed), 0))
        return True
    except OSError:
        return False
    except Exception:
        return False


def _parse_local_resolver(value: Any) -> Optional[Dict[str, Any]]:
    """Parse ``address`` or ``address:port`` for the LAN-side resolver.

    Unlike an upstream this one is *meant* to be a private address: it points
    at whatever still answers local names on the router or in the network.
    """
    text = str(value or "").strip()
    if not text:
        return None
    host, port = text, 53
    if text.startswith("["):
        host, _, tail = text[1:].partition("]")
        if tail.startswith(":"):
            port = int(tail[1:] or 53)
    elif text.count(":") == 1:
        host, _, raw_port = text.partition(":")
        try:
            port = int(raw_port)
        except ValueError:
            raise DnsOverVlessError(
                f"«{text}»: порт локального DNS должен быть числом.",
                code="local_resolver_invalid",
            )
    try:
        parsed = ipaddress.ip_address(host)
    except ValueError:
        raise DnsOverVlessError(
            f"«{text}»: укажите IP-адрес локального DNS, имя хоста здесь не подойдёт.",
            code="local_resolver_invalid",
        )
    if not (1 <= port <= 65535):
        raise DnsOverVlessError(f"«{text}»: недопустимый порт.", code="local_resolver_invalid")
    if parsed.is_multicast or parsed.is_unspecified or parsed.is_reserved:
        raise DnsOverVlessError(
            f"«{text}»: адрес нельзя использовать как DNS-сервер.",
            code="local_resolver_invalid",
        )
    if port == LISTENER_PORT and _address_is_ours(parsed):
        raise DnsOverVlessError(
            f"«{text}»: по этому адресу отвечает сам DNS-over-VLESS — запрос вернулся бы к нему же "
            "и зациклился. Домашние имена знает резолвер прошивки, он слушает на другом порту: "
            "127.0.0.1:41100, и дальше по одному порту на политику доступа.",
            code="local_resolver_loop",
        )
    return {"address": str(parsed), "port": port}


LOCAL_DOMAIN_PREFIXES = ("domain:", "full:", "keyword:", "regexp:", "geosite:", "ext:")


def _normalize_local_domain(value: str) -> str:
    """Make a zone entry explicit.

    A bare string is a *substring* match for Xray: ``lan`` would also catch
    ``atlantic.com`` and quietly send it to the LAN resolver.  Prefix anything
    unqualified with ``domain:`` so it matches the zone and its subdomains.
    """
    text = str(value or "").strip().lower().strip(".")
    if not text:
        return ""
    if text.startswith(LOCAL_DOMAIN_PREFIXES):
        head, _, tail = text.partition(":")
        return f"{head}:{tail.strip()}" if tail.strip() else ""
    return "domain:" + text


def _parse_resolver_list(value: Any, *, limit: int, noun: str, code: str) -> list[Dict[str, Any]]:
    """Parse one or several resolvers — a network can have segments, each with
    its own server, and they are asked in the order given."""
    if value is None or value == "":
        return []
    result: list[Dict[str, Any]] = []
    for item in normalize_upstreams(value):
        parsed = _parse_local_resolver(item)
        if parsed and parsed not in result:
            result.append(parsed)
    if len(result) > limit:
        raise DnsOverVlessError(f"Слишком много {noun}: не больше {limit}.", code=code)
    return result


def _parse_local_resolvers(value: Any) -> list[Dict[str, Any]]:
    return _parse_resolver_list(
        value, limit=MAX_LOCAL_RESOLVERS, noun="локальных DNS", code="local_resolver_invalid"
    )


def _parse_direct_resolvers(value: Any) -> list[Dict[str, Any]]:
    return _parse_resolver_list(
        value, limit=MAX_DIRECT_RESOLVERS, noun="прямых DNS", code="direct_resolver_invalid"
    )


def _direct_domains(value: Any) -> list[str]:
    """Domains resolved past the tunnel.  Empty means the feature is off: there
    is no sensible default list, it mirrors the user's own routing rules."""
    if value is None or value == "":
        return []
    result: list[str] = []
    for item in normalize_upstreams(value):
        normalized = _normalize_local_domain(item)
        if normalized and normalized not in result:
            result.append(normalized)
    if len(result) > MAX_DIRECT_DOMAINS:
        raise DnsOverVlessError(
            f"Слишком много доменов мимо туннеля: не больше {MAX_DIRECT_DOMAINS}.",
            code="direct_domains_invalid",
        )
    return result


def _resolver_label(resolver: Dict[str, Any]) -> str:
    return "%s:%s" % (resolver["address"], resolver.get("port") or 53)


def _local_domains(value: Any) -> list[str]:
    """Zone list for the LAN resolvers: defaults when empty, otherwise yours.

    The list itself is free-form — a home network may use any private zone —
    so nothing here restricts *which* zones you add, only how many.
    """
    if value is None or value == "":
        return list(DEFAULT_LOCAL_DOMAINS)
    result: list[str] = []
    for item in normalize_upstreams(value):
        normalized = _normalize_local_domain(item)
        if normalized and normalized not in result:
            result.append(normalized)
    if len(result) > MAX_LOCAL_DOMAINS:
        raise DnsOverVlessError(
            f"Слишком много локальных зон: не больше {MAX_LOCAL_DOMAINS}.",
            code="local_domains_invalid",
        )
    return result or list(DEFAULT_LOCAL_DOMAINS)


def _split_local_zones(zones: list[str]) -> tuple[list[str], list[str]]:
    """Zones that must stay home, and zones a public resolver may answer."""
    strict = [zone for zone in zones if zone in STRICT_LOCAL_ZONES]
    delegated = [zone for zone in zones if zone not in STRICT_LOCAL_ZONES]
    return strict, delegated


def _local_server(resolver: Dict[str, Any], domains: list[str], *, skip_fallback: bool) -> Dict[str, Any]:
    return {
        "address": resolver["address"],
        "port": int(resolver.get("port") or 53),
        "domains": domains,
        "skipFallback": skip_fallback,
    }


def _dns_listener() -> Dict[str, Any]:
    """The listener that takes over port 53.

    Nothing is rewritten here.  The pass-through does need the destination
    replaced -- a client that asks the router itself aims at a private address,
    which means nothing on the far side of the tunnel -- but doing it in the
    listener would move the destination *port* too, and the capture rule below
    matches by port.  A resolver on 443 or 853 would then drag every connection
    to that port into the DNS outbound.  The DNS outbound rewrites the
    destination itself, after routing, where no such collision is possible.
    """
    return {
        "tag": LISTENER_TAG,
        "protocol": "dokodemo-door",
        "port": LISTENER_PORT,
        "settings": {"network": "tcp,udp"},
    }


def _dns_outbound(pass_node: str = "", upstreams: Optional[list[str]] = None) -> Dict[str, Any]:
    """The DNS outbound, optionally letting the other record types through.

    Xray's built-in DNS answers A and AAAA and nothing else: MX, TXT, SRV,
    HTTPS, NS and SOA come back as ``NOERROR`` with no records, which a client
    reads as "no such record" and does not retry.  ``nonIPQuery: "skip"`` hands
    those queries on untouched instead, and ``proxySettings`` decides where
    they go -- without it they would leave in the clear.  A balancer cannot be
    named there (Xray looks for an outbound handler and fails to start), so
    these types ride exactly one node.
    """
    outbound: Dict[str, Any] = {"tag": DNS_OUT_TAG, "protocol": "dns"}
    if pass_node:
        settings: Dict[str, Any] = {"nonIPQuery": "skip"}
        # Where a skipped query goes: the address the client aimed at is
        # useless once it leaves the tunnel, so the first DNS server of the
        # list takes its place, port included.
        chosen = list(upstreams or DEFAULT_UPSTREAMS)[0]
        host, port = _split_upstream(chosen)
        settings["address"] = host or DEFAULT_UPSTREAMS[0]
        if port and port != LISTENER_PORT:
            settings["port"] = port
        outbound["settings"] = settings
        outbound["proxySettings"] = {"tag": pass_node}
    return outbound


def _managed_fragment(
    upstreams: Optional[list[str]] = None,
    local_resolvers: Optional[list[Dict[str, Any]]] = None,
    local_domains: Optional[list[str]] = None,
    direct_resolvers: Optional[list[Dict[str, Any]]] = None,
    direct_domains: Optional[list[str]] = None,
    pass_node: str = "",
) -> Dict[str, Any]:
    servers: list[Any] = []
    resolvers = list(local_resolvers or [])
    zones = list(local_domains or DEFAULT_LOCAL_DOMAINS)
    public_upstreams = list(upstreams or DEFAULT_UPSTREAMS)
    strict_zones, delegated_zones = _split_local_zones(zones)
    # Listed before the public upstreams so local zones are matched first.
    # skipFallback keeps a missing home name from being retried abroad; with
    # several segments Xray still tries the next local server.
    for resolver in resolvers:
        if strict_zones:
            servers.append(_local_server(resolver, strict_zones, skip_fallback=True))
    # Delegated zones (vendor domains, anything the user added) are real public
    # names: if every local resolver stays silent, the query has to reach a
    # public upstream instead of failing.
    for resolver in resolvers:
        if delegated_zones:
            servers.append(_local_server(resolver, delegated_zones, skip_fallback=False))
    # Domains routed past the tunnel: asked of the resolvers the user picked,
    # in order, and a miss still reaches a public upstream through VLESS rather
    # than leaving the name unresolved.
    bypass = list(direct_resolvers or [])
    bypass_zones = list(direct_domains or [])
    for resolver in bypass:
        if bypass_zones:
            servers.append(_local_server(resolver, bypass_zones, skip_fallback=False))
    # A server without a port stays a plain string, exactly as it has always
    # been written: an installation configured earlier must keep byte-identical
    # config.  A port can only be said in the object form.
    for item in public_upstreams:
        host, port = _split_upstream(item)
        if port and port != LISTENER_PORT:
            servers.append({"address": host, "port": port})
        else:
            # A spelled-out ``:53`` is the default said out loud; dropping it
            # keeps one written form per server, so the read-back matches.
            servers.append(host if port else item)
    public_count = len(public_upstreams)
    needs_fallback = bool(resolvers and delegated_zones) or bool(bypass and bypass_zones)
    return {
        "dns": {
            # Explicit public upstreams; the DNS outbound carries these UDP
            # requests through the selected VLESS route.
            "servers": servers,
            "queryStrategy": "UseIP",
            # A single upstream has nothing to fall back to, and forbidding the
            # fallback keeps Xray from trying anything else.  With several,
            # falling back to the next one is the reason they were listed.
            # The flag is global, so it also decides whether a delegated zone
            # may leave a silent local resolver for a public one: when such a
            # server exists, the fallback has to stay on even with one upstream.
            "disableFallback": public_count < 2 and not needs_fallback,
            "tag": DNS_IN_TAG,
        },
        "inbounds": [_dns_listener()],
        "outbounds": [_dns_outbound(pass_node, public_upstreams)],
    }


def _owned_rule(rule: Any) -> bool:
    return isinstance(rule, dict) and _clean_tag(rule.get("ruleTag")) in {
        PROXY_RULE_TAG,
        CAPTURE_RULE_TAG,
        LOCAL_RULE_TAG,
        DIRECT_RULE_TAG,
    }


def _direct_outbound_tag(runtime: Dict[str, Any]) -> str:
    """Tag of a freedom outbound, i.e. the one that leaves the tunnel."""
    for item in runtime.get("outbounds", []):
        if _clean_tag(item.get("protocol")).lower() == "freedom":
            return _clean_tag(item.get("tag"))
    return ""


def _bypass_rule(
    resolvers: Optional[list[Dict[str, Any]]], direct_tag: str, rule_tag: str
) -> Optional[Dict[str, Any]]:
    """Send queries aimed at these resolvers straight out, never via VLESS."""
    items = list(resolvers or [])
    if not items or not direct_tag:
        return None
    addresses = []
    for resolver in items:
        address = str(resolver["address"])
        addresses.append(address + ("/128" if ":" in address else "/32"))
    return {
        "type": "field",
        "inboundTag": [DNS_IN_TAG],
        "ip": addresses,
        "outboundTag": direct_tag,
        "ruleTag": rule_tag,
    }


def _domains_routed_direct(runtime: Dict[str, Any], routing: Dict[str, Any]) -> list[str]:
    """Domains the user's own rules already send past the tunnel.

    Offered to the card as a starting list: the whole point of resolving them
    directly is that they are routed directly, so keeping a second copy of the
    list by hand would only let the two drift apart.
    """
    direct_tag = _direct_outbound_tag(runtime)
    if not direct_tag:
        return []
    model = routing.get("routing") if isinstance(routing.get("routing"), dict) else {}
    rules = model.get("rules") if isinstance(model.get("rules"), list) else []
    result: list[str] = []
    for rule in rules:
        if not isinstance(rule, dict) or _owned_rule(rule):
            continue
        if _clean_tag(rule.get("outboundTag")) != direct_tag:
            continue
        for item in rule.get("domain") or []:
            value = _normalize_local_domain(item)
            if value and value not in result and len(result) < MAX_DIRECT_DOMAINS:
                result.append(value)
    return result


def _local_rule(
    resolvers: Optional[list[Dict[str, Any]]], direct_tag: str
) -> Optional[Dict[str, Any]]:
    return _bypass_rule(resolvers, direct_tag, LOCAL_RULE_TAG)


def _direct_rule(
    resolvers: Optional[list[Dict[str, Any]]], direct_tag: str
) -> Optional[Dict[str, Any]]:
    return _bypass_rule(resolvers, direct_tag, DIRECT_RULE_TAG)


def _capture_rule() -> Dict[str, Any]:
    """The rule that hands the intercepted queries to the built-in DNS.

    It catches port 53 wherever it is aimed, which is what pulls in the devices
    carrying a hard-wired public resolver of their own.  Nothing else may be
    added to that port list: every connection to the added port would be
    swallowed by the DNS outbound along with the queries.
    """
    return {
        "type": "field",
        "network": "tcp,udp",
        "port": "53",
        "outboundTag": DNS_OUT_TAG,
        "ruleTag": CAPTURE_RULE_TAG,
    }


def _build_enabled_routing(
    routing: Dict[str, Any],
    target: Dict[str, Any],
    local_rule: Optional[Dict[str, Any]] = None,
    direct_rule: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
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
    capture_rule = _capture_rule()
    # The bypass rules must be matched before the proxy rule, otherwise the
    # query for a home name would already be on its way through the tunnel.
    ordered = [item for item in (local_rule, direct_rule) if item]
    ordered.extend([proxy_rule, capture_rule])
    model["rules"] = [*ordered, *rules]

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


def _rebuild_local_rule(
    routing: Dict[str, Any],
    local_rule: Optional[Dict[str, Any]],
    direct_rule: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Replace our bypass rules in place, leaving the other managed rules alone."""
    result = copy.deepcopy(routing if isinstance(routing, dict) else {})
    model = result.get("routing")
    if not isinstance(model, dict):
        return result
    rules = [
        item
        for item in (model.get("rules") if isinstance(model.get("rules"), list) else [])
        if not (
            isinstance(item, dict)
            and _clean_tag(item.get("ruleTag")) in {LOCAL_RULE_TAG, DIRECT_RULE_TAG}
        )
    ]
    model["rules"] = [item for item in (local_rule, direct_rule) if item] + rules
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
    # The upstream list is user-configurable, so compare against a fragment
    # rebuilt from the servers this file declares: anything else that differs
    # (extra inbound, changed queryStrategy, wrong disableFallback) is caught.
    raw_servers = ((fragment or {}).get("dns") or {}).get("servers")
    raw_servers = raw_servers if isinstance(raw_servers, list) else []
    # The optional local resolvers are objects and always come first; the
    # public upstreams are plain strings after them.  One resolver may take two
    # entries — strict zones and delegated ones are declared separately — so
    # fold them back by address before rebuilding.
    # Objects in this list mean two different things: a local or bypass
    # resolver always names the zones it answers for, a public server with a
    # port names none.  That is the only difference, and it is enough.
    local_objs = [
        item
        for item in raw_servers
        if isinstance(item, dict) and item.get("address") and item.get("domains")
    ]
    declared = _safe_upstreams(
        [
            _upstream_text(item)
            for item in raw_servers
            if not (isinstance(item, dict) and item.get("domains"))
        ]
    )
    declared_resolvers: list[Dict[str, Any]] = []
    declared_zones: Dict[tuple[str, int], list[str]] = {}
    for item in local_objs:
        key = (str(item.get("address") or ""), int(item.get("port") or 53))
        if key not in declared_zones:
            declared_zones[key] = []
            declared_resolvers.append({"address": key[0], "port": key[1]})
        for zone in item.get("domains") or []:
            if zone not in declared_zones[key]:
                declared_zones[key].append(zone)
    model = routing.get("routing") if isinstance(routing.get("routing"), dict) else {}
    rules = model.get("rules") if isinstance(model.get("rules"), list) else []
    proxy_rule_obj = next((item for item in rules if _clean_tag(item.get("ruleTag")) == PROXY_RULE_TAG), None)
    local_rule_obj = next((item for item in rules if _clean_tag(item.get("ruleTag")) == LOCAL_RULE_TAG), None)
    direct_rule_obj = next((item for item in rules if _clean_tag(item.get("ruleTag")) == DIRECT_RULE_TAG), None)
    # Both groups are objects in the same ``servers`` list, and their zones may
    # legitimately look alike.  What tells them apart is the rule that sends
    # their traffic out: the bypass rule names exactly the addresses of its own
    # group, so the split comes from there rather than from guesswork.
    bypass_addresses = {
        str(value).split("/")[0].strip()
        for value in ((direct_rule_obj or {}).get("ip") or [])
        if str(value).strip()
    }
    local_declared = [item for item in declared_resolvers if item["address"] not in bypass_addresses]
    direct_declared = [item for item in declared_resolvers if item["address"] in bypass_addresses]

    def _zones_of(items: list[Dict[str, Any]]) -> Optional[list[str]]:
        for item in items:
            zones = declared_zones.get((item["address"], int(item["port"] or 53)))
            if zones:
                return zones
        return None

    # Whether the other record types are let through is written in the DNS
    # outbound itself, so read it back from there rather than from the panel's
    # own notes: a config the user edited by hand then reads as drift, which is
    # what it is.  Half of the pair (one key without the other) is not a
    # fragment this panel would write, so it reads back as no pass-through and
    # the comparison below reports the difference.
    declared_pass = ""
    first_outbound = next(iter((fragment or {}).get("outbounds") or []), None)
    if isinstance(first_outbound, dict):
        settings = first_outbound.get("settings")
        proxy_settings = first_outbound.get("proxySettings")
        if (
            isinstance(settings, dict)
            and settings.get("nonIPQuery") == "skip"
            and isinstance(proxy_settings, dict)
        ):
            declared_pass = _clean_tag(proxy_settings.get("tag"))
    exact_fragment = bool(declared) and fragment == _managed_fragment(
        declared,
        local_declared,
        _zones_of(local_declared),
        direct_declared,
        _zones_of(direct_declared),
        declared_pass,
    )
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
    # The local rule is optional; when present it must be exactly the one we
    # would build for the resolver this fragment declares.
    expected_local = (
        _local_rule(local_declared, _direct_outbound_tag(runtime)) if local_declared else None
    )
    safe_local_rule = (local_rule_obj is None) or (
        expected_local is not None and local_rule_obj == expected_local
    )
    expected_direct = (
        _direct_rule(direct_declared, _direct_outbound_tag(runtime)) if direct_declared else None
    )
    safe_direct_rule = (direct_rule_obj is None) or (
        expected_direct is not None and direct_rule_obj == expected_direct
    )
    safe_capture_rule = capture_rule_obj == _capture_rule()
    return {
        "fragment": exact_fragment,
        "fragment_owned": os.path.isfile(managed_path),
        "proxy_rule": safe_proxy_rule,
        "proxy_rule_owned": proxy_rule_obj is not None,
        "capture_rule": safe_capture_rule,
        "capture_rule_owned": capture_rule_obj is not None,
        "local_rule": safe_local_rule,
        "local_rule_owned": local_rule_obj is not None,
        "direct_rule": safe_direct_rule,
        "direct_rule_owned": direct_rule_obj is not None,
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
        for key in (
            "fragment_owned",
            "proxy_rule_owned",
            "capture_rule_owned",
            "local_rule_owned",
            "direct_rule_owned",
            "balancer_owned",
        )
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
            ("local_rule_owned", "local_rule"),
            ("direct_rule_owned", "direct_rule"),
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


def _write_routing_preserving_comments(
    path: str, obj: Dict[str, Any], *, managed: bool = True
) -> None:
    """Write routing, keeping the user's own JSONC comments attached to rules.

    ``managed`` says whether this write leaves the feature switched on.  On the
    way out the header must not be written again -- it used to be, and the line
    then stayed in the file as if the user had put it there, outliving the
    feature it described.  It is still named as ours so the old one is dropped
    rather than kept as somebody's comment.
    """
    # Reuse the same semantic JSONC comment preservation path as subscription
    # routing sync. This keeps user comments attached to their rules.
    from services.xray_subscriptions import _write_jsonc_sidecar_if_changed

    _write_jsonc_sidecar_if_changed(
        path,
        obj,
        header=MANAGED_JSONC_HEADER if managed else "",
        drop_header=MANAGED_JSONC_HEADER,
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

    # The captured devices come back to the firmware first.  A rule that sends
    # them to a port Xray no longer holds leaves them without DNS at all --
    # worse than the interception this feature undoes.
    try:
        steps.append("capture_removed" if dns_client_capture.remove() else "capture_absent")
    except Exception as exc:  # noqa: BLE001
        steps.append(f"capture_failed:{exc}")

    try:
        _write_routing_preserving_comments(
            routing_file, _build_disabled_routing(routing), managed=False
        )
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


# The health check, the restart budget and the release live in
# ``services.dns_guard`` now: both DNS assistants take port 53 the same way,
# so one guard watches whichever of them is on instead of this module
# assuming Xray is the only core that can answer.  ``_emergency_release``
# above stays here because only this module knows how to undo its own
# fragment and routing.


def reapply_client_capture(*, ui_state_dir: str) -> Dict[str, Any]:
    """Put the capture chain back the way this install asked for it.

    The firmware rebuilds its own firewall chains whenever policies or
    interfaces change, and our jump can end up below the redirect it is meant
    to precede -- where it is decoration.  The guard calls this on every
    healthy tick, so it has to be cheap when there is nothing to do.
    """
    state = _load_state(ui_state_dir)
    if not state.get("enabled"):
        return {"ok": True, "changed": False, "macs": []}
    wanted = _safe_capture_macs(state.get("capture_macs")) if state.get("capture_clients") else []
    return dns_client_capture.ensure(wanted)


def _safe_capture_macs(value: Any) -> list[str]:
    """Read back the chosen devices without raising on a hand-edited file."""
    try:
        return dns_client_capture.normalize_macs(value)
    except dns_client_capture.CaptureError:
        return []


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
    upstreams = _safe_upstreams(state.get("upstreams")) or list(DEFAULT_UPSTREAMS)
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
        "upstreams": upstreams,
        "default_upstreams": list(DEFAULT_UPSTREAMS),
        # Whether the DNS servers above live on the far side of the tunnel.
        "upstreams_remote": bool(state.get("upstreams_remote")),
        # Devices brought back with a rule of our own, and what the firewall
        # actually holds -- the two can differ after the firmware rebuilds its
        # chains, and the window has to say so rather than repeat the setting.
        "capture_clients": bool(state.get("capture_clients")),
        "capture_macs": _safe_capture_macs(state.get("capture_macs")),
        "capture_rule_state": dns_client_capture.status() if enabled else None,
        "max_capture_clients": dns_client_capture.MAX_CAPTURE_CLIENTS,
        "default_remote_upstream": DEFAULT_REMOTE_UPSTREAM,
        "max_upstreams": MAX_UPSTREAMS,
        "local_resolvers": (
            state.get("local_resolvers") if isinstance(state.get("local_resolvers"), list) else []
        ),
        "max_local_resolvers": MAX_LOCAL_RESOLVERS,
        "local_domains": (
            state.get("local_domains")
            if isinstance(state.get("local_domains"), list)
            else list(DEFAULT_LOCAL_DOMAINS)
        ),
        "default_local_domains": list(DEFAULT_LOCAL_DOMAINS),
        "zone_presets": {name: list(zones) for name, zones in ZONE_PRESETS.items()},
        "max_local_domains": MAX_LOCAL_DOMAINS,
        "direct_resolvers": (
            state.get("direct_resolvers") if isinstance(state.get("direct_resolvers"), list) else []
        ),
        "max_direct_resolvers": MAX_DIRECT_RESOLVERS,
        "direct_domains": (
            state.get("direct_domains") if isinstance(state.get("direct_domains"), list) else []
        ),
        "max_direct_domains": MAX_DIRECT_DOMAINS,
        # Domains the user already sends past the tunnel: the card offers them
        # as a starting list so nobody keeps two copies of it in sync by hand.
        "direct_rule_domains": _domains_routed_direct(runtime, routing),
        "direct_outbound": _direct_outbound_tag(runtime),
        # The other record types: whether they are let through, on which node,
        # and which nodes the chosen route could hand them to.
        "pass_non_ip": bool(state.get("pass_non_ip")),
        "pass_non_ip_node": _clean_tag(state.get("pass_non_ip_node")),
        "pass_non_ip_options": _pass_node_options(
            runtime, routing, _stored_selection(state)
        ),
        "route_drift": drift,
        "watchdog": state.get("watchdog") if isinstance(state.get("watchdog"), dict) else None,
        # The card explains what guards the feature, so it needs the values that
        # are actually in force — defaults or environment overrides alike.
        "watchdog_settings": watchdog_settings(),
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
    upstreams: Any = None,
    local_resolver: Any = None,
    local_domains: Any = None,
    direct_resolver: Any = None,
    direct_domains: Any = None,
    pass_non_ip: Any = None,
    pass_non_ip_node: Any = None,
    upstreams_remote: Any = None,
    capture_clients: Any = None,
    capture_macs: Any = None,
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
        stored_state = _load_state(ui_state_dir)
        # An explicit request wins; otherwise keep what this install chose.
        # An address on the far side of the tunnel is only allowed when the
        # user says that is what they meant.
        wanted_remote = (
            bool(upstreams_remote)
            if upstreams_remote is not None
            else bool(stored_state.get("upstreams_remote"))
        )
        wanted_upstreams = (
            validate_upstreams(upstreams, wanted_remote)
            if upstreams is not None
            else (_safe_upstreams(stored_state.get("upstreams")) or list(DEFAULT_UPSTREAMS))
        )
        wanted_local = (
            _parse_local_resolvers(local_resolver)
            if local_resolver is not None
            else _parse_local_resolvers(stored_state.get("local_resolvers"))
        )
        wanted_local_domains = (
            _local_domains(local_domains)
            if local_domains is not None
            else _local_domains(stored_state.get("local_domains"))
        )
        wanted_direct = (
            _parse_direct_resolvers(direct_resolver)
            if direct_resolver is not None
            else _parse_direct_resolvers(stored_state.get("direct_resolvers"))
        )
        wanted_direct_domains = (
            _direct_domains(direct_domains)
            if direct_domains is not None
            else _direct_domains(stored_state.get("direct_domains"))
        )
        # Devices whose DNS the firmware takes away can be brought back with a
        # rule of our own.  The switch and the list are separate on purpose:
        # with the switch off no chain is created at all, so a checkbox left
        # ticked by accident changes nothing in the firewall.
        wanted_capture = (
            bool(capture_clients)
            if capture_clients is not None
            else bool(stored_state.get("capture_clients"))
        )
        try:
            wanted_capture_macs = dns_client_capture.normalize_macs(
                capture_macs if capture_macs is not None else stored_state.get("capture_macs")
            )
        except dns_client_capture.CaptureError as exc:
            raise DnsOverVlessError(str(exc), code="capture_clients_invalid")
        if wanted_capture and not wanted_capture_macs:
            raise DnsOverVlessError(
                "Отметьте устройства, DNS которых нужно завести в туннель, "
                "или выключите переключатель.",
                code="capture_clients_empty",
            )

        # An omitted switch keeps what this install already chose.
        wanted_pass = (
            bool(pass_non_ip)
            if pass_non_ip is not None
            else bool(stored_state.get("pass_non_ip"))
        )
        wanted_pass_node = ""
        if wanted_pass:
            wanted_pass_node = _pick_pass_node(
                pass_non_ip_node,
                stored_state.get("pass_non_ip_node"),
                runtime,
                routing,
                normalize_target_request(target_tag) or _stored_selection(stored_state),
            )
        # Half a setting resolves nothing: without domains the resolvers are
        # never consulted, without resolvers the domains have nowhere to go.
        if bool(wanted_direct) != bool(wanted_direct_domains):
            raise DnsOverVlessError(
                "Для доменов мимо туннеля укажите и адреса DNS, и список доменов.",
                code="direct_incomplete",
            )
        # Both groups live in one ``servers`` list and are told apart on read-back
        # by the addresses named in the bypass rule — by address alone, port and
        # zones do not enter into it.  An address in both groups therefore reads
        # back as one group only, and the panel would report drift against a
        # config that is in fact exactly what it wrote.
        shared_resolvers = sorted(
            {item["address"] for item in wanted_local} & {item["address"] for item in wanted_direct}
        )
        if shared_resolvers:
            raise DnsOverVlessError(
                "Адрес " + ", ".join(shared_resolvers) + " указан и для домашних имён, и для доменов "
                "мимо туннеля. Панель различает эти группы по адресам, поэтому один и тот же адрес "
                "в обеих сделал бы настройку нечитаемой — оставьте его в одной.",
                code="resolver_group_overlap",
            )
        direct_tag = _direct_outbound_tag(runtime)
        if (wanted_local or wanted_direct) and not direct_tag:
            raise DnsOverVlessError(
                "Не найден outbound прямого подключения (freedom) — локальные зоны некуда направить.",
                code="direct_outbound_missing",
            )
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
        capture_result: Dict[str, Any] = {
            "enabled": wanted_capture,
            "clients": len(wanted_capture_macs) if wanted_capture else 0,
            "changed": False,
            "error": "",
        }

        try:
            if normalized == "enable":
                presence = _managed_presence(configs_dir, routing)
                current_fragment = _read_json(managed_path, None)
                current_upstreams = _safe_upstreams(
                    ((current_fragment or {}).get("dns") or {}).get("servers")
                )
                expected_fragment = _managed_fragment(
                    wanted_upstreams,
                    wanted_local,
                    wanted_local_domains,
                    wanted_direct,
                    wanted_direct_domains,
                    wanted_pass_node,
                )
                if _managed_config_complete(presence) and current_fragment == expected_fragment:
                    # Idempotent recovery path: configuration is already
                    # prepared, so only revalidate it and claim DNS override.
                    target = None
                    next_routing = routing
                    next_fragment = current_fragment
                elif _managed_config_complete(presence):
                    # Same route, new DNS settings: rewrite the fragment and
                    # re-lay our own rules so the local rule matches it.
                    target = None
                    next_routing = _rebuild_local_rule(
                        routing,
                        _local_rule(wanted_local, direct_tag),
                        _direct_rule(wanted_direct, direct_tag),
                    )
                    next_fragment = expected_fragment
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
                    next_routing = _build_enabled_routing(
                        routing,
                        target,
                        _local_rule(wanted_local, direct_tag),
                        _direct_rule(wanted_direct, direct_tag),
                    )
                    next_fragment = expected_fragment
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
                # The captured devices go back to the firmware before the port
                # changes hands: a rule pointing at a port Xray has left would
                # leave them without DNS at all.
                try:
                    capture_result["changed"] = dns_client_capture.remove()
                except Exception as exc:  # noqa: BLE001 - reported, never fatal
                    capture_result["error"] = str(exc)
                try:
                    os.remove(managed_path)
                except FileNotFoundError:
                    pass
                _write_routing_preserving_comments(routing_file, next_routing, managed=False)

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
                # Only now, with Xray answering, may devices be pointed at it.
                # A failure here is reported rather than rolled back: the
                # feature itself is already working for everyone else, and the
                # window shows the state of the rule separately.
                try:
                    result = dns_client_capture.ensure(
                        wanted_capture_macs if wanted_capture else []
                    )
                    capture_result["changed"] = bool(result.get("changed"))
                except Exception as exc:  # noqa: BLE001 - reported to the window
                    capture_result["error"] = str(exc)
                    try:
                        dns_client_capture.remove()
                    except Exception:  # noqa: BLE001 - nothing more to try
                        pass

            if normalized == "enable":
                _save_state(
                    ui_state_dir,
                    {
                        "version": 1,
                        "enabled": True,
                        "enabled_at": int(time.time()),
                        "original_dns_override": original_override_for_state,
                        "upstreams": wanted_upstreams,
                        "local_resolvers": [_resolver_label(item) for item in wanted_local],
                        "local_domains": wanted_local_domains if wanted_local else None,
                        "direct_resolvers": [_resolver_label(item) for item in wanted_direct],
                        "direct_domains": wanted_direct_domains if wanted_direct else None,
                        "upstreams_remote": wanted_remote,
                        "pass_non_ip": wanted_pass,
                        "pass_non_ip_node": wanted_pass_node,
                        "capture_clients": wanted_capture,
                        "capture_macs": wanted_capture_macs,
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
                "capture": capture_result,
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
