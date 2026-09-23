"""Deterministic offline traffic fixtures for analytics development and tests."""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any


GIB = 1024**3
MIB = 1024**2


@dataclass
class SimulationClock:
    value: float = 1_800_000_000.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> float:
        self.value += max(0.0, float(seconds))
        return self.value


@dataclass
class SimulatedDevice:
    ip: str
    name: str
    received: int = 0
    sent: int = 0


@dataclass
class SimulatedConnection:
    connection_id: str
    device_ip: str
    device_name: str
    resource: str
    route: str
    node: str
    download: int = 0
    upload: int = 0


@dataclass
class MihomoTrafficScenario:
    """Mutable pair of normalized Mihomo and Keenetic snapshots."""

    clock: SimulationClock = field(default_factory=SimulationClock)
    devices: dict[str, SimulatedDevice] = field(default_factory=dict)
    connections: dict[str, SimulatedConnection] = field(default_factory=dict)

    def add_device(self, ip: str, name: str) -> SimulatedDevice:
        device = SimulatedDevice(str(ip), str(name))
        self.devices[device.ip] = device
        return device

    def transfer(
        self,
        device_ip: str,
        *,
        download: int = 0,
        upload: int = 0,
        through_mihomo: bool = True,
        route: str = "DIRECT",
        node: str = "DIRECT",
        resource: str = "example.test",
        connection_id: str | None = None,
    ) -> str | None:
        device = self.devices[str(device_ip)]
        received = max(0, int(download))
        sent = max(0, int(upload))
        device.received += received
        device.sent += sent
        if not through_mihomo:
            return None
        identifier = connection_id or "|".join(
            (device.ip, str(route), str(node), str(resource))
        )
        connection = self.connections.get(identifier)
        if connection is None:
            connection = SimulatedConnection(
                connection_id=identifier,
                device_ip=device.ip,
                device_name=device.name,
                resource=str(resource),
                route=str(route),
                node=str(node),
            )
            self.connections[identifier] = connection
        connection.download += received
        connection.upload += sent
        return identifier

    def close_connection(self, connection_id: str) -> None:
        self.connections.pop(str(connection_id), None)

    def reset_client_counters(self, device_ip: str) -> None:
        device = self.devices[str(device_ip)]
        device.received = 0
        device.sent = 0

    def reset_connection_counters(self, connection_id: str) -> None:
        connection = self.connections[str(connection_id)]
        connection.download = 0
        connection.upload = 0

    def connections_snapshot(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "download_total": sum(item.download for item in self.connections.values()),
            "upload_total": sum(item.upload for item in self.connections.values()),
            "connections": [
                {
                    "id": item.connection_id,
                    "metadata": {
                        "source_ip": item.device_ip,
                        "source_name": item.device_name,
                        "sniff_host": item.resource,
                        "destination_ip": "198.51.100.1",
                    },
                    "download": item.download,
                    "upload": item.upload,
                    "chains": [item.route, item.node],
                    "rule": "DomainSuffix",
                    "rule_payload": item.resource,
                }
                for item in self.connections.values()
            ],
        }

    def clients_snapshot(self) -> dict[str, Any]:
        return {
            "available": True,
            "sampled_at": int(self.clock()),
            "items": [
                {
                    "ip": item.ip,
                    "name": item.name,
                    "received_bytes": item.received,
                    "sent_bytes": item.sent,
                    "online": True,
                }
                for item in self.devices.values()
            ],
        }


def _scaled(value: int, factor: float) -> int:
    return max(1, int(round(value * factor)))


def build_demo_traffic_analytics(
    *,
    range_seconds: int,
    now: int | None = None,
) -> dict[str, Any]:
    """Return a realistic, deterministic UI payload without router access."""

    end = int(now if now is not None else time.time())
    seconds = max(3600, min(7 * 24 * 3600, int(range_seconds)))
    factor = max(0.08, seconds / (24 * 3600))

    laptop_a = _scaled(int(3.2 * GIB), factor)
    laptop_b = _scaled(int(0.9 * GIB), factor)
    laptop_outside = _scaled(320 * MIB, factor)
    laptop_a_up = _scaled(180 * MIB, factor)
    laptop_b_up = _scaled(120 * MIB, factor)
    laptop_outside_up = _scaled(40 * MIB, factor)
    tv_c = _scaled(int(8.4 * GIB), factor)
    tv_outside = _scaled(110 * MIB, factor)
    tv_c_up = _scaled(20 * MIB, factor)
    tv_outside_up = _scaled(5 * MIB, factor)
    phone_a = _scaled(int(1.1 * GIB), factor)
    phone_b = _scaled(420 * MIB, factor)
    phone_outside = _scaled(150 * MIB, factor)
    phone_a_up = _scaled(80 * MIB, factor)
    phone_b_up = _scaled(60 * MIB, factor)
    phone_outside_up = _scaled(20 * MIB, factor)

    devices = [
        {
            "ip": "192.168.1.24",
            "name": "Ноутбук",
            "mihomo_bytes": laptop_a + laptop_b + laptop_a_up + laptop_b_up,
            "outside_bytes": laptop_outside + laptop_outside_up,
            "total_bytes": laptop_a + laptop_b + laptop_a_up + laptop_b_up + laptop_outside + laptop_outside_up,
            "mihomo_download": laptop_a + laptop_b,
            "mihomo_upload": laptop_a_up + laptop_b_up,
            "outside_download": laptop_outside,
            "outside_upload": laptop_outside_up,
            "routes": [
                {"route": "AUTO", "node": "VPN-A · Германия", "download": laptop_a, "upload": laptop_a_up},
                {"route": "WORK", "node": "VPN-B · Нидерланды", "download": laptop_b, "upload": laptop_b_up},
            ],
        },
        {
            "ip": "192.168.1.51",
            "name": "Телевизор",
            "mihomo_bytes": tv_c + tv_c_up,
            "outside_bytes": tv_outside + tv_outside_up,
            "total_bytes": tv_c + tv_c_up + tv_outside + tv_outside_up,
            "mihomo_download": tv_c,
            "mihomo_upload": tv_c_up,
            "outside_download": tv_outside,
            "outside_upload": tv_outside_up,
            "routes": [
                {"route": "MEDIA", "node": "VPN-C · Финляндия", "download": tv_c, "upload": tv_c_up},
            ],
        },
        {
            "ip": "192.168.1.78",
            "name": "Телефон",
            "mihomo_bytes": phone_a + phone_b + phone_a_up + phone_b_up,
            "outside_bytes": phone_outside + phone_outside_up,
            "total_bytes": phone_a + phone_b + phone_a_up + phone_b_up + phone_outside + phone_outside_up,
            "mihomo_download": phone_a + phone_b,
            "mihomo_upload": phone_a_up + phone_b_up,
            "outside_download": phone_outside,
            "outside_upload": phone_outside_up,
            "routes": [
                {"route": "AUTO", "node": "VPN-A · Германия", "download": phone_a, "upload": phone_a_up},
                {"route": "SOCIAL", "node": "VPN-B · Нидерланды", "download": phone_b, "upload": phone_b_up},
            ],
        },
    ]

    route_map: dict[tuple[str, str], dict[str, Any]] = {}
    for device in devices:
        for route in device["routes"]:
            key = (route["route"], route["node"])
            item = route_map.setdefault(
                key,
                {
                    "route": route["route"],
                    "node": route["node"],
                    "download": 0,
                    "upload": 0,
                    "bytes": 0,
                    "_devices": {},
                },
            )
            item["download"] += route["download"]
            item["upload"] += route["upload"]
            item["bytes"] += route["download"] + route["upload"]
            breakdown = item["_devices"].setdefault(
                device["ip"],
                {
                    "ip": device["ip"],
                    "name": device["name"],
                    "download": 0,
                    "upload": 0,
                },
            )
            breakdown["download"] += route["download"]
            breakdown["upload"] += route["upload"]
    routes = []
    for item in route_map.values():
        breakdown = list(item.pop("_devices").values())
        item["device_ips"] = sorted(row["ip"] for row in breakdown)
        item["device_count"] = len(item["device_ips"])
        item["breakdown"] = breakdown
        routes.append(item)
    routes.sort(key=lambda item: item["bytes"], reverse=True)

    mihomo_download_total = sum(item["mihomo_download"] for item in devices)
    mihomo_upload_total = sum(item["mihomo_upload"] for item in devices)
    outside_download_total = sum(item["outside_download"] for item in devices)
    outside_upload_total = sum(item["outside_upload"] for item in devices)
    mihomo_total = mihomo_download_total + mihomo_upload_total
    outside_total = outside_download_total + outside_upload_total
    point_count = min(97, max(13, int(seconds / 1800) + 1))
    interval = max(60, seconds // max(1, point_count - 1))
    weights = [
        0.72
        + 0.24 * math.sin(index * 0.63)
        + 0.12 * math.sin(index * 1.91)
        + (0.35 if index % 17 in {9, 10} else 0)
        for index in range(point_count)
    ]
    weight_sum = sum(max(0.08, value) for value in weights)
    series = []
    for index, raw_weight in enumerate(weights):
        weight = max(0.08, raw_weight) / weight_sum
        mihomo = int(round(mihomo_total * weight))
        outside = int(round(outside_total * weight))
        download = int(round((mihomo_download_total + outside_download_total) * weight))
        upload = int(round((mihomo_upload_total + outside_upload_total) * weight))
        series.append(
            {
                "at": end - interval * (point_count - index - 1),
                "mihomo_bytes": mihomo,
                "outside_bytes": outside,
                "download_bytes": download,
                "upload_bytes": upload,
                "total_bytes": download + upload,
            }
        )

    resources = [
        {
            "resource": "youtube.com",
            "download": _scaled(int(5.7 * GIB), factor),
            "upload": 0,
            "bytes": _scaled(int(5.7 * GIB), factor),
            "device_count": 1,
            "devices": ["Телевизор"],
            "device_ips": ["192.168.1.51"],
            "routes": ["MEDIA"],
            "breakdown": [
                {
                    "ip": "192.168.1.51",
                    "name": "Телевизор",
                    "route": "MEDIA",
                    "download": _scaled(int(5.7 * GIB), factor),
                    "upload": 0,
                },
            ],
        },
        {
            "resource": "googlevideo.com",
            "download": _scaled(int(2.5 * GIB), factor),
            "upload": 0,
            "bytes": _scaled(int(2.5 * GIB), factor),
            "device_count": 1,
            "devices": ["Телевизор"],
            "device_ips": ["192.168.1.51"],
            "routes": ["MEDIA"],
            "breakdown": [
                {
                    "ip": "192.168.1.51",
                    "name": "Телевизор",
                    "route": "MEDIA",
                    "download": _scaled(int(2.5 * GIB), factor),
                    "upload": 0,
                },
            ],
        },
        {
            "resource": "github.com",
            "download": _scaled(int(1.4 * GIB), factor),
            "upload": 0,
            "bytes": _scaled(int(1.4 * GIB), factor),
            "device_count": 1,
            "devices": ["Ноутбук"],
            "device_ips": ["192.168.1.24"],
            "routes": ["WORK"],
            "breakdown": [
                {
                    "ip": "192.168.1.24",
                    "name": "Ноутбук",
                    "route": "WORK",
                    "download": _scaled(int(1.4 * GIB), factor),
                    "upload": 0,
                },
            ],
        },
        {
            "resource": "telegram.org",
            "download": _scaled(620 * MIB, factor),
            "upload": 0,
            "bytes": _scaled(620 * MIB, factor),
            "device_count": 1,
            "devices": ["Телефон"],
            "device_ips": ["192.168.1.78"],
            "routes": ["SOCIAL"],
            "breakdown": [
                {
                    "ip": "192.168.1.78",
                    "name": "Телефон",
                    "route": "SOCIAL",
                    "download": _scaled(620 * MIB, factor),
                    "upload": 0,
                },
            ],
        },
    ]

    return {
        "schema_version": 1,
        "demo": True,
        "range_seconds": seconds,
        "from": end - seconds,
        "to": end,
        "summary": {
            "mihomo_bytes": mihomo_total,
            "mihomo_download_bytes": mihomo_download_total,
            "mihomo_upload_bytes": mihomo_upload_total,
            "outside_bytes": outside_total,
            "outside_download_bytes": outside_download_total,
            "outside_upload_bytes": outside_upload_total,
            "download_bytes": mihomo_download_total + outside_download_total,
            "upload_bytes": mihomo_upload_total + outside_upload_total,
            "total_bytes": mihomo_total + outside_total,
            "device_count": len(devices),
            "route_count": len(routes),
            "resource_count": len(resources),
        },
        "series": series,
        "devices": devices,
        "routes": routes,
        "resources": resources,
        "coverage": {
            "mihomo": True,
            "keenetic_client_counters": True,
            "outside_estimated": True,
            "outside_method": "demo",
            "mihomo_method": "demo",
            "accuracy": "synthetic",
        },
        "quality": {
            "state": "demo",
            "classification_percent": round(mihomo_total * 100.0 / max(1, mihomo_total + outside_total), 1),
            "confirmed_bytes": mihomo_total,
            "estimated_bytes": outside_total,
            "unclassified_bytes": 0,
            "connections": {"state": "demo", "samples": 999, "errors": 0, "age_seconds": 0},
            "clients": {"state": "demo", "samples": 999, "errors": 0, "age_seconds": 0},
            "storage": {"database_size_bytes": 0, "rows": {}},
        },
        "collection": {
            "state": "demo",
            "started_at": end - seconds,
            "last_sample_at": end,
            "last_error": None,
            "sample_interval_seconds": 10,
            "client_interval_seconds": 30,
            "retention_seconds": 7 * 24 * 3600,
        },
    }


__all__ = [
    "MihomoTrafficScenario",
    "SimulationClock",
    "build_demo_traffic_analytics",
]
