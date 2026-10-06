from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from services.module_registry import ModuleRegistry
from services.module_transactions.executor import recover
from services.module_transactions.launcher import launch, observe_status
from tests.support.module_tx import ARCHITECTURE


class CatalogRecorder:
    def __init__(self, release, state_dir: Path) -> None:
        self.client = release.client(state_dir)
        self.requested_versions: list[str] = []

    def get_release_catalog(self, version: str):
        self.requested_versions.append(version)
        return self.client.get_release_catalog(version)

    def get_catalog(self, **_kwargs):
        raise AssertionError("Stage 8.4 must not discover the latest release")


class StaticCatalogRecorder:
    def __init__(self, catalog) -> None:
        self.catalog = catalog
        self.requested_versions: list[str] = []

    def get_release_catalog(self, version: str):
        self.requested_versions.append(version)
        return SimpleNamespace(
            catalog=self.catalog,
            release_version=version,
            catalog_url=f"https://example.invalid/v{version}/catalog.json",
            fetched_at=1.0,
            freshness="fresh",
            stale_reason=None,
        )


def make_service(panel, release, *, registry=None, **overrides):
    from services.module_lifecycle import ModuleLifecycleService

    recorder = CatalogRecorder(release, panel.state)
    dependencies = {
        "catalog_factory": lambda _version, _architecture: recorder,
        "architecture_provider": lambda: ARCHITECTURE,
        "active_engines": lambda: frozenset(),
        "health_url": "http://127.0.0.1:8088/login",
        "restart_cmd": ("xkeen", "-restart"),
        "restart_panel": lambda _source: True,
        "launch_operation": launch,
        "observe_operation": observe_status,
        "recover_operation": recover,
    }
    dependencies.update(overrides)
    service = ModuleLifecycleService(
        registry or ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool"),
        panel_root=panel.root,
        state_dir=panel.state,
        **dependencies,
    )
    return service, recorder
