"""Core-owned orchestration for official module lifecycle operations.

The HTTP layer depends on this service, while file changes remain owned by
the detached Stage 8.3 transaction runner.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import uuid
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
    build_panel_update_plan,
    build_profile_transition_plan,
    plan_to_json,
    read_installed_modules,
    read_panel_version,
)
from services.module_transactions.state import ModuleTransactionError

if TYPE_CHECKING:
    from services.module_catalog_client import ModuleCatalogClient


_REPAIR_ONLY_MODULES = frozenset({"tool.editor"})
_FULL_SCOPE_OPERATIONS = frozenset({"panel-update", "profile-transition"})
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
        "scope",
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
PANEL_ARCHIVE_CACHE_DIRNAME = "panel-archive"
_SHA256_HEX = re.compile(r"[0-9a-f]{64}")
_PROFILE_TARGET_ERRORS = frozenset(
    {
        "profile_state_unavailable",
        "profile_installed_state_unavailable",
        "profile_ownership_unavailable",
        "profile_release_mismatch",
        "profile_unknown",
        "profile_modules_forbidden",
        "profile_modules_invalid",
        "profile_dependency_missing",
        "profile_module_conflict",
        "profile_editor_variant_invalid",
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
        archive_cache_dir: Path | None = None,
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
        self._archive_cache_dir = None if archive_cache_dir is None else Path(archive_cache_dir)

    @property
    def archive_cache_dir(self) -> Path:
        """Where the verified panel archive waits between a plan and its runner.

        On the storage, next to the update records and outside the panel
        tree: the router's temporary directory is its memory, and one archive
        serves the plan, its re-check under the lock and the runner.
        """

        if self._archive_cache_dir is None:
            from services.self_update.state import get_update_paths

            self._archive_cache_dir = (
                Path(get_update_paths(str(self.state_dir))["update_dir"]) / PANEL_ARCHIVE_CACHE_DIRNAME
            )
        return self._archive_cache_dir

    def _drop_archive_cache(self) -> None:
        shutil.rmtree(self.archive_cache_dir, ignore_errors=True)

    def _panel_archive(self, client: Any, snapshot: Any) -> tuple[Path, bool]:
        """The panel archive of a verified catalog and whether it was just downloaded."""

        descriptor = snapshot.catalog.get("panel")
        digest = descriptor.get("sha256") if isinstance(descriptor, Mapping) else None
        cache = self.archive_cache_dir
        target = (
            cache / f"{digest}.tar.gz"
            if isinstance(digest, str) and _SHA256_HEX.fullmatch(digest)
            else None
        )
        if target is not None and target.is_file():
            return target, False
        # One archive at a time: whatever is here belongs to another release.
        self._drop_archive_cache()
        incoming = cache / f"incoming-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        try:
            downloaded = client.download_verified_panel_archive(snapshot, incoming)
            if target is None:
                target = cache / "panel.tar.gz"
            os.replace(downloaded, target)
        finally:
            shutil.rmtree(incoming, ignore_errors=True)
        return target, True

    def _checked_panel_archive(self, client: Any, snapshot: Any, architecture: str) -> dict[str, Any]:
        """The verified listing of the panel archive; nothing is unpacked."""

        from services.module_package_contract import ModulePackageContractError
        from services.panel_package_contract import validate_panel_archive

        while True:
            archive, fresh = self._panel_archive(client, snapshot)
            try:
                return validate_panel_archive(
                    archive,
                    snapshot.catalog["panel"],
                    platform_architecture=architecture,
                )
            except ModulePackageContractError:
                # A kept copy may have rotted on the storage; a download that
                # fails the same check is the release's own fault.
                self._drop_archive_cache()
                if fresh:
                    raise

    def _raise_full_scope_error(self, operation: str, error: BaseException) -> None:
        code = str(getattr(error, "code", None) or "")
        if code.startswith("panel_archive_") or code in {
            "catalog_archive_checksum_mismatch",
            "catalog_archive_size_mismatch",
        }:
            raise ModuleLifecycleError(
                "panel_archive_invalid",
                "the panel archive failed verification",
                status=409,
            ) from error
        unavailable = code in {
            "catalog_archive_unavailable",
            "catalog_panel_not_object",
            "catalog_release_not_found",
        }
        if operation == "profile-transition" and unavailable:
            raise ModuleLifecycleError(
                "profile_payload_unavailable",
                "the exact-release panel payload is unavailable",
                status=503,
            ) from error
        if operation == "panel-update" and unavailable:
            raise ModuleLifecycleError(
                "panel_update_unavailable",
                "no trusted compatible panel update is available",
                status=503,
            ) from error
        if code:
            _raise_domain(error)
        raise error

    def panel_update_check(self, *, force_refresh: bool = False) -> dict[str, Any]:
        """Whether a newer signed release exists; reads the catalog and nothing else.

        The answer to "is there an update" must not cost the archive of the
        whole panel: the page asks on every load and every few hours.
        """

        self._ensure_profile_settled("panel-update")
        # A check means nobody is between a reviewed plan and its launch.
        self._drop_archive_cache()
        try:
            from services.module_package_contract import compare_semver

            source_version = read_panel_version(self.panel_root)
            client = self._catalog_factory(source_version, self._architecture_provider())
            snapshot = client.get_catalog(force_refresh=bool(force_refresh))
            target_version = str(snapshot.catalog.get("release_version") or "")
            newer = compare_semver(target_version, source_version) > 0
        except ModuleTransactionError as error:
            _raise_domain(error)
        except Exception as error:
            self._raise_full_scope_error("panel-update", error)
        return {
            "ok": True,
            "source_version": source_version,
            "target_version": target_version,
            "update_available": newer,
        }

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
    def _validate_operation(operation: str, module_id: str | None) -> tuple[str, str | None]:
        normalized_operation = str(operation or "").strip()
        normalized_module = str(module_id or "").strip()
        if normalized_operation in _FULL_SCOPE_OPERATIONS:
            if normalized_module:
                raise ModuleLifecycleError(
                    "module_operation_invalid",
                    "full-panel operations do not accept module_id",
                    status=400,
                )
            return normalized_operation, None
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

    def _full_scope_plan_and_payload(self, operation: str) -> tuple[Plan | None, dict[str, Any]]:
        try:
            source_version = read_panel_version(self.panel_root)
            architecture = self._architecture_provider()
            client = self._catalog_factory(source_version, architecture)
            snapshot = (
                client.get_catalog(force_refresh=True)
                if operation == "panel-update"
                else client.get_release_catalog(source_version)
            )
            if operation == "panel-update":
                from services.module_package_contract import compare_semver

                # Before the archive: a panel that is already current must
                # not download the whole release to learn that.
                target_version = str(snapshot.catalog.get("release_version") or "")
                if compare_semver(target_version, source_version) <= 0:
                    raise ModuleTransactionError(
                        "panel_update_not_newer",
                        "the stable catalog does not contain a newer panel release",
                        current_version=source_version,
                        target_version=target_version,
                    )
            checked = self._checked_panel_archive(client, snapshot, architecture)
            builder = build_panel_update_plan if operation == "panel-update" else build_profile_transition_plan
            plan = builder(
                panel_root=self.panel_root,
                state_dir=self.state_dir,
                catalog=snapshot.catalog,
                target_archive=checked,
                architecture=architecture,
            )
        except ModuleTransactionError as error:
            # Nothing will be launched from this plan: the archive has no reader.
            self._drop_archive_cache()
            if error.code in _PLAN_BLOCKERS | {"panel_update_not_newer", "profile_transition_not_required"}:
                public_code = {
                    "panel_update_not_newer": "panel_version_current",
                    "module_free_space": "operation_free_space",
                }.get(error.code, error.code)
                blocker = {"code": public_code, "message": error.message, **error.details}
                return None, {
                    "ok": True,
                    "scope": "panel" if operation == "panel-update" else "profile",
                    "operation": operation,
                    "module_id": None,
                    "source_version": locals().get("source_version"),
                    "target_version": getattr(locals().get("snapshot"), "release_version", None),
                    "target_profile": None,
                    "affected_module_ids": [],
                    "files_add": [],
                    "files_remove": [],
                    "required_free_bytes": int(error.details.get("required", 0)),
                    "restart_required": True,
                    "installed_after": [],
                    "dependency_diff": {},
                    "blockers": [blocker],
                    "applicable": False,
                    "plan_id": None,
                }
            if error.code in _PROFILE_TARGET_ERRORS:
                raise ModuleLifecycleError(
                    "profile_target_invalid",
                    "the desired profile cannot form a valid physical payload",
                    status=409,
                ) from error
            _raise_domain(error)
        except Exception as error:
            self._drop_archive_cache()
            self._raise_full_scope_error(operation, error)

        encoded = plan_to_json(plan)
        dependency_diff: dict[str, Any] = {}
        return plan, {
            "ok": True,
            "scope": plan.scope,
            "operation": plan.operation,
            "module_id": None,
            "version": plan.version,
            "source_version": plan.source_version,
            "target_version": plan.target_version,
            "target_profile": dict(plan.target_profile or {}),
            "affected_module_ids": list(plan.installed_after),
            "files_add": encoded["files_add"],
            "files_remove": encoded["files_remove"],
            "required_free_bytes": plan.required_free_bytes,
            "restart_required": plan.restart_required,
            "installed_after": encoded["installed_after"],
            "dependency_diff": dependency_diff,
            "blockers": [],
            "applicable": True,
            "plan_id": _plan_digest(plan, dependency_diff),
        }

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
        module_id: str | None,
    ) -> tuple[Plan | None, dict[str, Any]]:
        operation, module_id = self._validate_operation(operation, module_id)
        if operation in _FULL_SCOPE_OPERATIONS:
            return self._full_scope_plan_and_payload(operation)
        assert module_id is not None
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

    def plan(self, operation: str, module_id: str | None = None) -> dict[str, Any]:
        normalized_operation, _normalized_module = self._validate_operation(operation, module_id)
        self._ensure_profile_settled(normalized_operation)
        _plan, payload = self._plan_and_payload(operation, module_id)
        return payload

    def _ensure_profile_settled(self, operation: str) -> None:
        if operation == "profile-transition":
            return
        pending = self.profile_transition_status()
        if pending["transition_required"]:
            raise ModuleLifecycleError(
                "profile_transition_required",
                "the configured profile must be physically applied before another operation",
                status=409,
                transition_target=pending["transition_target"],
            )

    def apply(
        self,
        operation: str,
        module_id: str | None,
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

        if not self.restart_cmd:
            # Every operation ends with a restart of the panel. Without a
            # service to ask, the runner would lay the files and only then
            # find out that it has to put them back.
            raise ModuleLifecycleError(
                "panel_restart_unavailable",
                "the panel service that restarts the panel was not found",
                status=503,
            )

        if operation not in _FULL_SCOPE_OPERATIONS:
            return self._apply(operation, module_id, plan_id, {})
        try:
            # The runner takes the archive this process has already verified.
            return self._apply(
                operation, module_id, plan_id, {"extra_args": ("--archive-cache", str(self.archive_cache_dir))}
            )
        except BaseException:
            # Nothing was launched, so nobody will come for the archive.
            self._drop_archive_cache()
            raise

    def _apply(
        self,
        operation: str,
        module_id: str | None,
        plan_id: str,
        launch_options: Mapping[str, Any],
    ) -> dict[str, Any]:
        plan, payload = self._plan_and_payload(operation, module_id)
        stale_code = "operation_plan_stale" if operation in _FULL_SCOPE_OPERATIONS else "module_plan_stale"
        if plan is None or not payload["applicable"]:
            raise ModuleLifecycleError(
                stale_code,
                "the reviewed module plan is no longer applicable",
                status=409,
                blockers=payload["blockers"],
            )
        if not hmac.compare_digest(payload["plan_id"], plan_id):
            raise ModuleLifecycleError(
                stale_code,
                "the reviewed module plan is stale",
                status=409,
            )

        self._ensure_profile_settled(operation)

        def prepare_plan() -> Plan:
            rebuilt, current = self._plan_and_payload(operation, module_id)
            matches = (
                rebuilt is not None
                and current["applicable"]
                and hmac.compare_digest(current["plan_id"], plan_id)
            )
            if not matches:
                raise ModuleLifecycleError(
                    stale_code,
                    "the reviewed module plan is stale",
                    status=409,
                    blockers=current["blockers"],
                )
            self._ensure_profile_settled(operation)
            return rebuilt

        try:
            operation_id = self._launch_operation(
                plan,
                panel_root=self.panel_root,
                state_dir=self.state_dir,
                health_url=self.health_url,
                restart_cmd=self.restart_cmd,
                prepare_plan=prepare_plan,
                **launch_options,
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

    def profile_transition_status(self) -> dict[str, Any]:
        registry = self.module_registry.get_registry()
        desired_ids = tuple(
            module_id for module_id in MODULE_IDS if module_id in set(registry.get("configured_module_ids", ()))
        )
        desired = {
            "profile": registry.get("profile"),
            "module_ids": list(desired_ids),
            "editor_variant": (registry.get("editor") or {}).get("variant"),
        }
        try:
            installed_profile = json.loads((self.state_dir / "install-profile.json").read_text(encoding="utf-8"))
            installed_ids = read_installed_modules(self.state_dir)
            matches = (
                installed_profile.get("profile") == desired["profile"]
                and installed_profile.get("editor_variant") == desired["editor_variant"]
                and set(installed_profile.get("module_ids", ())) == set(desired_ids)
                and set(installed_ids) == set(desired_ids)
            )
        except (OSError, ValueError, TypeError, AttributeError, ModuleTransactionError):
            matches = False
        return {"transition_required": not matches, "transition_target": desired}

    def restart(self) -> dict[str, Any]:
        pending = self.profile_transition_status()
        if pending["transition_required"]:
            raise ModuleLifecycleError(
                "profile_transition_required",
                "the configured profile must be physically applied before restart",
                status=409,
                transition_target=pending["transition_target"],
            )
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
