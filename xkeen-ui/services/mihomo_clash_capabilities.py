"""Capability matrix and rollout flags for the Mihomo Clash facade.

The matrix is deliberately data-only.  It describes what a core version is
expected to expose; runtime probing is separate and never guesses a successful
mutation.  This lets the panel distinguish an old core from a temporarily
unavailable endpoint while keeping the public capability values small and
backwards compatible (``bool | None``).
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any, Mapping


VERSION_RE = re.compile(r"(?<!\d)v?(\d+)\.(\d+)\.(\d+)(?!\d)", re.IGNORECASE)


@dataclass(frozen=True)
class MihomoCapabilitySpec:
    name: str
    endpoint: str
    method: str
    min_version: tuple[int, int, int] | None
    probe: str | None = None
    mutating: bool = False
    flag: str | None = None


# Version gates are intentionally conservative.  ``None`` means that a
# capability is a Xkeen-side contract (and therefore has no upstream version
# gate).  The endpoint names and methods are part of the checked-in baseline.
MIHOMO_CAPABILITY_MATRIX: tuple[MihomoCapabilitySpec, ...] = (
    MihomoCapabilitySpec("traffic", "/traffic", "GET", (1, 18, 0), "traffic", flag="traffic"),
    MihomoCapabilitySpec("dns_query", "/dns/query", "GET", (1, 18, 0), "dns_query", flag="dns_query"),
    MihomoCapabilitySpec("dns_flush", "/cache/dns/flush", "POST", (1, 18, 0), mutating=True, flag="dns_flush"),
    MihomoCapabilitySpec("fake_ip_flush", "/cache/fakeip/flush", "POST", (1, 18, 0), mutating=True, flag="fake_ip_flush"),
    MihomoCapabilitySpec("rule_counters", "/rules", "GET", (1, 19, 0), "rules", flag="rule_counters"),
    MihomoCapabilitySpec("rules_disable", "/rules/disable", "PATCH", (1, 19, 0), mutating=True, flag="rules_disable"),
    MihomoCapabilitySpec("cache_etag", "xkeen://mihomo-cache", "INTERNAL", None, flag="cache_etag"),
    MihomoCapabilitySpec("telemetry_stream", "/ws/mihomo-clash/telemetry", "WS", None, flag="telemetry_stream"),
)

CAPABILITY_MATRIX_VERSION = 1
CAPABILITY_FLAG_PREFIX = "XKEEN_MIHOMO_"
CAPABILITY_KILL_SWITCH_ENV = "XKEEN_MIHOMO_TELEMETRY_KILL_SWITCH"

# New surfaces are opt-in until the hub/adapter implementations are enabled.
# The existing connections stream is independent and remains available.
DEFAULT_FLAGS: Mapping[str, bool] = {
    "traffic": False,
    "telemetry_stream": False,
    "dns_query": False,
    "dns_flush": False,
    "fake_ip_flush": False,
    "rule_counters": False,
    "rules_disable": False,
    "cache_etag": False,
}


def parse_mihomo_version(value: Any) -> tuple[int, int, int] | None:
    """Parse a semantic ``major.minor.patch`` version from Mihomo output."""

    text = str((value or {}).get("version") if isinstance(value, Mapping) else value or "")
    match = VERSION_RE.search(text)
    if not match:
        return None
    return tuple(int(part) for part in match.groups())


def _env_bool(env: Mapping[str, Any], name: str, default: bool) -> bool:
    raw = env.get(name)
    if raw is None:
        return bool(default)
    value = str(raw).strip().lower()
    if value in {"1", "true", "yes", "on", "y"}:
        return True
    if value in {"0", "false", "no", "off", "n", "-"}:
        return False
    return bool(default)


def mihomo_feature_flags(env: Mapping[str, Any] | None = None) -> dict[str, bool]:
    """Resolve rollout flags and the global telemetry kill-switch."""

    source = os.environ if env is None else env
    flags = {
        name: _env_bool(source, f"{CAPABILITY_FLAG_PREFIX}{name.upper()}_ENABLE", default)
        for name, default in DEFAULT_FLAGS.items()
    }
    if _env_bool(source, CAPABILITY_KILL_SWITCH_ENV, False):
        flags["traffic"] = False
        flags["telemetry_stream"] = False
    return flags


def capability_matrix_payload() -> dict[str, Any]:
    """Return a JSON-safe copy suitable for diagnostics and contract tests."""

    return {
        "version": CAPABILITY_MATRIX_VERSION,
        "schema_version": CAPABILITY_MATRIX_VERSION,
        "capabilities": [
            {
                "name": item.name,
                "endpoint": item.endpoint,
                "method": item.method,
                "min_version": ".".join(str(part) for part in item.min_version)
                if item.min_version
                else None,
                "probe": item.probe,
                "mutating": item.mutating,
                "flag": item.flag,
            }
            for item in MIHOMO_CAPABILITY_MATRIX
        ],
    }


def build_capability_state(
    version_payload: Any,
    *,
    status_ready: bool,
    ws_runtime: bool,
    env: Mapping[str, Any] | None = None,
    runtime_probe: Mapping[str, bool] | None = None,
) -> tuple[dict[str, bool | None], dict[str, dict[str, Any]]]:
    """Build public values plus detailed static/runtime readiness metadata.

    Public values intentionally remain tri-state.  ``None`` means that the
    core version or an optional non-mutating runtime probe is unknown; it is
    never treated as success by the frontend.  Mutating endpoints are not
    probed, so a true value for them requires an explicit feature flag and a
    known compatible version.
    """

    flags = mihomo_feature_flags(env)
    version = parse_mihomo_version(version_payload)
    probes = dict(runtime_probe or {})
    values: dict[str, bool | None] = {}
    details: dict[str, dict[str, Any]] = {}

    for item in MIHOMO_CAPABILITY_MATRIX:
        static_supported: bool | None
        if item.min_version is None:
            static_supported = True
        elif version is None:
            static_supported = None
        else:
            static_supported = version >= item.min_version

        enabled = bool(flags.get(item.name, True))
        if item.name == "telemetry_stream":
            runtime_ready: bool | None = bool(ws_runtime) if status_ready else False
        elif not status_ready:
            runtime_ready = False
        elif item.name in probes:
            runtime_ready = bool(probes[item.name])
        elif item.mutating:
            # Mutations are deliberately not executed as a readiness probe.
            # A known-compatible version is the safe static readiness signal;
            # an explicit probe result (when supplied by an integration
            # harness) still takes precedence above.
            runtime_ready = bool(status_ready and static_supported is True)
        else:
            runtime_ready = None

        if not enabled or static_supported is False or runtime_ready is False:
            public: bool | None = False
        elif static_supported is None or runtime_ready is None:
            public = None
        else:
            public = bool(static_supported and runtime_ready)

        details[item.name] = {
            "endpoint": item.endpoint,
            "method": item.method,
            "min_version": ".".join(str(part) for part in item.min_version)
            if item.min_version
            else None,
            "version": ".".join(str(part) for part in version) if version else None,
            "static_supported": static_supported,
            "runtime_ready": runtime_ready,
            "enabled": enabled,
            "mutating": item.mutating,
            "reason": (
                "disabled"
                if not enabled
                else "old_core"
                if static_supported is False
                else "version_unknown"
                if static_supported is None
                else "runtime_probe_required"
                if runtime_ready is None
                else None
            ),
        }
        values[item.name] = public

    return values, details


def probe_non_mutating_capabilities(
    client: Any,
    *,
    names: tuple[str, ...] = ("traffic", "dns_query", "rule_counters"),
) -> dict[str, bool]:
    """Probe only bounded, read-only endpoints through the allow-listed client.

    DNS probing is skipped unless the client exposes the dedicated method; the
    method validates a fixed ``example.invalid`` name and therefore cannot be
    used as a browser-controlled resolver primitive.
    """

    result: dict[str, bool] = {}
    operation_for_name = {"rule_counters": "rules"}
    for name in names:
        try:
            if name == "dns_query":
                query = getattr(client, "query_dns", None)
                if query is None:
                    continue
                query("example.invalid", "A")
            elif name == "traffic":
                request_traffic = getattr(client, "request_traffic", None)
                if request_traffic is None:
                    continue
                request_traffic()
            else:
                operation = operation_for_name.get(name)
                if not operation:
                    continue
                response = client.request_json(operation)
                if name == "rule_counters":
                    payload = getattr(response, "payload", None)
                    rules = payload.get("rules") if isinstance(payload, Mapping) else None
                    # Merely having /rules is not enough: counters are an
                    # optional ``extra`` contract on at least one rule.
                    result[name] = bool(
                        isinstance(rules, list)
                        and any(
                            isinstance(rule, Mapping)
                            and isinstance(rule.get("extra"), Mapping)
                            and any(key in rule["extra"] for key in ("hitCount", "hitAt", "missCount", "missAt"))
                            for rule in rules[:256]
                        )
                    )
                    continue
        except Exception:
            # Unknown client/fixture failures are not readiness.  Only a
            # normal response proves the endpoint; a sanitized 404 is the
            # explicit unsupported result.
            result[name] = False
        else:
            result[name] = True
    return result


__all__ = [
    "CAPABILITY_KILL_SWITCH_ENV",
    "CAPABILITY_MATRIX_VERSION",
    "DEFAULT_FLAGS",
    "MIHOMO_CAPABILITY_MATRIX",
    "MihomoCapabilitySpec",
    "build_capability_state",
    "capability_matrix_payload",
    "mihomo_feature_flags",
    "parse_mihomo_version",
    "probe_non_mutating_capabilities",
]
