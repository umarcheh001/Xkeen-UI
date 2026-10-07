"""Read-only LTE modem transport probing.

The service deliberately keeps transport paths and command output out of its
public DTOs. A modem is selected by its normalised RCI id and IMEI matching is
required before a QMI or TTY transport is reported as available.
"""

from __future__ import annotations

import copy
import glob
import os
import re
import select
import stat
import subprocess
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

try:
    import termios
except ImportError:  # pragma: no cover - exercised by Windows import tests
    termios = None  # type: ignore[assignment]

from services.router_diagnostics import fetch_rci_json, sample_router_lte


MODEM_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
IMEI_RE = re.compile(r"(?<!\d)(\d{14,17})(?!\d)")
PROBE_TIMEOUT_SECONDS = 3.0
# The probe endpoint runs synchronously in the browser request. Keep identity
# checks below the browser timeout even when the router exposes many stale
# transport candidates.
MODEM_PROBE_DEADLINE_SECONDS = 12.0
MAX_TTY_RESPONSE_BYTES = 2048
_SNAPSHOT_LIMITS = {
    "id": 64, "name": 96, "operator": 96, "technology": 32,
    "connection_state": 32, "address": 64, "mask": 64, "band": 32,
    "apn": 96, "base_station": 64, "enb_id": 32, "sector_id": 32,
    "tac": 32, "phy_cell_id": 32, "model": 128, "manufacturer": 96,
    "firmware": 256,
}


class ModemControlError(RuntimeError):
    """An expected, safe-to-serialise modem control failure."""

    def __init__(self, code: str, message: str | None = None):
        self.code = str(code)
        self.message = message or self.code
        super().__init__(self.code)


def validate_modem_id(value: Any) -> str:
    if not isinstance(value, str) or not MODEM_ID_RE.fullmatch(value):
        raise ValueError("invalid_modem_id")
    return value


@dataclass(frozen=True)
class ModemControlProbe:
    modem: Mapping[str, Any]
    preferred_transport: str | None
    transports: tuple[Mapping[str, Any], ...]
    code: str | None = None
    sampled_at: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "modem": copy.deepcopy(dict(self.modem)),
            "preferred_transport": self.preferred_transport,
            "transports": copy.deepcopy([dict(item) for item in self.transports]),
            "sampled_at": self.sampled_at,
        }
        if self.code:
            result["code"] = self.code
        return result


def _default_device_enumerator() -> dict[str, list[str]]:
    """Return only character devices owned by the router's modem namespace."""

    result: dict[str, list[str]] = {"qmi": [], "tty": []}
    for kind, pattern in (("qmi", "/dev/cdc-wdm*"), ("tty", "/dev/ttyUSB*")):
        for path in sorted(glob.glob(pattern)):
            try:
                if stat.S_ISCHR(os.stat(path).st_mode):
                    result[kind].append(path)
            except OSError:
                continue
    return result


def _safe_snapshot(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Keep a small public snapshot and intentionally omit identity secrets."""

    allowed = (
        "id", "name", "operator", "technology", "connection_state", "connected",
        "default_route", "address", "mask", "priority", "uptime", "band",
        "bandwidth", "rsrp", "rsrq", "cinr", "rssi", "signal_level", "apn",
        "roaming", "base_station", "enb_id", "sector_id", "tac", "phy_cell_id",
        "earfcn", "distance", "model", "manufacturer", "firmware", "carriers",
    )
    snapshot: dict[str, Any] = {}
    for key in allowed:
        if key not in raw or key in {"imei", "sim"}:
            continue
        if key == "carriers":
            continue
        value = raw[key]
        if isinstance(value, str):
            text = value[:_SNAPSHOT_LIMITS.get(key, 128)]
            text = IMEI_RE.sub("<redacted>", text)
            text = re.sub(r"/dev/[A-Za-z0-9._/-]+", "<redacted>", text)
            snapshot[key] = text
        elif isinstance(value, (bool, int, float)) or value is None:
            snapshot[key] = copy.deepcopy(value)
    carriers = raw.get("carriers")
    if isinstance(carriers, list):
        carrier_keys = {
            "technology", "band", "bandwidth", "earfcn", "phy_cell_id",
            "downlink_frequency", "uplink_frequency",
        }
        safe_carriers: list[dict[str, Any]] = []
        for item in carriers[:8]:
            if not isinstance(item, Mapping):
                continue
            safe_item: dict[str, Any] = {}
            for key in carrier_keys:
                value = item.get(key)
                if isinstance(value, str):
                    text = IMEI_RE.sub("<redacted>", value[:64])
                    text = re.sub(r"/dev/[A-Za-z0-9._/-]+", "<redacted>", text)
                    safe_item[key] = text
                elif isinstance(value, (bool, int, float)) or value is None:
                    safe_item[key] = value
            if safe_item:
                safe_carriers.append(safe_item)
        if safe_carriers:
            snapshot["carriers"] = safe_carriers
    return snapshot


def _modem_items(inventory: Any) -> list[Mapping[str, Any]]:
    if not isinstance(inventory, Mapping):
        return []
    items = inventory.get("items")
    return [item for item in items if isinstance(item, Mapping)] if isinstance(items, list) else []


def _find_imei(value: Any) -> str | None:
    match = IMEI_RE.search(str(value or ""))
    return match.group(1) if match else None


def _response_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")[:MAX_TTY_RESPONSE_BYTES]
    return str(value or "")[:MAX_TTY_RESPONSE_BYTES]


def _default_tty_exchange(path: str, command: str, *, timeout: float = PROBE_TIMEOUT_SECONDS) -> str:
    if termios is None:
        raise OSError("tty_transport_unavailable")
    fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        attributes = termios.tcgetattr(fd)
        attributes[0] = 0
        attributes[1] = 0
        attributes[2] = termios.CLOCAL | termios.CREAD | termios.CS8
        attributes[3] = 0
        attributes[4] = termios.B115200
        attributes[5] = termios.B115200
        termios.tcsetattr(fd, termios.TCSANOW, attributes)
        os.write(fd, (command + "\r").encode("ascii"))
        chunks: list[bytes] = []
        deadline = time.monotonic() + max(0.1, min(float(timeout), PROBE_TIMEOUT_SECONDS))
        while sum(len(chunk) for chunk in chunks) < MAX_TTY_RESPONSE_BYTES:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            ready, _, _ = select.select([fd], [], [], remaining)
            if not ready:
                break
            try:
                chunk = os.read(fd, MAX_TTY_RESPONSE_BYTES - sum(len(item) for item in chunks))
            except BlockingIOError:
                continue
            if not chunk:
                break
            chunks.append(chunk)
            if b"\nOK" in b"".join(chunks) or b"\r\nOK" in b"".join(chunks):
                break
        return b"".join(chunks).decode("utf-8", errors="replace")[:MAX_TTY_RESPONSE_BYTES]
    finally:
        os.close(fd)


class ModemControlService:
    """Probe one exact RCI modem without changing modem state."""

    def __init__(
        self,
        rci_fetcher: Callable[[str], Any] = fetch_rci_json,
        device_enumerator: Callable[[], Mapping[str, Sequence[str]]] = _default_device_enumerator,
        runner: Callable[..., Any] = subprocess.run,
        tty_exchange: Callable[..., str] | None = None,
        clock: Callable[[], float] = time.time,
        sampler: Callable[[], Mapping[str, Any]] | None = None,
    ):
        self._clock = clock
        self._rci_fetcher = rci_fetcher
        self._sampler_explicit = sampler is not None
        self._sampler = sampler or (lambda: sample_router_lte(rci_fetcher=rci_fetcher, clock=clock))
        self._device_enumerator = device_enumerator
        self._runner = runner
        self._tty_exchange = tty_exchange or _default_tty_exchange
        self._direct_inventory_mode: bool | None = None

    @staticmethod
    def _inventory_available(result: Any) -> bool:
        if not isinstance(result, Mapping):
            return False
        if result.get("rci_available") is True:
            return True
        if "available" in result:
            return result.get("available") is True
        return bool(_modem_items(result))

    def _inventory(self) -> tuple[dict[str, Any], bool]:
        if self._direct_inventory_mode is True:
            try:
                direct = self._rci_fetcher("show/interface")
                value = dict(direct) if isinstance(direct, Mapping) else {"available": False, "items": []}
                return value, self._inventory_available(value)
            except Exception:
                return {"available": False, "items": [], "state": "unavailable"}, False
        try:
            result = self._sampler()
            # Unit and integration seams may provide an already-normalised
            # inventory through the injected RCI fetcher.  Keep that fixture
            # shape compatible while the live path continues through the
            # shared sampler above.
            if not self._sampler_explicit and not _modem_items(result):
                direct = self._rci_fetcher("show/interface")
                if _modem_items(direct):
                    self._direct_inventory_mode = True
                    result = direct
        except Exception:
            result = {"available": False, "items": []}
        value = dict(result) if isinstance(result, Mapping) else {"available": False, "items": []}
        return value, self._inventory_available(value)

    def _selected_modem(self, modem_id: str) -> Mapping[str, Any]:
        inventory, available = self._inventory()
        if not available:
            raise ModemControlError("modem_not_found")
        for item in _modem_items(inventory):
            if str(item.get("id") or "") == modem_id:
                return item
        raise ModemControlError("modem_not_found")

    def _devices(self) -> dict[str, list[str]]:
        try:
            raw = self._device_enumerator()
        except Exception:
            raw = {}
        result: dict[str, list[str]] = {"qmi": [], "tty": []}
        for kind in result:
            values = raw.get(kind, []) if isinstance(raw, Mapping) else []
            if not isinstance(values, (list, tuple)):
                continue
            prefix = "/dev/cdc-wdm" if kind == "qmi" else "/dev/ttyUSB"
            result[kind] = [path for path in values if isinstance(path, str) and path.startswith(prefix)][:32]
        return result

    def _qmi_imei(self, path: str, *, timeout: float = PROBE_TIMEOUT_SECONDS) -> tuple[str | None, str | None]:
        timeout = max(0.1, min(float(timeout), PROBE_TIMEOUT_SECONDS))
        try:
            completed = self._runner(
                ["qmicli", "-d", path, "--dms-get-ids"],
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
                shell=False,
            )
        except FileNotFoundError:
            return None, "qmi_tool_missing"
        except subprocess.TimeoutExpired:
            return None, "qmi_probe_timeout"
        except Exception:
            return None, "qmi_probe_failed"
        if int(getattr(completed, "returncode", 1) or 0) != 0:
            return None, "qmi_probe_failed"
        imei = _find_imei(getattr(completed, "stdout", ""))
        return imei, None

    def _tty_match(self, path: str, expected_imei: str, *, deadline: float | None = None) -> bool:
        try:
            def remaining_timeout() -> float:
                if deadline is None:
                    return PROBE_TIMEOUT_SECONDS
                remaining = deadline - self._clock()
                if remaining < 0.1:
                    raise TimeoutError("modem_probe_deadline")
                return min(PROBE_TIMEOUT_SECONDS, remaining)

            at = _response_text(self._tty_exchange(path, "AT", timeout=remaining_timeout()))
            if not re.search(r"\bOK\b", at, re.I):
                return False
            cgsn = _response_text(self._tty_exchange(path, "AT+CGSN", timeout=remaining_timeout()))
            return _find_imei(cgsn) == expected_imei and bool(re.search(r"\bOK\b", cgsn, re.I))
        except Exception:
            return False

    def _probe_internal(self, modem_id: str, *, deadline: float | None = None) -> dict[str, Any]:
        modem = self._selected_modem(modem_id)
        expected_imei = str(modem.get("imei") or "").strip()
        snapshot = _safe_snapshot(modem)
        statuses: list[dict[str, Any]] = []
        if not expected_imei:
            statuses = [{"kind": kind, "available": False} for kind in ("qmi", "tty")]
            return ModemControlProbe(snapshot, None, tuple(statuses), "transport_not_matched", self._clock()).as_dict()

        qmi_error: str | None = None
        for path in self._devices()["qmi"]:
            if deadline is not None and deadline - self._clock() < 0.1:
                break
            remaining = PROBE_TIMEOUT_SECONDS if deadline is None else min(PROBE_TIMEOUT_SECONDS, deadline - self._clock())
            imei, error = self._qmi_imei(path, timeout=remaining)
            qmi_error = qmi_error or error
            if imei == expected_imei:
                statuses.append({"kind": "qmi", "available": True})
                return ModemControlProbe(snapshot, "qmi", tuple(statuses), sampled_at=self._clock()).as_dict()
        statuses.append({"kind": "qmi", "available": False})

        for path in self._devices()["tty"]:
            if deadline is not None and deadline - self._clock() < 0.1:
                break
            if self._tty_match(path, expected_imei, deadline=deadline):
                statuses = [{"kind": "tty", "available": True}]
                return ModemControlProbe(snapshot, "tty", tuple(statuses), sampled_at=self._clock()).as_dict()
        statuses.append({"kind": "tty", "available": False})
        code = qmi_error if qmi_error and not any(item["available"] for item in statuses) else "transport_not_matched"
        result = ModemControlProbe(snapshot, None, tuple(statuses), code, self._clock()).as_dict()
        return result

    def probe(self, modem_id: str) -> dict[str, Any]:
        modem_id = validate_modem_id(modem_id)
        return self._probe_internal(
            modem_id,
            deadline=self._clock() + MODEM_PROBE_DEADLINE_SECONDS,
        )



__all__ = [
    "MODEM_PROBE_DEADLINE_SECONDS",
    "ModemControlError",
    "ModemControlProbe",
    "ModemControlService",
    "validate_modem_id",
]
