"""Background collector of the router-resources history.

One daemon thread (``xkeen-resource-history``, the loop follows
``services/memory_guard.py``) takes a sample every 5 s: processor, memory, task
queue, thermal sensors and the byte counters of every internet connection.
Slower RCI data is refreshed by tick counting: internet and DNS availability and
conntrack every 30 s; connections, Wi-Fi temperature, ports, zram and processor
frequency every 60 s.  Everything outside the process (``/proc``, ``/sys``,
RCI, the clock, sleeping) is injected so tests never start the thread.

Metrics: ``cpu, memory, queue, online`` plus, per connection,
``rate_up:<id>, rate_down:<id>`` (Mbit/s), ``link_up:<id>, link_down:<id>``
(percent of that connection's tariff) and per sensor group ``temp:<group>``.
A sample which cannot be trusted (first one, counters that went backwards, the
connection's kernel interface changed, a clock jump) is stored as "no data",
never as a rate.
"""

from __future__ import annotations

import atexit
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Literal

from services.router_diagnostics import fetch_rci_json, normalize_internet_status, sample_conntrack
from services.ui_settings import get_diagnostics_tariffs

from . import hardware as hw
from . import sensors
from .persist import load_history, save_history
from .problems import ProblemTracker
from .store import HistoryStore
from .zones import hotter_than_usual, zone

log = logging.getLogger(__name__)

STEP_S = 5
MID_EVERY = 6  # ticks: 30 s
SLOW_EVERY = 12  # ticks: 60 s
MAX_RATE_DT_S = 6 * STEP_S  # a longer gap between counter reads is not a rate
TMP_SAVE_EVERY_S = 300
FLASH_SAVE_EVERY_S = 21600
HISTORY_FILE = "resource-history.json"
TMP_DIR = "/tmp/xkeen-ui"
BASE_METRICS = ("cpu", "memory", "queue", "online")
ZONED = ("cpu", "memory", "queue")

Reader = Callable[[Path], str]


def _default_reader(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def parse_net_dev(text: str) -> dict[str, tuple[int, int]]:
    """``{interface: (received bytes, sent bytes)}`` from ``/proc/net/dev``."""
    counters: dict[str, tuple[int, int]] = {}
    for line in str(text or "").splitlines():
        name, sep, rest = line.partition(":")
        fields = rest.split()
        if not sep or len(fields) < 9:
            continue
        try:
            counters[name.strip()] = (int(fields[0]), int(fields[8]))
        except ValueError:
            continue
    return counters


def _first_number(text: str) -> float | None:
    try:
        return float(str(text).split()[0])
    except (IndexError, ValueError):
        return None


class Collector:
    def __init__(
        self,
        ui_state_dir: str,
        *,
        reader: Reader = _default_reader,
        clock: Callable[[], float] = time.time,
        sleeper: Callable[[float], Any] | None = None,
        rci: Callable[[str], Any] = fetch_rci_json,
        tmp_dir: str = TMP_DIR,
        lister: Callable[[Path], "list[str]"] | None = None,
    ) -> None:
        self.ui_state_dir = ui_state_dir
        self._reader = reader
        self._clock = clock
        self._rci_fetch = rci
        self._lister = lister or sensors._default_lister
        self._stop = threading.Event()
        self._sleeper = sleeper or self._stop.wait
        self._thread: threading.Thread | None = None
        self._lock = threading.RLock()
        self._paths = {
            "tmp": os.path.join(tmp_dir, HISTORY_FILE),
            "flash": os.path.join(ui_state_dir, HISTORY_FILE),
        }
        self._n = 0
        self._values: dict[str, float | None] = {}
        self._zones: dict[str, int | None] = {}
        self._cpu_prev: dict = {}
        self._cores = 1
        self._per_core: list[float] = []
        self._memory: dict = {}
        self._uptime_s: float | None = None
        # RCI-derived state
        self._connections: list[dict] = []
        self._conn_signature: tuple | None = None
        self._sysnames: dict[str, str | None] = {}
        self._primary: str | None = None
        self._original: str | None = None
        self._prev_net: dict[str, tuple[str, int, int, float]] = {}
        self._tariffs: dict[str, tuple[int | None, int | None]] = {}
        self._show_interface: dict = {}
        self._identity: dict = {"model": None, "firmware": None}
        self._wifi: dict[str, float | None] = {}
        self._groups: list[sensors.TempGroup] = []
        self._chip_shutdown: float | None = None
        self._ports: list[hw.Port] = []
        self._zram: dict | None = None
        self._freq: dict | None = None
        self._internet: dict = {}
        self._conntrack: dict = {"available": False}
        self._online_value: float | None = None
        self._pruned = False
        # persistence
        now = self._clock()
        self._last_save = {"tmp": now, "flash": now}
        self._gap_s = 0.0
        self._uptime_s = self._read_uptime()
        restored = load_history([self._paths["tmp"], self._paths["flash"]], None)
        persisted_uptime = None
        events: list[dict] = []
        if restored is not None:
            self._store, events, saved_at, meta = restored
            # a router clock that was wrong when saving must not give a negative gap
            self._gap_s = max(0.0, now - saved_at)
            raw_uptime = meta.get("uptime_s")
            if isinstance(raw_uptime, (int, float)) and not isinstance(raw_uptime, bool):
                persisted_uptime = float(raw_uptime)
        else:
            self._store = HistoryStore(BASE_METRICS)
        for name in BASE_METRICS:
            self._store.add_metric(name)
        self._tracker = ProblemTracker(self._clock, events=events)
        if self._uptime_s is not None:
            self._tracker.note_start(self._uptime_s, persisted_uptime)
        self._tariffs = get_diagnostics_tariffs(ui_state_dir)

    # -- small helpers ------------------------------------------------------
    def _read(self, path: str) -> str | None:
        try:
            return self._reader(Path(path))
        except (OSError, ValueError):
            return None

    def _read_uptime(self) -> float | None:
        text = self._read("/proc/uptime")
        return _first_number(text) if text else None

    def _rci(self, path: str) -> Any:
        try:
            return self._rci_fetch(path)
        except Exception:  # noqa: BLE001 - the firmware may be down; /proc data goes on
            return None

    def refresh_tariffs(self) -> None:
        with self._lock:
            self._tariffs = get_diagnostics_tariffs(self.ui_state_dir)

    # -- the 5 s step -------------------------------------------------------
    def tick(self) -> None:
        with self._lock:
            now = self._clock()
            n = self._n
            self._n += 1
            if n % SLOW_EVERY == 0:
                self._refresh_slow(now)
            if n % MID_EVERY == 0:
                self._refresh_mid(now)
            values = self._sample_fast(now)
            self._store_and_judge(now, values)
            self._save_if_due(now)

    def _sample_fast(self, now: float) -> dict[str, float | None]:
        values: dict[str, float | None] = {"online": self._online_value}
        stat = self._read("/proc/stat")
        values["cpu"] = None
        values["queue"] = None
        if stat:
            had_prev = bool(self._cpu_prev)
            self._cpu_prev, percents = sensors.per_core_busy(self._cpu_prev, stat)
            if percents:
                self._cores = len(percents)
                self._per_core = percents if had_prev else []
                if had_prev:  # the first sample has no interval: no data, not idle
                    values["cpu"] = sum(percents) / len(percents)
            values["queue"] = float(sensors.procs_running(stat))
        meminfo = self._read("/proc/meminfo")
        values["memory"] = None
        if meminfo:
            self._memory = sensors.memory_split(meminfo)
            if self._memory["total_bytes"]:
                values["memory"] = self._memory["percent"]
        self._uptime_s = self._read_uptime()
        values.update(self._sample_links(now))
        zones = sensors.read_thermal_zones(self._reader, self._lister)
        shutdowns = [z.shutdown_c for z in zones if z.shutdown_c is not None]
        self._chip_shutdown = max(shutdowns) if shutdowns else None
        self._groups = sensors.group_temperatures(zones, self._wifi)
        for group in self._groups:
            values[f"temp:{group.id}"] = group.value_c
        return values

    def _sample_links(self, now: float) -> dict[str, float | None]:
        values: dict[str, float | None] = {}
        counters = parse_net_dev(self._read("/proc/net/dev") or "")
        for conn in self._connections:
            cid = conn["id"]
            up = down = None
            kernel = self._sysnames.get(cid)
            current = counters.get(kernel) if kernel else None
            if current is not None:
                prev = self._prev_net.get(cid)
                self._prev_net[cid] = (kernel, current[0], current[1], now)
                if prev is not None and prev[0] == kernel and 0 < now - prev[3] <= MAX_RATE_DT_S:
                    d_rx, d_tx = current[0] - prev[1], current[1] - prev[2]
                    if d_rx >= 0 and d_tx >= 0:  # a reset counter gives no point
                        dt = now - prev[3]
                        down, up = d_rx * 8 / dt / 1e6, d_tx * 8 / dt / 1e6
            else:
                self._prev_net.pop(cid, None)
            tariff_up, tariff_down = self._tariffs.get(cid, (None, None))
            values[f"rate_up:{cid}"] = up
            values[f"rate_down:{cid}"] = down
            values[f"link_up:{cid}"] = up / tariff_up * 100 if up is not None and tariff_up else None
            values[f"link_down:{cid}"] = down / tariff_down * 100 if down is not None and tariff_down else None
        self._update_primary(now, self._read("/proc/net/route") or "")
        return values

    def _update_primary(self, now: float, route: str) -> None:
        kernel = hw.default_route_iface(route)
        matched = next((c["id"] for c in self._connections if kernel and self._sysnames.get(c["id"]) == kernel), None)
        if matched is not None:
            self._primary = matched
        elif self._primary is None and self._connections:
            self._primary = self._connections[0]["id"]
        self._judge_failover(now, matched)

    def _judge_failover(self, now: float, matched: str | None) -> None:
        """wan_failover is open while the route runs through a connection that is not the main one."""
        if matched is None or self._original is None:
            return
        current = next((e for e in self._tracker.active() if e["type"] == "wan_failover"), None)
        if current is not None and current.get("key") != matched:
            self._tracker.close("wan_failover", now, current.get("key"))
            current = None
        if matched == self._original or current is not None:
            return
        label = next((c["label"] for c in self._connections if c["id"] == matched), matched)
        self._tracker.emit(
            "wan_failover", now, title=f"Интернет переключился на резервное подключение {label}", key=matched
        )

    def _zone_of(self, metric: str, value: float | None, kinds: dict[str, str]) -> int | None:
        if metric.startswith(("link_up:", "link_down:")):
            return zone(metric.split(":", 1)[0], value)  # one set of thresholds for every connection
        kind = kinds.get(metric, "chip" if metric.startswith("temp:") else None)
        return zone(metric, value, cores=self._cores, kind=kind)

    def _store_and_judge(self, now: float, values: dict[str, float | None]) -> None:
        for name in values:
            self._store.add_metric(name)
        if not self._pruned and self._conn_signature is not None:
            self._prune_vanished(values)
        self._store.add(now, values)
        self._values = values
        kinds = {f"temp:{g.id}": g.kind for g in self._groups}
        self._zones = {m: self._zone_of(m, v, kinds) for m, v in values.items()}
        zones: dict[str, int | None] = {k: v for k, v in self._zones.items() if k in ("cpu", "memory") or k.startswith("temp:")}
        details = {k: f"{values[k]:.0f}" for k in zones if values.get(k) is not None}
        if self._primary is not None:
            for direction in ("up", "down"):
                zones[f"link_{direction}"] = self._zones.get(f"link_{direction}:{self._primary}")
        self._tracker.update(now, zones, details)

    def _prune_vanished(self, values: dict[str, float | None]) -> None:
        """At the first look at the router drop series of connections and sensors that no longer exist."""
        self._pruned = True
        wanted = set(BASE_METRICS) | set(values)
        if set(self._store.metrics) - wanted:
            keep = [m for m in self._store.metrics if m in wanted]
            keep += [m for m in values if m not in keep]
            self._store = self._store.with_metrics(keep)

    # -- the 30 s step ------------------------------------------------------
    def _refresh_mid(self, now: float) -> None:
        payload = self._rci("show/internet/status")
        self._conntrack = sample_conntrack(reader=self._reader)
        if not isinstance(payload, dict):
            self._online_value = None
            return
        status = normalize_internet_status(payload)
        self._internet = status
        online = status.get("internet")
        self._online_value = None if online is None else (1.0 if online else 0.0)
        if online is True:
            if self._tracker.close("internet_lost", now) is not None:
                self._tracker.emit("internet_restored", now)
            if status.get("dns") is False:
                self._tracker.emit("dns_failed", now)
            elif status.get("dns") is True:
                self._tracker.close("dns_failed", now)
        elif online is False:
            self._tracker.emit("internet_lost", now)
            self._tracker.close("dns_failed", now)

    # -- the 60 s step ------------------------------------------------------
    def _refresh_slow(self, now: float) -> None:
        self._tariffs = get_diagnostics_tariffs(self.ui_state_dir)
        show = self._rci("show/interface")
        if isinstance(show, dict):
            self._show_interface = show
            self._apply_connections(hw.internet_connections(show))
            self._wifi = hw.wifi_temperatures(show)
            self._ports = hw.parse_ports(show)
            slow = {p.id: p for p in hw.slow_ports(self._ports)}
            for port_id, port in slow.items():
                self._tracker.emit("port_slow", now, f"{port.label}: {port.speed_mbps} Мбит/с", key=port_id)
            for event in [e for e in self._tracker.active() if e["type"] == "port_slow"]:
                if event["key"] not in slow:
                    self._tracker.close("port_slow", now, event["key"])
        if self._identity["model"] is None:
            self._identity = hw.router_identity(self._rci("show/version") or {})
        self._zram = sensors.zram_state(self._read("/proc/swaps") or "", self._reader)
        freq = sensors.cpu_frequency(self._reader)
        if freq is not None:
            self._freq = freq
            if freq["throttled"]:
                self._tracker.emit("cpu_throttled", now, f"{freq['current_mhz']} из {freq['max_mhz']} МГц")
            else:
                self._tracker.close("cpu_throttled", now)

    def _apply_connections(self, connections: list[dict]) -> None:
        signature = tuple((c["id"], c["interface_name"], c["connected"], c["priority"]) for c in connections)
        if signature != self._conn_signature:  # system names are cached until the list changes
            self._sysnames = {}
            for conn in connections:
                name = self._rci(f"show/interface/system-name?name={conn['interface_name']}")
                self._sysnames[conn["id"]] = hw.parse_system_name(name)
            self._conn_signature = signature
        self._connections = connections
        self._original = connections[0]["id"] if connections else None
        if self._original is not None and self._primary not in {c["id"] for c in connections}:
            self._primary = self._original

    # -- persistence --------------------------------------------------------
    def save(self, kind: Literal["tmp", "flash"]) -> None:
        with self._lock:
            meta = {"uptime_s": self._uptime_s} if self._uptime_s is not None else None
            save_history(self._paths[kind], self._store, self._tracker.events(0), now=self._clock(), meta=meta)

    def _save_if_due(self, now: float) -> None:
        for kind, every in (("tmp", TMP_SAVE_EVERY_S), ("flash", FLASH_SAVE_EVERY_S)):
            if now < self._last_save[kind]:  # the clock went back: count from here
                self._last_save[kind] = now
            if now - self._last_save[kind] >= every:
                self._last_save[kind] = now
                try:
                    self.save(kind)
                except Exception:  # noqa: BLE001 - a full disk must not stop sampling
                    log.warning("resource history: save to %s failed", kind, exc_info=True)

    # -- reading ------------------------------------------------------------
    def _links(self) -> list[dict]:
        links = []
        for conn in self._connections:
            up, down = self._tariffs.get(conn["id"], (None, None))
            links.append(
                {
                    "id": conn["id"],
                    "label": conn["label"],
                    "kernel": self._sysnames.get(conn["id"]),
                    "primary": conn["id"] == self._primary,
                    "priority": conn["priority"],
                    "connected": conn["connected"],
                    "tariff": {"up_mbps": up, "down_mbps": down},
                }
            )
        return links

    def hardware(self) -> dict:
        with self._lock:
            temps = []
            for g in self._groups:
                usual = self._store.median(f"temp:{g.id}")
                shutdown = g.shutdown_c
                if shutdown is None and g.kind == "chip":
                    shutdown = self._chip_shutdown  # chip-wide trip for sensors without their own
                temps.append(
                    {
                        "id": g.id,
                        "label": g.label,
                        "kind": g.kind,
                        "value_c": g.value_c,
                        "sensors": [{"name": n, "value_c": v} for n, v in g.sensors],
                        "shutdown_c": shutdown,
                        "usual_c": usual,
                        "hotter_by_c": hotter_than_usual(g.value_c, usual) if g.value_c is not None else None,
                    }
                )
            return {
                "model": self._identity["model"],
                "firmware": self._identity["firmware"],
                "cores": self._cores,
                "memory_total_bytes": self._memory.get("total_bytes"),
                "temperatures": temps,
                "ports": [vars(p).copy() for p in self._ports],
                "zram": self._zram,
                "frequency": self._freq,
                "links": self._links(),
            }

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "ts": self._clock(),
                "values": dict(self._values),
                "zones": dict(self._zones),
                "problems": [dict(e) for e in self._tracker.active()],
                "primary": self._primary,
                "links": self._links(),
                "memory": dict(self._memory),
                "cores": self._cores,
                "per_core": list(self._per_core),
                "uptime_s": self._uptime_s,
                "internet": dict(self._internet),
                "conntrack": dict(self._conntrack),
                "restored_gap_s": self._gap_s,
                "hardware": self.hardware(),
            }

    def history(self, range_id: str) -> dict:
        with self._lock:
            data = self._store.columns(range_id, self._clock())
            kinds = {f"temp:{g.id}": g.kind for g in self._groups}
            zoned: dict[str, dict[str, list[int | None]]] = {}
            for metric, series in data["metrics"].items():
                if metric not in ZONED and not metric.startswith(("link_", "temp:")):
                    continue
                zoned[metric] = {
                    key: [self._zone_of(metric, v, kinds) for v in series[key]] for key in ("avg", "max")
                }
            data["zones"] = zoned
            data["cores"] = self._cores
            return data

    def events(self, since: float) -> list[dict]:
        with self._lock:
            return [dict(e) for e in self._tracker.events(since)]

    # -- thread -------------------------------------------------------------
    def _run(self) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - one bad sample must not end the history
                log.warning("resource history: tick failed", exc_info=True)
            self._sleeper(max(0.5, STEP_S - (time.monotonic() - started)))

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="xkeen-resource-history", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)
        try:
            self.save("flash")
        except Exception:  # noqa: BLE001
            log.warning("resource history: final save failed", exc_info=True)


_lock = threading.Lock()
_collector: Collector | None = None
_atexit_registered = False


def start_collector(*, ui_state_dir: str) -> Collector:
    global _collector, _atexit_registered
    with _lock:
        if _collector is None:
            _collector = Collector(ui_state_dir, tmp_dir=TMP_DIR)
        _collector.start()
        if not _atexit_registered:
            atexit.register(stop_collector)
            _atexit_registered = True
        return _collector


def get_collector() -> Collector | None:
    with _lock:
        return _collector


def stop_collector() -> None:
    global _collector
    with _lock:
        collector, _collector = _collector, None
    if collector is not None:
        collector.stop()
