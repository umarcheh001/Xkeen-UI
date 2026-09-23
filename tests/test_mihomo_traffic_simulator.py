from __future__ import annotations

from pathlib import Path

from scripts.mihomo_traffic_lab import run_reference, run_soak
from services.mihomo_traffic_simulator import (
    MIB,
    MihomoTrafficScenario,
    build_demo_traffic_analytics,
)


def test_scenario_separates_mihomo_and_outside_counters():
    scenario = MihomoTrafficScenario()
    scenario.add_device("192.0.2.10", "Ноутбук")
    connection_id = scenario.transfer(
        "192.0.2.10",
        download=50 * MIB,
        upload=2 * MIB,
        route="AUTO",
        node="VPN-A",
        resource="github.com",
    )
    scenario.transfer("192.0.2.10", download=10 * MIB, through_mihomo=False)

    connections = scenario.connections_snapshot()
    clients = scenario.clients_snapshot()

    assert connection_id
    assert connections["connections"][0]["download"] == 50 * MIB
    assert connections["connections"][0]["chains"] == ["AUTO", "VPN-A"]
    assert clients["items"][0]["received_bytes"] == 60 * MIB


def test_scenario_can_close_connections_and_reset_counters():
    scenario = MihomoTrafficScenario()
    scenario.add_device("192.0.2.10", "Ноутбук")
    connection_id = scenario.transfer(
        "192.0.2.10",
        download=10,
        route="AUTO",
        node="VPN-A",
        resource="example.test",
    )
    assert connection_id

    scenario.reset_connection_counters(connection_id)
    assert scenario.connections_snapshot()["connections"][0]["download"] == 0
    scenario.close_connection(connection_id)
    assert scenario.connections_snapshot()["connections"] == []
    scenario.reset_client_counters("192.0.2.10")
    assert scenario.clients_snapshot()["items"][0]["received_bytes"] == 0


def test_demo_payload_contains_devices_routes_resources_and_time_series():
    payload = build_demo_traffic_analytics(
        range_seconds=24 * 3600,
        now=1_800_000_000,
    )

    assert payload["demo"] is True
    assert payload["summary"]["device_count"] == 3
    assert {item["node"] for item in payload["routes"]} == {
        "VPN-A · Германия",
        "VPN-B · Нидерланды",
        "VPN-C · Финляндия",
    }
    assert any(item["resource"] == "youtube.com" for item in payload["resources"])
    assert len(payload["series"]) >= 13
    assert payload["collection"]["state"] == "demo"
    assert payload["quality"]["state"] == "demo"
    assert payload["summary"]["upload_bytes"] > 0


def test_reference_lab_matches_known_byte_distribution(tmp_path: Path):
    result = run_reference(tmp_path / "reference.sqlite3")

    assert result["ok"] is True
    assert result["actual"] == result["expected"]


def test_seven_day_soak_is_bounded_and_survives_restart(tmp_path: Path):
    result = run_soak(tmp_path / "soak.sqlite3", days=7)

    assert result["ok"] is True
    assert result["steps"] == 2016
    assert result["checks"]["restart_preserves_summary"] is True
    assert result["checks"]["database_under_32_mib"] is True
    assert result["checks"]["query_under_two_seconds"] is True
    assert result["database_size_bytes"] < 32 * MIB
