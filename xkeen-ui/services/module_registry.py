"""Versioned registry and persisted activation state for Xkeen UI modules.

The registry is intentionally configuration-only in Stage 1 of the modular
panel rollout.  It records the requested/effective module set and exposes
stable metadata, but it does *not* yet gate Flask blueprint registration,
frontend imports, or background tasks.  Those runtime gates are introduced in
later stages after the registry has been deployed and migrated safely.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from services.io import read_json, safe_write_text


API_VERSION = 1
STATE_SCHEMA_VERSION = 1
REGISTRY_VERSION = "1.0.0"
STATE_FILENAME = "modules.json"
RUNTIME_DIAGNOSTICS_FILENAME = "module-runtime.json"
LEGACY_FULL_PROFILE = "legacy-full"
CUSTOM_PROFILE = "custom"


@dataclass(frozen=True, slots=True)
class SystemRequirement:
    """A declared runtime dependency of a module."""

    id: str
    optional: bool = False


@dataclass(frozen=True, slots=True)
class ModuleDefinition:
    """Static, shipped metadata for one official Xkeen UI module."""

    id: str
    name: str
    description: str
    version: str
    dependencies: tuple[str, ...]
    conflicts: tuple[str, ...]
    system_requirements: tuple[SystemRequirement, ...]
    size_bytes: int
    removable: bool
    can_disable: bool
    requires_restart: bool
    frontend_bundles: tuple[str, ...] = ()
    navigation_views: tuple[str, ...] = ()
    installed: bool = True


def _requirement(id: str, *, optional: bool = False) -> SystemRequirement:
    return SystemRequirement(id=id, optional=optional)


# This is the source of truth for the base registry.  Sizes and boundaries
# originate from the Stage 0 inventory; keeping them here makes the runtime API
# independent of documentation files, which are not guaranteed to be shipped.
MODULE_DEFINITIONS: tuple[ModuleDefinition, ...] = (
    ModuleDefinition(
        id="core",
        name="Xkeen UI Core",
        description="Запуск панели, авторизация, shell, настройки, сервис и общий runtime.",
        version=REGISTRY_VERSION,
        dependencies=(),
        conflicts=(),
        system_requirements=(_requirement("python3"), _requirement("flask")),
        size_bytes=5740236,
        removable=False,
        can_disable=False,
        requires_restart=False,
        frontend_bundles=("panel-core",),
        navigation_views=("xkeen",),
    ),
    ModuleDefinition(
        id="engine.xray",
        name="Xray",
        description="Routing, inbounds, outbounds, подписки, логи, DNS-over-VLESS и geodat.",
        version=REGISTRY_VERSION,
        dependencies=("core", "tool.editor"),
        conflicts=(),
        system_requirements=(_requirement("xkeen"), _requirement("xray")),
        size_bytes=3492277,
        removable=True,
        can_disable=True,
        requires_restart=True,
        frontend_bundles=("panel-routing",),
        navigation_views=("routing", "xray-logs"),
    ),
    ModuleDefinition(
        id="engine.mihomo",
        name="Mihomo",
        description="Mihomo config, Clash API, DNS, генератор, импорт, telemetry и Zashboard.",
        version=REGISTRY_VERSION,
        dependencies=("core", "tool.editor"),
        conflicts=(),
        system_requirements=(_requirement("xkeen"), _requirement("mihomo")),
        size_bytes=2977965,
        removable=True,
        can_disable=True,
        requires_restart=True,
        frontend_bundles=("panel-mihomo", "mihomo-generator-page"),
        navigation_views=("mihomo",),
    ),
    ModuleDefinition(
        id="tool.editor",
        name="Редакторы",
        description="CodeMirror, Monaco, JSON/YAML schema, форматирование, diff и quick-fix.",
        version=REGISTRY_VERSION,
        dependencies=("core",),
        conflicts=(),
        system_requirements=(_requirement("browser-esm"),),
        size_bytes=828077,
        removable=True,
        can_disable=True,
        requires_restart=True,
    ),
    ModuleDefinition(
        id="tool.terminal",
        name="Терминал и команды",
        description="PTY, WebSocket, xterm, command jobs и shell policy.",
        version=REGISTRY_VERSION,
        dependencies=("core",),
        conflicts=(),
        system_requirements=(
            _requirement("shell"),
            _requirement("gevent", optional=True),
            _requirement("gevent-websocket", optional=True),
        ),
        size_bytes=508806,
        removable=True,
        can_disable=True,
        requires_restart=True,
        frontend_bundles=("terminal-lazy",),
        navigation_views=("commands",),
    ),
    ModuleDefinition(
        id="tool.files",
        name="Файловый менеджер",
        description="Локальные/удалённые операции, архивы, передачи и USB storage.",
        version=REGISTRY_VERSION,
        dependencies=("core",),
        conflicts=(),
        system_requirements=(
            _requirement("lftp", optional=True),
            _requirement("ndmc", optional=True),
        ),
        size_bytes=995945,
        removable=True,
        can_disable=True,
        requires_restart=True,
        frontend_bundles=("file-manager-lazy",),
        navigation_views=("files",),
    ),
    ModuleDefinition(
        id="tool.backups",
        name="Резервные копии",
        description="Страница и API резервных копий конфигураций Xray/Mihomo.",
        version=REGISTRY_VERSION,
        dependencies=("core",),
        conflicts=(),
        system_requirements=(),
        size_bytes=109598,
        removable=True,
        can_disable=True,
        requires_restart=True,
        frontend_bundles=("backups-page",),
        navigation_views=("backups",),
    ),
    ModuleDefinition(
        id="integration.happ",
        name="Happ",
        description="Декриптор Happ, payload/link helpers и Mihomo HWID/Happ subscriptions.",
        version=REGISTRY_VERSION,
        dependencies=("core", "engine.mihomo"),
        conflicts=(),
        system_requirements=(_requirement("happ-decrypt-universal", optional=True),),
        size_bytes=347312,
        removable=True,
        can_disable=True,
        requires_restart=True,
    ),
    ModuleDefinition(
        id="tool.advanced-diagnostics",
        name="Расширенная диагностика",
        description="DevTools, ресурсы, router diagnostics, update UI и служебные журналы.",
        version=REGISTRY_VERSION,
        dependencies=("core",),
        conflicts=(),
        system_requirements=(_requirement("ndmc", optional=True),),
        size_bytes=617690,
        removable=True,
        can_disable=True,
        requires_restart=True,
        frontend_bundles=("devtools-page",),
        navigation_views=("devtools",),
    ),
)

MODULE_IDS = tuple(definition.id for definition in MODULE_DEFINITIONS)
_DEFINITIONS_BY_ID = {definition.id: definition for definition in MODULE_DEFINITIONS}
_MAX_LAST_ERROR_CHARS = 1024


class ModuleRegistryError(ValueError):
    """Expected, client-safe error from a module registry operation."""

    def __init__(self, code: str, message: str, *, status: int = 400, **details: Any):
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details


class ModuleRegistry:
    """Read and update the official module registry for one UI state directory."""

    def __init__(
        self,
        ui_state_dir: str,
        *,
        which: Callable[[str], str | None] = shutil.which,
        environ: Mapping[str, str] | None = None,
    ):
        self.ui_state_dir = os.fspath(ui_state_dir)
        self._path = os.path.join(self.ui_state_dir, STATE_FILENAME)
        self._which = which
        self._environ = environ
        self._lock = threading.RLock()
        self._runtime_activation: dict[str, Any] | None = None

    @property
    def state_path(self) -> str:
        """Absolute path to the persisted module activation state."""

        return self._path

    def initialize_for_startup(self) -> dict[str, Any]:
        """Create/migrate state and consume a restart request on application boot."""

        with self._lock:
            state, changed = self._load_state_locked()
            if state["restart_required"]:
                state["restart_required"] = False
                changed = True
            if changed:
                self._write_state_locked(state)
            return self._snapshot_from_state(state)

    def runtime_activation(self) -> dict[str, Any]:
        """Resolve the module set used by backend gates during this process.

        A missing/legacy state must not make an existing installation lose
        routes.  ``legacy-full`` therefore keeps the historical eager
        activation while still exposing unavailable requirements in the
        registry.  Any explicit profile uses the effective dependency and
        system-requirement result.
        """

        try:
            snapshot = self.get_registry()
            legacy_compatibility = snapshot.get("profile") == LEGACY_FULL_PROFILE
            active: list[str] = []
            inactive: dict[str, str] = {}
            for item in snapshot.get("modules", []):
                module_id = str(item.get("id") or "").strip()
                if not module_id:
                    continue
                if not bool(item.get("enabled")):
                    inactive[module_id] = str(item.get("reason") or "user_disabled")
                elif legacy_compatibility or bool(item.get("effective_enabled")):
                    active.append(module_id)
                else:
                    inactive[module_id] = str(item.get("reason") or "module_unavailable")

            if "core" not in active:
                active.insert(0, "core")
                inactive.pop("core", None)

            return {
                "schema_version": STATE_SCHEMA_VERSION,
                "api_version": API_VERSION,
                "profile": snapshot.get("profile"),
                "legacy_compatibility": legacy_compatibility,
                "runtime_gates_active": True,
                "active_module_ids": active,
                "inactive_modules": inactive,
                "restart_required": bool(snapshot.get("restart_required")),
            }

        except Exception:
            # A registry I/O failure must not brick an existing panel.  Keep
            # the same safe legacy-full activation and expose the failure for
            # diagnostics.
            return {
                "schema_version": STATE_SCHEMA_VERSION,
                "api_version": API_VERSION,
                "profile": LEGACY_FULL_PROFILE,
                "legacy_compatibility": True,
                "runtime_gates_active": True,
                "active_module_ids": list(MODULE_IDS),
                "inactive_modules": {},
                "restart_required": False,
                "reason": "module_registry_unavailable",
            }

    def set_runtime_activation(self, activation: Mapping[str, Any]) -> None:
        """Publish the activation used by the current Flask process."""

        self._runtime_activation = dict(activation)

    def is_runtime_active(self, module_id: str) -> bool:
        """Return whether a module is active for backend registration."""

        normalized_id = self._require_known_module(module_id)
        return normalized_id in set(self.runtime_activation()["active_module_ids"])

    def write_runtime_diagnostic(
        self,
        activation: Mapping[str, Any],
        *,
        registered_blueprints: list[str],
        background_tasks: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Persist a compact, secret-free report of the composed backend."""

        payload = {
            "schema_version": 1,
            "written_at": int(time.time()),
            "profile": activation.get("profile"),
            "runtime_gates_active": True,
            "active_module_ids": list(activation.get("active_module_ids") or []),
            "inactive_modules": dict(activation.get("inactive_modules") or {}),
            "registered_blueprints": sorted(set(registered_blueprints)),
            "background_tasks": list(background_tasks),
        }
        safe_write_text(
            os.path.join(self.ui_state_dir, RUNTIME_DIAGNOSTICS_FILENAME),
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            mode=0o600,
        )
        return payload

    def get_registry(self) -> dict[str, Any]:
        """Return the complete, stable registry payload."""

        with self._lock:
            state, changed = self._load_state_locked()
            if changed:
                self._write_state_locked(state)
            return self._snapshot_from_state(state)

    def get_module(self, module_id: str) -> dict[str, Any]:
        """Return a single module together with effective-set context."""

        normalized_id = self._require_known_module(module_id)
        snapshot = self.get_registry()
        for item in snapshot["modules"]:
            if item["id"] == normalized_id:
                return {
                    "ok": True,
                    "api_version": API_VERSION,
                    "schema_version": STATE_SCHEMA_VERSION,
                    "registry_version": REGISTRY_VERSION,
                    "profile": snapshot["profile"],
                    "restart_required": snapshot["restart_required"],
                    "runtime_gates_active": bool(snapshot["runtime_gates_active"]),
                    "configured_module_ids": snapshot["configured_module_ids"],
                    "effective_module_ids": snapshot["effective_module_ids"],
                    "module": item,
                }
        # `_require_known_module` makes this unreachable; retain a defensive
        # failure in case a future registry serializer is changed incorrectly.
        raise ModuleRegistryError("module_not_found", "Модуль не найден.", status=404)

    def set_enabled(self, module_id: str, enabled: bool) -> tuple[dict[str, Any], bool]:
        """Persist a requested module state and return (payload, changed)."""

        normalized_id = self._require_known_module(module_id)
        if not isinstance(enabled, bool):
            raise ModuleRegistryError(
                "invalid_enabled",
                "Поле enabled должно быть boolean.",
                status=400,
            )

        with self._lock:
            state, normalized = self._load_state_locked()
            definition = _DEFINITIONS_BY_ID[normalized_id]
            current_enabled = bool(state["modules"][normalized_id]["enabled"])

            if not enabled and not definition.can_disable:
                raise ModuleRegistryError(
                    "core_required",
                    "Базовый модуль core нельзя отключить.",
                    status=409,
                    module_id=normalized_id,
                )

            if not enabled:
                dependents = self._enabled_dependents(normalized_id, state)
                if dependents:
                    raise ModuleRegistryError(
                        "module_required_by",
                        "Модуль требуется включённым зависимым модулям.",
                        status=409,
                        module_id=normalized_id,
                        dependent_module_ids=dependents,
                    )
            else:
                conflicts = [
                    conflict_id
                    for conflict_id in definition.conflicts
                    if bool(state["modules"].get(conflict_id, {}).get("enabled"))
                ]
                if conflicts:
                    raise ModuleRegistryError(
                        "module_conflict",
                        "Модуль конфликтует с уже включённым модулем.",
                        status=409,
                        module_id=normalized_id,
                        conflict_module_ids=conflicts,
                    )

                # Enabling a module enables its declared dependencies as well.
                # This prevents a persisted state which can never become
                # effective after the backend gates are introduced.
                dependency_changed = self._enable_dependencies(normalized_id, state)

            changed = current_enabled != enabled or (enabled and dependency_changed)
            if changed:
                state["modules"][normalized_id]["enabled"] = enabled
                state["profile"] = CUSTOM_PROFILE
                if definition.requires_restart:
                    state["restart_required"] = True

            if changed or normalized:
                self._write_state_locked(state)

            snapshot = self._snapshot_from_state(state)
            module_payload = next(item for item in snapshot["modules"] if item["id"] == normalized_id)
            return (
                {
                    "ok": True,
                    "api_version": API_VERSION,
                    "schema_version": STATE_SCHEMA_VERSION,
                    "registry_version": REGISTRY_VERSION,
                    "profile": snapshot["profile"],
                    "restart_required": snapshot["restart_required"],
                    "runtime_gates_active": bool(snapshot["runtime_gates_active"]),
                    "configured_module_ids": snapshot["configured_module_ids"],
                    "effective_module_ids": snapshot["effective_module_ids"],
                    "module": module_payload,
                },
                changed,
            )

    def _load_state_locked(self) -> tuple[dict[str, Any], bool]:
        file_exists = os.path.isfile(self._path)
        raw = read_json(self._path, default=None) if file_exists else None
        state, normalized = self._normalize_state(raw)
        return state, normalized or not file_exists

    def _write_state_locked(self, state: Mapping[str, Any]) -> None:
        text = json.dumps(state, ensure_ascii=False, indent=2) + "\n"
        safe_write_text(self._path, text, mode=0o600)

    def _normalize_state(self, raw: Any) -> tuple[dict[str, Any], bool]:
        """Migrate pre-v1 forms and sanitize all persisted state to schema v1."""

        default = self._default_state()
        if not isinstance(raw, dict):
            return default, True

        changed = False
        schema_version = raw.get("schema_version")
        if schema_version is None:
            schema_version = raw.get("schemaVersion")
            changed = True
        if not isinstance(schema_version, int) or isinstance(schema_version, bool):
            changed = True
        elif schema_version != STATE_SCHEMA_VERSION:
            # v0 state is converted below.  A newer unknown schema is reduced
            # to the stable, supported contract instead of being trusted.
            changed = True

        profile = raw.get("profile", LEGACY_FULL_PROFILE)
        if not isinstance(profile, str) or not profile.strip() or len(profile.strip()) > 64:
            profile = LEGACY_FULL_PROFILE
            changed = True
        else:
            profile = profile.strip()

        raw_modules = raw.get("modules")
        legacy_enabled_modules = raw.get("enabled_modules", raw.get("active_modules"))
        if isinstance(raw_modules, list) and not isinstance(legacy_enabled_modules, list):
            legacy_enabled_modules = raw_modules
            raw_modules = None
            changed = True

        if raw_modules is not None and not isinstance(raw_modules, dict):
            raw_modules = None
            changed = True

        legacy_enabled: set[str] | None = None
        if isinstance(legacy_enabled_modules, list):
            legacy_enabled = {item for item in legacy_enabled_modules if isinstance(item, str)}
            changed = True
        elif legacy_enabled_modules is not None:
            changed = True

        modules: dict[str, dict[str, Any]] = {}
        for definition in MODULE_DEFINITIONS:
            raw_item = raw_modules.get(definition.id) if isinstance(raw_modules, dict) else None
            enabled = True
            last_error: str | None = None

            if legacy_enabled is not None:
                enabled = definition.id in legacy_enabled
            elif isinstance(raw_item, bool):
                enabled = raw_item
                changed = True
            elif isinstance(raw_item, dict):
                configured = raw_item.get("enabled")
                if isinstance(configured, bool):
                    enabled = configured
                elif configured is not None:
                    changed = True
                raw_error = raw_item.get("last_error")
                if isinstance(raw_error, str) and raw_error.strip():
                    last_error = raw_error.strip()[:_MAX_LAST_ERROR_CHARS]
                    if last_error != raw_error:
                        changed = True
                elif raw_error is not None:
                    changed = True
            elif raw_item is not None:
                changed = True

            if definition.id == "core" and not enabled:
                enabled = True
                changed = True

            item: dict[str, Any] = {"enabled": enabled}
            if last_error:
                item["last_error"] = last_error
            modules[definition.id] = item

        if isinstance(raw_modules, dict) and set(raw_modules) != set(MODULE_IDS):
            changed = True

        restart_required = raw.get("restart_required", False)
        if not isinstance(restart_required, bool):
            restart_required = False
            changed = True

        normalized = {
            "schema_version": STATE_SCHEMA_VERSION,
            "profile": profile,
            "restart_required": restart_required,
            "modules": modules,
        }
        if raw != normalized:
            changed = True
        return normalized, changed

    @staticmethod
    def _default_state() -> dict[str, Any]:
        """Legacy installations start with every shipped module enabled."""

        return {
            "schema_version": STATE_SCHEMA_VERSION,
            "profile": LEGACY_FULL_PROFILE,
            "restart_required": False,
            "modules": {module_id: {"enabled": True} for module_id in MODULE_IDS},
        }

    def _snapshot_from_state(self, state: Mapping[str, Any]) -> dict[str, Any]:
        module_payloads = self._module_payloads(state)
        configured_module_ids = [
            definition.id
            for definition in MODULE_DEFINITIONS
            if bool(state["modules"][definition.id]["enabled"])
        ]
        effective_module_ids = [
            item["id"] for item in module_payloads if bool(item["effective_enabled"])
        ]
        return {
            "ok": True,
            "api_version": API_VERSION,
            "schema_version": STATE_SCHEMA_VERSION,
            "registry_version": REGISTRY_VERSION,
            "profile": str(state["profile"]),
            "restart_required": bool(state["restart_required"]),
            # This documents the intentional Stage 1 compatibility boundary.
            # The effective set is an eligibility calculation until Stage 3.
            "runtime_gates_active": bool(self._runtime_activation),
            "configured_module_ids": configured_module_ids,
            "effective_module_ids": effective_module_ids,
            "modules": module_payloads,
        }

    def _module_payloads(self, state: Mapping[str, Any]) -> list[dict[str, Any]]:
        requirement_status = {
            definition.id: self._requirement_status(definition)
            for definition in MODULE_DEFINITIONS
        }
        results: dict[str, dict[str, Any]] = {}

        def resolve(module_id: str, resolving: set[str] | None = None) -> dict[str, Any]:
            existing = results.get(module_id)
            if existing is not None:
                return existing

            resolving = resolving or set()
            if module_id in resolving:
                # Static definitions are validated by tests; still make a
                # bad future edit observable instead of recursing forever.
                raise RuntimeError(f"module dependency cycle at {module_id}")
            resolving.add(module_id)

            definition = _DEFINITIONS_BY_ID[module_id]
            module_state = state["modules"][module_id]
            requested_enabled = bool(module_state["enabled"])
            requirements = requirement_status[module_id]
            missing_requirements = [
                item["id"] for item in requirements if not item["optional"] and not item["available"]
            ]

            dependency_payloads = [resolve(dependency_id, resolving) for dependency_id in definition.dependencies]
            unavailable_dependencies = [
                item["id"] for item in dependency_payloads if not item["effective_enabled"]
            ]

            status = "enabled"
            reason: str | None = None
            effective_enabled = False
            last_error = module_state.get("last_error")

            if not definition.installed:
                status = "not_installed"
                reason = "module_not_installed"
            elif not requested_enabled:
                status = "disabled"
                reason = "user_disabled"
            elif isinstance(last_error, str) and last_error:
                status = "failed"
                reason = "last_initialization_failed"
            elif missing_requirements:
                status = "unavailable"
                reason = "system_requirements_unmet"
            elif unavailable_dependencies:
                status = "unavailable"
                reason = "dependency_unavailable"
            else:
                effective_enabled = True

            payload: dict[str, Any] = {
                "id": definition.id,
                "module_id": definition.id,
                "name": definition.name,
                "description": definition.description,
                "version": definition.version,
                "api_version": API_VERSION,
                "depends_on": list(definition.dependencies),
                "dependencies": list(definition.dependencies),
                "conflicts": list(definition.conflicts),
                "system_requirements": requirements,
                "size_bytes": definition.size_bytes,
                "removable": definition.removable,
                "can_disable": definition.can_disable,
                "requires_restart": definition.requires_restart,
                "frontend": {
                    "bundles": list(definition.frontend_bundles),
                    "navigation_views": list(definition.navigation_views),
                },
                "installed": definition.installed,
                # `enabled` is the persisted user request; `effective_enabled`
                # is the dependency/system eligibility result.
                "enabled": requested_enabled,
                "effective_enabled": effective_enabled,
                "available": not missing_requirements,
                "status": status,
                "reason": reason,
                "missing_requirement_ids": missing_requirements,
                "unavailable_dependency_ids": unavailable_dependencies,
            }
            if isinstance(last_error, str) and last_error:
                payload["last_error"] = last_error

            resolving.remove(module_id)
            results[module_id] = payload
            return payload

        return [resolve(definition.id) for definition in MODULE_DEFINITIONS]

    def _requirement_status(self, definition: ModuleDefinition) -> list[dict[str, Any]]:
        return [
            {
                "id": requirement.id,
                "optional": requirement.optional,
                "available": self._is_requirement_available(requirement.id),
            }
            for requirement in definition.system_requirements
        ]

    def _is_requirement_available(self, requirement_id: str) -> bool:
        env = self._environ if self._environ is not None else os.environ
        try:
            if requirement_id == "python3":
                return bool(sys.executable)
            if requirement_id == "flask":
                return importlib.util.find_spec("flask") is not None
            if requirement_id == "browser-esm":
                # Browser assets are bundled with the official panel package.
                return True
            if requirement_id == "shell":
                return bool(
                    self._which("sh")
                    or self._which("bash")
                    or self._which("ash")
                    or env.get("ComSpec")
                )
            if requirement_id == "xkeen":
                return bool(
                    self._which(str(env.get("XKEEN_BIN", "xkeen")))
                    or self._executable_path("/opt/sbin/xkeen")
                    or self._executable_path("/opt/etc/init.d/S05xkeen")
                    or self._executable_path("/opt/etc/init.d/S99xkeen")
                )
            if requirement_id == "xray":
                return bool(
                    self._executable_path("/opt/sbin/xray")
                    or self._executable_path("/opt/bin/xray")
                    or self._which("xray")
                )
            if requirement_id == "mihomo":
                return bool(
                    self._executable_path("/opt/sbin/mihomo")
                    or self._executable_path("/opt/bin/mihomo")
                    or self._which(str(env.get("MIHOMO_BIN", "mihomo")))
                )
            if requirement_id == "gevent":
                return importlib.util.find_spec("gevent") is not None
            if requirement_id == "gevent-websocket":
                return importlib.util.find_spec("geventwebsocket") is not None
            return bool(self._which(requirement_id))
        except Exception:
            return False

    @staticmethod
    def _executable_path(path: str) -> bool:
        try:
            return os.path.isfile(path) and os.access(path, os.X_OK)
        except OSError:
            return False

    @staticmethod
    def _require_known_module(module_id: str) -> str:
        normalized = str(module_id or "").strip()
        if normalized not in _DEFINITIONS_BY_ID:
            raise ModuleRegistryError(
                "module_not_found",
                "Модуль не найден.",
                status=404,
                module_id=normalized,
            )
        return normalized

    @staticmethod
    def _enabled_dependents(module_id: str, state: Mapping[str, Any]) -> list[str]:
        dependents: list[str] = []
        for definition in MODULE_DEFINITIONS:
            if not bool(state["modules"][definition.id]["enabled"]):
                continue
            if module_id in ModuleRegistry._transitive_dependencies(definition.id):
                dependents.append(definition.id)
        return dependents

    @staticmethod
    def _transitive_dependencies(module_id: str) -> set[str]:
        dependencies: set[str] = set()

        def visit(current_id: str) -> None:
            for dependency_id in _DEFINITIONS_BY_ID[current_id].dependencies:
                if dependency_id not in dependencies:
                    dependencies.add(dependency_id)
                    visit(dependency_id)

        visit(module_id)
        return dependencies

    @staticmethod
    def _enable_dependencies(module_id: str, state: dict[str, Any]) -> bool:
        changed = False
        for dependency_id in _DEFINITIONS_BY_ID[module_id].dependencies:
            if not bool(state["modules"][dependency_id]["enabled"]):
                changed = True
            state["modules"][dependency_id]["enabled"] = True
            changed = ModuleRegistry._enable_dependencies(dependency_id, state) or changed
        return changed
