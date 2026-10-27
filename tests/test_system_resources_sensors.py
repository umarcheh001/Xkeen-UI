from __future__ import annotations

from pathlib import Path

import pytest

from services.system_resources_history.sensors import (
    ThermalZone,
    cpu_frequency,
    group_temperatures,
    memory_split,
    per_core_busy,
    procs_running,
    read_thermal_zones,
    zram_state,
)

FIXTURES = Path(__file__).parent / "fixtures" / "system_resources_sensors"

THERMAL_ROOT = "/sys/class/thermal"


def _fixture_name(path: Path) -> str:
    """Translate a /sys path into the flat file name used by the fixtures."""
    posix = path.as_posix()
    if posix.startswith(THERMAL_ROOT + "/"):
        return "thermal/" + posix[len(THERMAL_ROOT) + 1:].replace("/", "_")
    if posix.endswith("/zram0/disksize"):
        return "zram0_disksize"
    if posix.endswith("/zram0/mm_stat"):
        return "zram0_mm_stat"
    if posix.endswith("scaling_cur_freq"):
        return "cpufreq_cur"
    if posix.endswith("scaling_max_freq"):
        return "cpufreq_max"
    raise FileNotFoundError(posix)


def read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def reader(router: str):
    def _read(path: Path) -> str:
        return read(f"{router}/{_fixture_name(path)}")

    return _read


def lister(router: str):
    thermal = FIXTURES / router / "thermal"

    def _list(path: Path) -> list[str]:
        posix = path.as_posix()
        if posix == THERMAL_ROOT:
            return sorted({p.name.split("_", 2)[0] + "_" + p.name.split("_", 2)[1] for p in thermal.iterdir()})
        if posix.startswith(THERMAL_ROOT + "/"):
            prefix = posix[len(THERMAL_ROOT) + 1:] + "_"
            return sorted(p.name[len(prefix):] for p in thermal.iterdir() if p.name.startswith(prefix))
        raise FileNotFoundError(posix)

    return _list


def fixture(router: str):
    return reader(router), lister(router)


def test_nc1812_zones_and_shutdown():
    zones = read_thermal_zones(*fixture("nc1812"))
    assert len(zones) == 9
    assert [z.type for z in zones][:3] == ["soc_thermal", "mcusys_thermal0", "mcusys_thermal1"]
    assert zones[0].temp_c == pytest.approx(55.493)
    assert zones[0].shutdown_c == 125
    assert all(z.shutdown_c is None for z in zones[1:])


def test_nc1812_groups():
    groups = group_temperatures(read_thermal_zones(*fixture("nc1812")), {"wifi24": 47, "wifi5": 53})
    assert [g.id for g in groups] == ["cpu", "soc", "npu", "ports", "wifi24", "wifi5"]
    assert [g.label for g in groups] == [
        "Процессор", "Чип целиком", "Сетевой ускоритель", "Порты и коммутатор",
        "Wi‑Fi 2,4 ГГц", "Wi‑Fi 5 ГГц",
    ]
    assert len(next(g for g in groups if g.id == "ports").sensors) == 4
    assert len(next(g for g in groups if g.id == "cpu").sensors) == 2
    cpu = next(g for g in groups if g.id == "cpu")
    assert cpu.shutdown_c is None
    soc = next(g for g in groups if g.id == "soc")
    assert soc.shutdown_c == 125
    ports = next(g for g in groups if g.id == "ports")
    assert ports.value_c == pytest.approx(55.493)
    assert [g.kind for g in groups] == ["chip"] * 4 + ["wifi"] * 2
    wifi5 = groups[-1]
    assert wifi5.value_c == 53 and wifi5.shutdown_c is None


def test_kn1811_single_zone_is_cpu_and_shutdown_from_active_trip():
    groups = group_temperatures(read_thermal_zones(*fixture("kn1811")), {"wifi24": 70, "wifi5": 63})
    assert [g.id for g in groups] == ["cpu", "wifi24", "wifi5"]
    assert groups[0].value_c == pytest.approx(61.8)
    assert groups[0].shutdown_c == 125


def test_cpu_core_group_cpu_value_is_max_and_shutdown_max():
    zones = [
        ThermalZone("mcusys_thermal0", 50.0, 100.0),
        ThermalZone("mcusys_thermal1", 58.0, 110.0),
    ]
    (cpu,) = group_temperatures(zones, {})
    assert cpu.value_c == 58.0
    assert cpu.shutdown_c == 110.0
    assert cpu.sensors == [("mcusys_thermal0", 50.0), ("mcusys_thermal1", 58.0)]


def test_wifi_radio_off_gives_group_without_value():
    groups = group_temperatures([], {"wifi24": None, "wifi5": 55})
    assert [g.id for g in groups] == ["wifi24", "wifi5"]
    assert groups[0].value_c is None and groups[0].sensors == []
    assert groups[1].value_c == 55


def test_unknown_type_is_own_group():
    zones = [ThermalZone("mcusys_thermal0", 50.0, None), ThermalZone("weird_zone", 40.0, None)]
    groups = group_temperatures(zones, {})
    assert [g.id for g in groups] == ["cpu", "weird_zone"]
    assert groups[1].label == "weird_zone"


def test_single_unknown_zone_is_cpu():
    (g,) = group_temperatures([ThermalZone("cpu-thermal", 45.0, None)], {})
    assert g.id == "cpu" and g.label == "Процессор"


def test_shutdown_prefers_critical_then_largest_nonzero():
    files = {
        "thermal_zone0/type": "z",
        "thermal_zone0/temp": "40000",
        "thermal_zone0/trip_point_0_temp": "90000",
        "thermal_zone0/trip_point_0_type": "active",
        "thermal_zone0/trip_point_1_temp": "100000",
        "thermal_zone0/trip_point_1_type": "critical",
        "thermal_zone0/trip_point_2_temp": "120000",
        "thermal_zone0/trip_point_2_type": "hot",
        "thermal_zone1/type": "y",
        "thermal_zone1/temp": "41000",
        "thermal_zone1/trip_point_0_temp": "0",
        "thermal_zone1/trip_point_0_type": "active",
        "thermal_zone1/trip_point_1_temp": "85000",
        "thermal_zone1/trip_point_1_type": "hot",
    }

    def rd(path: Path) -> str:
        return files[path.relative_to(THERMAL_ROOT).as_posix()]

    def ls(path: Path) -> list[str]:
        rel = path.relative_to(THERMAL_ROOT).as_posix()
        if rel == ".":
            return ["thermal_zone0", "thermal_zone1", "cooling_device0"]
        return [k.split("/", 1)[1] for k in files if k.startswith(rel + "/")]

    z0, z1 = read_thermal_zones(rd, ls)
    assert z0.shutdown_c == 100 and z1.shutdown_c == 85


def test_unreadable_sensor_is_skipped():
    def rd(path: Path) -> str:
        if path.name == "temp" and path.parent.name == "thermal_zone1":
            raise OSError("boom")
        return reader("nc1812")(path)

    zones = read_thermal_zones(rd, lister("nc1812"))
    assert len(zones) == 8
    assert "mcusys_thermal0" not in [z.type for z in zones]


def test_missing_thermal_root_gives_no_zones():
    def ls(path: Path) -> list[str]:
        raise FileNotFoundError(path)

    assert read_thermal_zones(reader("nc1812"), ls) == []


def test_memory_split_sums_to_total():
    m = memory_split(read("kn1811/meminfo"))
    assert m["total_bytes"] == 500924 * 1024
    assert m["programs_bytes"] == (500924 - 220228) * 1024
    assert m["cache_bytes"] == (220228 - 93496) * 1024
    assert m["free_bytes"] == 93496 * 1024
    assert m["programs_bytes"] + m["cache_bytes"] + m["free_bytes"] == m["total_bytes"]
    # Brief says ~57 %, but the captured file gives 280696 / 500924 = 56.04 %.
    assert round(m["percent"]) == 56
    assert m["percent"] == pytest.approx(56.04, abs=0.01)


def test_memory_split_nc1812():
    m = memory_split(read("nc1812/meminfo"))
    assert m["programs_bytes"] + m["cache_bytes"] + m["free_bytes"] == m["total_bytes"]
    assert m["percent"] == pytest.approx((1015072 - 541360) / 1015072 * 100)


def test_memory_split_without_available_falls_back_to_free_buffers_cached():
    m = memory_split("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\n")
    assert m["free_bytes"] == 100 * 1024
    assert m["cache_bytes"] == 200 * 1024
    assert m["programs_bytes"] == 700 * 1024


def test_memory_split_garbage_is_zeroes():
    m = memory_split("")
    assert m["total_bytes"] == 0 and m["percent"] == 0.0


def test_procs_running_excludes_self():
    assert procs_running("procs_running 1\n") == 0
    assert procs_running(read("kn1811/stat")) == 2
    assert procs_running("cpu 1 2 3\n") == 0
    assert procs_running("procs_running 0\n") == 0


def test_per_core_busy():
    first = "cpu  0 0 0 0\ncpu0 100 0 100 800 0 0 0 0\ncpu1 0 0 0 1000 0 0 0 0\n"
    second = "cpu  0 0 0 0\ncpu0 150 0 150 900 0 0 0 0\ncpu1 0 0 0 1100 0 0 0 0\n"
    state, first_pct = per_core_busy({}, first)
    assert first_pct == [0.0, 0.0]
    state, pct = per_core_busy(state, second)
    assert pct == [50.0, 0.0]
    # idle counter going backwards (counter reset) must not produce garbage
    _, pct = per_core_busy(state, "cpu0 1 0 0 1\ncpu1 0 0 0 1\n")
    assert pct == [0.0, 0.0]


def test_zram():
    z = zram_state(read("nc1812/swaps"), reader("nc1812"))
    assert z == {"size_bytes": 1073741824, "used_bytes": 0}
    z = zram_state(read("kn1811/swaps"), reader("kn1811"))
    assert z["size_bytes"] == 536870912


def test_zram_used_from_swaps():
    swaps = "Filename Type Size Used Priority\n/dev/zram0 partition 524284 2048 0\n"
    assert zram_state(swaps, reader("kn1811"))["used_bytes"] == 2048 * 1024


def test_no_zram():
    assert zram_state("Filename Type Size Used Priority\n", reader("kn1811")) is None


def test_throttle():
    files = {"scaling_cur_freq": "900000", "scaling_max_freq": "1350000"}
    f = cpu_frequency(lambda p: files[p.name])
    assert f == {"current_mhz": 900, "max_mhz": 1350, "below_max": True}


def test_below_max_compares_raw_khz_not_rounded_mhz():
    files = {"scaling_cur_freq": "1349600", "scaling_max_freq": "1350000"}
    assert cpu_frequency(lambda p: files[p.name])["below_max"] is True
    files = {"scaling_cur_freq": "1350000", "scaling_max_freq": "1350000"}
    assert cpu_frequency(lambda p: files[p.name])["below_max"] is False


def test_cpufreq_kn1811_not_throttled():
    f = cpu_frequency(reader("kn1811"))
    assert f == {"current_mhz": 1350, "max_mhz": 1350, "below_max": False}


def test_no_cpufreq_on_nc1812():
    assert cpu_frequency(reader("nc1812")) is None
