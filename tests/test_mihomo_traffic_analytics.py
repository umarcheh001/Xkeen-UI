from __future__ import annotations

from pathlib import Path

from services.mihomo_traffic_analytics import (
    BUCKET_SECONDS,
    MAX_RESOURCE_ROWS_PER_BUCKET,
    MihomoTrafficAnalyticsCollector,
)
from services.mihomo_traffic_simulator import MihomoTrafficScenario


class Clock:
    def __init__(self, value: float = 1_800_000_000.0):
        self.value = value

    def __call__(self) -> float:
        return self.value


def connection_snapshot(*, download: int, upload: int):
    return {
        "connections": [
            {
                "id": "connection-a",
                "metadata": {
                    "source_ip": "192.0.2.10",
                    "source_name": "Ноутбук",
                    "sniff_host": "github.com",
                },
                "download": download,
                "upload": upload,
                "chains": ["AUTO", "vpn-a"],
            }
        ]
    }


def client_snapshot(*, received: int, sent: int):
    return {
        "available": True,
        "items": [
            {
                "ip": "192.0.2.10",
                "name": "Ноутбук",
                "received_bytes": received,
                "sent_bytes": sent,
            }
        ],
    }


def test_collector_attributes_deltas_to_device_route_and_resource(tmp_path: Path):
    clock = Clock()
    collector = MihomoTrafficAnalyticsCollector(
        db_path=str(tmp_path / "traffic.sqlite3"),
        connections_factory=lambda: {},
        clients_factory=lambda: {},
        clock=clock,
    )

    collector.connections_factory = lambda: connection_snapshot(download=1000, upload=200)
    collector.clients_factory = lambda: client_snapshot(received=5000, sent=1000)
    collector._sample_connections(clock())
    collector._sample_clients(clock())

    clock.value += 30
    collector.connections_factory = lambda: connection_snapshot(download=1300, upload=300)
    collector.clients_factory = lambda: client_snapshot(received=5600, sent=1200)
    collector._sample_connections(clock())
    collector._sample_clients(clock())

    payload = collector.summary(range_seconds=3600)

    assert payload["summary"]["mihomo_bytes"] == 400
    assert payload["summary"]["outside_bytes"] == 400
    assert payload["devices"][0]["name"] == "Ноутбук"
    assert payload["devices"][0]["routes"][0] == {
        "route": "AUTO",
        "node": "vpn-a",
        "download": 300,
        "upload": 100,
    }
    assert payload["resources"][0]["resource"] == "github.com"
    assert payload["coverage"]["keenetic_client_counters"] is True
    assert payload["summary"]["download_bytes"] == 600
    assert payload["summary"]["upload_bytes"] == 200
    assert payload["quality"]["classification_percent"] == 50
    assert payload["quality"]["connections"]["state"] == "live"
    assert payload["quality"]["clients"]["state"] == "live"
    assert payload["quality"]["storage"]["database_size_bytes"] > 0


def test_collector_does_not_count_existing_connections_on_first_snapshot(tmp_path: Path):
    clock = Clock()
    collector = MihomoTrafficAnalyticsCollector(
        db_path=str(tmp_path / "traffic.sqlite3"),
        connections_factory=lambda: connection_snapshot(download=50_000, upload=10_000),
        clients_factory=lambda: {"available": False, "items": []},
        clock=clock,
    )

    collector._sample_connections(clock())
    payload = collector.summary(range_seconds=3600)

    assert payload["summary"]["mihomo_bytes"] == 0
    assert payload["devices"] == []


def test_collector_store_is_bounded_to_requested_range(tmp_path: Path):
    clock = Clock()
    collector = MihomoTrafficAnalyticsCollector(
        db_path=str(tmp_path / "traffic.sqlite3"),
        connections_factory=lambda: {},
        clients_factory=lambda: {},
        clock=clock,
    )
    old_bucket = int(clock()) - 7200
    current_bucket = int(clock()) - BUCKET_SECONDS
    with collector._connect() as connection:
        connection.execute(
            """
            INSERT INTO traffic_route
                (bucket, device_ip, device_name, route, node, download, upload)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                old_bucket - old_bucket % BUCKET_SECONDS,
                "192.0.2.1",
                "Старое",
                "OLD",
                "old",
                999,
                0,
            ),
        )
        connection.execute(
            """
            INSERT INTO traffic_route
                (bucket, device_ip, device_name, route, node, download, upload)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                current_bucket - current_bucket % BUCKET_SECONDS,
                "192.0.2.2",
                "Новое",
                "AUTO",
                "vpn",
                100,
                0,
            ),
        )

    payload = collector.summary(range_seconds=3600)

    assert payload["summary"]["mihomo_bytes"] == 100
    assert [item["name"] for item in payload["devices"]] == ["Новое"]


def test_collector_limits_persisted_resources_per_bucket(tmp_path: Path):
    clock = Clock()
    collector = MihomoTrafficAnalyticsCollector(
        db_path=str(tmp_path / "traffic.sqlite3"),
        connections_factory=lambda: {},
        clients_factory=lambda: {},
        clock=clock,
    )
    bucket = int(clock()) - int(clock()) % BUCKET_SECONDS
    for index in range(MAX_RESOURCE_ROWS_PER_BUCKET + 10):
        collector._pending_resources[
            (bucket, "192.0.2.10", "Ноутбук", f"host-{index}.example", "AUTO")
        ] = [index + 1, 0]

    collector._flush_pending()

    with collector._connect() as connection:
        count = connection.execute(
            "SELECT COUNT(*) FROM traffic_resource WHERE bucket = ?",
            (bucket,),
        ).fetchone()[0]
    assert count == MAX_RESOURCE_ROWS_PER_BUCKET


def test_short_mihomo_connection_is_not_misreported_as_observed(tmp_path: Path):
    scenario = MihomoTrafficScenario()
    scenario.add_device("192.0.2.10", "Ноутбук")
    collector = MihomoTrafficAnalyticsCollector(
        db_path=str(tmp_path / "traffic.sqlite3"),
        connections_factory=scenario.connections_snapshot,
        clients_factory=scenario.clients_snapshot,
        clock=scenario.clock,
    )
    collector._sample_connections(scenario.clock())
    collector._sample_clients(scenario.clock())
    scenario.transfer(
        "192.0.2.10",
        download=10 * 1024 * 1024,
        route="AUTO",
        node="VPN-A",
        resource="short.example",
    )
    connection_id = next(iter(scenario.connections))
    scenario.close_connection(connection_id)
    scenario.clock.advance(30)
    collector._sample_connections(scenario.clock())
    collector._sample_clients(scenario.clock())

    payload = collector.summary(range_seconds=3600)

    assert payload["summary"]["mihomo_bytes"] == 0
    assert payload["summary"]["outside_bytes"] == 10 * 1024 * 1024
    assert payload["quality"]["classification_percent"] == 0


def test_unavailable_client_counters_keep_mihomo_observation_for_later_recovery(tmp_path: Path):
    scenario = MihomoTrafficScenario()
    scenario.add_device("192.0.2.10", "Ноутбук")
    collector = MihomoTrafficAnalyticsCollector(
        db_path=str(tmp_path / "traffic.sqlite3"),
        connections_factory=scenario.connections_snapshot,
        clients_factory=scenario.clients_snapshot,
        clock=scenario.clock,
    )
    collector._sample_connections(scenario.clock())
    collector._sample_clients(scenario.clock())
    scenario.transfer(
        "192.0.2.10",
        download=20 * 1024 * 1024,
        route="AUTO",
        node="VPN-A",
        resource="recovery.example",
    )
    scenario.clock.advance(30)
    collector._sample_connections(scenario.clock())
    collector.clients_factory = lambda: {"available": False, "items": []}
    collector._sample_clients(scenario.clock())
    partial = collector.summary(range_seconds=3600)
    assert partial["quality"]["state"] == "partial"
    assert partial["quality"]["clients"]["state"] == "unavailable"
    collector.clients_factory = scenario.clients_snapshot
    collector._sample_clients(scenario.clock())

    payload = collector.summary(range_seconds=3600)

    assert payload["summary"]["mihomo_bytes"] == 20 * 1024 * 1024
    assert payload["summary"]["outside_bytes"] == 0


def test_counter_reset_route_switch_and_ipv6_remain_nonnegative(tmp_path: Path):
    scenario = MihomoTrafficScenario()
    scenario.add_device("2001:db8::10", "Телефон IPv6")
    collector = MihomoTrafficAnalyticsCollector(
        db_path=str(tmp_path / "traffic.sqlite3"),
        connections_factory=scenario.connections_snapshot,
        clients_factory=scenario.clients_snapshot,
        clock=scenario.clock,
    )
    collector._sample_connections(scenario.clock())
    collector._sample_clients(scenario.clock())
    first = scenario.transfer(
        "2001:db8::10",
        download=12 * 1024 * 1024,
        route="AUTO",
        node="VPN-A",
        resource="ipv6.example",
    )
    scenario.clock.advance(30)
    collector._sample_connections(scenario.clock())
    collector._sample_clients(scenario.clock())
    assert first

    scenario.reset_connection_counters(first)
    scenario.reset_client_counters("2001:db8::10")
    scenario.transfer(
        "2001:db8::10",
        download=8 * 1024 * 1024,
        route="WORK",
        node="VPN-B",
        resource="switch.example",
    )
    scenario.clock.advance(30)
    collector._sample_connections(scenario.clock())
    collector._sample_clients(scenario.clock())

    payload = collector.summary(range_seconds=3600)

    assert payload["summary"]["mihomo_bytes"] >= 20 * 1024 * 1024
    assert {item["route"] for item in payload["devices"][0]["routes"]} == {"AUTO", "WORK"}
    assert payload["devices"][0]["ip"] == "2001:db8::10"
    assert payload["summary"]["outside_bytes"] >= 0


def test_quality_reports_source_errors_and_truncated_snapshots(tmp_path: Path):
    connections = [
        {
            "id": f"connection-{index}",
            "metadata": {"source_ip": "192.0.2.10", "source_name": "Ноутбук"},
            "download": 0,
            "upload": 0,
            "chains": ["AUTO", "VPN-A"],
        }
        for index in range(1001)
    ]
    clock = Clock()
    collector = MihomoTrafficAnalyticsCollector(
        db_path=str(tmp_path / "traffic.sqlite3"),
        connections_factory=lambda: {"connections": connections},
        clients_factory=lambda: {"available": False, "items": []},
        clock=clock,
    )
    collector._sample_connections(clock())
    collector._record_source_error("connections", RuntimeError("fixture outage"))

    payload = collector.summary(range_seconds=3600)

    assert payload["quality"]["state"] == "degraded"
    assert payload["quality"]["connections"]["errors"] == 1
    assert payload["quality"]["connections"]["truncated_samples"] == 1
    assert payload["quality"]["connections"]["last_error"] == "fixture outage"
