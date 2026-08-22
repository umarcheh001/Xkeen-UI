from __future__ import annotations

from pathlib import Path

from flask import Flask

import routes.system_resources as resource_routes
from routes.system_resources import create_system_resources_blueprint
from services.system_resources import reset_system_resource_sampler, sample_system_resources


def test_resource_sampler_returns_cpu_memory_load_and_uptime():
    samples = {
        "/proc/stat": "cpu  100 0 50 850 0 0 0 0 0 0\n",
        "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n",
        "/proc/loadavg": "0.25 0.50 0.75 1/10 42\n",
        "/proc/uptime": "1234.56 999.00\n",
    }

    reset_system_resource_sampler()
    payload = sample_system_resources(reader=lambda path: samples[path.as_posix()], clock=lambda: 77.9)

    assert payload["sampled_at"] == 77
    assert payload["cpu"]["percent"] == 15.0
    assert payload["cpu"]["load_1m"] == 0.25
    assert payload["memory"] == {
        "total_bytes": 1_024_000,
        "used_bytes": 614_400,
        "available_bytes": 409_600,
        "percent": 60.0,
        "swap_total_bytes": 204_800,
        "swap_used_bytes": 51_200,
    }
    assert payload["uptime_seconds"] == 1234


def test_resource_sampler_cpu_is_delta_based_after_first_sample():
    current = {"stat": "cpu 100 0 0 900\n"}
    fixed = {
        "/proc/meminfo": "MemTotal: 100 kB\nMemAvailable: 50 kB\n",
        "/proc/loadavg": "0 0 0\n",
        "/proc/uptime": "1 0\n",
    }

    def reader(path: Path) -> str:
        key = path.as_posix()
        return current["stat"] if key == "/proc/stat" else fixed[key]

    reset_system_resource_sampler()
    sample_system_resources(reader=reader)
    current["stat"] = "cpu 180 0 0 920\n"
    payload = sample_system_resources(reader=reader)
    assert payload["cpu"]["percent"] == 80.0


def test_resource_sampler_adds_optional_dashboard_telemetry(monkeypatch):
    samples = {
        "/proc/stat": "cpu 100 0 0 900\n",
        "/proc/meminfo": "MemTotal: 100 kB\nMemAvailable: 50 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n",
        "/proc/loadavg": "0.25 0.50 0.75 3/42 42\n",
        "/proc/uptime": "1234 0\n",
        "/proc/net/dev": "Inter-| Receive | Transmit\n eth0: 100 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\n",
        "/sys/class/thermal/thermal_zone0/temp": "48250\n",
    }

    class Usage:
        total = 1000
        used = 250
        free = 750

    reset_system_resource_sampler()
    monkeypatch.setattr("services.system_resources.os.path.isdir", lambda path: path == "/opt")
    payload = sample_system_resources(
        reader=lambda path: samples[path.as_posix()],
        clock=lambda: 77.9,
        disk_usage=lambda path: Usage(),
    )

    assert payload["schema_version"] == 1
    assert payload["cpu"]["runnable_tasks"] == 3
    assert payload["cpu"]["total_tasks"] == 42
    assert payload["network"]["interfaces"][0]["name"] == "eth0"
    assert payload["storage"]["percent"] == 25.0
    assert payload["storage"]["path"] == "/opt"
    assert payload["temperature_celsius"] == 48.2


def test_system_resources_route_is_no_store(monkeypatch):
    monkeypatch.setattr(resource_routes, "sample_system_resources", lambda: {"schema_version": 1, "cpu": {}, "memory": {}})
    monkeypatch.setattr(resource_routes, "cached_router_diagnostics", lambda: {"internet": {"available": False}})
    app = Flask(__name__)
    app.register_blueprint(create_system_resources_blueprint())

    response = app.test_client().get("/api/system/resources")

    assert response.status_code == 200
    assert response.get_json()["ok"] is True
    assert response.get_json()["router"]["internet"]["available"] is False
    assert response.headers["Cache-Control"] == "no-store"


def test_system_resources_route_has_safe_unavailable_error(monkeypatch):
    def fail():
        raise OSError("procfs details must not leak")

    monkeypatch.setattr(resource_routes, "sample_system_resources", fail)
    app = Flask(__name__)
    app.register_blueprint(create_system_resources_blueprint())

    response = app.test_client().get("/api/system/resources")

    assert response.status_code == 503
    assert response.get_json()["code"] == "system_resources_unavailable"
    assert "procfs" not in response.get_data(as_text=True)


def test_optional_router_diagnostics_failure_keeps_resource_endpoint_available(monkeypatch):
    monkeypatch.setattr(resource_routes, "sample_system_resources", lambda: {"schema_version": 1, "sampled_at": 7, "cpu": {}, "memory": {}})
    monkeypatch.setattr(resource_routes, "cached_router_diagnostics", lambda: (_ for _ in ()).throw(RuntimeError("secret")))
    app = Flask(__name__)
    app.register_blueprint(create_system_resources_blueprint())

    response = app.test_client().get("/api/system/resources")

    assert response.status_code == 200
    assert response.get_json()["router"]["rci"]["state"] == "unavailable"
    assert "secret" not in response.get_data(as_text=True)


def test_process_route_is_separate_and_no_store(monkeypatch):
    monkeypatch.setattr(
        resource_routes,
        "sample_router_processes",
        lambda: {"schema_version": 1, "sampled_at": 10, "items": [], "count": 0},
    )
    app = Flask(__name__)
    app.register_blueprint(create_system_resources_blueprint())

    response = app.test_client().get("/api/system/processes")

    assert response.status_code == 200
    assert response.get_json()["ok"] is True
    assert response.headers["Cache-Control"] == "no-store"
