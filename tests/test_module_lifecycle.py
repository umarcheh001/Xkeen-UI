from __future__ import annotations

import json
import re
from dataclasses import replace
from types import SimpleNamespace

import pytest

from services.module_catalog_client import CatalogTransportError, official_release_asset_url
from services.module_lifecycle import ModuleLifecycleError, _plan_digest
from services.module_registry import ModuleRegistry
from services.module_transactions.plan import build_plan
from tests.support.module_lifecycle import (
    LaunchRecorder,
    StaticCatalogRecorder,
    make_service,
    status_record,
)
from tests.support.module_tx import (
    ARCHITECTURE,
    OWNERSHIP,
    VERSION,
    catalog_document,
    make_panel,
    make_release,
)


def test_installed_uses_actual_install_manifest_without_fetching_catalog(tmp_path):
    panel = make_panel(tmp_path)
    service, catalog = make_service(panel, make_release())

    payload = service.installed()

    assert payload["ok"] is True
    assert payload["installed_module_ids"] == ["core", "engine.xray", "tool.editor"]
    assert {item["id"] for item in payload["modules"]} == {
        "core",
        "engine.xray",
        "tool.editor",
    }
    assert payload["lifecycle"] == {"available": True, "code": None}
    assert catalog.requested_versions == []


def test_installed_remains_readable_when_install_manifest_is_missing(tmp_path):
    panel = make_panel(tmp_path)
    service, catalog = make_service(panel, make_release())
    panel.path("module-installed.json").unlink()

    payload = service.installed()

    assert payload["ok"] is True
    assert payload["lifecycle"] == {
        "available": False,
        "code": "module_state_unavailable",
    }
    assert payload["installed_module_ids"]
    assert catalog.requested_versions == []


def test_available_uses_installed_release_and_exposes_only_stage83_actions(tmp_path):
    panel = make_panel(tmp_path)
    service, catalog = make_service(panel, make_release())

    payload = service.available()
    modules = {item["id"]: item for item in payload["modules"]}

    assert catalog.requested_versions == [VERSION]
    assert payload["release_version"] == VERSION
    assert payload["catalog_url"] == official_release_asset_url(VERSION, "catalog.json")
    assert payload["freshness"] == "fresh"
    assert modules["core"]["lifecycle_actions"] == []
    assert modules["tool.editor"]["lifecycle_actions"] == ["repair"]
    assert modules["engine.xray"]["lifecycle_actions"] == ["repair", "remove"]
    assert modules["tool.terminal"]["lifecycle_actions"] == ["install"]
    assert all(item["update_available"] is False for item in modules.values())


def test_available_never_offers_install_for_absent_repair_only_editor(tmp_path):
    panel = make_panel(tmp_path, installed=("core",))
    service, _ = make_service(panel, make_release())

    modules = {item["id"]: item for item in service.available()["modules"]}

    assert modules["tool.editor"]["installed"] is False
    assert modules["tool.editor"]["lifecycle_actions"] == []


def test_available_maps_exact_release_transport_failure_to_503(tmp_path):
    panel = make_panel(tmp_path)
    release = make_release()
    for url in list(release.transport.responses):
        release.transport.fail[url] = CatalogTransportError(
            "catalog_transport_unavailable", "offline"
        )
    service, _ = make_service(panel, release)

    with pytest.raises(ModuleLifecycleError) as raised:
        service.available()

    assert raised.value.code == "catalog_unavailable"
    assert raised.value.status == 503
    assert raised.value.details == {}


def test_plan_returns_single_module_file_and_dependency_diff(tmp_path):
    panel = make_panel(tmp_path)
    service, _ = make_service(panel, make_release())

    payload = service.plan("install", "tool.terminal")

    assert payload["applicable"] is True
    assert payload["affected_module_ids"] == ["tool.terminal"]
    assert payload["files_add"] == sorted(OWNERSHIP["tool.terminal"])
    assert payload["files_remove"] == []
    assert payload["dependency_diff"] == {
        "requires": ["core"],
        "missing": [],
        "conflicts": [],
        "required_by": [],
    }
    assert payload["blockers"] == []
    assert re.fullmatch(r"[0-9a-f]{64}", payload["plan_id"])


def test_missing_dependency_is_a_visible_blocker_not_an_automatic_install(tmp_path):
    panel = make_panel(tmp_path, installed=("core",))
    service, _ = make_service(panel, make_release())

    payload = service.plan("install", "engine.mihomo")

    assert payload["applicable"] is False
    assert payload["affected_module_ids"] == ["engine.mihomo"]
    assert payload["dependency_diff"]["missing"] == ["tool.editor"]
    assert [item["code"] for item in payload["blockers"]] == [
        "module_dependency_missing"
    ]
    assert payload["plan_id"] is None


def test_conflict_and_required_by_are_derived_from_trusted_catalog(tmp_path):
    panel = make_panel(
        tmp_path,
        installed=("core", "tool.editor", "engine.xray", "tool.terminal"),
    )
    catalog = catalog_document()
    entries = {item["id"]: item for item in catalog["modules"]}
    entries["tool.files"]["conflicts"] = ["tool.terminal"]
    entries["engine.xray"]["requires"].append("tool.terminal")
    recorder = StaticCatalogRecorder(catalog)
    service, _ = make_service(
        panel,
        make_release(),
        catalog_factory=lambda _version, _architecture: recorder,
    )

    install = service.plan("install", "tool.files")
    remove = service.plan("remove", "tool.terminal")

    assert install["dependency_diff"]["conflicts"] == ["tool.terminal"]
    assert install["blockers"][0]["code"] == "module_conflict"
    assert remove["dependency_diff"]["required_by"] == ["engine.xray"]
    assert remove["blockers"][0]["code"] == "module_required_by"


def test_running_engine_and_free_space_are_visible_blockers(tmp_path, monkeypatch):
    panel = make_panel(tmp_path)
    service, _ = make_service(
        panel,
        make_release(),
        active_engines=lambda: frozenset({"engine.xray"}),
    )

    running = service.plan("remove", "engine.xray")
    assert running["blockers"][0]["code"] == "module_engine_active"

    service, _ = make_service(panel, make_release())
    monkeypatch.setattr(
        "services.module_transactions.plan.shutil.disk_usage",
        lambda _path: SimpleNamespace(free=0),
    )
    no_space = service.plan("install", "tool.terminal")
    assert no_space["blockers"][0]["code"] == "module_free_space"
    assert no_space["required_free_bytes"] > 0


@pytest.mark.parametrize(
    ("operation", "module_id", "code", "status"),
    [
        ("update", "tool.terminal", "module_operation_invalid", 400),
        ("install", "unknown.module", "module_not_found", 404),
        ("remove", "core", "module_operation_forbidden", 400),
        ("install", "tool.editor", "module_operation_forbidden", 400),
    ],
)
def test_plan_rejects_invalid_or_forbidden_targets(
    tmp_path, operation, module_id, code, status
):
    service, _ = make_service(make_panel(tmp_path), make_release())

    with pytest.raises(ModuleLifecycleError) as raised:
        service.plan(operation, module_id)

    assert (raised.value.code, raised.value.status) == (code, status)


def test_plan_digest_covers_transaction_and_dependency_changes(tmp_path):
    panel = make_panel(tmp_path)
    plan = build_plan("install", "tool.terminal", **panel.kwargs)
    dependencies = {
        "requires": ["core"],
        "missing": [],
        "conflicts": [],
        "required_by": [],
    }
    original = _plan_digest(plan, dependencies)

    assert _plan_digest(replace(plan, required_free_bytes=plan.required_free_bytes + 1), dependencies) != original
    assert _plan_digest(replace(plan, files_add=plan.files_add[:-1]), dependencies) != original
    assert _plan_digest(replace(plan, installed_after=plan.installed_after + ("tool.files",)), dependencies) != original
    assert _plan_digest(plan, {**dependencies, "missing": ["core"]}) != original


def test_apply_rebuilds_and_launches_only_the_reviewed_server_plan(tmp_path):
    panel = make_panel(tmp_path)
    launcher = LaunchRecorder()
    service, _ = make_service(
        panel,
        make_release(),
        launch_operation=launcher,
        observe_operation=lambda _root, _state: status_record(),
    )
    preview = service.plan("install", "tool.terminal")

    payload = service.apply("install", "tool.terminal", preview["plan_id"])

    assert payload == {
        "ok": True,
        "operation_id": "20261006T120000Z-abcdef",
        "status": status_record(),
    }
    assert len(launcher.plans) == 1
    assert launcher.plans[0].module_id == "tool.terminal"
    assert launcher.plans[0].files_add == tuple(sorted(OWNERSHIP["tool.terminal"]))
    assert launcher.kwargs == [
        {
            "panel_root": panel.root,
            "state_dir": panel.state,
            "health_url": "http://127.0.0.1:8088/login",
            "restart_cmd": ("xkeen", "-restart"),
        }
    ]


def test_apply_rejects_plan_when_installed_state_changed(tmp_path):
    panel = make_panel(tmp_path)
    launcher = LaunchRecorder()
    service, _ = make_service(panel, make_release(), launch_operation=launcher)
    preview = service.plan("install", "tool.terminal")
    installed = panel.read_json("module-installed.json")
    installed["modules"]["tool.terminal"] = True
    panel.path("module-installed.json").write_text(
        json.dumps(installed), encoding="utf-8"
    )

    with pytest.raises(ModuleLifecycleError) as raised:
        service.apply("install", "tool.terminal", preview["plan_id"])

    assert (raised.value.code, raised.value.status) == ("module_plan_stale", 409)
    assert launcher.plans == []


@pytest.mark.parametrize("plan_id", [None, "", "A" * 64, "a" * 63, "x" * 64])
def test_apply_rejects_malformed_plan_digest(tmp_path, plan_id):
    launcher = LaunchRecorder()
    service, _ = make_service(
        make_panel(tmp_path), make_release(), launch_operation=launcher
    )

    with pytest.raises(ModuleLifecycleError) as raised:
        service.apply("install", "tool.terminal", plan_id)

    assert (raised.value.code, raised.value.status) == (
        "module_plan_id_invalid",
        400,
    )
    assert launcher.plans == []


def test_apply_rejects_plan_that_rebuilds_with_blockers(tmp_path):
    panel = make_panel(tmp_path)
    launcher = LaunchRecorder()
    catalog = catalog_document()
    recorder = StaticCatalogRecorder(catalog)
    service, _ = make_service(
        panel,
        make_release(),
        launch_operation=launcher,
        catalog_factory=lambda _version, _architecture: recorder,
    )
    preview = service.plan("install", "tool.terminal")
    entries = {item["id"]: item for item in catalog["modules"]}
    entries["tool.terminal"]["requires"].append("engine.mihomo")

    with pytest.raises(ModuleLifecycleError) as raised:
        service.apply("install", "tool.terminal", preview["plan_id"])

    assert (raised.value.code, raised.value.status) == ("module_plan_stale", 409)
    assert raised.value.details["blockers"][0]["code"] == "module_dependency_missing"
    assert launcher.plans == []


def test_apply_preserves_launcher_domain_error(tmp_path):
    from services.module_transactions.state import ModuleTransactionError

    def refuse(_plan, **_kwargs):
        raise ModuleTransactionError(
            "operation_in_progress", "a module operation is already running"
        )

    service, _ = make_service(
        make_panel(tmp_path), make_release(), launch_operation=refuse
    )
    preview = service.plan("install", "tool.terminal")

    with pytest.raises(ModuleLifecycleError) as raised:
        service.apply("install", "tool.terminal", preview["plan_id"])

    assert (raised.value.code, raised.value.status) == ("operation_in_progress", 409)


def test_status_preserves_observed_log_error_and_recovery_fields(tmp_path):
    observed = status_record(
        result="rollback_failed",
        error_code="operation_rollback_failed",
        error="restore failed",
        log=[{"step": "download"}, {"step": "rollback"}],
        recovery={"available": True, "action": "retry"},
    )
    service, _ = make_service(
        make_panel(tmp_path),
        make_release(),
        observe_operation=lambda _root, _state: observed,
    )

    assert service.status() == {"ok": True, **observed}
