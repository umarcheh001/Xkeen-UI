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
import errno
import logging
import math
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable, Literal

from services.router_diagnostics import fetch_rci_json, normalize_internet_status, sample_conntrack
from services.ui_settings import get_diagnostics_tariffs

from . import hardware as hw
from . import sensors
from . import top_procs
from .persist import load_history, save_history
from .problems import REBOOT_UPTIME_S, ProblemTracker
from .store import BACK_JUMP_RESET_S, RANGES, HistoryStore
from .zones import USUAL_MIN_POINTS, chart_bands, hotter_than_usual, red_from, temp_bands, zone, zram_pressure

log = logging.getLogger(__name__)

STEP_S = 5
MID_EVERY = 6  # ticks: 30 s
SLOW_EVERY = 12  # ticks: 60 s
CLOCK_JUMP_FORWARD_S = 3600  # two ticks this far apart: the clock was set, not the panel asleep
FAILOVER_HOLD_S = 60  # the route must stay on the reserve this long to count as a failover
MAX_RATE_DT_S = 6 * STEP_S  # a longer gap between counter reads is not a rate
TMP_SAVE_EVERY_S = 300
FLASH_SAVE_EVERY_S = 3600  # a reboot cannot save (/opt is gone before SIGTERM): this is what it may lose
INTERNET_STARTUP_GRACE_S = 120  # early negative firmware probes can mean the network is still starting
# While the router clock is not set yet, events are stamped with the uptime (far below any real
# date) and moved to real time once NTP has set the clock.
STAND_IN_BELOW = 1e9
HISTORY_FILE = "resource-history.json"
TMP_DIR = "/tmp/xkeen-ui"
BASE_METRICS = ("cpu", "memory", "queue", "online")
ZONED = ("cpu", "memory", "queue")
CARD_SPEC = ("fresh", 3, 40)  # card indicator: 40 columns of 45 s, the last 30 minutes
MIN_SECONDARY_MBPS = 0.05  # a connection below this carries no traffic worth a line

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


def _ru_number(value: float) -> str:
    return f"{value:.1f}".replace(".", ",")


def _cores_word(n: int) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} ядро"
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return f"{n} ядра"
    return f"{n} ядер"


def _duration(seconds: float) -> str:
    minutes = int(max(0.0, seconds) // 60)
    days, rest = divmod(minutes, 1440)
    hours, minutes = divmod(rest, 60)
    if days:
        return f"{days} д {hours} ч"
    if hours:
        return f"{hours} ч {minutes} мин"
    return f"{max(1, minutes)} мин"


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
        self._network_recent: deque = deque(maxlen=40)
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
        self._zone_infos: list[sensors.ZoneInfo] | None = None  # types and trips: refreshed every 60 s
        self._below_max_streak = 0  # slow samples in a row with the frequency under its maximum
        self._chip_shutdown: float | None = None
        self._ports: list[hw.Port] = []
        self._zram: dict | None = None
        self._freq: dict | None = None
        self._internet: dict = {}
        self._conntrack: dict = {"available": False}
        self._online_value: float | None = None
        self._internet_seen_online = False
        self._boot_id = (self._read("/proc/sys/kernel/random/boot_id") or "").strip()
        self._rci_ok = False  # whether the last RCI call answered
        self._events_on_uptime = False  # events are stamped with the uptime until the clock is set
        self._procs_prev: tuple[dict, int] | None = None  # the last process scan and the processor ticks then
        self._top = top_procs.TopStore()
        # persistence
        now = self._clock()
        self._last_save = {"tmp": now, "flash": now}
        self._gap_s = 0.0
        self._uptime_s = self._read_uptime()
        restored = load_history([self._paths["tmp"], self._paths["flash"]], None)
        persisted_uptime = None
        same_clock_boot = False
        clock_anchor: dict = {}
        events: list[dict] = []
        if restored is not None:
            self._store, events, saved_at, meta = restored
            # a router clock that was wrong when saving must not give a negative gap
            self._gap_s = max(0.0, now - saved_at)
            self._top = top_procs.TopStore.from_dict(meta.get("top"))
            self._internet_seen_online = bool(self._boot_id and meta.get("internet_ready_boot_id") == self._boot_id)
            raw_uptime = meta.get("uptime_s")
            if isinstance(raw_uptime, (int, float)) and not isinstance(raw_uptime, bool):
                persisted_uptime = float(raw_uptime)
            raw_anchor = meta.get("clock_anchor")
            clock_anchor = raw_anchor if isinstance(raw_anchor, dict) else {}
            anchor_wall, anchor_uptime = clock_anchor.get("wall_ts"), clock_anchor.get("uptime_s")
            same_clock_boot = bool(
                self._boot_id and meta.get("clock_origin_boot_id") == self._boot_id
                and persisted_uptime is not None and self._uptime_s is not None
                and self._uptime_s >= persisted_uptime
                and isinstance(anchor_wall, (int, float)) and math.isfinite(anchor_wall)
                and isinstance(anchor_uptime, (int, float)) and math.isfinite(anchor_uptime)
                and self._uptime_s >= anchor_uptime
            )
            if saved_at <= now or same_clock_boot:
                self._restore_network_recent(meta.get("network_recent"), saved_at)
            # Flash is written every hour counted from the copy on flash, not from this
            # start: a panel restarted more often than that must still reach the flash.
            on_flash = load_history([self._paths["flash"]], None)
            self._last_save["flash"] = min(on_flash[2], now) if on_flash is not None else 0.0
        else:
            self._store = HistoryStore(BASE_METRICS)
        for name in BASE_METRICS:
            self._store.add_metric(name)
        self._tracker = ProblemTracker(self._clock, events=events)
        self._failover_pending: tuple[str, float] | None = None
        self._boot_event: dict | None = None
        self._cold_clock = same_clock_boot or (
            restored is None and self._uptime_s is not None and 0 <= self._uptime_s < REBOOT_UPTIME_S
        )
        self._last_tick_ts = clock_anchor["wall_ts"] if same_clock_boot else now
        self._last_tick_uptime = clock_anchor["uptime_s"] if same_clock_boot else self._uptime_s
        if same_clock_boot:
            self._correct_cold_clock(now, self._uptime_s)
            self._gap_s = max(0.0, self._uptime_s - persisted_uptime)
            self._boot_event = next((e for e in reversed(self._tracker.events(0)) if e["type"] == "router_rebooted"), None)
        elif self._uptime_s is not None:
            self._boot_event = self._tracker.note_start(self._uptime_s, persisted_uptime)
            if self._boot_event is not None:  # the moment the router started, not the panel
                self._tracker.restamp(self._boot_event, now - self._uptime_s)
        self._last_tick_ts, self._last_tick_uptime = now, self._uptime_s
        self._tariffs = get_diagnostics_tariffs(ui_state_dir)

    # -- small helpers ------------------------------------------------------
    def _restore_network_recent(self, raw: Any, saved_at: float) -> None:
        """Optional metadata must never invalidate the main persisted history."""
        if not isinstance(raw, list):
            return

        def finite_number(value: Any) -> bool:
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                return False
            try:
                return math.isfinite(value)
            except OverflowError:  # JSON integers need not fit in a float
                return False

        slots: dict[int, tuple[float, dict]] = {}
        for item in raw[-40:]:
            if not isinstance(item, list) or len(item) != 2:
                continue
            at, values = item
            if (not finite_number(at) or not saved_at - 40 * STEP_S < at <= saved_at
                    or not isinstance(values, dict)):
                continue
            clean = {
                key: value for key, value in values.items()
                if key.startswith(("rate_up:", "rate_down:", "link_up:", "link_down:"))
                and (value is None or (finite_number(value) and value >= 0))
            }
            slot = int(at // STEP_S)
            if slot not in slots or at >= slots[slot][0]:
                slots[slot] = (at, clean)
        self._network_recent.extend(slots[slot] for slot in sorted(slots))

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
            answer = self._rci_fetch(path)
        except Exception:  # noqa: BLE001 - the firmware may be down; /proc data goes on
            answer = None
        self._rci_ok = answer is not None
        return answer

    def refresh_tariffs(self) -> None:
        with self._lock:
            self._tariffs = get_diagnostics_tariffs(self.ui_state_dir)

    # -- the 5 s step -------------------------------------------------------
    def _guarded(self, what: str, fn: Callable, *args: Any) -> Any:
        """Run one step; a failure is logged and the step is skipped, never the whole tick."""
        try:
            return fn(*args)
        except Exception:  # noqa: BLE001
            log.warning("resource history: %s failed", what, exc_info=True)
            return None

    def tick(self) -> None:
        # Only this thread calls tick().  Slow RCI and file reads happen outside
        # the lock, so a timing-out firmware never blocks snapshot()/history().
        now = self._clock()
        uptime = self._read_uptime()
        n = self._n
        self._n += 1
        slow = self._guarded("60 s fetch", self._fetch_slow) if n % SLOW_EVERY == 0 else None
        mid = self._guarded("30 s fetch", self._fetch_mid) if n % MID_EVERY == 0 else None
        with self._lock:
            self._correct_cold_clock(now, uptime)
            if self._event_now(now) != now:
                self._events_on_uptime = True
            elif now - self._last_tick_ts > CLOCK_JUMP_FORWARD_S:
                self._on_clock_jump(now)
            self._last_tick_ts = now
            self._last_tick_uptime = uptime
            if slow is not None:
                self._guarded("60 s apply", self._apply_slow, now, slow)
            if mid is not None:
                self._guarded("30 s apply", self._apply_mid, now, mid)
            values = self._sample_fast(now)
            self._store_and_judge(now, values)
            slot = int(now // STEP_S) * STEP_S
            previous_slot = int(self._network_recent[-1][0] // STEP_S) * STEP_S if self._network_recent else None
            if previous_slot is not None and slot < previous_slot:
                self._network_recent.clear()
            elif previous_slot is not None and slot == previous_slot:
                self._network_recent.pop()
            self._network_recent.append((now, {k: v for k, v in values.items() if k.startswith(('rate_', 'link_'))}))
        self._save_if_due(now)

    def _correct_cold_clock(self, now: float, uptime: float | None) -> None:
        if not self._cold_clock or uptime is None or self._last_tick_uptime is None or uptime < self._last_tick_uptime:
            return
        if not all(math.isfinite(value) for value in (now, uptime, self._last_tick_ts, self._last_tick_uptime)):
            return
        seconds = now - self._last_tick_ts - (uptime - self._last_tick_uptime)
        if abs(seconds) <= BACK_JUMP_RESET_S:
            return
        since = self._store.history_since
        self._store.rebase_time(seconds)
        self._network_recent = deque(
            ((at + seconds, values) for at, values in self._network_recent), maxlen=40
        )
        self._top.rebase_time(seconds, since=since)
        self._tracker.rebase_time(seconds)
        if self._boot_event is not None:
            self._tracker.restamp(self._boot_event, now - uptime)
        if self._failover_pending is not None:
            key, at = self._failover_pending
            self._failover_pending = (key, at + seconds)
        self._last_save = {kind: min(now, at + seconds) for kind, at in self._last_save.items()}
        self._last_tick_ts += seconds

    def _event_now(self, now: float) -> float:
        """The time to stamp events with: the uptime while the clock is not set yet."""
        if not self._store.clock_unset_at(now):
            return now
        uptime = self._read_uptime()
        return uptime if uptime is not None and uptime < STAND_IN_BELOW else now

    def _on_clock_set(self, now: float) -> None:
        """NTP has set the clock: events stamped with the uptime move to real time."""
        self._events_on_uptime = False
        uptime = self._read_uptime() or 0.0
        self._tracker.shift_stand_in(STAND_IN_BELOW, now - uptime)
        boot, self._boot_event = self._boot_event, None
        if boot is not None:
            self._tracker.restamp(boot, now - uptime)
        self._failover_pending = None

    def _on_clock_jump(self, now: float) -> None:
        """The clock went far forward between two ticks (NTP after boot).

        The reboot event was stamped with the unset clock: stamp it where it belongs.
        """
        self._tracker.forget_timers()
        boot, self._boot_event = self._boot_event, None
        if boot is not None:
            uptime = self._read_uptime()
            self._tracker.restamp(boot, now - (uptime if uptime is not None else 0.0))

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
        if self._zone_infos is None:  # before the first 60 s step has looked
            self._zone_infos = sensors.discover_thermal_zones(self._reader, self._lister)
        zones = sensors.read_zone_temperatures(self._zone_infos, self._reader)
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
        self._judge_failover(self._event_now(now), matched)

    def _judge_failover(self, now: float, matched: str | None) -> None:
        """wan_failover is open while the route runs through a connection that is not the main one."""
        if matched is None or self._original is None:
            return
        current = next((e for e in self._tracker.active() if e["type"] == "wan_failover"), None)
        if current is not None and current.get("key") != matched:
            self._tracker.close("wan_failover", now, current.get("key"))
            current = None
        if matched == self._original:
            self._failover_pending = None
            return
        if current is not None:
            return
        pending = self._failover_pending
        if pending is None or pending[0] != matched:  # a switch must hold before it is news
            self._failover_pending = (matched, now)
            return
        if now - pending[1] < FAILOVER_HOLD_S:
            return
        self._failover_pending = None
        label = next((c["label"] for c in self._connections if c["id"] == matched), matched)
        self._tracker.emit(
            "wan_failover", pending[1], title=f"Интернет переключился на резервное подключение {label}", key=matched
        )

    def _zone_of(self, metric: str, value: float | None, kinds: dict[str, str]) -> int | None:
        if metric.startswith(("link_up:", "link_down:")):
            return zone(metric.split(":", 1)[0], value)  # one set of thresholds for every connection
        kind = kinds.get(metric, "chip" if metric.startswith("temp:") else None)
        return zone(metric, value, cores=self._cores, kind=kind)

    def _store_and_judge(self, now: float, values: dict[str, float | None]) -> None:
        for name in values:
            self._store.add_metric(name)
        self._store.add(now, values)
        if self._events_on_uptime and not self._store.clock_unset_at(now):
            self._on_clock_set(now)
        at = self._event_now(now)
        self._values = values
        kinds = {f"temp:{g.id}": g.kind for g in self._groups}
        self._zones = {m: self._zone_of(m, v, kinds) for m, v in values.items()}
        zones: dict[str, int | None] = {k: v for k, v in self._zones.items() if k in ("cpu", "memory") or k.startswith("temp:")}
        details = {k: f"{values[k]:.0f}" for k in zones if values.get(k) is not None}
        if self._primary is not None:
            for direction in ("up", "down"):
                zones[f"link_{direction}"] = self._zones.get(f"link_{direction}:{self._primary}")
        self._tracker.update(at, zones, details)

    # -- the 30 s step ------------------------------------------------------
    def _fetch_mid(self) -> dict:
        """RCI and /proc reads of the 30 s step; no lock, no state changes."""
        out: dict = {"payload": self._rci("show/internet/status")}
        out["conntrack"] = self._guarded("conntrack", lambda: sample_conntrack(reader=self._reader))
        return out

    def _apply_mid(self, now: float, got: dict) -> None:
        if got.get("conntrack") is not None:
            self._conntrack = got["conntrack"]
        payload = got.get("payload")
        if not isinstance(payload, dict):
            self._online_value = None
            return
        now = self._event_now(now)
        status = normalize_internet_status(payload)
        online = status.get("internet")
        if online is True:
            self._internet_seen_online = True
        elif online is False and not self._internet_seen_online:
            uptime = self._read_uptime()
            if uptime is not None and 0 <= uptime < INTERNET_STARTUP_GRACE_S:
                # The first connection after boot is not a recovery from an outage.
                # Share the unknown state across the card, history and event journal.
                status = dict(status, internet=None, dns=None)
                online = None
        self._internet = status
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
    def _fetch_slow(self) -> dict:
        """RCI, parsing and file reads of the 60 s step; no lock, no state changes.

        Every part is isolated: one that fails is simply missing from the result.
        """
        out: dict = {}
        out["tariffs"] = self._guarded("tariffs", lambda: get_diagnostics_tariffs(self.ui_state_dir))
        show = self._rci("show/interface")
        if isinstance(show, dict):
            connections = self._guarded("connections", lambda: hw.internet_connections(show))
            if connections is not None:
                out["connections"] = connections
                signature = tuple((c["id"], c["interface_name"], c["connected"], c["priority"]) for c in connections)
                out["signature"] = signature
                if signature != self._conn_signature:  # system names are cached until the list changes
                    out["sysnames"] = {
                        c["id"]: hw.parse_system_name(self._rci(f"show/interface/system-name?name={c['interface_name']}"))
                        for c in connections
                    }
            out["wifi"] = self._guarded("wifi", lambda: hw.wifi_temperatures(show))
            out["ports"] = self._guarded("ports", lambda: hw.parse_ports(show))
        if self._identity["model"] is None:
            version = self._rci("show/version")
            out["identity"] = self._guarded("identity", lambda: hw.router_identity(version or {}))
        swaps = self._read("/proc/swaps") or ""
        try:  # no zram is an answer (None); a failed step is no answer and keeps the previous value
            out["zram"] = sensors.zram_state(swaps, self._reader)
        except Exception:  # noqa: BLE001
            log.warning("resource history: zram failed", exc_info=True)
        out["freq"] = self._guarded("frequency", lambda: sensors.cpu_frequency(self._reader))
        out["zones"] = self._guarded("thermal zones", lambda: sensors.discover_thermal_zones(self._reader, self._lister))
        out["procs"] = self._guarded("processes", self._scan_processes)
        return out

    def _scan_processes(self) -> tuple[dict, int] | None:
        total = top_procs.total_ticks(self._read("/proc/stat") or "")
        if total is None:
            return None
        return top_procs.scan_processes(self._reader, self._lister), total

    def _chip_zone(self) -> int:
        """Worst zone among the chip's own sensors (0 without any)."""
        zones = [zone(f"temp:{g.id}", g.value_c, kind=g.kind) for g in self._groups if g.kind == "chip" and g.value_c is not None]
        return max((z for z in zones if z is not None), default=0)

    def _apply_slow(self, now: float, got: dict) -> None:
        if got.get("tariffs") is not None:
            self._tariffs = got["tariffs"]
        if "connections" in got:
            self._guarded("apply connections", self._apply_connections, got)
        if got.get("wifi") is not None:
            self._wifi = got["wifi"]
        at = self._event_now(now)
        if got.get("ports") is not None:
            self._ports = got["ports"]
            self._guarded("port events", self._judge_ports, at)
        if got.get("identity") is not None:
            self._identity = got["identity"]
        if "zram" in got:
            self._zram = got["zram"]
        if got.get("zones") is not None:
            self._zone_infos = got["zones"]
        freq = got.get("freq")
        if freq is not None:
            # Below the maximum is what an idle governor does all day; heat is when it
            # happens twice in a row while the chip itself is warm.
            self._below_max_streak = self._below_max_streak + 1 if freq["below_max"] else 0
            freq = dict(freq, throttled=self._below_max_streak >= 2 and self._chip_zone() >= 1)
            self._freq = freq
            if freq["throttled"]:
                self._tracker.emit("cpu_throttled", at, f"{freq['current_mhz']} из {freq['max_mhz']} МГц")
            else:
                self._tracker.close("cpu_throttled", at)
        if got.get("procs") is not None:
            self._apply_processes(now, got["procs"])

    def _apply_processes(self, now: float, scan: tuple[dict, int]) -> None:
        prev, self._procs_prev = self._procs_prev, scan
        if prev is None or self._store.clock_unset:  # leaders on an unset clock would land in the wrong hour
            return
        self._top.add(now, top_procs.cpu_shares(prev[0], scan[0], scan[1] - prev[1]))
        for event in self._tracker.active():
            if event["type"] == "cpu_overload":
                leaders = self._top.window(event["at"], now)
                event["leaders"] = leaders
                if leaders:
                    event["detail"] = f"больше всех: {top_procs.leaders_text(leaders)}"

    def _judge_ports(self, now: float) -> None:
        slow = {p.id: p for p in hw.slow_ports(self._ports)}
        for port_id, port in slow.items():
            self._tracker.emit("port_slow", now, f"{port.label}: {port.speed_mbps} Мбит/с", key=port_id)
        for event in [e for e in self._tracker.active() if e["type"] == "port_slow"]:
            if event["key"] not in slow:
                self._tracker.close("port_slow", now, event["key"])

    def _apply_connections(self, got: dict) -> None:
        connections = got["connections"]
        if "sysnames" in got:
            self._sysnames = got["sysnames"]
            self._conn_signature = got["signature"]
        self._connections = connections
        self._original = connections[0]["id"] if connections else None
        if self._original is not None and self._primary not in {c["id"] for c in connections}:
            self._primary = self._original

    # -- persistence --------------------------------------------------------
    def save(self, kind: Literal["tmp", "flash"]) -> None:
        # copy the state under the lock, write the file outside it
        with self._lock:
            store = self._store.with_metrics(self._store.metrics)
            # stand-in times and the boot not yet placed in real time would be wrong for good
            pending = self._boot_event if self._events_on_uptime else None
            events = [dict(e) for e in self._tracker.events(0) if e["at"] >= STAND_IN_BELOW and e is not pending]
            meta: dict = {
                "top": self._top.to_dict(),
                "network_recent": [[at, dict(values)] for at, values in self._network_recent],
            }
            if self._internet_seen_online and self._boot_id:
                meta["internet_ready_boot_id"] = self._boot_id
            if self._cold_clock and self._boot_id:
                meta["clock_origin_boot_id"] = self._boot_id
                meta["clock_anchor"] = {"wall_ts": self._last_tick_ts, "uptime_s": self._last_tick_uptime}
            if self._uptime_s is not None:
                meta["uptime_s"] = self._uptime_s
            now = self._clock()
        save_history(self._paths[kind], store, events, now=now, meta=meta)

    def _save_if_due(self, now: float) -> None:
        if self._store.clock_unset_at(now):  # nothing for the long history yet; the copies stay as they are
            return
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
                usual = self._store.median(f"temp:{g.id}", min_points=USUAL_MIN_POINTS)
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
                        "zone": zone(f"temp:{g.id}", g.value_c, kind=g.kind),
                        "usual_c": usual,
                        "bands": temp_bands(g.kind),
                        "hotter_by_c": hotter_than_usual(g.value_c, usual) if g.value_c is not None else None,
                    }
                )
            return {
                "model": self._identity["model"],
                "firmware": self._identity["firmware"],
                "identity": dict(self._identity),
                "cores": self._cores,
                "memory_total_bytes": self._memory.get("total_bytes"),
                "memory": dict(self._memory),
                "temperatures": temps,
                "ports": [vars(p).copy() for p in self._ports],
                "slow_ports": [vars(p).copy() for p in hw.slow_ports(self._ports)],
                "zram": dict(self._zram, pressure=zram_pressure(self._zram.get("size_bytes"), self._zram.get("used_bytes"))) if self._zram else None,
                "frequency": self._freq,
                "throttle": dict(self._freq) if self._freq else None,
                "conntrack": dict(self._conntrack, zone=zone("conntrack", self._conntrack.get("percent"))),
                "links": self._links(),
            }

    # -- the summary (cards, status line) -----------------------------------
    def _bars(self, data: dict, metric: str) -> dict:
        values = list(data["metrics"].get(metric, {}).get("avg") or [None] * CARD_SPEC[2])
        return {"values": values, "zones": [self._zone_of(metric, v, {}) for v in values]}

    def _network_bars(self, metric: str, now: float) -> dict:
        latest = self._network_recent[-1][0] if self._network_recent else now
        end = int((latest if 0 <= now - latest < STEP_S else now) // STEP_S) * STEP_S
        samples = {int(at // STEP_S) * STEP_S: values for at, values in self._network_recent}
        values = [samples.get(end - offset * STEP_S, {}).get(metric) for offset in range(39, -1, -1)]
        return {'values': values, 'zones': [self._zone_of(metric, v, {}) for v in values]}

    def _problem_age(self, now: float, etype: str, key: str | None = None) -> int | None:
        """Whole minutes the open problem of this type has lasted, or ``None``."""
        now = self._event_now(now)
        for event in self._tracker.active():
            if event["type"] == etype and (key is None or event.get("key") == key):
                return max(1, int((now - event["at"]) // 60))
        return None

    def _cpu_card(self, data: dict, now: float) -> dict:
        value, z = self._values.get("cpu"), self._zones.get("cpu")
        age = self._problem_age(now, "cpu_overload")
        queue_word = {0: "небольшая", 1: "большая", 2: "забита"}.get(self._zones.get("queue"))
        if age is not None:
            text = f"выше {red_from('cpu'):.0f} % уже {age} мин"
        elif queue_word is None:
            text = _cores_word(self._cores)
        else:
            text = f"{_cores_word(self._cores)} · очередь задач {queue_word}"
        return {
            "value": value, "zone": z, "cores": self._cores, "queue": self._values.get("queue"),
            "queue_zone": self._zones.get("queue"), "text": text, "bars": self._bars(data, "cpu"),
        }

    def _memory_card(self, data: dict, now: float) -> dict:
        mem = self._memory
        mb = lambda key: round(mem.get(key, 0) / 1048576)  # noqa: E731
        age = self._problem_age(now, "memory_low")
        if age is not None:
            text = f"выше {red_from('memory'):.0f} % уже {age} мин"
        elif mem.get("total_bytes"):
            # "свободно" counts the cache like the router's own web UI does,
            # so used % + free % add up to 100 %.
            free = round((mem.get("cache_bytes", 0) + mem.get("free_bytes", 0)) / 1048576)
            text = f"программы {mb('programs_bytes')} МБ · свободно {free} МБ, из них кэш {mb('cache_bytes')} МБ"
        else:
            text = "нет данных"
        return {
            "value": self._values.get("memory"), "zone": self._zones.get("memory"), "text": text,
            "programs_bytes": mem.get("programs_bytes"), "cache_bytes": mem.get("cache_bytes"),
            "free_bytes": mem.get("free_bytes"), "total_bytes": mem.get("total_bytes"),
            "bars": self._bars(data, "memory"),
        }

    def _primary_label(self) -> str | None:
        link = next((l for l in self._links() if l["primary"]), None)
        if link is None:
            return None
        return f"{link['label']} ({link['kernel']})" if link["kernel"] else link["label"]

    def _internet_card(self, data: dict, now: float) -> dict:
        online, dns = self._internet.get("internet"), self._internet.get("dns")
        if online is True and dns is False:
            state, label, z = "dns_failed", "С перебоями", 1
        elif online is True:
            state, label, z = "online", "В сети", 0
        elif online is False:
            state, label, z = "offline", "Нет связи", 2
        else:
            state, label, z = None, "нет данных", None
        parts = []
        via = self._primary_label()
        if via:
            parts.append(f"Через {via}")
        if state == "online":
            lost = [e["until"] for e in self._tracker.events(0) if e["type"] == "internet_lost" and e.get("until") is not None]
            since = max(lost) if lost else data.get("history_since")
            if since is not None:
                parts.append(f"без перерывов {_duration(now - since)}")
        elif state == "dns_failed":
            age = self._problem_age(now, "dns_failed")
            parts.append(f"сбой DNS идёт {age} мин" if age else "сбой DNS")
        elif state == "offline":
            age = self._problem_age(now, "internet_lost")
            parts.append(f"нет связи уже {age} мин" if age else "нет связи")
        online_cols = list(data["metrics"].get("online", {}).get("avg") or [None] * CARD_SPEC[2])
        bars = {"values": online_cols, "zones": [zone("online", v) for v in online_cols]}
        return {"state": state, "label": label, "zone": z, "text": " · ".join(parts), "bars": bars}

    def _link_card(self, data: dict, now: float) -> dict | None:
        if self._primary is None:
            return None
        pid = self._primary
        link = next((l for l in self._links() if l["id"] == pid), None)
        if link is None:
            return None
        tariff_up, tariff_down = self._tariffs.get(pid, (None, None))
        has_tariff = tariff_up is not None or tariff_down is not None
        up_mbps, down_mbps = self._values.get(f"rate_up:{pid}"), self._values.get(f"rate_down:{pid}")
        up_pct, down_pct = self._values.get(f"link_up:{pid}"), self._values.get(f"link_down:{pid}")
        zones = [z for z in (self._zones.get(f"link_up:{pid}"), self._zones.get(f"link_down:{pid}")) if z is not None]
        age = self._problem_age(now, "link_saturated")
        if age is not None:
            text = f"выше {red_from('link_up'):.0f} % уже {age} мин"
        elif not has_tariff:
            text = "тариф не указан"
        elif up_mbps is None or down_mbps is None:
            text = "нет данных"
        else:
            shown = lambda v: "—" if v is None else str(v)  # noqa: E731
            text = (
                f"{_ru_number(up_mbps)} / {_ru_number(down_mbps)} Мбит/с из "
                f"{shown(tariff_up)} / {shown(tariff_down)} по тарифу"
            )
        suffix = ("link" if has_tariff else "rate")
        secondary = []
        for other in self._links():
            if other["id"] == pid:
                continue
            o_up, o_down = self._values.get(f"rate_up:{other['id']}"), self._values.get(f"rate_down:{other['id']}")
            if max(o_up or 0.0, o_down or 0.0) < MIN_SECONDARY_MBPS:
                continue
            secondary.append(
                {
                    "label": other["label"],
                    "up_percent": self._values.get(f"link_up:{other['id']}"),
                    "down_percent": self._values.get(f"link_down:{other['id']}"),
                    "up_mbps": o_up,
                    "down_mbps": o_down,
                }
            )
        return {
            "id": pid, "label": link["label"], "has_tariff": has_tariff, "tariff": link["tariff"] if has_tariff else None,
            "up_percent": up_pct, "down_percent": down_pct, "up_mbps": up_mbps, "down_mbps": down_mbps,
            "zone": max(zones) if zones else None, "text": text,
            "bars": {"up": self._network_bars(f"{suffix}_up:{pid}", now), "down": self._network_bars(f"{suffix}_down:{pid}", now), "step_s": STEP_S},
            "secondary": secondary,
        }

    def _summary(self) -> dict:
        now = self._clock()
        data = self._store.columns_spec(CARD_SPEC, now)
        problems = [dict(e) for e in self._tracker.active() if e["severity"] == "problem"]
        return {
            "status": {"tone": "problem" if problems else "ok", "problems": problems},
            "identity": dict(self._identity),
            "cards": {
                "cpu": self._cpu_card(data, now),
                "memory": self._memory_card(data, now),
                "internet": self._internet_card(data, now),
                "link": self._link_card(data, now),
            },
            "rci_available": self._rci_ok,
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
                **self._summary(),
            }

    def history(self, range_id: str) -> dict:
        with self._lock:
            data = self._store.columns(range_id, self._clock())
            kinds = {f"temp:{g.id}": g.kind for g in self._groups}
            zoned: dict[str, dict[str, list[int | None]]] = {}
            for metric, series in data["metrics"].items():
                if metric not in ZONED and metric != "online" and not metric.startswith(("link_", "temp:")):
                    continue
                zoned[metric] = {
                    key: [self._zone_of(metric, v, kinds) for v in series[key]] for key in ("avg", "max")
                }
            data["zones"] = zoned
            data["cores"] = self._cores
            data["bands"] = chart_bands(self._cores)
            data["top"] = self._top.columns(data["step_s"], data["start"], RANGES[range_id][2])
            data["links"] = self._links()
            return data

    def events(self, since: float) -> list[dict]:
        with self._lock:
            return [dict(e) for e in self._tracker.events(since)]

    def active_events(self) -> list[dict]:
        with self._lock:
            return [dict(e) for e in self._tracker.active()]

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


def flush_collector() -> bool:
    """Checkpoint RAM first, then flash; True when the flash copy was written.

    A slow flash write can outlive the bounded SIGTERM grace period. A fresh
    tmpfs copy lets the next process restore the tail even in that case.
    Neither failure prevents trying the other destination.
    """
    collector = _collector  # no module lock: the signal may arrive while it is held
    if collector is None:
        return False
    try:
        collector.save("tmp")
    except Exception:  # noqa: BLE001 - flash may still be writable
        log.warning("resource history: tmp save on SIGTERM failed", exc_info=True)
    try:
        collector.save("flash")
    except OSError as exc:
        if exc.errno != errno.EROFS:
            log.warning("resource history: save on SIGTERM failed", exc_info=True)
            return False
        # On reboot tmpfs will be lost too; the hourly flash copy stays.
        log.info("resource history: /opt is read-only (reboot), the hourly flash copy is kept")
        return False
    except Exception:  # noqa: BLE001
        log.warning("resource history: save on SIGTERM failed", exc_info=True)
        return False
    return True


def install_terminate_save() -> bool:
    """On SIGTERM save the history to RAM and flash, then die with the signal.

    ``atexit`` never runs on SIGTERM, and the init script stops the panel with it.
    Returns False where the signal cannot be handled (not the main thread).
    """
    import signal

    sigterm = getattr(signal, "SIGTERM", None)
    if sigterm is None:
        return False

    def _on_term(signum, frame=None):  # noqa: ANN001
        flush_collector()
        try:
            signal.signal(sigterm, signal.SIG_DFL)
            os.kill(os.getpid(), sigterm)
        except Exception:  # noqa: BLE001
            os._exit(0)

    try:
        signal.signal(sigterm, _on_term)
    except (ValueError, OSError):
        return False
    return True
