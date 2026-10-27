"""HTTP addresses of the router-resources history: history, hardware, events, summary."""

from __future__ import annotations

import re

import pytest
from flask import Flask

import routes.devtools as devtools_routes
import routes.system_resources as resource_routes
import routes.ui_settings as ui_settings_routes
from routes.devtools import create_devtools_blueprint
from routes.system_resources import create_system_resources_blueprint
from routes.ui_settings import create_ui_settings_blueprint
from services import UISettingsStore
from services import entware_initrc
from services.system_resources_history.zones import zone
from tests.test_system_resources_collector import ISP, T0, USB, FakeRouter, make, tariffs


@pytest.fixture
def initrc_api(tmp_path, monkeypatch):
    store = UISettingsStore(ui_state_dir=str(tmp_path))
    # Patch the provider before creating the blueprint; no real router involved.
    import services
    monkeypatch.setattr(services, "get_ui_settings_store", lambda: store)
    monkeypatch.setattr(resource_routes, "get_ui_settings_store", lambda: store, raising=False)
    return _app_with(None, monkeypatch).test_client(), store


@pytest.mark.parametrize("state,path", [("ok", "/custom/stop"), ("missing", None), ("unknown", None)])
def test_initrc_status_api(initrc_api, monkeypatch, state, path):
    client, store = initrc_api
    monkeypatch.setattr(entware_initrc, "initrc_status", lambda: {"state": state, "path": path})
    response = client.get("/api/system/router/initrc")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json == {"ok": True, "state": state, "path": path, "dismissed": False}


def test_initrc_dismiss_persists_without_losing_tariff(initrc_api, monkeypatch):
    client, store = initrc_api
    store.patch({"diagnostics": {"tariffs": {"ISP": {"down_mbps": 100}}}})
    monkeypatch.setattr(entware_initrc, "initrc_status", lambda: {"state": "missing", "path": None})
    response = client.post("/api/system/router/initrc/dismiss")
    assert response.status_code == 200 and response.json == {"ok": True}
    assert response.headers["Cache-Control"] == "no-store"
    assert client.get("/api/system/router/initrc").json["dismissed"] is True
    assert store.load()["diagnostics"]["tariffs"]["ISP"]["down_mbps"] == 100


def test_initrc_dismiss_write_failure(initrc_api, monkeypatch):
    client, store = initrc_api
    def fail(*a):
        raise OSError("private disk details")
    monkeypatch.setattr(UISettingsStore, "patch", fail)
    response = client.post("/api/system/router/initrc/dismiss")
    assert response.status_code == 500 and response.json["ok"] is False
    assert response.json["code"] == "settings_save_failed"
    assert "private disk details" not in response.get_data(as_text=True)
    assert response.headers["Cache-Control"] == "no-store"


def test_initrc_apply_api(initrc_api, monkeypatch):
    client, _ = initrc_api
    monkeypatch.setattr(entware_initrc, "apply_initrc", lambda: {"state": "ok", "path": "/opt/etc/init.d/rc.unslung"})
    response = client.post("/api/system/router/initrc/apply")
    assert response.status_code == 200 and response.json == {"ok": True, "state": "ok"}
    assert response.headers["Cache-Control"] == "no-store"


def test_initrc_apply_firmware_error_api(initrc_api, monkeypatch):
    client, _ = initrc_api
    def fail():
        raise entware_initrc.InitrcError("Не удалось сохранить настройку.", code="initrc_command_failed", details="% error denied")
    monkeypatch.setattr(entware_initrc, "apply_initrc", fail)
    response = client.post("/api/system/router/initrc/apply")
    assert response.status_code == 502
    assert response.json["ok"] is False
    assert response.json["code"] == "initrc_command_failed"
    assert response.json["details"] == "% error denied"
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("action", ["apply", "dismiss"])
def test_initrc_mutations_reject_get(initrc_api, action):
    client, _ = initrc_api
    assert client.get(f"/api/system/router/initrc/{action}").status_code == 405


def _app_with(collector, monkeypatch) -> Flask:
    monkeypatch.setattr(resource_routes, "get_collector", lambda: collector)
    monkeypatch.setattr(
        resource_routes,
        "cached_router_diagnostics",
        lambda: {"chain": [{"id": "router", "ok": True}], "external_address": "203.0.113.7"},
    )
    app = Flask(__name__)
    app.register_blueprint(create_system_resources_blueprint(include_summary=False))
    return app


def _running(tmp_path, ticks=13, **kw):
    router = FakeRouter(**kw)
    collector = make(tmp_path, router)
    router.step(collector, ticks)
    return router, collector


@pytest.mark.parametrize(
    "range_id, columns",
    [("15m", 60), ("30m", 60), ("1h", 60), ("6h", 72), ("24h", 96), ("7d", 336)],
)
def test_history_ranges_shapes(tmp_path, monkeypatch, range_id, columns):
    _router, collector = _running(tmp_path)
    client = _app_with(collector, monkeypatch).test_client()

    response = client.get(f"/api/system/history?range={range_id}")

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    body = response.get_json()
    assert body["ok"] is True and body["range"] == range_id
    assert body["step_s"] > 0 and body["start"] > 0
    assert body["history_since"] == pytest.approx(T0 + 5)
    cpu = body["metrics"]["cpu"]
    assert len(cpu["avg"]) == len(cpu["max"]) == len(body["top"]) == columns
    assert any(v is not None for v in cpu["avg"])


@pytest.mark.parametrize("query", ["?range=2h", "?range=", ""])
def test_history_bad_range_400(tmp_path, monkeypatch, query):
    _router, collector = _running(tmp_path, ticks=2)
    client = _app_with(collector, monkeypatch).test_client()

    response = client.get("/api/system/history" + query)

    assert response.status_code == 400
    assert response.get_json()["code"] == "bad_range"
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize(
    "path",
    ["/api/system/history?range=15m", "/api/system/hardware", "/api/system/events?since=0", "/api/system/summary"],
)
def test_routes_answer_503_when_the_collector_is_not_running(monkeypatch, path):
    client = _app_with(None, monkeypatch).test_client()

    response = client.get(path)

    assert response.status_code == 503
    assert response.get_json()["code"] == "history_unavailable"
    assert response.headers["Cache-Control"] == "no-store"


def test_a_bad_range_is_400_even_without_a_collector(monkeypatch):
    response = _app_with(None, monkeypatch).test_client().get("/api/system/history?range=zzz")

    assert response.status_code == 400
    assert response.get_json()["code"] == "bad_range"


def test_history_zone_fields(tmp_path, monkeypatch):
    router = FakeRouter()
    router.busy_share = 0.9
    collector = make(tmp_path, router)
    router.step(collector, 13)
    client = _app_with(collector, monkeypatch).test_client()

    metrics = client.get("/api/system/history?range=15m").get_json()["metrics"]

    cpu = metrics["cpu"]
    assert len(cpu["zone"]) == len(cpu["peak_zone"]) == len(cpu["avg"])
    assert {z for z in cpu["zone"] if z is not None} == {2}
    assert {z for z in cpu["peak_zone"] if z is not None} == {2}
    assert {z for z in metrics["memory"]["zone"] if z is not None} == {0}
    # availability: a full column is normal, any gap in it is a failure
    assert {z for z in metrics["online"]["zone"] if z is not None} == {0}


def test_history_carries_chart_bands_for_every_chart_metric(tmp_path, monkeypatch):
    _router, collector = _running(tmp_path)
    client = _app_with(collector, monkeypatch).test_client()

    body = client.get("/api/system/history?range=1h").get_json()

    cores = body["cores"]
    assert body["bands"]["cpu"] == {"orange": 60.0, "red": 85.0}
    assert body["bands"]["memory"] == {"orange": 75.0, "red": 90.0}
    assert body["bands"]["link"] == {"orange": 70.0, "red": 90.0}
    assert body["bands"]["queue"] == {"orange": 0.7 * cores, "red": 1.0 * cores, "scale_max": 2.0 * cores}


def test_online_zone_is_normal_only_for_a_full_column():
    from services.system_resources_history.zones import zone

    assert zone("online", 1.0) == 0
    assert zone("online", 0.93) == 2
    assert zone("online", 0.0) == 2
    assert zone("online", None) is None


def test_history_links_list_two_connections(tmp_path, monkeypatch):
    router = FakeRouter(with_usb=True)
    collector = make(tmp_path, router)
    tariffs(tmp_path, {ISP: {"up_mbps": 100, "down_mbps": 400}})
    collector.refresh_tariffs()
    router.step(collector, 13)
    client = _app_with(collector, monkeypatch).test_client()

    links = {l["id"]: l for l in client.get("/api/system/history?range=15m").get_json()["links"]}

    assert set(links) == {ISP, USB}
    assert links[ISP]["primary"] is True and links[USB]["primary"] is False
    assert links[ISP]["kernel"] == "eth3" and links[USB]["kernel"] == "wwan0"
    assert links[ISP]["tariff"] == {"up_mbps": 100, "down_mbps": 400}
    assert links[USB]["tariff"] is None
    assert links[ISP]["label"] and links[USB]["label"]


def test_hardware_payload_from_fixtures(tmp_path, monkeypatch):
    router, collector = _running(tmp_path)
    router.files["/proc/swaps"] = "Filename Type Size Used Priority\n/dev/zram0 partition 1048576 2048 -2\n"
    router.files["/sys/block/zram0/disksize"] = "1073741824"
    router.files["/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"] = "1200000"
    router.files["/sys/devices/system/cpu/cpu0/cpufreq/scaling_max_freq"] = "2000000"
    router.step(collector, 12)  # the 60 s step reads the slow data again
    monkeypatch.setattr(resource_routes, "sample_storage", lambda: {"total_bytes": 100, "used_bytes": 25, "percent": 25.0})
    client = _app_with(collector, monkeypatch).test_client()

    response = client.get("/api/system/hardware")

    assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"
    body = response.get_json()
    assert body["ok"] is True
    assert body["identity"]["model"] and body["identity"]["firmware"].startswith("KeeneticOS")
    assert body["cores"] == 2
    temp = body["temperatures"][0]
    assert temp["id"] == "cpu" and temp["value_c"] == 55.0 and temp["zone"] == 0
    assert "hotter_by" in temp and "hotter_by_c" not in temp
    assert temp["bands"] == {"orange_c": 80.0, "red_c": 95.0}  # the scale is drawn from these, never from JS constants
    # below the maximum on one cool sample is an idle governor, not heat
    assert body["throttle"] == {"current_mhz": 1200, "max_mhz": 2000, "below_max": True, "throttled": False}
    assert body["memory"]["total_bytes"] == 1_000_000 * 1024
    assert body["memory"]["programs_bytes"] + body["memory"]["cache_bytes"] + body["memory"]["free_bytes"] == body["memory"]["total_bytes"]
    assert body["zram"] == {"size_bytes": 1073741824, "used_bytes": 2048 * 1024, "pressure": False}
    assert body["storage"]["percent"] == 25.0
    assert "available" in body["conntrack"]
    assert [p["id"] for p in body["ports"]]
    assert body["slow_ports"] == []


@pytest.mark.parametrize(
    ("metric", "value", "expected"),
    [("storage", 74.9, 0), ("storage", 75, 1), ("storage", 90, 2), ("conntrack", 74.9, 0), ("conntrack", 75, 1), ("conntrack", 95, 2), ("conntrack", None, None)],
)
def test_storage_and_conntrack_zones(metric, value, expected):
    from services.system_resources_history.zones import zone

    assert zone(metric, value) == expected


def test_zram_pressure_starts_above_a_quarter():
    from services.system_resources_history.zones import zram_pressure

    assert zram_pressure(1000, 250) is False
    assert zram_pressure(1000, 251) is True
    assert zram_pressure(0, 0) is None and zram_pressure(1000, None) is None


def test_hardware_carries_zones_for_storage_conntrack_and_zram(tmp_path, monkeypatch):
    router, collector = _running(tmp_path)
    router.files["/proc/swaps"] = "Filename Type Size Used Priority\n/dev/zram0 partition 1048576 600000 -2\n"
    router.files["/sys/block/zram0/disksize"] = "1073741824"
    router.step(collector, 12)
    monkeypatch.setattr(resource_routes, "sample_storage", lambda: {"total_bytes": 100, "used_bytes": 92, "percent": 92.0})
    body = _app_with(collector, monkeypatch).test_client().get("/api/system/hardware").get_json()

    assert body["storage"]["zone"] == 2
    from services.system_resources_history.zones import zone

    assert body["conntrack"]["zone"] == zone("conntrack", body["conntrack"].get("percent"))
    assert body["zram"]["pressure"] is True


def test_hardware_throttle_is_null_without_frequency_data(tmp_path, monkeypatch):
    _router, collector = _running(tmp_path)
    monkeypatch.setattr(resource_routes, "sample_storage", lambda: None)
    body = _app_with(collector, monkeypatch).test_client().get("/api/system/hardware").get_json()

    assert body["throttle"] is None
    assert body["storage"] is None


def test_events_since(tmp_path, monkeypatch):
    _router, collector = _running(tmp_path, ticks=2)
    collector._tracker.emit("internet_restored", T0 + 10)
    collector._tracker.emit("dns_failed", T0 + 100)
    client = _app_with(collector, monkeypatch).test_client()

    def ids(query):
        body = client.get("/api/system/events" + query).get_json()
        assert body["ok"] is True
        return {e["type"] for e in body["events"]}, {e["type"] for e in body["active"]}

    assert ids("?since=0") == ({"internet_restored", "dns_failed"}, {"dns_failed"})
    assert ids(f"?since={T0 + 50}") == ({"dns_failed"}, {"dns_failed"})  # an open event is always listed
    assert ids("") == ({"internet_restored", "dns_failed"}, {"dns_failed"})
    assert ids("?since=abc") == ({"internet_restored", "dns_failed"}, {"dns_failed"})
    assert ids("?since=nan") == ({"internet_restored", "dns_failed"}, {"dns_failed"})


def test_summary_has_router_chain_and_rci_flag(tmp_path, monkeypatch):
    router, collector = _running(tmp_path)
    client = _app_with(collector, monkeypatch).test_client()

    body = client.get("/api/system/summary").get_json()

    assert body["ok"] is True
    assert body["router"]["external_address"] == "203.0.113.7" and body["router"]["chain"]
    assert body["rci_available"] is True
    assert body["status"] == {"tone": "ok", "problems": []}
    assert body["identity"]["model"]
    assert body["uptime_s"] == pytest.approx(router.uptime)
    cards = body["cards"]
    assert set(cards) == {"cpu", "memory", "internet", "link"}
    for name in ("cpu", "memory", "internet"):
        assert len(cards[name]["bars"]["values"]) == len(cards[name]["bars"]["zones"]) == 40
    assert cards["cpu"]["value"] == pytest.approx(40.0) and cards["cpu"]["zone"] == 0
    assert cards["memory"]["value"] == pytest.approx(60.0)
    assert "программы" in cards["memory"]["text"] and "кэш" in cards["memory"]["text"]
    # "свободно" includes the cache, as in the router's own UI: programs + free = all memory
    programs_mb, free_mb, cache_mb = map(int, re.findall(r"(\d+) МБ", cards["memory"]["text"]))
    assert cache_mb <= free_mb
    assert abs(programs_mb + free_mb - round(cards["memory"]["total_bytes"] / 1048576)) <= 1
    assert cards["internet"]["state"] == "online"
    assert cards["internet"]["bars"]["values"][-1] == 1.0

    router.rci_down = True
    router.step(collector, 12)
    assert client.get("/api/system/summary").get_json()["rci_available"] is False


def test_summary_card_bars_are_forty_columns_of_45_seconds(tmp_path, monkeypatch):
    router, collector = _running(tmp_path, ticks=2)
    router.busy_share = 0.9
    router.step(collector, 100)  # 500 s: about 11 columns of the 40
    client = _app_with(collector, monkeypatch).test_client()

    bars = client.get("/api/system/summary").get_json()["cards"]["cpu"]["bars"]

    assert len(bars["values"]) == 40
    lit = [(v, z) for v, z in zip(bars["values"], bars["zones"]) if v is not None]
    assert 9 <= len(lit) <= 13
    assert lit[-1][1] == 2
    assert all(v is None for v in bars["values"][:20])  # the older half has no data yet


def test_summary_link_card_and_secondary_connections(tmp_path, monkeypatch):
    router = FakeRouter(with_usb=True)
    router.rate["wwan0"] = (3, 1)
    collector = make(tmp_path, router)
    tariffs(tmp_path, {ISP: {"up_mbps": 100, "down_mbps": 400}})
    collector.refresh_tariffs()
    router.step(collector, 13)
    client = _app_with(collector, monkeypatch).test_client()

    link = client.get("/api/system/summary").get_json()["cards"]["link"]

    assert link["label"] and link["has_tariff"] is True
    assert link["up_percent"] == pytest.approx(20.0) and link["down_percent"] == pytest.approx(25.0)
    assert link["up_mbps"] == pytest.approx(20.0) and link["down_mbps"] == pytest.approx(100.0)
    assert "из 100 / 400 по тарифу" in link["text"]
    assert len(link["bars"]["up"]["values"]) == len(link["bars"]["down"]["zones"]) == 40
    assert len(link["secondary"]) == 1
    second = link["secondary"][0]
    assert second["label"] and second["up_percent"] is None and second["down_percent"] is None
    assert second["up_mbps"] == pytest.approx(1.0) and second["down_mbps"] == pytest.approx(3.0)


def test_summary_link_without_tariff_is_in_mbps(tmp_path, monkeypatch):
    _router, collector = _running(tmp_path)
    client = _app_with(collector, monkeypatch).test_client()

    link = client.get("/api/system/summary").get_json()["cards"]["link"]

    assert link["has_tariff"] is False and link["up_percent"] is None
    assert link["up_mbps"] == pytest.approx(20.0) and link["down_mbps"] == pytest.approx(100.0)
    assert link["secondary"] == []
    assert any(v is not None for v in link["bars"]["down"]["values"])


def test_summary_reports_a_problem_with_its_age(tmp_path, monkeypatch):
    router = FakeRouter()
    router.busy_share = 0.95
    collector = make(tmp_path, router)
    router.step(collector, 60)  # five minutes in the red
    client = _app_with(collector, monkeypatch).test_client()

    body = client.get("/api/system/summary").get_json()

    assert body["status"]["tone"] == "problem"
    assert [p["type"] for p in body["status"]["problems"]] == ["cpu_overload"]
    assert body["cards"]["cpu"]["zone"] == 2
    assert body["cards"]["cpu"]["text"].startswith("выше 85 % уже ")


def test_summary_router_failure_keeps_the_history_summary(tmp_path, monkeypatch):
    _router, collector = _running(tmp_path, ticks=2)
    client = _app_with(collector, monkeypatch).test_client()
    monkeypatch.setattr(resource_routes, "cached_router_diagnostics", lambda: (_ for _ in ()).throw(RuntimeError("secret")))

    response = client.get("/api/system/summary")

    assert response.status_code == 200
    assert response.get_json()["router"]["rci"]["state"] == "unavailable"
    assert "secret" not in response.get_data(as_text=True)


# -- the header monitor ------------------------------------------------------
def _devtools_app(tmp_path, monkeypatch, cpu=5.0, memory=60.0) -> Flask:
    monkeypatch.setattr(
        devtools_routes,
        "sample_system_resources",
        lambda: {"sampled_at": 10, "cpu": {"percent": cpu}, "memory": {"percent": memory, "total_bytes": 1000}},
    )
    monkeypatch.setattr(devtools_routes, "cached_router_diagnostics", lambda: {"internet": {"available": False}})
    monkeypatch.setattr(
        devtools_routes, "cached_router_system", lambda: {"available": False, "state": "unavailable", "cpu": {}, "memory": {}}
    )
    app = Flask(__name__)
    app.register_blueprint(create_devtools_blueprint(str(tmp_path)))
    return app


@pytest.mark.parametrize(
    "cpu,memory,expected",
    [(5.0, 60.0, {"cpu": 0, "memory": 0}), (60.0, 75.0, {"cpu": 1, "memory": 1}), (95.0, 80.0, {"cpu": 2, "memory": 1}), (85.0, 90.0, {"cpu": 2, "memory": 2})],
)
def test_resources_carry_the_zones_for_the_header_colours(tmp_path, monkeypatch, cpu, memory, expected):
    payload = _devtools_app(tmp_path, monkeypatch, cpu, memory).test_client().get("/api/system/resources").get_json()
    assert payload["ok"] is True
    assert payload["zones"] == expected  # the page has no thresholds of its own
    assert payload["memory"]["percent"] == memory  # the old fields stay
    assert "link" not in payload


# -- the tariff reaches the running collector at once -------------------------
class _Spy:
    def __init__(self):
        self.calls = 0

    def refresh_tariffs(self):
        self.calls += 1


def _settings_client(tmp_path, monkeypatch, collector):
    store = UISettingsStore(ui_state_dir=str(tmp_path / "state"))  # where make() puts the collector's settings
    monkeypatch.setattr(ui_settings_routes, "get_ui_settings_store", lambda: store)
    monkeypatch.setattr("services.system_resources_history.collector.get_collector", lambda: collector)
    app = Flask(__name__)
    app.register_blueprint(create_ui_settings_blueprint())
    return app.test_client()


def test_saving_a_tariff_refreshes_the_running_collector(tmp_path, monkeypatch):
    spy = _Spy()
    client = _settings_client(tmp_path, monkeypatch, spy)

    response = client.patch("/api/ui-settings", json={"diagnostics": {"tariffs": {ISP: {"up_mbps": 50, "down_mbps": 100}}}})

    assert response.status_code == 200 and spy.calls == 1


def test_a_new_tariff_applies_to_the_collector_without_a_restart(tmp_path, monkeypatch):
    router = FakeRouter()
    collector = make(tmp_path, router)
    router.step(collector, 13)
    client = _settings_client(tmp_path, monkeypatch, collector)

    client.patch("/api/ui-settings", json={"diagnostics": {"tariffs": {ISP: {"up_mbps": 50, "down_mbps": 100}}}})

    assert collector.snapshot()["links"][0]["tariff"] == {"up_mbps": 50, "down_mbps": 100}


def test_other_settings_and_rejected_tariffs_do_not_refresh_the_collector(tmp_path, monkeypatch):
    spy = _Spy()
    client = _settings_client(tmp_path, monkeypatch, spy)

    assert client.patch("/api/ui-settings", json={"editor": {"engine": "monaco"}}).status_code == 200
    bad = client.patch("/api/ui-settings", json={"diagnostics": {"tariffs": {ISP: {"up_mbps": -5, "down_mbps": 100}}}})

    assert bad.status_code == 400
    assert spy.calls == 0


def test_saving_a_tariff_without_a_collector_still_succeeds(tmp_path, monkeypatch):
    client = _settings_client(tmp_path, monkeypatch, None)

    response = client.patch("/api/ui-settings", json={"diagnostics": {"tariffs": {ISP: {"up_mbps": 50, "down_mbps": 100}}}})

    assert response.status_code == 200
