"""Verified, transactional installation of curated Xray/Mihomo releases."""

from __future__ import annotations

import gzip
import hashlib
import io
import os
import posixpath
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import asdict
import re
from typing import Any, Callable
import zipfile

from services.core_profile_state import CoreProfileStateStore
from services.core_profiles import (
    CoreProfile,
    RouterPlatform,
    detect_router_platform,
    get_profile,
    list_profiles,
    profile_view,
    resolve_release,
)
from services.io.atomic import _atomic_write_json


class CoreInstallError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


_PHASE_PROGRESS = {
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
_PHASE_LABELS = {
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


class CoreInstaller:
    """Coordinates release resolution and an atomic install transaction."""

    def __init__(
        self,
        *,
        state_store: CoreProfileStateStore,
        binary_paths: dict[str, str],
        xray_configs_dir: str,
        mihomo_config_file: str,
        restart: Callable[..., Any],
        running_core: Callable[[], str | None],
        platform: RouterPlatform | None = None,
        release_resolver: Callable[..., dict[str, Any]] = resolve_release,
        downloader: Callable[..., bytes] | None = None,
        run_command: Callable[..., tuple[int, str]] | None = None,
        health_timeout_s: float = 10.0,
        resolve_timeout_s: float = 8.0,
        release_cache_ttl_s: float = 300.0,
    ):
        self.state_store = state_store
        self.binary_paths = {str(key): os.path.abspath(str(value)) for key, value in binary_paths.items()}
        self.xray_configs_dir = str(xray_configs_dir)
        self.mihomo_config_file = str(mihomo_config_file)
        self.restart = restart
        self.running_core = running_core
        self.platform = platform or detect_router_platform()
        self.release_resolver = release_resolver
        self.downloader = downloader or self._download
        self.run_command = run_command or self._run_command
        self.health_timeout_s = max(0.1, float(health_timeout_s))
        self.resolve_timeout_s = max(1.0, float(resolve_timeout_s))
        self.release_cache_ttl_s = max(0.0, float(release_cache_ttl_s))
        self._plans: dict[str, dict[str, Any]] = {}
        self._operations: dict[str, dict[str, Any]] = {}
        self._guard = threading.RLock()
        self._busy = False

    def profiles(self, engine_id: str) -> dict[str, Any]:
        selected = self.state_store.get(engine_id).get("selected_profile_id") or "official"
        installed = self.state_store.get(engine_id).get("installed_profile_id")
        state = self.state_store.get(engine_id)
        state["detected_version"] = self._read_binary_version(engine_id)
        items = []
        for profile in list_profiles(engine_id):
            release = self._resolve(profile)
            items.append({**profile_view(profile), "selected": profile.profile_id == selected, "installed": profile.profile_id == installed, "release": self._public_release(release)})
        return {"engine_id": engine_id, "platform": asdict(self.platform), "profiles": items, "state": state}

    def select(self, engine_id: str, profile_id: str) -> dict[str, Any]:
        return self.state_store.set_selected(engine_id, profile_id)

    def prepare(self, engine_id: str) -> dict[str, Any]:
        profile = get_profile(engine_id, self.state_store.get(engine_id).get("selected_profile_id") or "official")
        self._require_active(engine_id)
        release = self._resolve(profile, fresh=True)
        if not release.get("installable"):
            reason = str(release.get("reason") or "release_unavailable")
            raise CoreInstallError(reason, self._reason_message(reason))
        confirmation_id = secrets.token_urlsafe(18)
        plan = {
            "confirmation_id": confirmation_id,
            "engine_id": engine_id,
            "profile": profile_view(profile),
            "release": release,
            "created_at": time.time(),
            "expires_at": time.time() + 300,
        }
        with self._guard:
            self._plans[confirmation_id] = plan
        return self._public_plan(plan)

    def apply(self, engine_id: str, confirmation_id: str) -> dict[str, Any]:
        self._require_active(engine_id)
        with self._guard:
            plan = self._plans.get(str(confirmation_id))
            if not plan or plan.get("engine_id") != engine_id or float(plan.get("expires_at", 0)) < time.time():
                raise CoreInstallError("confirmation_expired", "Подтверждение устарело. Подготовьте установку заново.")
            if self._busy:
                raise CoreInstallError("operation_in_progress", "Установка другого ядра уже выполняется.")
            self._busy = True
            self._plans.pop(str(confirmation_id), None)
            operation_id = secrets.token_urlsafe(18)
            self._operations[operation_id] = {
                "operation_id": operation_id,
                "engine_id": engine_id,
                "status": "running",
                "phase": "download",
                "phase_label": _PHASE_LABELS["download"],
                "progress": _PHASE_PROGRESS["download"],
                "error": None,
                "started_at": time.time(),
                "finished_at": None,
            }
        thread = threading.Thread(target=self._run, args=(operation_id, plan), daemon=True, name=f"core-install-{engine_id}")
        thread.start()
        return {"operation_id": operation_id, "status": "running"}

    def status(self, engine_id: str, operation_id: str | None = None) -> dict[str, Any]:
        with self._guard:
            if operation_id:
                operation = self._operations.get(str(operation_id))
                if operation and operation.get("engine_id") == engine_id:
                    return dict(operation)
                raise CoreInstallError("operation_not_found", "Операция установки не найдена.")
            candidates = [item for item in self._operations.values() if item.get("engine_id") == engine_id]
            if candidates:
                return dict(max(candidates, key=lambda item: float(item.get("started_at") or 0)))
        state = self.state_store.get(engine_id)
        return {
            "operation_id": state.get("last_operation_id"),
            "engine_id": engine_id,
            "status": state.get("last_status", "idle"),
            "phase": state.get("last_phase", "idle"),
            "phase_label": state.get("last_phase_label", _PHASE_LABELS.get(state.get("last_phase"), "Ожидание установки")),
            "progress": state.get("last_progress", 0),
            "error": state.get("last_error"),
        }

    def _resolve(self, profile: CoreProfile, *, fresh: bool = False) -> dict[str, Any]:
        cache_key = f"{profile.engine_id}:{profile.profile_id}:{self.platform.machine}:{self.platform.opkg_arch}:{self.platform.endianness}"
        cached = None if fresh else self.state_store.get_release_cache(cache_key, max_age_s=self.release_cache_ttl_s)
        stale_cached = self.state_store.get_release_cache(cache_key, max_age_s=0, allow_stale=True)
        if cached is not None:
            return cached
        if not fresh and isinstance(stale_cached, dict) and stale_cached.get("installable"):
            return {**stale_cached, "stale": True}
        release = self.release_resolver(profile, self.platform, timeout_s=self.resolve_timeout_s)
        if release.get("installable"):
            self.state_store.set_release_cache(cache_key, release)
        elif (
            str(release.get("reason") or "") == "github_unavailable"
            and isinstance(stale_cached, dict)
            and stale_cached.get("installable")
        ):
            return {**stale_cached, "stale": True}
        return release

    @staticmethod
    def _public_release(release: dict[str, Any]) -> dict[str, Any]:
        value = dict(release)
        checksum = value.get("checksum")
        if isinstance(checksum, dict):
            value["checksum"] = {"sha256": checksum.get("sha256"), "name": checksum.get("name")}
        return value

    def _public_plan(self, plan: dict[str, Any]) -> dict[str, Any]:
        return {
            "confirmation_id": plan["confirmation_id"],
            "engine_id": plan["engine_id"],
            "profile": plan["profile"],
            "release": self._public_release(plan["release"]),
            "expires_at": plan["expires_at"],
        }

    def _require_active(self, engine_id: str) -> None:
        if engine_id not in {"xray", "mihomo"}:
            raise CoreInstallError("invalid_engine", "Неизвестное ядро.")
        try:
            active = self.running_core()
        except Exception:
            active = None
        if active != engine_id:
            raise CoreInstallError("inactive_core", "Устанавливать можно только активное ядро.")

    @staticmethod
    def _reason_message(reason: str) -> str:
        return {
            "asset_missing": "Для архитектуры роутера нет подходящего asset.",
            "checksum_missing": "Релиз не содержит обязательную контрольную сумму.",
            "unsupported_arch": "Архитектура роутера не поддерживается этим профилем.",
            "github_unavailable": "GitHub недоступен. Попробуйте позже.",
            "invalid_release": "Последний релиз не является стабильным проверенным релизом.",
        }.get(reason, "Релиз источника недоступен для установки.")

    def _set_operation(self, operation_id: str, **changes: Any) -> None:
        with self._guard:
            self._operations[operation_id].update(changes)

    def _phase(self, operation_id: str, engine_id: str, phase: str) -> None:
        progress = _PHASE_PROGRESS.get(phase, 0)
        phase_label = _PHASE_LABELS.get(phase, phase)
        self._set_operation(operation_id, phase=phase, phase_label=phase_label, progress=progress)
        self.state_store.set_runtime(
            engine_id,
            status="running",
            phase=phase,
            error=None,
            operation_id=operation_id,
            progress=progress,
            phase_label=phase_label,
        )

    def _run(self, operation_id: str, plan: dict[str, Any]) -> None:
        engine_id = str(plan["engine_id"])
        profile = get_profile(engine_id, str(plan["profile"]["profile_id"]))
        release = plan["release"]
        target = self.binary_paths.get(engine_id)
        backup_dir = os.path.join(self.state_store.root, "backups", operation_id)
        backup_target = os.path.join(backup_dir, profile.binary_name)
        prior_state = self.state_store.snapshot()
        had_backup = False
        replaced = False
        current_phase = "download"
        try:
            if not target:
                raise CoreInstallError("binary_path_missing", "Не найден путь к бинарному файлу ядра.")
            current_phase = "download"
            self._phase(operation_id, engine_id, "download")
            payload = self.downloader(str(release["asset"]["url"]), timeout_s=self.resolve_timeout_s)
            if not isinstance(payload, (bytes, bytearray)):
                raise CoreInstallError("download_failed", "Источник вернул некорректный файл.")
            current_phase = "verify"
            self._phase(operation_id, engine_id, "verify")
            expected = str(release["checksum"]["sha256"]).lower()
            actual = hashlib.sha256(bytes(payload)).hexdigest().lower()
            if actual != expected:
                raise CoreInstallError("checksum_mismatch", "Контрольная сумма файла не совпала.")
            binary = self._extract(bytes(payload), str(release["asset"]["name"]), profile.binary_name)
            if not binary:
                raise CoreInstallError("binary_missing", "В архиве нет бинарного файла ядра.")
            self._require_active(engine_id)
            current_phase = "backup"
            self._phase(operation_id, engine_id, "backup")
            os.makedirs(backup_dir, exist_ok=True)
            _atomic_write_json(os.path.join(backup_dir, "state.json"), prior_state, mode=0o600)
            if os.path.exists(target):
                shutil.copy2(target, backup_target)
                had_backup = True
            current_phase = "replace"
            self._phase(operation_id, engine_id, "replace")
            os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
            fd, temp_path = tempfile.mkstemp(prefix=os.path.basename(target) + ".", suffix=".new", dir=os.path.dirname(target) or ".")
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(binary)
                    handle.flush()
                    os.fsync(handle.fileno())
                try:
                    os.chmod(temp_path, 0o755)
                except OSError:
                    pass
                self._require_active(engine_id)
                os.replace(temp_path, target)
            finally:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
            replaced = True
            current_phase = "preflight"
            self._phase(operation_id, engine_id, current_phase)
            command = self._preflight_command(engine_id, target)
            code, output = self.run_command(command, timeout_s=self.resolve_timeout_s)
            if int(code) != 0:
                raise CoreInstallError("preflight_failed", "Конфигурация не прошла проверку перед установкой.")
            current_phase = "restart"
            self._phase(operation_id, engine_id, current_phase)
            self._require_active(engine_id)
            self._restart()
            current_phase = "healthcheck"
            self._phase(operation_id, engine_id, current_phase)
            deadline = time.monotonic() + self.health_timeout_s
            observed_core = None
            while True:
                observed_core = self.running_core()
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.05)
            if observed_core != engine_id:
                raise CoreInstallError("healthcheck_failed", "Ядро не прошло проверку после перезапуска.")
            self.state_store.set_installed(
                engine_id,
                profile_id=profile.profile_id,
                release_tag=str(release["stable"]["tag"]),
                asset_name=str(release["asset"]["name"]),
            )
            self.state_store.set_runtime(
                engine_id,
                status="succeeded",
                phase="complete",
                error=None,
                operation_id=operation_id,
                progress=100,
                phase_label=_PHASE_LABELS["complete"],
            )
            self._set_operation(
                operation_id,
                status="succeeded",
                phase="complete",
                phase_label=_PHASE_LABELS["complete"],
                progress=100,
                finished_at=time.time(),
                error=None,
            )
        except Exception as exc:
            error = exc.message if isinstance(exc, CoreInstallError) else "Не удалось завершить установку ядра."
            if replaced and had_backup:
                try:
                    self._phase(operation_id, engine_id, "rollback")
                    os.replace(backup_target, target)
                    self.state_store.restore_install_state(engine_id, prior_state)
                    if self.running_core() != self._other_engine(engine_id):
                        self._restart()
                    self._set_operation(
                        operation_id,
                        status="rolled_back",
                        phase="rolled_back",
                        phase_label=_PHASE_LABELS["rolled_back"],
                        progress=100,
                        finished_at=time.time(),
                        error=error,
                    )
                    self.state_store.set_runtime(
                        engine_id,
                        status="rolled_back",
                        phase="rolled_back",
                        error=error,
                        operation_id=operation_id,
                        progress=100,
                        phase_label=_PHASE_LABELS["rolled_back"],
                    )
                except Exception as rollback_exc:
                    rollback_error = "Не удалось завершить откат ядра."
                    self._set_operation(operation_id, status="failed", phase="rollback", phase_label=_PHASE_LABELS["rollback"], progress=_PHASE_PROGRESS["rollback"], finished_at=time.time(), error=rollback_error)
                    self.state_store.set_runtime(engine_id, status="failed", phase="rollback", error=rollback_error, operation_id=operation_id, progress=_PHASE_PROGRESS["rollback"], phase_label=_PHASE_LABELS["rollback"])
            elif replaced:
                try:
                    if os.path.exists(target):
                        os.unlink(target)
                    self.state_store.restore_install_state(engine_id, prior_state)
                    if self.running_core() != self._other_engine(engine_id):
                        self._restart()
                except Exception:
                    rollback_error = "Не удалось завершить откат ядра."
                    self._set_operation(operation_id, status="failed", phase="rollback", phase_label=_PHASE_LABELS["rollback"], progress=_PHASE_PROGRESS["rollback"], finished_at=time.time(), error=rollback_error)
                    self.state_store.set_runtime(engine_id, status="failed", phase="rollback", error=rollback_error, operation_id=operation_id, progress=_PHASE_PROGRESS["rollback"], phase_label=_PHASE_LABELS["rollback"])
                else:
                    self._set_operation(operation_id, status="rolled_back", phase="rolled_back", phase_label=_PHASE_LABELS["rolled_back"], progress=100, finished_at=time.time(), error=error)
                    self.state_store.set_runtime(engine_id, status="rolled_back", phase="rolled_back", error=error, operation_id=operation_id, progress=100, phase_label=_PHASE_LABELS["rolled_back"])
            else:
                phase_label = _PHASE_LABELS.get(current_phase, current_phase)
                progress = _PHASE_PROGRESS.get(current_phase, 0)
                self._set_operation(operation_id, status="failed", phase=current_phase, phase_label=phase_label, progress=progress, finished_at=time.time(), error=error)
                self.state_store.set_runtime(engine_id, status="failed", phase=current_phase, error=error, operation_id=operation_id, progress=progress, phase_label=phase_label)
        finally:
            with self._guard:
                self._busy = False

    def _restart(self) -> None:
        try:
            result = self.restart(source="core-install")
        except TypeError:
            result = self.restart()
        if result is False:
            raise CoreInstallError("restart_failed", "Не удалось перезапустить сервис ядра.")

    def _preflight_command(self, engine_id: str, target: str) -> list[str]:
        if engine_id == "xray":
            return [target, "-test", "-confdir", self.xray_configs_dir]
        return [target, "-t", "-f", self.mihomo_config_file]

    @staticmethod
    def _other_engine(engine_id: str) -> str:
        return "mihomo" if engine_id == "xray" else "xray"

    def _read_binary_version(self, engine_id: str) -> str | None:
        binary = self.binary_paths.get(engine_id)
        if not binary or not os.path.isfile(binary):
            return None
        command = [binary, "-version"] if engine_id == "xray" else [binary, "-v"]
        try:
            code, output = self.run_command(command, timeout_s=2.5)
        except Exception:
            return None
        if int(code) != 0:
            return None
        match = re.search(r"\bv?\d+(?:\.\d+){1,2}(?:[-+][0-9A-Za-z.-]+)?", str(output or ""))
        return match.group(0) if match else None

    @staticmethod
    def _extract(payload: bytes, asset_name: str, binary_name: str) -> bytes:
        if asset_name.endswith(".gz"):
            try:
                return gzip.decompress(payload)
            except (OSError, EOFError) as exc:
                raise CoreInstallError("archive_invalid", "Не удалось распаковать gzip-архив.") from exc
        if not asset_name.endswith(".zip"):
            return payload
        try:
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                for member in archive.infolist():
                    clean = posixpath.normpath(member.filename)
                    if clean.startswith("../") or clean.startswith("/") or member.is_dir():
                        continue
                    if posixpath.basename(clean) in {binary_name, "xray", "mihomo"}:
                        return archive.read(member)
        except (OSError, zipfile.BadZipFile) as exc:
            raise CoreInstallError("archive_invalid", "Не удалось распаковать zip-архив.") from exc
        raise CoreInstallError("binary_missing", "В архиве нет бинарного файла ядра.")

    @staticmethod
    def _download(url: str, *, timeout_s: float) -> bytes:
        import urllib.request

        with urllib.request.urlopen(str(url), timeout=float(timeout_s)) as response:
            return response.read()

    @staticmethod
    def _run_command(command: list[str], *, timeout_s: float) -> tuple[int, str]:
        try:
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=float(timeout_s))
            return int(result.returncode), str(result.stdout or "")
        except (OSError, subprocess.TimeoutExpired) as exc:
            return 1, str(exc)
