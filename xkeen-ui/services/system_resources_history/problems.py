"""Journal of router problems and events.

Zone-driven problems (cpu, memory, link, temperature) follow one rule: the
metric stays in the red zone for 3 minutes in a row - a problem starts; it is
out of red for 2 minutes - the problem ends.  A ``None`` zone (no data) is a
gap: it neither starts nor ends anything.  Edge-driven events (internet loss,
throttling, slow port ...) are opened and closed by the collector through
``emit`` / ``close``.  Events are plain JSON-serialisable dicts kept 7 days.
"""

from __future__ import annotations

import math
from typing import Callable

RED_HOLD_S = 180.0
CLEAR_HOLD_S = 120.0
RETENTION_S = 7 * 24 * 3600
REBOOT_UPTIME_S = 600.0

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
        if len(kept) != len(self._events):
            alive = {e["id"] for e in kept}
            self._open = {k: e for k, e in self._open.items() if e["id"] in alive}
            self._events = kept

    def _open_event(self, etype: str, at: float, detail: str, title: str | None, key: str | None) -> dict:
        slot = f"{etype}|{key or ''}"
        if slot in self._open:
            return self._open[slot]
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
            ev["until"] = at
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
        self._prune(ts)
        return changed

    def active(self) -> list[dict]:
        return [e for e in self._events if e.get("until") is None]

    def events(self, since: float) -> list[dict]:
        return [e for e in self._events if e["at"] >= since or e.get("until") is None]

    def note_start(self, uptime_s: float, persisted_uptime_s: float | None) -> None:
        if uptime_s < REBOOT_UPTIME_S or (persisted_uptime_s is not None and uptime_s < persisted_uptime_s):
            self.emit("router_rebooted", self._clock())
