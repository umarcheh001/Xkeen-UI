"""Core-owned, local notification state for official panel releases.

The center is intentionally a *catalog reader*, not another updater.  Its
only remote operation is :meth:`ModuleLifecycleService.notification_catalog`,
which verifies small signed catalog files and never downloads an archive.
"""

from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Mapping

from services.io.atomic import _atomic_write_json
from services.module_update_channel import CHANNELS, read_channel

if TYPE_CHECKING:
    from services.module_lifecycle import ModuleLifecycleService


STATE_FILENAME = "module-notifications.json"
STATE_SCHEMA_VERSION = 1
BACKGROUND_INTERVAL_S = 24 * 60 * 60
MAX_BACKOFF_S = 7 * BACKGROUND_INTERVAL_S
# A probe that fails right after the router boots usually meets a network
# that is not up yet: the first retries come soon, then the daily backoff.
SHORT_RETRY_S = (15 * 60, 60 * 60)
MAX_STATE_RECORDS = 160
STATE_RETENTION_S = 90 * 24 * 60 * 60
SNOOZE_INTERVALS = frozenset({24 * 60 * 60, 7 * 24 * 60 * 60})
# Records computed from the catalog describe a step away from one installed
# version; once the panel runs another version they no longer apply.
_RELEASE_KINDS = frozenset({"panel-update", "module-new", "module-update", "module_update_available"})
# An update of one module inside the installed release. Its record is the same
# on either channel: the update document belongs to the release, not the channel.
MODULE_UPDATE_KIND = "module_update_available"
# Notes about the check itself rather than about a release.
_CHECK_NOTE_KINDS = frozenset({"catalog-error", "catalog-stale", "catalog-baseline"})
_IDENTITY_HEX = frozenset("0123456789abcdef")

_ERROR_MESSAGES = {
    "catalog_unavailable": "Не удалось связаться с каталогом обновлений.",
    "catalog_baseline_unavailable": "Не удалось прочитать каталог установленной версии панели.",
    "catalog_cache_invalid": "Локальная копия каталога требует повторной проверки.",
    "catalog_channel_unsupported": "Выбранный канал обновлений недоступен.",
    "catalog_stable_unreleased": "Для стабильного канала пока нет модульного выпуска.",
    "module_state_unavailable": "Не удалось прочитать состояние установленных модулей.",
    "panel_version_unsupported": "Версия панели не поддерживает проверку обновлений.",
    "profile_transition_required": "Сначала нужно применить выбранный набор модулей в окне «Модули и обновления».",
}


class NotificationCenterError(ValueError):
    """A stable notification-center failure safe to return from the API."""

    def __init__(self, code: str, message: str, *, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _now_number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) and result >= 0 else None


def _record_id(kind: str, module_id: str | None, version: str, channel: str) -> str:
    canonical = "\0".join((kind, module_id or "panel", version, channel)).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _safe_module_list(value: Any) -> list[str]:
    return sorted({str(item) for item in value if isinstance(item, str) and item}) if isinstance(value, list) else []


def _dependency_changes(previous: Mapping[str, Any] | None, current: Mapping[str, Any]) -> dict[str, list[str]]:
    old_requires = set(_safe_module_list(previous.get("requires") if previous else []))
    new_requires = set(_safe_module_list(current.get("requires")))
    old_conflicts = set(_safe_module_list(previous.get("conflicts") if previous else []))
    new_conflicts = set(_safe_module_list(current.get("conflicts")))
    return {
        "requires_added": sorted(new_requires - old_requires),
        "requires_removed": sorted(old_requires - new_requires),
        "conflicts_added": sorted(new_conflicts - old_conflicts),
        "conflicts_removed": sorted(old_conflicts - new_conflicts),
    }


def _module_changes(payload: Mapping[str, Any], installed: set[str], known: Mapping[str, Any]) -> list[dict[str, str]]:
    """Installed modules whose own version the new panel raises, in its catalog order.

    ``version`` of a catalog entry is the release's and rises for every module;
    only ``module_version`` tells a changed module. A catalog without it (a
    release built before it was published) lists none rather than all.
    """

    from services.module_package_contract import compare_semver

    have = payload.get("installed_module_versions")
    have = have if isinstance(have, Mapping) else {}
    changes: list[dict[str, str]] = []
    for target in payload.get("target_modules", []):
        if not isinstance(target, Mapping):
            continue
        module_id, new, old = target.get("id"), target.get("module_version"), None
        if isinstance(module_id, str):
            old = have.get(module_id)
        if module_id not in installed or not isinstance(new, str) or not isinstance(old, str):
            continue
        try:
            if compare_semver(new, old) <= 0:
                continue
        except Exception:
            continue
        definition = known.get(module_id)
        changes.append({
            "module_id": module_id,
            "name": definition.name if definition is not None else module_id,
            "from": old,
            "to": new,
        })
    return changes


class NotificationCenter:
    """Persist notifications and quietly refresh their signed source once daily."""

    def __init__(
        self,
        lifecycle_service: "ModuleLifecycleService",
        *,
        state_dir: Path,
        now: Callable[[], float] = time.time,
        background_interval_s: float = BACKGROUND_INTERVAL_S,
        panel_version: Callable[[], str | None] | None = None,
        module_versions: Callable[[], Mapping[str, str] | None] | None = None,
    ) -> None:
        self.lifecycle_service = lifecycle_service
        self._panel_version = panel_version or self._installed_panel_version
        self._module_versions = module_versions or self._installed_module_versions
        self.state_dir = Path(state_dir)
        self._path = self.state_dir / STATE_FILENAME
        self._now = now
        self._background_interval_s = max(60.0, float(background_interval_s))
        self._lock = threading.RLock()
        self._poll_lock = threading.Lock()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    def _installed_panel_version(self) -> str | None:
        panel_root = getattr(self.lifecycle_service, "panel_root", None)
        if panel_root is None:
            return None
        from services.module_transactions.plan import read_panel_version

        return read_panel_version(Path(panel_root))

    def _installed_module_versions(self) -> Mapping[str, str] | None:
        panel_root = getattr(self.lifecycle_service, "panel_root", None)
        state_dir = getattr(self.lifecycle_service, "state_dir", None)
        if panel_root is None or state_dir is None:
            return None
        from services.module_transactions.state import ModuleTransactionError
        from services.module_transactions.plan import read_installed_modules
        from services.module_versions import read_installed_module_versions

        try:
            installed = read_installed_modules(Path(state_dir))
        except ModuleTransactionError:
            return None
        versions = read_installed_module_versions(Path(state_dir), Path(panel_root))
        return {module_id: version for module_id, version in versions.items() if module_id in installed}

    def _current_module_versions(self) -> Mapping[str, str] | None:
        try:
            versions = self._module_versions()
        except Exception:
            return None
        return versions if isinstance(versions, Mapping) else None

    @staticmethod
    def _module_updated(record: Mapping[str, Any], versions: Mapping[str, str] | None) -> bool:
        """A module update the router no longer waits for: laid, or the module is gone."""

        return (
            versions is not None
            and record.get("kind") == MODULE_UPDATE_KIND
            and versions.get(str(record.get("module_id"))) != record.get("installed_version")
        )

    def _current_panel_version(self) -> str | None:
        try:
            version = self._panel_version()
        except Exception:
            return None
        return version if isinstance(version, str) and version else None

    @staticmethod
    def _outdated(record: Mapping[str, Any], panel_version: str | None) -> bool:
        source_version = record.get("source_version")
        return (
            panel_version is not None
            and record.get("kind") in _RELEASE_KINDS
            and isinstance(source_version, str)
            and source_version != panel_version
        )

    @staticmethod
    def _empty_state() -> dict[str, Any]:
        return {
            "schema_version": STATE_SCHEMA_VERSION,
            "records": {},
            "channels": {
                channel: {
                    "records": [],
                    "last_attempt_at": None,
                    "last_success_at": None,
                    "freshness": None,
                    "stale_reason": None,
                    "error_code": None,
                    "failure_count": 0,
                    "next_poll_at": None,
                    "fetched_at": None,
                    "baseline_error": None,
                }
                for channel in sorted(CHANNELS)
            },
        }

    @staticmethod
    def _valid_record_id(value: Any) -> bool:
        return isinstance(value, str) and len(value) == 64 and set(value) <= _IDENTITY_HEX

    @classmethod
    def _normalize_record_state(cls, raw: Any) -> dict[str, float | None]:
        data = raw if isinstance(raw, Mapping) else {}
        return {
            "seen_at": _now_number(data.get("seen_at")),
            "dismissed_at": _now_number(data.get("dismissed_at")),
            "snoozed_until": _now_number(data.get("snoozed_until")),
            "updated_at": _now_number(data.get("updated_at")),
        }

    @classmethod
    def _normalize_channel_state(cls, raw: Any) -> dict[str, Any]:
        data = raw if isinstance(raw, Mapping) else {}
        records = data.get("records")
        normalized_records = [
            dict(item)
            for item in records if isinstance(item, Mapping) and cls._valid_record_id(item.get("id"))
        ] if isinstance(records, list) else []
        error_code = data.get("error_code")
        try:
            failure_count = min(16, max(0, int(data.get("failure_count") or 0)))
        except (TypeError, ValueError):
            failure_count = 0
        return {
            "records": normalized_records[:MAX_STATE_RECORDS],
            "last_attempt_at": _now_number(data.get("last_attempt_at")),
            "last_success_at": _now_number(data.get("last_success_at")),
            "freshness": data.get("freshness") if data.get("freshness") in {"fresh", "stale", "local"} else None,
            "stale_reason": str(data["stale_reason"])[:80] if isinstance(data.get("stale_reason"), str) else None,
            "error_code": str(error_code)[:80] if isinstance(error_code, str) else None,
            "failure_count": failure_count,
            "next_poll_at": _now_number(data.get("next_poll_at")),
            "fetched_at": _now_number(data.get("fetched_at")),
            "baseline_error": str(data["baseline_error"])[:80] if isinstance(data.get("baseline_error"), str) else None,
        }

    def _read_state_locked(self) -> tuple[dict[str, Any], bool]:
        state = self._empty_state()
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return state, False
        except (OSError, ValueError, TypeError):
            return state, True
        if not isinstance(raw, Mapping):
            return state, True

        # Schema 0 was never publicly released, but accepting its simple
        # records map makes early test builds migrate without losing dismissals.
        schema = raw.get("schema_version", 0)
        if schema not in {0, STATE_SCHEMA_VERSION}:
            return state, True
        stored_records = raw.get("records")
        if isinstance(stored_records, Mapping):
            state["records"] = {
                record_id: self._normalize_record_state(record)
                for record_id, record in stored_records.items()
                if self._valid_record_id(record_id)
            }
        stored_channels = raw.get("channels")
        if isinstance(stored_channels, Mapping):
            for channel in CHANNELS:
                state["channels"][channel] = self._normalize_channel_state(stored_channels.get(channel))
        return state, schema != STATE_SCHEMA_VERSION

    def _write_state_locked(self, state: Mapping[str, Any]) -> None:
        _atomic_write_json(str(self._path), state, mode=0o600)

    @staticmethod
    def _error_record(channel: str, code: str) -> dict[str, Any]:
        normalized = code if code in _ERROR_MESSAGES else "catalog_unavailable"
        return {
            "id": _record_id("catalog-error", None, normalized, channel),
            "kind": "catalog-error",
            "channel": channel,
            "version": normalized,
            "title": "Проверка обновлений требует внимания",
            "message": _ERROR_MESSAGES[normalized],
            "retry_available": True,
        }

    @staticmethod
    def _stale_record(channel: str, reason: str | None, fetched_at: float | None) -> dict[str, Any]:
        code = str(reason or "catalog_unavailable")
        return {
            "id": _record_id("catalog-stale", None, code, channel),
            "kind": "catalog-stale",
            "channel": channel,
            "version": code,
            "title": "Каталог может быть неактуален",
            "message": "Показана последняя проверенная копия каталога.",
            "retry_available": True,
            "fetched_at": fetched_at,
        }

    @staticmethod
    def _baseline_record(channel: str, code: str) -> dict[str, Any]:
        normalized = code if code in _ERROR_MESSAGES else "catalog_baseline_unavailable"
        return {
            "id": _record_id("catalog-baseline", None, normalized, channel),
            "kind": "catalog-baseline",
            "channel": channel,
            "version": normalized,
            "title": "Неполная информация о модулях",
            "message": _ERROR_MESSAGES[normalized],
            "retry_available": True,
        }

    @staticmethod
    def _module_update_records(payload: Mapping[str, Any], channel: str) -> list[dict[str, Any]]:
        from services.module_registry import MODULE_DEFINITIONS

        names = {definition.id: definition.name for definition in MODULE_DEFINITIONS}
        source_version = str(payload.get("source_version") or "")
        records: list[dict[str, Any]] = []
        offers = payload.get("module_updates")
        for offer in offers if isinstance(offers, list) else []:
            if not isinstance(offer, Mapping):
                continue
            module_id, version, installed = offer.get("module_id"), offer.get("version"), offer.get("installed_version")
            if not all(isinstance(value, str) and value for value in (module_id, version, installed)):
                continue
            name = names.get(module_id, module_id)
            records.append(
                {
                    "id": _record_id(MODULE_UPDATE_KIND, module_id, version, "release"),
                    "kind": MODULE_UPDATE_KIND,
                    "channel": channel,
                    "module_id": module_id,
                    "version": version,
                    "installed_version": installed,
                    "source_version": source_version,
                    "title": f"Обновление модуля: {name}",
                    "message": f"Доступна версия {version}, установлена {installed}. Обновить можно на странице модулей.",
                    "requires_restart": True,
                }
            )
        return records

    def _records_from_catalog(self, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        channel = str(payload.get("channel") or "stable")
        if channel not in CHANNELS:
            return []
        module_updates = self._module_update_records(payload, channel)
        if payload.get("update_available") is not True:
            return module_updates
        # The new panel brings every module with it: only the panel is told of,
        # unless it needs the installer and the button cannot lay it.
        if payload.get("requires_installer") is not True:
            module_updates = []

        from services.module_registry import MODULE_DEFINITIONS

        known = {definition.id: definition for definition in MODULE_DEFINITIONS}
        installed = set(_safe_module_list(payload.get("installed_module_ids")))
        target_version = str(payload.get("target_version") or "")
        source_version = str(payload.get("source_version") or "")
        records: list[dict[str, Any]] = list(module_updates)
        target_panel = payload.get("target_panel")
        if target_version:
            panel_size = target_panel.get("size") if isinstance(target_panel, Mapping) else None
            module_changes = _module_changes(payload, installed, known)
            message = "Обновление панели проверит совместимость и сохранит выбранный профиль."
            if module_changes:
                message += " Вместе с ней обновятся модули:"
            records.append(
                {
                    "id": _record_id("panel-update", None, target_version, channel),
                    "kind": "panel-update",
                    "channel": channel,
                    "version": target_version,
                    "source_version": source_version,
                    "title": "Доступна новая версия панели",
                    "message": message,
                    "size": panel_size if isinstance(panel_size, int) and panel_size > 0 else None,
                    "requires_restart": True,
                    "requires_installer": payload.get("requires_installer") is True,
                    "module_changes": module_changes,
                }
            )

        # Without the installed release catalog nothing tells a new module
        # from one the panel always had: keep only the panel note.
        if payload.get("baseline_error"):
            return records

        previous = {
            str(item.get("id"))
            for item in payload.get("current_modules", [])
            if isinstance(item, Mapping) and isinstance(item.get("id"), str)
        }
        # A module the panel already had is told of inside the panel note: it
        # comes with the panel and is not updated on its own.
        for target in payload.get("target_modules", []):
            if not isinstance(target, Mapping):
                continue
            module_id = target.get("id")
            version = target.get("version")
            if not isinstance(module_id, str) or not isinstance(version, str):
                continue
            if module_id in previous or module_id in installed:
                continue
            definition = known.get(module_id)
            module_name = definition.name if definition is not None else "Новый официальный модуль"
            records.append(
                {
                    "id": _record_id("module-new", module_id, version, channel),
                    "kind": "module-new",
                    "channel": channel,
                    "module_id": module_id,
                    "version": version,
                    "source_version": source_version,
                    "title": f"Новый модуль: {module_name}",
                    "message": (
                        "Этот модуль станет доступен после обновления панели; "
                        "текущая панель ещё не знает его состав."
                        if definition is None
                        else "Этот модуль станет доступен после обновления панели."
                    ),
                    "size": target.get("size") if isinstance(target.get("size"), int) and target["size"] > 0 else None,
                    "requires_restart": target.get("requires_restart") is True,
                    "dependency_changes": _dependency_changes(None, target),
                    "requires_panel_update": True,
                }
            )
        return records

    @staticmethod
    def _sort_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        priority = {
            "catalog-error": 0, "catalog-stale": 1, "catalog-baseline": 2, "panel-update": 3,
            MODULE_UPDATE_KIND: 4, "module-new": 5, "module-update": 6,
        }
        return sorted(records, key=lambda record: (priority.get(str(record.get("kind")), 9), str(record.get("title") or "")))

    def _prune_locked(self, state: dict[str, Any], active_ids: set[str], now: float) -> None:
        records = state["records"]
        # A record still offered on another channel keeps its dismissal for
        # the day the user switches back.
        for channel_state in state["channels"].values():
            active_ids = active_ids | {
                record.get("id")
                for record in channel_state.get("records", [])
                if isinstance(record, Mapping) and self._valid_record_id(record.get("id"))
            }
        candidates = sorted(
            records,
            key=lambda record_id: float(records[record_id].get("updated_at") or 0),
            reverse=True,
        )
        keep = set(candidates[:MAX_STATE_RECORDS]) | active_ids
        for record_id in list(records):
            updated = float(records[record_id].get("updated_at") or 0)
            if record_id not in keep or (record_id not in active_ids and updated < now - STATE_RETENTION_S):
                records.pop(record_id, None)

    def _public_snapshot_locked(self, state: dict[str, Any], channel: str, now: float) -> dict[str, Any]:
        channel_state = state["channels"][channel]
        visible: list[dict[str, Any]] = []
        unread = 0
        active_ids: set[str] = set()
        snooze_ends: list[float] = []
        panel_version = self._current_panel_version()
        module_versions = self._current_module_versions()
        for raw in self._sort_records(list(channel_state["records"])):
            record_id = raw.get("id")
            if not self._valid_record_id(record_id):
                continue
            active_ids.add(record_id)
            if self._outdated(raw, panel_version) or self._module_updated(raw, module_versions):
                continue
            persisted = state["records"].get(record_id, self._normalize_record_state(None))
            if persisted.get("dismissed_at") is not None:
                continue
            snoozed_until = persisted.get("snoozed_until")
            if snoozed_until is not None and snoozed_until > now:
                snooze_ends.append(snoozed_until)
                continue
            item = dict(raw)
            item["seen"] = persisted.get("seen_at") is not None
            item["snoozed_until"] = snoozed_until
            visible.append(item)
            if not item["seen"]:
                unread += 1
        self._prune_locked(state, active_ids, now)
        status = {
            key: channel_state.get(key)
            for key in (
                "last_attempt_at",
                "last_success_at",
                "freshness",
                "stale_reason",
                "error_code",
                "next_poll_at",
                "fetched_at",
                "baseline_error",
            )
        }
        # Relative, so a page with another clock still wakes on time.
        status["snooze_wake_in_s"] = max(1.0, min(snooze_ends) - now) if snooze_ends else None
        return {
            "ok": True,
            "channel": channel,
            "records": visible,
            "unread_count": unread,
            "status": status,
        }

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            state, needs_write = self._read_state_locked()
            result = self._public_snapshot_locked(state, read_channel(self.state_dir), float(self._now()))
            if needs_write:
                self._write_state_locked(state)
            return result

    def _finish_poll_locked(
        self,
        state: dict[str, Any],
        *,
        channel: str,
        now: float,
        records: list[dict[str, Any]] | None,
        freshness: str | None,
        stale_reason: str | None,
        fetched_at: float | None,
        error_code: str | None,
        baseline_error: str | None,
    ) -> dict[str, Any]:
        channel_state = state["channels"][channel]
        previous_notes = {
            record.get("id")
            for record in channel_state.get("records", [])
            if isinstance(record, Mapping) and record.get("kind") in _CHECK_NOTE_KINDS
        }
        channel_state["last_attempt_at"] = now
        channel_state["freshness"] = freshness
        channel_state["stale_reason"] = stale_reason
        channel_state["fetched_at"] = fetched_at
        channel_state["baseline_error"] = baseline_error
        if records is not None:
            channel_state["records"] = self._sort_records(records)
        if freshness in {"fresh", "local"} and error_code is None:
            channel_state["last_success_at"] = now
            channel_state["error_code"] = None
            channel_state["failure_count"] = 0
            channel_state["next_poll_at"] = now + self._background_interval_s
            # A dismissed outage note is about that outage only: once the
            # catalog answers, the next outage must be shown again.
            current = {record.get("id") for record in channel_state["records"] if isinstance(record, Mapping)}
            for record_id in previous_notes - current:
                state["records"].pop(record_id, None)
        else:
            failures = min(16, int(channel_state.get("failure_count") or 0) + 1)
            channel_state["failure_count"] = failures
            # A stale response still contains a verified catalog.  Keep its
            # transport reason separately so the UI says “stale” rather than
            # pretending it has no usable answer at all.
            channel_state["error_code"] = None if freshness == "stale" else (error_code or "catalog_unavailable")
            # Failed probes never become noisy retries: two short ones for a
            # network that is still coming up, then a day backing off to a week.
            if failures <= len(SHORT_RETRY_S):
                delay = min(SHORT_RETRY_S[failures - 1], self._background_interval_s)
            else:
                steps = failures - len(SHORT_RETRY_S) - 1
                delay = min(MAX_BACKOFF_S, self._background_interval_s * (2 ** min(steps, 3)))
            channel_state["next_poll_at"] = now + delay
        result = self._public_snapshot_locked(state, channel, now)
        self._write_state_locked(state)
        return result

    def check(self, *, force_refresh: bool = False, background: bool = False) -> dict[str, Any]:
        """Refresh notification records through the single catalog source."""

        if not self._poll_lock.acquire(blocking=False):
            # A manual check during a running poll waits for its answer
            # rather than showing the state from before it.
            if not background and self._poll_lock.acquire(timeout=60):
                self._poll_lock.release()
            return self.snapshot()
        try:
            with self._lock:
                state, migrated = self._read_state_locked()
                channel = read_channel(self.state_dir)
                now = float(self._now())
                due_at = state["channels"][channel].get("next_poll_at")
                panel_version = self._current_panel_version()
                # An updated panel must not wait for the daily gate: its
                # records still describe the update that is now installed.
                outdated = any(
                    isinstance(record, Mapping) and self._outdated(record, panel_version)
                    for record in state["channels"][channel]["records"]
                )
                if background and isinstance(due_at, (int, float)) and due_at > now and not outdated:
                    result = self._public_snapshot_locked(state, channel, now)
                    if migrated:
                        self._write_state_locked(state)
                    return result
            try:
                payload = self.lifecycle_service.notification_catalog(force_refresh=bool(force_refresh))
                payload_channel = str(payload.get("channel") or channel)
                if payload_channel in CHANNELS:
                    channel = payload_channel
                records = self._records_from_catalog(payload)
                freshness = str(payload.get("freshness") or "")
                stale_reason = payload.get("stale_reason")
                fetched_at = _now_number(payload.get("fetched_at"))
                baseline_error = payload.get("baseline_error")
                if freshness == "stale":
                    records.append(self._stale_record(channel, str(stale_reason or ""), fetched_at))
                if isinstance(baseline_error, str) and baseline_error:
                    records.append(self._baseline_record(channel, baseline_error))
                with self._lock:
                    state, _ = self._read_state_locked()
                    return self._finish_poll_locked(
                        state,
                        channel=channel,
                        now=float(self._now()),
                        records=records,
                        freshness=freshness if freshness in {"fresh", "stale", "local"} else None,
                        stale_reason=str(stale_reason)[:80] if isinstance(stale_reason, str) else None,
                        fetched_at=fetched_at,
                        error_code=None,
                        baseline_error=baseline_error if isinstance(baseline_error, str) else None,
                    )
            except Exception as error:  # lifecycle maps trust/transport failures to a stable code
                code = str(getattr(error, "code", None) or "catalog_unavailable")
                with self._lock:
                    state, _ = self._read_state_locked()
                    channel_state = state["channels"][channel]
                    panel_version = self._current_panel_version()
                    # Records of a previous panel version are dropped, so a
                    # failed probe after an update backs off like any other.
                    retained = [
                        dict(record)
                        for record in channel_state.get("records", [])
                        if isinstance(record, Mapping)
                        and str(record.get("kind")) not in {
                            "catalog-error",
                            "catalog-stale",
                            "catalog-baseline",
                        }
                        and not self._outdated(record, panel_version)
                    ]
                    retained.append(self._error_record(channel, code))
                    return self._finish_poll_locked(
                        state,
                        channel=channel,
                        now=float(self._now()),
                        records=retained,
                        freshness=None,
                        stale_reason=None,
                        fetched_at=None,
                        error_code=code,
                        baseline_error=None,
                    )
        finally:
            self._poll_lock.release()

    def mark_seen(self, record_ids: list[str] | None = None) -> dict[str, Any]:
        with self._lock:
            state, _ = self._read_state_locked()
            channel = read_channel(self.state_dir)
            now = float(self._now())
            active = {record.get("id") for record in state["channels"][channel]["records"] if isinstance(record, Mapping)}
            targets = active if record_ids is None else set(record_ids) & active
            for record_id in targets:
                if self._valid_record_id(record_id):
                    entry = state["records"].setdefault(record_id, self._normalize_record_state(None))
                    entry["seen_at"] = now
                    entry["updated_at"] = now
            result = self._public_snapshot_locked(state, channel, now)
            self._write_state_locked(state)
            return result

    def set_record_state(self, record_id: str, action: str, *, snooze_seconds: int | None = None) -> dict[str, Any]:
        if not self._valid_record_id(record_id):
            raise NotificationCenterError("notification_not_found", "notification was not found", status=404)
        if action not in {"dismiss", "snooze", "restore"}:
            raise NotificationCenterError("notification_action_invalid", "unsupported notification action")
        with self._lock:
            state, _ = self._read_state_locked()
            channel = read_channel(self.state_dir)
            active = {record.get("id") for record in state["channels"][channel]["records"] if isinstance(record, Mapping)}
            if record_id not in active:
                raise NotificationCenterError("notification_not_found", "notification was not found", status=404)
            now = float(self._now())
            entry = state["records"].setdefault(record_id, self._normalize_record_state(None))
            if action == "dismiss":
                entry["dismissed_at"] = now
                entry["snoozed_until"] = None
            elif action == "restore":
                entry["dismissed_at"] = None
                entry["snoozed_until"] = None
            else:
                seconds = int(snooze_seconds or 24 * 60 * 60)
                if seconds not in SNOOZE_INTERVALS:
                    raise NotificationCenterError("notification_snooze_invalid", "unsupported notification snooze interval")
                # Back from the snooze it is news again: the bell counts it.
                entry["seen_at"] = None
                entry["dismissed_at"] = None
                entry["snoozed_until"] = now + seconds
            entry["updated_at"] = now
            result = self._public_snapshot_locked(state, channel, now)
            self._write_state_locked(state)
            return result

    def start_background(self) -> None:
        """Start one daemon poller without holding up Flask or the router."""

        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._thread = threading.Thread(
                target=self._background_loop,
                name="xkeen-notification-poll",
                daemon=True,
            )
            self._thread.start()

    def _background_loop(self) -> None:
        while True:
            wait = min(60 * 60, self._background_interval_s)
            try:
                due_at = self.check(background=True).get("status", {}).get("next_poll_at")
                if isinstance(due_at, (int, float)):
                    wait = max(60.0, min(wait, float(due_at) - float(self._now())))
            except Exception:
                pass
            # Waking at least hourly lets an update-channel change become
            # eligible promptly; a short retry wakes the loop when it is due.
            self._wake.wait(timeout=wait)
            self._wake.clear()

    def wake_background(self) -> None:
        self._wake.set()


__all__ = [
    "BACKGROUND_INTERVAL_S",
    "NotificationCenter",
    "NotificationCenterError",
    "SNOOZE_INTERVALS",
    "STATE_FILENAME",
]
