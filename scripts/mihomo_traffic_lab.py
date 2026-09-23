#!/usr/bin/env python3
"""Run deterministic Mihomo traffic analytics scenarios without a router."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
XKEEN_UI = ROOT / "xkeen-ui"
if str(XKEEN_UI) not in sys.path:
    sys.path.insert(0, str(XKEEN_UI))

from services.mihomo_traffic_analytics import (  # noqa: E402
    BUCKET_SECONDS,
    MihomoTrafficAnalyticsCollector,
)
from services.mihomo_traffic_simulator import (  # noqa: E402
    GIB,
    MIB,
    MihomoTrafficScenario,
)


def _collector(scenario: MihomoTrafficScenario, database: Path) -> MihomoTrafficAnalyticsCollector:
    return MihomoTrafficAnalyticsCollector(
        db_path=str(database),
        connections_factory=scenario.connections_snapshot,
        clients_factory=scenario.clients_snapshot,
        clock=scenario.clock,
    )


def _baseline(collector: MihomoTrafficAnalyticsCollector, scenario: MihomoTrafficScenario) -> None:
    collector._sample_connections(scenario.clock())
    collector._sample_clients(scenario.clock())


def run_reference(database: Path) -> dict[str, Any]:
    scenario = MihomoTrafficScenario()
    scenario.add_device("192.168.1.24", "Ноутбук")
    scenario.add_device("192.168.1.51", "Телевизор")
    collector = _collector(scenario, database)
    _baseline(collector, scenario)

    scenario.clock.advance(30)
    scenario.transfer(
        "192.168.1.24",
        download=500 * MIB,
        route="AUTO",
        node="VPN-A",
        resource="github.com",
    )
    scenario.transfer(
        "192.168.1.24",
        download=200 * MIB,
        route="WORK",
        node="VPN-B",
        resource="openai.com",
    )
    scenario.transfer("192.168.1.24", download=100 * MIB, through_mihomo=False)
    scenario.transfer(
        "192.168.1.51",
        download=2 * GIB,
        route="MEDIA",
        node="VPN-C",
        resource="youtube.com",
    )
    scenario.transfer("192.168.1.51", download=50 * MIB, through_mihomo=False)
    collector._sample_connections(scenario.clock())
    collector._sample_clients(scenario.clock())
    collector._flush_pending()
    payload = collector.summary(range_seconds=3600)

    expected = {
        "mihomo_bytes": 500 * MIB + 200 * MIB + 2 * GIB,
        "outside_bytes": 150 * MIB,
        "device_count": 2,
        "route_count": 3,
    }
    actual = {
        key: payload["summary"][key]
        for key in expected
    }
    return {
        "scenario": "reference",
        "ok": actual == expected,
        "expected": expected,
        "actual": actual,
        "analytics": payload,
        "database": str(database),
        "database_size_bytes": database.stat().st_size if database.exists() else 0,
    }


def run_soak(database: Path, *, days: int) -> dict[str, Any]:
    scenario = MihomoTrafficScenario()
    scenario.add_device("192.168.1.24", "Ноутбук")
    scenario.add_device("192.168.1.51", "Телевизор")
    scenario.add_device("192.168.1.78", "Телефон")
    collector = _collector(scenario, database)
    _baseline(collector, scenario)

    steps = max(1, int(days)) * 24 * 3600 // BUCKET_SECONDS
    routes = (
        ("AUTO", "VPN-A", "github.com"),
        ("WORK", "VPN-B", "openai.com"),
        ("SOCIAL", "VPN-C", "telegram.org"),
    )
    started = time.perf_counter()
    for index in range(steps):
        scenario.clock.advance(BUCKET_SECONDS)
        route, node, resource = routes[index % len(routes)]
        scenario.transfer(
            "192.168.1.24",
            download=(18 + index % 7) * MIB,
            upload=(1 + index % 3) * MIB,
            route=route,
            node=node,
            resource=resource,
        )
        scenario.transfer(
            "192.168.1.51",
            download=(42 + index % 11) * MIB,
            route="MEDIA",
            node="VPN-C",
            resource="youtube.com",
        )
        scenario.transfer(
            "192.168.1.78",
            download=(5 + index % 5) * MIB,
            route="AUTO",
            node="VPN-A",
            resource="telegram.org",
        )
        if index % 3 == 0:
            scenario.transfer(
                "192.168.1.78",
                download=2 * MIB,
                through_mihomo=False,
            )
        collector._sample_connections(scenario.clock())
        collector._sample_clients(scenario.clock())
        if index % 12 == 11:
            collector._flush_pending()
        if index % 288 == 287:
            collector._prune(int(scenario.clock()))
    collector._flush_pending()
    simulation_seconds = time.perf_counter() - started

    query_started = time.perf_counter()
    payload = collector.summary(range_seconds=7 * 24 * 3600)
    query_ms = round((time.perf_counter() - query_started) * 1000, 1)
    before_restart = payload["summary"]
    restarted = _collector(scenario, database)
    after_restart = restarted.summary(range_seconds=7 * 24 * 3600)["summary"]

    with collector._connect() as connection:
        rows = {
            table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in ("traffic_route", "traffic_resource", "traffic_total")
        }
    database_size = database.stat().st_size if database.exists() else 0
    checks = {
        "restart_preserves_summary": before_restart == after_restart,
        "query_under_two_seconds": query_ms < 2000,
        "database_under_32_mib": database_size < 32 * MIB,
        "devices_present": payload["summary"]["device_count"] == 3,
        "outside_present": payload["summary"]["outside_bytes"] > 0,
    }
    return {
        "scenario": "soak",
        "days": days,
        "steps": steps,
        "ok": all(checks.values()),
        "checks": checks,
        "simulation_seconds": round(simulation_seconds, 3),
        "query_ms": query_ms,
        "database": str(database),
        "database_size_bytes": database_size,
        "rows": rows,
        "summary": before_restart,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", choices=("reference", "soak"), default="reference")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="xkeen-traffic-lab-") as temporary:
        database = args.database or Path(temporary) / "mihomo-traffic.sqlite3"
        database.parent.mkdir(parents=True, exist_ok=True)
        result = (
            run_reference(database)
            if args.scenario == "reference"
            else run_soak(database, days=max(1, min(14, args.days)))
        )
        text = json.dumps(result, ensure_ascii=False, indent=2)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(text + "\n", encoding="utf-8")
        print(text)
        return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
