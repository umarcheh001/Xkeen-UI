"""Scoped LTE modem probing and reset operations.

The service deliberately keeps transport paths and command output out of its
public DTOs.  A modem is selected by its normalised RCI id and IMEI matching
is required before either QMI or TTY can be used for a reset.
"""

from __future__ import annotations

import copy
import glob
import os
import re
import select
import stat
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence

try:
    import termios
except ImportError:  # pragma: no cover - exercised by Windows import tests
    termios = None  # type: ignore[assignment]

from services.router_diagnostics import fetch_rci_json, sample_router_lte


MODEM_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
IMEI_RE = re.compile(r"(?<!\d)(\d{14,17})(?!\d)")
TERMINAL_STATES = frozenset({"recovered", "failed", "timed_out"})

PROBE_TIMEOUT_SECONDS = 3.0
RESET_TIMEOUT_SECONDS = 30.0
RECOVERY_POLL_SECONDS = 1.0
OPERATION_RETENTION_SECONDS = 15 * 60
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


@dataclass(frozen=True)
class _OperationState:
    operation_id: str
    modem_id: str
    status: str
    transport: str | None
    code: str | None
    message: str | None
    started_at: float
    updated_at: float
    finished_at: float | None
    before: Mapping[str, Any]
    after: Mapping[str, Any] | None

    def as_dict(self) -> dict[str, Any]:
        result = {
            "operation_id": self.operation_id,
            "modem_id": self.modem_id,
            "status": self.status,
            "transport": self.transport,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
            "finished_at": self.finished_at,
            "before": copy.deepcopy(dict(self.before)),
            "after": copy.deepcopy(dict(self.after)) if self.after is not None else None,
        }
        if self.code:
            result["code"] = self.code
        if self.message:
            result["message"] = self.message
        return result


@dataclass(frozen=True)
class _TransportMatch:
    kind: str
    path: str


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
    """Probe and reset one exact RCI modem with injected transport seams."""

    def __init__(
        self,
        rci_fetcher: Callable[[str], Any] = fetch_rci_json,
        device_enumerator: Callable[[], Mapping[str, Sequence[str]]] = _default_device_enumerator,
        runner: Callable[..., Any] = subprocess.run,
        tty_exchange: Callable[..., str] | None = None,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        worker_starter: Callable[[Callable[[], None]], Any] | None = None,
        sampler: Callable[[], Mapping[str, Any]] | None = None,
    ):
        self._clock = clock
        self._sleep = sleep
        self._rci_fetcher = rci_fetcher
        self._sampler_explicit = sampler is not None
        self._sampler = sampler or (lambda: sample_router_lte(rci_fetcher=rci_fetcher, clock=clock))
        self._device_enumerator = device_enumerator
        self._runner = runner
        self._tty_exchange = tty_exchange or _default_tty_exchange
        self._worker_starter = worker_starter or self._start_thread
        self._direct_inventory_mode: bool | None = None
        self._lock = threading.RLock()
        self._operations: dict[str, _OperationState] = {}
        self._targets: dict[str, _TransportMatch] = {}
        self._active_by_modem: dict[str, str] = {}

    @staticmethod
    def _start_thread(worker: Callable[[], None]) -> None:
        threading.Thread(target=worker, name="router-modem-reset", daemon=True).start()

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

    def _qmi_imei(self, path: str) -> tuple[str | None, str | None]:
        try:
            completed = self._runner(
                ["qmicli", "-d", path, "--dms-get-ids"],
                capture_output=True,
                text=True,
                timeout=PROBE_TIMEOUT_SECONDS,
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

    def _tty_match(self, path: str, expected_imei: str) -> bool:
        try:
            at = _response_text(self._tty_exchange(path, "AT", timeout=PROBE_TIMEOUT_SECONDS))
            if not re.search(r"\bOK\b", at, re.I):
                return False
            cgsn = _response_text(self._tty_exchange(path, "AT+CGSN", timeout=PROBE_TIMEOUT_SECONDS))
            return _find_imei(cgsn) == expected_imei and bool(re.search(r"\bOK\b", cgsn, re.I))
        except Exception:
            return False

    def _probe_internal(self, modem_id: str) -> tuple[dict[str, Any], _TransportMatch | None]:
        modem = self._selected_modem(modem_id)
        expected_imei = str(modem.get("imei") or "").strip()
        snapshot = _safe_snapshot(modem)
        statuses: list[dict[str, Any]] = []
        if not expected_imei:
            statuses = [{"kind": kind, "available": False} for kind in ("qmi", "tty")]
            return ModemControlProbe(snapshot, None, tuple(statuses), "transport_not_matched", self._clock()).as_dict(), None

        qmi_error: str | None = None
        for path in self._devices()["qmi"]:
            imei, error = self._qmi_imei(path)
            qmi_error = qmi_error or error
            if imei == expected_imei:
                statuses.append({"kind": "qmi", "available": True})
                return ModemControlProbe(snapshot, "qmi", tuple(statuses), sampled_at=self._clock()).as_dict(), _TransportMatch("qmi", path)
        statuses.append({"kind": "qmi", "available": False})

        for path in self._devices()["tty"]:
            if self._tty_match(path, expected_imei):
                statuses = [{"kind": "tty", "available": True}]
                return ModemControlProbe(snapshot, "tty", tuple(statuses), sampled_at=self._clock()).as_dict(), _TransportMatch("tty", path)
        statuses.append({"kind": "tty", "available": False})
        code = qmi_error if qmi_error and not any(item["available"] for item in statuses) else "transport_not_matched"
        result = ModemControlProbe(snapshot, None, tuple(statuses), code, self._clock()).as_dict()
        return result, None

    def probe(self, modem_id: str) -> dict[str, Any]:
        modem_id = validate_modem_id(modem_id)
        return self._probe_internal(modem_id)[0]

    def _replace(self, operation_id: str, **changes: Any) -> None:
        with self._lock:
            current = self._operations.get(operation_id)
            if current is None:
                return
            self._operations[operation_id] = _OperationState(
                operation_id=current.operation_id,
                modem_id=current.modem_id,
                status=changes.get("status", current.status),
                transport=changes.get("transport", current.transport),
                code=changes.get("code", current.code),
                message=changes.get("message", current.message),
                started_at=current.started_at,
                updated_at=self._clock(),
                finished_at=changes.get("finished_at", current.finished_at),
                before=changes.get("before", current.before),
                after=changes.get("after", current.after),
            )

    def _finish(self, operation_id: str, *, status: str, code: str | None = None, after: Mapping[str, Any] | None = None) -> None:
        now = self._clock()
        self._replace(operation_id, status=status, code=code, after=after, finished_at=now)
        self._release_operation_slot(operation_id)

    def _release_operation_slot(self, operation_id: str) -> None:
        with self._lock:
            state = self._operations.get(operation_id)
            if state and self._active_by_modem.get(state.modem_id) == operation_id:
                self._active_by_modem.pop(state.modem_id, None)
            self._targets.pop(operation_id, None)

    def _reset_qmi(self, path: str) -> bool:
        try:
            result = self._runner(
                ["qmicli", "-d", path, "--dms-set-operating-mode=reset"],
                capture_output=True,
                text=True,
                timeout=RESET_TIMEOUT_SECONDS,
                check=False,
                shell=False,
            )
            return int(getattr(result, "returncode", 1) or 0) == 0
        except Exception:
            return False

    def _reset_target(self, target: _TransportMatch) -> bool:
        if target.kind == "qmi":
            return self._reset_qmi(target.path)
        try:
            response = _response_text(self._tty_exchange(target.path, "AT+RESET", timeout=RESET_TIMEOUT_SECONDS))
            return not response or bool(re.search(r"\b(?:OK|RESET)\b", response, re.I))
        except Exception:
            return False

    def _worker(self, operation_id: str) -> None:
        try:
            with self._lock:
                target = self._targets.get(operation_id)
            if target is None:
                self._finish(operation_id, status="failed", code="modem_operation_target_missing")
                return
            self._replace(operation_id, status="running")
            if not self._reset_target(target):
                self._finish(operation_id, status="failed", code="modem_reset_failed")
                return
            self._replace(operation_id, status="waiting_for_modem")
            deadline = self._clock() + RESET_TIMEOUT_SECONDS
            seen_missing = False
            last_now = self._clock()
            for _attempt in range(128):
                if self._clock() >= deadline:
                    break
                inventory, available = self._inventory()
                modem = next((item for item in _modem_items(inventory) if str(item.get("id") or "") == self._operation_modem(operation_id)), None)
                if available and modem is None:
                    seen_missing = True
                elif available and seen_missing and modem is not None:
                    self._finish(operation_id, status="recovered", after=_safe_snapshot(modem))
                    return
                current_now = self._clock()
                if current_now >= deadline:
                    break
                self._sleep(min(RECOVERY_POLL_SECONDS, max(0.0, deadline - current_now)))
                after_sleep = self._clock()
                if not seen_missing and after_sleep <= last_now:
                    # A synchronous test worker may inject a no-op sleep.  Avoid
                    # spinning forever while retaining the same timeout result.
                    break
                last_now = after_sleep
            self._finish(operation_id, status="timed_out", code="modem_recovery_timeout")
        except Exception:
            self._finish(operation_id, status="failed", code="modem_operation_failed")
        finally:
            self._release_operation_slot(operation_id)

    def _operation_modem(self, operation_id: str) -> str:
        with self._lock:
            state = self._operations.get(operation_id)
            return state.modem_id if state else ""

    def start_reset(self, modem_id: str, *, confirmation: str | None = None) -> dict[str, Any]:
        modem_id = validate_modem_id(modem_id)
        if confirmation != modem_id:
            raise ModemControlError("modem_confirmation_mismatch")
        probe, target = self._probe_internal(modem_id)
        if target is None:
            raise ModemControlError(str(probe.get("code") or "transport_not_matched"))
        with self._lock:
            if modem_id in self._active_by_modem:
                raise ModemControlError("modem_operation_in_progress")
            now = self._clock()
            operation_id = uuid.uuid4().hex
            state = _OperationState(
                operation_id=operation_id,
                modem_id=modem_id,
                status="queued",
                transport=target.kind,
                code=None,
                message=None,
                started_at=now,
                updated_at=now,
                finished_at=None,
                before=_safe_snapshot(probe["modem"]),
                after=None,
            )
            self._operations[operation_id] = state
            self._targets[operation_id] = target
            self._active_by_modem[modem_id] = operation_id
        try:
            self._worker_starter(lambda: self._worker(operation_id))
        except Exception as exc:
            self._finish(operation_id, status="failed", code="worker_start_failed")
            raise ModemControlError("worker_start_failed") from exc
        return {
            "operation_id": operation_id,
            "modem_id": modem_id,
            "status": "queued",
            "before": copy.deepcopy(state.before),
            "transport": target.kind,
        }

    def status(self, operation_id: str) -> dict[str, Any]:
        if not isinstance(operation_id, str) or not operation_id or len(operation_id) > 128:
            raise ModemControlError("operation_not_found")
        now = self._clock()
        with self._lock:
            expired = [
                key for key, state in self._operations.items()
                if now - max(state.finished_at or state.started_at, 0.0) > OPERATION_RETENTION_SECONDS
            ]
            for key in expired:
                state = self._operations.pop(key)
                self._targets.pop(key, None)
                if self._active_by_modem.get(state.modem_id) == key:
                    self._active_by_modem.pop(state.modem_id, None)
            state = self._operations.get(operation_id)
            if state is None:
                raise ModemControlError("operation_not_found")
            return state.as_dict()


__all__ = ["ModemControlError", "ModemControlProbe", "ModemControlService", "validate_modem_id"]
