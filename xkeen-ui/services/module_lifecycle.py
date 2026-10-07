"""Core-owned orchestration for official module lifecycle operations.

The HTTP layer depends on this service, while file changes remain owned by
the detached Stage 8.3 transaction runner.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Mapping, Sequence

from services.module_registry import MODULE_IDS, ModuleRegistry
from services.module_transactions.executor import recover
from services.module_transactions.launcher import (
    ensure_restartable,
    launch,
    observe_status,
    request_cancel,
)
from services.module_transactions.plan import (
    OPERATIONS,
    Plan,
    build_plan,
    plan_to_json,
    read_installed_modules,
    read_panel_version,
)
from services.module_transactions.state import ModuleTransactionError

if TYPE_CHECKING:
    from services.module_catalog_client import ModuleCatalogClient


_REPAIR_ONLY_MODULES = frozenset({"tool.editor"})
_PLAN_BLOCKERS = frozenset(
    {
        "module_already_installed",
        "module_not_installed",
        "module_dependency_missing",
        "module_conflict",
        "module_required_by",
        "module_engine_active",
        "module_free_space",
    }
)
_PUBLIC_STATUS_FIELDS = frozenset(
    {
        "operation_id",
        "operation",
        "module_id",
        "version",
        "step",
        "result",
        "error_code",
        "error",
        "started_at",
        "finished_at",
        "log",
        "recovered",
        "restart_required",
        "panel_unresponsive",
    }
)
_PUBLIC_STATUS_ERRORS = {
    "operation_cancelled": "the module operation was cancelled",
    "operation_health_failed": "the panel did not become healthy after the module operation",
    "operation_in_progress": "another panel operation is already running",
    "operation_interrupted": "the module operation was interrupted",
    "operation_restart_failed": "the panel could not be restarted",
    "operation_rollback_failed": "the module operation could not be rolled back",
    "operation_start_failed": "the module operation runner could not be started",
}
_CATALOG_COMPATIBILITY_ERRORS = frozenset(
    {
        "catalog_api_unsupported",
        "catalog_architecture_unsupported",
        "catalog_channel_unsupported",
        "catalog_min_core_unsupported",
        "catalog_module_unknown",
        "catalog_release_version_mismatch",
        "catalog_schema_unsupported",
    }
)


class ModuleLifecycleError(Exception):
    """A client-safe lifecycle error with a stable code and HTTP status."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int,
        **details: Any,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details


def _domain_status(code: str) -> int:
    if code.startswith("catalog_"):
        return 409 if code in _CATALOG_COMPATIBILITY_ERRORS else 503
    if code in {"module_not_found", "operation_not_found"}:
        return 404
    if code.endswith("_invalid") or code in {
        "module_operation_forbidden",
        "module_operation_invalid",
        "module_plan_id_invalid",
    }:
        return 400
    return 409


def _raise_domain(error: BaseException) -> None:
    code = str(getattr(error, "code", None) or "module_lifecycle_failed")
    message = str(getattr(error, "message", None) or "module lifecycle operation failed")
    details = getattr(error, "details", None)
    raise ModuleLifecycleError(
        code,
        message,
        status=_domain_status(code),
        **(dict(details) if isinstance(details, Mapping) else {}),
    ) from error


def _default_catalog_factory(
    state_dir: Path,
) -> Callable[[str, str], "ModuleCatalogClient"]:
    def build(version: str, architecture: str) -> "ModuleCatalogClient":
        from services.module_catalog_client import ModuleCatalogClient

        return ModuleCatalogClient(
            state_dir,
            platform_architecture=architecture,
            core_version=version,
        )

    return build


def _default_architecture_provider() -> str:
    from services.module_package_contract import detect_platform_architecture

    return detect_platform_architecture()


def _dependency_diff(
    catalog: Mapping[str, Any],
    module_id: str,
    installed: frozenset[str],
) -> dict[str, list[str]]:
    entries = {
        str(item.get("id")): item
        for item in catalog.get("modules", [])
        if isinstance(item, Mapping)
    }
    entry = entries[module_id]
    requires = sorted(set(entry.get("requires", ())))
    return {
        "requires": requires,
        "missing": sorted(set(requires) - installed),
        "conflicts": sorted(set(entry.get("conflicts", ())) & installed),
        "required_by": sorted(
            other
            for other in installed
            if other != module_id
            and module_id in entries.get(other, {}).get("requires", ())
        ),
    }


def _plan_digest(plan: Plan, dependency_diff: Mapping[str, Any]) -> str:
    canonical = json.dumps(
        {"plan": plan_to_json(plan), "dependency_diff": dependency_diff},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _public_status(status: Mapping[str, Any]) -> dict[str, Any]:
    payload = {
        key: value
        for key, value in status.items()
        if key in _PUBLIC_STATUS_FIELDS and key != "log"
    }
    raw_log = status.get("log")
    payload["log"] = [
        {key: entry[key] for key in ("step", "at") if key in entry}
        for entry in raw_log
        if isinstance(entry, Mapping)
    ] if isinstance(raw_log, list) else []
    error_code = payload.get("error_code")
    payload["error"] = (
        _PUBLIC_STATUS_ERRORS.get(str(error_code), "module operation failed")
        if error_code
        else None
    )
    return payload


class ModuleLifecycleService:
    """Compose registry, trusted catalog, and transaction boundaries."""

    def __init__(
        self,
        module_registry: ModuleRegistry,
        *,
        panel_root: Path,
        state_dir: Path,
        catalog_factory: Callable[[str, str], "ModuleCatalogClient"] | None = None,
        architecture_provider: Callable[[], str] = _default_architecture_provider,
        active_engines: Callable[[], frozenset[str]] | None = None,
        health_url: str = "",
        restart_cmd: Sequence[str] = (),
        restart_panel: Callable[[str], bool] | None = None,
        launch_operation: Callable[..., str] = launch,
        observe_operation: Callable[[Path, Path], dict[str, Any]] = observe_status,
        recover_operation: Callable[..., str | None] = recover,
        cancel_operation: Callable[..., None] = request_cancel,
        ensure_restartable_operation: Callable[[Path, Path], None] = ensure_restartable,
    ) -> None:
        self.module_registry = module_registry
        self.panel_root = Path(panel_root)
        self.state_dir = Path(state_dir)
        self._catalog_factory = catalog_factory or _default_catalog_factory(self.state_dir)
        self._architecture_provider = architecture_provider
        self._active_engines = active_engines or (lambda: frozenset())
        self.health_url = str(health_url)
        self.restart_cmd = tuple(str(part) for part in restart_cmd)
        self._restart_panel = restart_panel
        self._launch_operation = launch_operation
        self._observe_operation = observe_operation
        self._recover_operation = recover_operation
        self._cancel_operation = cancel_operation
        self._ensure_restartable = ensure_restartable_operation

    def _release_context(self):
        try:
            version = read_panel_version(self.panel_root)
            architecture = self._architecture_provider()
            client = self._catalog_factory(version, architecture)
            snapshot = client.get_release_catalog(version)
        except Exception as error:  # domain adapters expose stable codes
            if getattr(error, "code", None):
                _raise_domain(error)
            raise
        return version, architecture, client, snapshot

    def installed(self) -> dict[str, Any]:
        registry = self.module_registry.get_registry()
        try:
            installed_ids = read_installed_modules(self.state_dir)
            lifecycle = {"available": True, "code": None}
        except ModuleTransactionError as error:
            installed_ids = frozenset(
                str(item["id"])
                for item in registry.get("modules", [])
                if item.get("installed") is True
            )
            lifecycle = {"available": False, "code": error.code}
        ordered_ids = [module_id for module_id in MODULE_IDS if module_id in installed_ids]
        return {
            "ok": True,
            "profile": registry.get("profile"),
            "editor": registry.get("editor"),
            "restart_required": bool(registry.get("restart_required")),
            "installed_module_ids": ordered_ids,
            "modules": [
                item
                for item in registry.get("modules", [])
                if item.get("id") in installed_ids
            ],
            "lifecycle": lifecycle,
        }

    def available(self) -> dict[str, Any]:
        version, _architecture, _client, snapshot = self._release_context()
        try:
            installed_ids = read_installed_modules(self.state_dir)
        except ModuleTransactionError as error:
            _raise_domain(error)

        modules: list[dict[str, Any]] = []
        for raw_entry in snapshot.catalog.get("modules", []):
            entry = dict(raw_entry)
            module_id = str(entry.get("id") or "")
            installed = module_id in installed_ids
            if module_id == "core" or (module_id in _REPAIR_ONLY_MODULES and not installed):
                actions: list[str] = []
            elif module_id in _REPAIR_ONLY_MODULES:
                actions = ["repair"]
            elif installed:
                actions = ["repair", "remove"]
            else:
                actions = ["install"]
            entry.update(
                installed=installed,
                lifecycle_actions=actions,
                update_available=False,
            )
            modules.append(entry)

        return {
            "ok": True,
            "release_version": version,
            "catalog_url": snapshot.catalog_url,
            "fetched_at": snapshot.fetched_at,
            "freshness": snapshot.freshness,
            "stale_reason": snapshot.stale_reason,
            "modules": modules,
        }

    @staticmethod
    def _validate_operation(operation: str, module_id: str) -> tuple[str, str]:
        normalized_operation = str(operation or "").strip()
        normalized_module = str(module_id or "").strip()
        if normalized_operation not in OPERATIONS:
            raise ModuleLifecycleError(
                "module_operation_invalid",
                "operation must be install, repair, or remove",
                status=400,
            )
        if normalized_module not in MODULE_IDS:
            raise ModuleLifecycleError(
                "module_not_found",
                "module does not exist",
                status=404,
                module_id=normalized_module,
            )
        if normalized_module == "core" or (
            normalized_module in _REPAIR_ONLY_MODULES
            and normalized_operation != "repair"
        ):
            raise ModuleLifecycleError(
                "module_operation_forbidden",
                "this operation is not available for the module",
                status=400,
                operation=normalized_operation,
                module_id=normalized_module,
            )
        return normalized_operation, normalized_module

    @staticmethod
    def _blocked_payload(
        *,
        operation: str,
        module_id: str,
        version: str,
        installed: frozenset[str],
        dependency_diff: Mapping[str, Any],
        restart_required: bool,
        error: ModuleTransactionError,
    ) -> dict[str, Any]:
        blocker = {"code": error.code, "message": error.message, **error.details}
        return {
            "ok": True,
            "operation": operation,
            "module_id": module_id,
            "version": version,
            "affected_module_ids": [module_id],
            "files_add": [],
            "files_remove": [],
            "required_free_bytes": int(error.details.get("required", 0)),
            "restart_required": restart_required,
            "installed_after": sorted(installed),
            "dependency_diff": dict(dependency_diff),
            "blockers": [blocker],
            "applicable": False,
            "plan_id": None,
        }

    def _plan_and_payload(
        self,
        operation: str,
        module_id: str,
    ) -> tuple[Plan | None, dict[str, Any]]:
        operation, module_id = self._validate_operation(operation, module_id)
        version, architecture, _client, snapshot = self._release_context()
        try:
            installed = read_installed_modules(self.state_dir)
            entries = {
                str(item.get("id")): item
                for item in snapshot.catalog.get("modules", [])
                if isinstance(item, Mapping)
            }
            entry = entries[module_id]
            dependencies = _dependency_diff(snapshot.catalog, module_id, installed)
            plan = build_plan(
                operation,
                module_id,
                panel_root=self.panel_root,
                state_dir=self.state_dir,
                catalog=snapshot.catalog,
                architecture=architecture,
                active_engines=self._active_engines(),
            )
        except KeyError as error:
            raise ModuleLifecycleError(
                "catalog_module_unknown",
                "module does not exist in the trusted catalog",
                status=409,
                module_id=module_id,
            ) from error
        except ModuleTransactionError as error:
            if error.code in _PLAN_BLOCKERS:
                return None, self._blocked_payload(
                    operation=operation,
                    module_id=module_id,
                    version=version,
                    installed=installed,
                    dependency_diff=dependencies,
                    restart_required=bool(entry.get("requires_restart", True)),
                    error=error,
                )
            _raise_domain(error)

        encoded = plan_to_json(plan)
        payload = {
            "ok": True,
            "operation": plan.operation,
            "module_id": plan.module_id,
            "version": plan.version,
            "affected_module_ids": [plan.module_id],
            "files_add": encoded["files_add"],
            "files_remove": encoded["files_remove"],
            "required_free_bytes": plan.required_free_bytes,
            "restart_required": plan.restart_required,
            "installed_after": encoded["installed_after"],
            "dependency_diff": dependencies,
            "blockers": [],
            "applicable": True,
            "plan_id": _plan_digest(plan, dependencies),
        }
        return plan, payload

    def plan(self, operation: str, module_id: str) -> dict[str, Any]:
        _plan, payload = self._plan_and_payload(operation, module_id)
        return payload

    def apply(
        self,
        operation: str,
        module_id: str,
        plan_id: str,
    ) -> dict[str, Any]:
        if not isinstance(plan_id, str) or re.fullmatch(
            r"[0-9a-f]{64}", plan_id
        ) is None:
            raise ModuleLifecycleError(
                "module_plan_id_invalid",
                "plan_id must be a lowercase SHA-256 digest",
                status=400,
            )

        plan, payload = self._plan_and_payload(operation, module_id)
        if plan is None or not payload["applicable"]:
            raise ModuleLifecycleError(
                "module_plan_stale",
                "the reviewed module plan is no longer applicable",
                status=409,
                blockers=payload["blockers"],
            )
        if not hmac.compare_digest(payload["plan_id"], plan_id):
            raise ModuleLifecycleError(
                "module_plan_stale",
                "the reviewed module plan is stale",
                status=409,
            )

        try:
            operation_id = self._launch_operation(
                plan,
                panel_root=self.panel_root,
                state_dir=self.state_dir,
                health_url=self.health_url,
                restart_cmd=self.restart_cmd,
            )
        except ModuleTransactionError as error:
            _raise_domain(error)
        return {
            "ok": True,
            "operation_id": operation_id,
            "status": _public_status(
                self._observe_operation(self.panel_root, self.state_dir)
            ),
        }

    def status(self) -> dict[str, Any]:
        return {
            "ok": True,
            **_public_status(
                self._observe_operation(self.panel_root, self.state_dir)
            ),
        }

    def cancel(self, operation_id: str) -> dict[str, Any]:
        try:
            self._cancel_operation(self.panel_root, self.state_dir, operation_id)
        except ModuleTransactionError as error:
            _raise_domain(error)
        return {
            "ok": True,
            "operation_id": operation_id,
            "cancel_requested": True,
        }

    def recover(self) -> dict[str, Any]:
        try:
            result = self._recover_operation(
                self.panel_root,
                self.state_dir,
                panel_running=True,
            )
        except ModuleTransactionError as error:
            _raise_domain(error)
        observed = _public_status(
            self._observe_operation(self.panel_root, self.state_dir)
        )
        if result is None and observed.get("result") == "running":
            raise ModuleLifecycleError(
                "operation_in_progress",
                "a module operation is already running",
                status=409,
            )
        return {"ok": True, "recovery_result": result, **observed}

    def restart(self) -> dict[str, Any]:
        try:
            self._ensure_restartable(self.panel_root, self.state_dir)
        except ModuleTransactionError as error:
            _raise_domain(error)
        try:
            dispatched = self._restart_panel is not None and self._restart_panel(
                "module-lifecycle"
            )
        except Exception as error:
            raise ModuleLifecycleError(
                "module_restart_failed",
                "the panel restart could not be dispatched",
                status=503,
            ) from error
        if not dispatched:
            raise ModuleLifecycleError(
                "module_restart_failed",
                "the panel restart could not be dispatched",
                status=503,
            )
        return {"ok": True, "restart_requested": True}
