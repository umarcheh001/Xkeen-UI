from __future__ import annotations

from pathlib import Path

from services.mihomo_traffic_analytics import (
    BUCKET_SECONDS,
    MAX_RESOURCE_ROWS_PER_BUCKET,
    MihomoTrafficAnalyticsCollector,
)


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
