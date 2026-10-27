"""Journal of router problems and events.

Zone-driven problems (cpu, memory, link, temperature) follow one rule: the
metric stays in the red zone for 3 minutes in a row - a problem starts; it is
out of red for 2 minutes - the problem ends.  A ``None`` zone (no data) is a
gap: it neither starts nor ends anything.  Edge-driven events (internet loss,
throttling, slow port ...) are opened and closed by the collector through
``emit`` / ``close``.  A zone-driven problem whose metric stops reporting for 2 minutes (or whose key
vanishes) ends at the last time it was seen.  Events are plain JSON-serialisable
dicts kept 7 days, at most ``MAX_EVENTS`` of them.
"""

from __future__ import annotations

import math
from typing import Callable

RED_HOLD_S = 180.0
CLEAR_HOLD_S = 120.0
RETENTION_S = 7 * 24 * 3600
REBOOT_UPTIME_S = 600.0
MAX_EVENTS = 500  # the journal keeps this many newest events (open ones never leave)
POINT_MERGE_S = 60.0  # a point event repeated within this time is the same moment

# type -> (severity, title)
_TYPES: dict[str, tuple[str, str]] = {
    "internet_lost": ("problem", "Связь с интернетом потеряна"),
    "internet_restored": ("info", "Связь с интернетом восстановлена"),
    "dns_failed": ("problem", "Не отвечает DNS"),
    "cpu_overload": ("problem", "Процессор перегружен"),
    "memory_low": ("problem", "Память занята больше чем на 90 %"),
    "link_saturated": ("problem", "Канал забит"),
    "overheat": ("problem", "Перегрев"),
    "cpu_throttled": ("problem", "Процессор замедлился из-за нагрева"),
    "port_slow": ("warning", "Порт работает на 100 Мбит/с"),
    "router_rebooted": ("info", "Роутер перезагружен"),
    "wan_failover": ("warning", "Интернет переключился на резервное подключение"),
}
# events that are a moment, not a state: they are born closed
_POINT = {"internet_restored", "router_rebooted"}
# opened and closed by zones (the others by the collector)
_ZONE_TYPES = {"cpu_overload", "memory_low", "link_saturated", "overheat"}


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _zone_type(key: str) -> str | None:
    if key == "cpu":
        return "cpu_overload"
    if key == "memory":
        return "memory_low"
    if key in ("link_up", "link_down"):
        return "link_saturated"
    if key.startswith("temp:"):
        return "overheat"
    return None


class ProblemTracker:
    def __init__(self, clock: Callable[[], float], events: list[dict] | None = None):
        self._clock = clock
        self._events: list[dict] = []
        self._open: dict[str, dict] = {}  # "type|key" -> open event
        self._red_since: dict[str, float] = {}
        self._clear_since: dict[str, float] = {}
        self._last_seen: dict[str, float] = {}  # slot -> last time its metric reported
        self._seq = 0
        for e in events or []:
            if not isinstance(e, dict) or e.get("type") not in _TYPES or not _is_number(e.get("at")):
                continue
            # a stored journal can be hand-edited or half-written: never crash on it
            if not isinstance(e.get("id"), str) or (e.get("until") is not None and not _is_number(e.get("until"))):
                continue
            ev = dict(e)
            ev.setdefault("until", None)
            self._events.append(ev)
            if ev["until"] is None:
                self._open[f"{ev['type']}|{ev.get('key') or ''}"] = ev

    # -- events -----------------------------------------------------------
    def _prune(self, now: float) -> None:
        limit = now - RETENTION_S
        kept = [e for e in self._events if e.get("until") is None or e["until"] >= limit]
        excess = len(kept) - MAX_EVENTS
        if excess > 0:  # drop the oldest finished events; the open ones stay
            dropped: set[str] = set()
            for e in sorted(kept, key=lambda e: e["at"]):
                if excess <= 0:
                    break
                if e.get("until") is not None:
                    dropped.add(e["id"])
                    excess -= 1
            kept = [e for e in kept if e["id"] not in dropped]
        if len(kept) != len(self._events):
            alive = {e["id"] for e in kept}
            self._open = {k: e for k, e in self._open.items() if e["id"] in alive}
            self._events = kept

    def _open_event(self, etype: str, at: float, detail: str, title: str | None, key: str | None) -> dict:
        slot = f"{etype}|{key or ''}"
        if slot in self._open:
            return self._open[slot]
        if etype in _POINT:  # a flapping producer must not fill the journal with one moment
            for old in reversed(self._events[-20:]):
                if old["type"] == etype and (old.get("key") or "") == (key or "") and abs(at - old["at"]) <= POINT_MERGE_S:
                    return old
        severity, default_title = _TYPES[etype]
        if title is None:
            title = default_title
            if etype == "port_slow" and key:
                title = f"Порт {key} работает на 100 Мбит/с"
        self._seq += 1
        ev = {
            "id": f"{etype}-{int(at)}-{self._seq}",
            "type": etype,
            "at": at,
            "until": at if etype in _POINT else None,
            "severity": severity,
            "title": title,
            "detail": detail,
            "key": key or "",
        }
        self._events.append(ev)
        if etype not in _POINT:
            self._open[slot] = ev
        self._prune(at)
        return ev

    def emit(self, type: str, at: float, detail: str = "", *, title: str | None = None, key: str | None = None) -> dict:
        """Open an event right away (no 3-minute wait); an already open one is returned as is."""
        return self._open_event(type, at, detail, title, key)

    def close(self, type: str, at: float, key: str | None = None) -> dict | None:
        ev = self._open.pop(f"{type}|{key or ''}", None)
        if ev is not None:
            ev["until"] = max(at, ev["at"])  # a clock that went back must not end it before it began
        return ev

    # -- zone-driven problems --------------------------------------------
    def update(self, ts: float, zones: dict[str, int | None], details: dict[str, str]) -> list[dict]:
        """Feed the current zones; returns events opened or closed by this call."""
        changed: list[dict] = []
        seen: set[str] = set()
        for key, z in zones.items():
            etype = _zone_type(key)
            if etype is None or z is None:
                continue
            slot = f"{etype}|{key}"
            seen.add(slot)
            self._last_seen[slot] = ts
            if z == 2:
                self._clear_since.pop(slot, None)
                since = self._red_since.setdefault(slot, ts)
                if slot not in self._open and ts - since >= RED_HOLD_S:
                    changed.append(self._open_event(etype, since, details.get(key, ""), None, key))
            else:
                self._red_since.pop(slot, None)
                if slot in self._open:
                    since = self._clear_since.setdefault(slot, ts)
                    if ts - since >= CLEAR_HOLD_S:
                        del self._clear_since[slot]
                        changed.append(self.close(etype, since, key))
        # no data (None or vanished key) is a gap: restart both timers
        for timers in (self._red_since, self._clear_since):
            for slot in [k for k in timers if k not in seen]:
                del timers[slot]
        # ... but a problem whose metric is gone for good does not stay open forever
        for slot, ev in list(self._open.items()):
            if slot in seen or ev["type"] not in _ZONE_TYPES:
                continue
            last = self._last_seen.setdefault(slot, ts)  # restored: counted from the first look
            if ts - last > CLEAR_HOLD_S:
                closed = self.close(ev["type"], last, ev.get("key") or None)
                if closed is not None:
                    changed.append(closed)
        for slot in [k for k in self._last_seen if k not in self._open and k not in seen]:
            del self._last_seen[slot]
        self._prune(ts)
        return changed

    def active(self) -> list[dict]:
        return [e for e in self._events if e.get("until") is None]

    def events(self, since: float) -> list[dict]:
        return [e for e in self._events if e["at"] >= since or e.get("until") is None]

    def note_start(self, uptime_s: float, persisted_uptime_s: float | None) -> dict | None:
        if uptime_s < REBOOT_UPTIME_S or (persisted_uptime_s is not None and uptime_s < persisted_uptime_s):
            return self.emit("router_rebooted", self._clock())
        return None

    def restamp(self, event: dict, at: float) -> None:
        """Move a point event to another time (the clock was set after it was stamped)."""
        event["at"] = at
        if event.get("until") is not None:
            event["until"] = at

    def shift_stand_in(self, below: float, by: float) -> None:
        """Times under ``below`` were taken on a stand-in clock (uptime): move them by ``by``."""
        for ev in self._events:
            if ev["at"] < below:
                ev["at"] += by
            if ev.get("until") is not None and ev["until"] < below:
                ev["until"] += by
        for stamps in (self._red_since, self._clear_since, self._last_seen):
            for slot, at in stamps.items():
                if at < below:
                    stamps[slot] = at + by

    def forget_timers(self) -> None:
        """The clock jumped: red/clear stopwatches started before it mean nothing now."""
        self._red_since.clear()
        self._clear_since.clear()
