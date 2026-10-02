"""Persistent state for curated core source selection and installations."""

from __future__ import annotations

from copy import deepcopy
import json
import os
import threading
import time
from typing import Any

from services.core_profiles import get_profile
from services.io.atomic import _atomic_write_json


_ENGINES = ("xray", "mihomo")
_LEGACY_PHASE_PROGRESS = {
    "idle": 0,
    "download": 8,
    "verify": 28,
    "backup": 42,
    "replace": 58,
    "preflight": 70,
    "restart": 82,
    "healthcheck": 94,
    "rollback": 96,
    "complete": 100,
    "rolled_back": 100,
}
_LEGACY_PHASE_LABELS = {
    "idle": "Ожидание установки",
    "download": "Загрузка релиза",
    "verify": "Проверка контрольной суммы",
    "backup": "Резервное копирование текущего ядра",
    "replace": "Замена бинарного файла",
    "preflight": "Проверка конфигурации",
    "restart": "Перезапуск сервиса",
    "healthcheck": "Проверка работоспособности",
    "rollback": "Восстановление предыдущей версии",
    "complete": "Установка завершена",
    "rolled_back": "Откат завершён",
}


def _empty_engine_state() -> dict[str, Any]:
    return {
        "selected_profile_id": "official",
        "installed_profile_id": None,
        "installed_release_tag": None,
        "installed_asset_name": None,
        "last_status": "idle",
        "last_phase": "idle",
        "last_phase_label": "Ожидание установки",
        "last_progress": 0,
        "last_operation_id": None,
        "last_error": None,
    }


class CoreProfileStateStore:
    """Owns only source/install metadata; binary backups are kept separately."""

    def __init__(self, ui_state_dir: str):
        self.root = os.path.join(os.path.abspath(str(ui_state_dir)), "core-profiles")
        self.path = os.path.join(self.root, "state.json")
        self.release_cache_path = os.path.join(self.root, "release-cache.json")
        self._lock = threading.RLock()

    def _default(self) -> dict[str, Any]:
        return {"version": 1, "xray": _empty_engine_state(), "mihomo": _empty_engine_state()}

    def _read(self) -> dict[str, Any]:
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError, TypeError):
            payload = self._default()
        if not isinstance(payload, dict):
            payload = self._default()
        result = self._default()
        for engine in _ENGINES:
            value = payload.get(engine)
            if isinstance(value, dict):
                result[engine].update({key: value.get(key) for key in result[engine] if key in value})
                phase = str(result[engine].get("last_phase") or "idle")
                if "last_progress" not in value:
                    result[engine]["last_progress"] = _LEGACY_PHASE_PROGRESS.get(phase, 0)
                if "last_phase_label" not in value:
                    result[engine]["last_phase_label"] = _LEGACY_PHASE_LABELS.get(phase, phase)
        return result

    def _write(self, payload: dict[str, Any]) -> None:
        os.makedirs(self.root, exist_ok=True)
        _atomic_write_json(self.path, payload, mode=0o600)

    def all(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._read())

    def get(self, engine_id: str) -> dict[str, Any]:
        if engine_id not in _ENGINES:
            raise ValueError("Неизвестное ядро")
        return self.all()[engine_id]

    def snapshot(self) -> dict[str, Any]:
        return self.all()

    def restore(self, snapshot: dict[str, Any]) -> None:
        with self._lock:
            payload = self._default()
            if isinstance(snapshot, dict):
                for engine in _ENGINES:
                    if isinstance(snapshot.get(engine), dict):
                        payload[engine].update(snapshot[engine])
            self._write(payload)

    def restore_install_state(self, engine_id: str, snapshot: dict[str, Any]) -> None:
        """Restore only installation metadata for one core after a failed update.

        Profile selection is a separate user preference and can legitimately
        change while an installation is running. Keeping the scope this narrow
        also preserves state owned by the other core.
        """
        if engine_id not in _ENGINES:
            raise ValueError("Неизвестное ядро")
        with self._lock:
            payload = self._read()
            prior = snapshot.get(engine_id) if isinstance(snapshot, dict) else None
            if isinstance(prior, dict):
                for key in ("installed_profile_id", "installed_release_tag", "installed_asset_name"):
                    if key in prior:
                        payload[engine_id][key] = prior[key]
            self._write(payload)

    def set_selected(self, engine_id: str, profile_id: str) -> dict[str, Any]:
        profile = get_profile(engine_id, profile_id)
        with self._lock:
            payload = self._read()
            payload[profile.engine_id]["selected_profile_id"] = profile.profile_id
            self._write(payload)
            return deepcopy(payload[profile.engine_id])

    def set_installed(self, engine_id: str, *, profile_id: str, release_tag: str, asset_name: str) -> dict[str, Any]:
        profile = get_profile(engine_id, profile_id)
        with self._lock:
            payload = self._read()
            current = payload[profile.engine_id]
            current.update(
                {
                    "installed_profile_id": profile.profile_id,
                    "installed_release_tag": str(release_tag),
                    "installed_asset_name": str(asset_name),
                }
            )
            self._write(payload)
            return deepcopy(current)

    def set_runtime(
        self,
        engine_id: str,
        *,
        status: str,
        phase: str,
        error: str | None = None,
        operation_id: str | None = None,
        progress: int | None = None,
        phase_label: str | None = None,
    ) -> dict[str, Any]:
        if engine_id not in _ENGINES:
            raise ValueError("Неизвестное ядро")
        with self._lock:
            payload = self._read()
            current = payload[engine_id]
            current.update({"last_status": status, "last_phase": phase, "last_error": error})
            if operation_id is not None:
                current["last_operation_id"] = str(operation_id)
            if progress is not None:
                current["last_progress"] = max(0, min(100, int(progress)))
            if phase_label is not None:
                current["last_phase_label"] = str(phase_label)
            self._write(payload)
            return deepcopy(current)

    def get_release_cache(self, key: str, *, max_age_s: float, allow_stale: bool = False) -> dict[str, Any] | None:
        with self._lock:
            try:
                with open(self.release_cache_path, "r", encoding="utf-8") as handle:
                    payload = json.load(handle)
            except (OSError, ValueError, TypeError):
                return None
            entry = payload.get(str(key)) if isinstance(payload, dict) else None
            if not isinstance(entry, dict):
                return None
            fetched_at = entry.get("fetched_at")
            if not allow_stale:
                try:
                    if float(fetched_at) + max(0.0, float(max_age_s)) < time.time():
                        return None
                except (TypeError, ValueError):
                    return None
            release = entry.get("release")
            return deepcopy(release) if isinstance(release, dict) else None

    def set_release_cache(self, key: str, release: dict[str, Any]) -> None:
        with self._lock:
            try:
                with open(self.release_cache_path, "r", encoding="utf-8") as handle:
                    payload = json.load(handle)
            except (OSError, ValueError, TypeError):
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            payload[str(key)] = {"fetched_at": time.time(), "release": deepcopy(release)}
            os.makedirs(self.root, exist_ok=True)
            _atomic_write_json(self.release_cache_path, payload, mode=0o600)
