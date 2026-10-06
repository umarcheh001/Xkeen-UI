"""Core-owned orchestration for official module lifecycle operations.

The HTTP layer depends on this service, while file changes remain owned by
the detached Stage 8.3 transaction runner.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Mapping, Sequence

from services.module_package_contract import detect_platform_architecture
from services.module_registry import MODULE_IDS, ModuleRegistry
from services.module_transactions.executor import recover
from services.module_transactions.launcher import launch, observe_status
from services.module_transactions.plan import read_installed_modules, read_panel_version
from services.module_transactions.state import ModuleTransactionError

if TYPE_CHECKING:
    from services.module_catalog_client import ModuleCatalogClient


_REPAIR_ONLY_MODULES = frozenset({"tool.editor"})


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
    if code in {"catalog_unavailable", "catalog_archive_unavailable"} or code.startswith(
        "catalog_transport_"
    ):
        return 503
    if code in {"module_not_found", "operation_not_found"}:
        return 404
    if code.endswith("_invalid") or code in {
        "module_operation_forbidden",
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


class ModuleLifecycleService:
    """Compose registry, trusted catalog, and transaction boundaries."""

    def __init__(
        self,
        module_registry: ModuleRegistry,
        *,
        panel_root: Path,
        state_dir: Path,
        catalog_factory: Callable[[str, str], "ModuleCatalogClient"] | None = None,
        architecture_provider: Callable[[], str] = detect_platform_architecture,
        active_engines: Callable[[], frozenset[str]] | None = None,
        health_url: str = "",
        restart_cmd: Sequence[str] = (),
        restart_panel: Callable[[str], bool] | None = None,
        launch_operation: Callable[..., str] = launch,
        observe_operation: Callable[[Path, Path], dict[str, Any]] = observe_status,
        recover_operation: Callable[..., str | None] = recover,
        cancel_operation: Callable[..., None] | None = None,
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
