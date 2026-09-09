from __future__ import annotations

import pytest

from services.mihomo_clash_capabilities import (
    build_capability_state,
    capability_matrix_payload,
    mihomo_feature_flags,
)
from services.mihomo_clash_client import (
    MihomoClashClient,
    MihomoClashClientError,
    MihomoClashEndpoint,
)
from services.mihomo_clash_dto import build_mihomo_clash_snapshot_envelope
from services.mihomo_clash_target import MihomoClashTarget


def _client() -> MihomoClashClient:
    return MihomoClashClient(
        MihomoClashTarget(transport="tcp", port=9090, loopback_host="127.0.0.1"),
        endpoints={
            "dns_query": MihomoClashEndpoint("GET", "/dns/query", 1, 1024),
            "rules_disable": MihomoClashEndpoint("PATCH", "/rules/disable", 1, 1024),
        },
    )


def test_stage0_matrix_has_required_optional_surfaces_and_no_arbitrary_paths():
    matrix = capability_matrix_payload()
    names = {item["name"] for item in matrix["capabilities"]}
    assert matrix["schema_version"] == 1
    assert {
        "traffic",
        "telemetry_stream",
        "dns_query",
        "dns_flush",
        "fake_ip_flush",
        "rule_counters",
        "rules_disable",
        "cache_etag",
    } <= names
    assert all(item["endpoint"].startswith(("/", "xkeen://")) for item in matrix["capabilities"])


def test_stage0_telemetry_is_default_and_kill_switch_keeps_legacy_fallback():
    defaults = mihomo_feature_flags({})
    assert defaults["telemetry_stream"] is True
    assert defaults["traffic"] is False

    enabled = mihomo_feature_flags(
        {
            "XKEEN_MIHOMO_TRAFFIC_ENABLE": "1",
            "XKEEN_MIHOMO_TELEMETRY_STREAM_ENABLE": "true",
            "XKEEN_MIHOMO_DNS_QUERY_ENABLE": "1",
        }
    )
    assert enabled["traffic"] is True
    assert enabled["telemetry_stream"] is True
    assert enabled["dns_query"] is True

    killed = mihomo_feature_flags(
        {
            "XKEEN_MIHOMO_TRAFFIC_ENABLE": "1",
            "XKEEN_MIHOMO_TELEMETRY_STREAM_ENABLE": "1",
            "XKEEN_MIHOMO_TELEMETRY_KILL_SWITCH": "1",
        }
    )
    assert killed["traffic"] is False
    assert killed["telemetry_stream"] is False


def test_stage0_capability_state_distinguishes_old_core_and_unknown_runtime():
    values, details = build_capability_state(
        {"version": "Mihomo Meta v1.18.9"},
        status_ready=True,
        ws_runtime=False,
        env={
            "XKEEN_MIHOMO_TRAFFIC_ENABLE": "1",
            "XKEEN_MIHOMO_RULE_COUNTERS_ENABLE": "1",
        },
    )
    assert values["traffic"] is None
    assert details["traffic"]["static_supported"] is True
    assert values["rule_counters"] is False
    assert details["rule_counters"]["static_supported"] is False
    assert values["telemetry_stream"] is False

    enabled_values, enabled_details = build_capability_state(
        {"version": "Mihomo Meta v1.19.12"},
        status_ready=True,
        ws_runtime=False,
        env={
            "XKEEN_MIHOMO_DNS_FLUSH_ENABLE": "1",
            "XKEEN_MIHOMO_FAKE_IP_FLUSH_ENABLE": "1",
            "XKEEN_MIHOMO_RULES_DISABLE_ENABLE": "1",
        },
    )
    assert enabled_values["dns_flush"] is True
    assert enabled_values["fake_ip_flush"] is True
    assert enabled_values["rules_disable"] is True
    assert enabled_details["rules_disable"]["runtime_ready"] is True


def test_dns_query_is_available_for_healthy_vendor_build_without_semver():
    values, details = build_capability_state(
        {"version": "alpha-65287f0"},
        status_ready=True,
        ws_runtime=False,
        env={},
    )
    assert values["dns_query"] is True
    assert details["dns_query"]["static_supported"] is None
    assert details["dns_query"]["runtime_ready"] is True
    # Mutating operations remain conservatively gated until a compatible
    # semver is known, even though their rollout flags default to enabled.
    assert values["dns_flush"] is False
    assert values["fake_ip_flush"] is False


def test_snapshot_envelope_keeps_schema_v1_legacy_fields_and_stale_metadata():
    envelope = build_mihomo_clash_snapshot_envelope(
        {"schema_version": 1, "connections": []},
        stream_type="mihomo-clash-connections",
        sequence=4,
        state="stale",
        stale_since=100,
        source_age_ms=900,
        error={"code": "target_unavailable", "detail": "drop"},
    )
    assert envelope["schema_version"] == 1
    assert envelope["sequence"] == 4
    assert envelope["state"] == "stale"
    assert envelope["payload"]["connections"] == []
    assert envelope["connections"] == []
    assert envelope["stale_since"] == 100
    assert envelope["source_age_ms"] == 900
    assert "secret" not in envelope


@pytest.mark.parametrize("name", ["", "bad name", "-bad.example", "a." + "x" * 64])
def test_dns_query_rejects_invalid_names_before_connecting(name: str):
    with pytest.raises(MihomoClashClientError) as captured:
        _client().query_dns(name)
    assert captured.value.code == "dns_name_invalid"
    assert captured.value.status == 400


def test_dns_query_rejects_unsupported_type_and_rules_payload_is_strict():
    with pytest.raises(MihomoClashClientError) as captured:
        _client().query_dns("example.invalid", "MX")
    assert captured.value.code == "dns_type_invalid"

    with pytest.raises(MihomoClashClientError) as captured:
        _client().disable_rules({"0": "true"})
    assert captured.value.code == "rules_disable_payload_invalid"

    with pytest.raises(MihomoClashClientError) as captured:
        _client().disable_rules({"../../debug": True})
    assert captured.value.code == "rules_disable_payload_invalid"
