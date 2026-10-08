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
    assert payload["panel_version"] == VERSION
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


def test_available_maps_invalid_trusted_catalog_to_503(tmp_path):
    class InvalidCatalog:
        def get_release_catalog(self, _version):
            from services.module_catalog_client import CatalogClientError

            raise CatalogClientError(
                "catalog_signature_invalid", "catalog signature is invalid"
            )

    service, _ = make_service(
        make_panel(tmp_path),
        make_release(),
        catalog_factory=lambda _version, _architecture: InvalidCatalog(),
    )

    with pytest.raises(ModuleLifecycleError) as raised:
        service.available()

    assert (raised.value.code, raised.value.status) == (
        "catalog_signature_invalid",
        503,
    )


def test_available_maps_release_compatibility_failure_to_409(tmp_path):
    class IncompatibleCatalog:
        def get_release_catalog(self, _version):
            from services.module_catalog_client import CatalogClientError

            raise CatalogClientError(
                "catalog_architecture_unsupported",
                "module architecture is not supported",
            )

    service, _ = make_service(
        make_panel(tmp_path),
        make_release(),
        catalog_factory=lambda _version, _architecture: IncompatibleCatalog(),
    )

    with pytest.raises(ModuleLifecycleError) as raised:
        service.available()

    assert (raised.value.code, raised.value.status) == (
        "catalog_architecture_unsupported",
        409,
    )


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


def test_panel_update_plan_uses_latest_release_and_preserves_profile(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0")
    release = make_release(version="2.11.0")
    launcher = LaunchRecorder()
    service, catalog = make_service(panel, release, launch_operation=launcher)

    payload = service.plan("panel-update", None)

    assert payload["scope"] == "panel"
    assert payload["source_version"] == "2.10.0"
    assert payload["target_version"] == "2.11.0"
    assert payload["target_profile"]["profile"] == "xray-minimal"
    assert payload["module_id"] is None
    assert payload["applicable"] is True
    assert re.fullmatch(r"[0-9a-f]{64}", payload["plan_id"])
    assert catalog.latest_requests == 1


def test_profile_transition_plan_and_apply_use_exact_release(tmp_path):
    panel = make_panel(tmp_path)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    registry.set_profile("mihomo-minimal")
    launcher = LaunchRecorder()
    service, catalog = make_service(panel, make_release(), registry=registry, launch_operation=launcher)

    payload = service.plan("profile-transition", None)
    applied = service.apply("profile-transition", None, payload["plan_id"])

    assert payload["scope"] == "profile"
    assert payload["source_version"] == payload["target_version"] == VERSION
    assert payload["target_profile"]["profile"] == "mihomo-minimal"
    assert catalog.requested_versions == [VERSION, VERSION]
    assert launcher.plans[-1].scope == "profile"
    assert applied["operation_id"] == "20261006T120000Z-abcdef"


def test_full_scope_apply_rejects_profile_change_after_review(tmp_path):
    panel = make_panel(tmp_path)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    registry.set_profile("mihomo-minimal")
    service, _ = make_service(panel, make_release(), registry=registry, launch_operation=LaunchRecorder())
    reviewed = service.plan("profile-transition", None)
    registry.set_profile("full")

    with pytest.raises(ModuleLifecycleError) as raised:
        service.apply("profile-transition", None, reviewed["plan_id"])

    assert raised.value.code == "operation_plan_stale"


def test_full_scope_apply_revalidates_reviewed_plan_inside_launcher(tmp_path):
    panel = make_panel(tmp_path)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    registry.set_profile("mihomo-minimal")

    def race(_plan, **kwargs):
        registry.set_profile("full")
        kwargs["prepare_plan"]()
        pytest.fail("stale plan must not launch")

    service, _ = make_service(
        panel,
        make_release(),
        registry=registry,
        launch_operation=race,
    )
    reviewed = service.plan("profile-transition", None)

    with pytest.raises(ModuleLifecycleError) as raised:
        service.apply("profile-transition", None, reviewed["plan_id"])

    assert raised.value.code == "operation_plan_stale"


def test_restart_is_blocked_while_profile_transition_is_pending(tmp_path):
    panel = make_panel(tmp_path)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    registry.set_profile("mihomo-minimal")
    service, _ = make_service(panel, make_release(), registry=registry)

    pending = service.profile_transition_status()
    with pytest.raises(ModuleLifecycleError) as raised:
        service.restart()

    assert pending["transition_required"] is True
    assert pending["transition_target"]["profile"] == "mihomo-minimal"
    assert raised.value.code == "profile_transition_required"


@pytest.mark.parametrize(
    ("operation", "module_id"),
    [("panel-update", None), ("repair", "engine.xray")],
)
def test_non_profile_operations_are_blocked_while_profile_transition_is_pending(
    tmp_path, operation, module_id
):
    panel = make_panel(tmp_path)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    registry.set_profile("mihomo-minimal")
    service, _ = make_service(panel, make_release(version="2.11.0"), registry=registry)

    with pytest.raises(ModuleLifecycleError) as raised:
        service.plan(operation, module_id)

    assert raised.value.code == "profile_transition_required"


def test_full_scope_plans_expose_stable_design_error_codes(tmp_path, monkeypatch):
    panel = make_panel(tmp_path)
    service, _ = make_service(panel, make_release(version=VERSION))
    current = service.plan("panel-update", None)
    assert current["blockers"][0]["code"] == "panel_version_current"

    monkeypatch.setattr(
        "services.module_transactions.plan.shutil.disk_usage",
        lambda _path: SimpleNamespace(free=0),
    )
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    registry.set_profile("mihomo-minimal")
    service, _ = make_service(panel, make_release(), registry=registry)
    no_space = service.plan("profile-transition", None)
    assert no_space["blockers"][0]["code"] == "operation_free_space"


def test_invalid_profile_target_uses_stable_public_code(tmp_path):
    panel = make_panel(tmp_path)
    desired = panel.read_json("modules.json")
    desired["physical_request"] = {
        "profile": "custom",
        "module_ids": ["core", "engine.xray", "tool.editor"],
        "editor_variant": "unsupported",
    }
    panel.path("modules.json").write_text(json.dumps(desired), encoding="utf-8")
    service, _ = make_service(panel, make_release())

    with pytest.raises(ModuleLifecycleError) as raised:
        service.plan("profile-transition", None)

    assert raised.value.code == "profile_target_invalid"


@pytest.mark.parametrize(
    ("operation", "lower_code", "public_code"),
    [
        ("panel-update", "catalog_panel_not_object", "panel_update_unavailable"),
        ("panel-update", "catalog_archive_unavailable", "panel_update_unavailable"),
        ("profile-transition", "catalog_archive_unavailable", "profile_payload_unavailable"),
    ],
)
def test_full_scope_catalog_failures_use_stable_public_codes(
    tmp_path, operation, lower_code, public_code
):
    from services.module_catalog_client import CatalogClientError

    class FailedCatalog:
        def get_catalog(self, **_kwargs):
            raise CatalogClientError(lower_code, "unavailable")

        def get_release_catalog(self, _version):
            raise CatalogClientError(lower_code, "unavailable")

    service, _ = make_service(
        make_panel(tmp_path),
        make_release(),
        catalog_factory=lambda _version, _architecture: FailedCatalog(),
    )

    with pytest.raises(ModuleLifecycleError) as raised:
        service.plan(operation, None)

    assert raised.value.code == public_code


def test_invalid_panel_archive_uses_stable_public_code(tmp_path):
    from services.module_catalog_client import CatalogClientError

    service, catalog = make_service(make_panel(tmp_path), make_release(version="2.11.0"))

    def reject(_snapshot, _destination):
        raise CatalogClientError("catalog_archive_checksum_mismatch", "bad digest")

    catalog.download_verified_panel_archive = reject

    with pytest.raises(ModuleLifecycleError) as raised:
        service.plan("panel-update", None)

    assert raised.value.code == "panel_archive_invalid"


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
    assert len(launcher.kwargs) == 1
    launch_kwargs = launcher.kwargs[0]
    prepare_plan = launch_kwargs.pop("prepare_plan")
    assert callable(prepare_plan)
    assert launch_kwargs == {
        "panel_root": panel.root,
        "state_dir": panel.state,
        "health_url": "http://127.0.0.1:8088/login",
        "restart_cmd": ("xkeen", "-restart"),
    }


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

    assert service.status() == {
        "ok": True,
        **{key: value for key, value in observed.items() if key != "recovery"},
        "error": "the module operation could not be rolled back",
    }


def test_status_redacts_internal_paths_and_unrecognized_fields(tmp_path):
    observed = status_record(
        result="rollback_failed",
        error_code="operation_rollback_failed",
        error="cannot restore C:\\secret\\backup",
        failed_path="services/private.py",
        failed_error="permission denied at C:\\secret\\backup",
    )
    service, _ = make_service(
        make_panel(tmp_path),
        make_release(),
        observe_operation=lambda _root, _state: observed,
    )

    payload = service.status()

    assert payload["error"] == "the module operation could not be rolled back"
    # The file is one of the panel's own; what the system said about it is not shown.
    assert payload["failed_path"] == "services/private.py"
    assert "failed_error" not in payload
    assert "secret" not in json.dumps(payload)


def test_cancel_delegates_exact_operation_id(tmp_path):
    calls = []
    service, _ = make_service(
        make_panel(tmp_path),
        make_release(),
        cancel_operation=lambda root, state, operation_id: calls.append(
            (root, state, operation_id)
        ),
    )

    payload = service.cancel("20261006T120000Z-abcdef")

    assert payload == {
        "ok": True,
        "operation_id": "20261006T120000Z-abcdef",
        "cancel_requested": True,
    }
    assert calls == [
        (
            service.panel_root,
            service.state_dir,
            "20261006T120000Z-abcdef",
        )
    ]


def test_recovery_never_restarts_implicitly(tmp_path):
    panel = make_panel(tmp_path)
    restarts = []
    observed = status_record(result="rolled_back", restart_required=True)
    service, _ = make_service(
        panel,
        make_release(),
        recover_operation=lambda _root, _state, *, panel_running: "rolled_back",
        observe_operation=lambda _root, _state: observed,
        restart_panel=lambda source: restarts.append(source) or True,
    )

    payload = service.recover()

    assert payload == {"ok": True, "recovery_result": "rolled_back", **observed}
    assert payload["restart_required"] is True
    assert restarts == []


def test_recovery_maps_live_runner_refusal(tmp_path):
    from services.module_transactions.state import ModuleTransactionError

    def refuse(_root, _state, *, panel_running):
        assert panel_running is True
        raise ModuleTransactionError(
            "operation_in_progress", "a module operation is already running"
        )

    service, _ = make_service(
        make_panel(tmp_path), make_release(), recover_operation=refuse
    )

    with pytest.raises(ModuleLifecycleError) as raised:
        service.recover()

    assert (raised.value.code, raised.value.status) == ("operation_in_progress", 409)


def test_restart_runs_guard_before_existing_restart_boundary(tmp_path):
    calls = []

    def guard(root, state):
        calls.append(("guard", root, state))

    def restart(source):
        calls.append(("restart", source))
        return True

    service, _ = make_service(
        make_panel(tmp_path),
        make_release(),
        ensure_restartable_operation=guard,
        restart_panel=restart,
    )

    assert service.restart() == {"ok": True, "restart_requested": True}
    assert calls == [
        ("guard", service.panel_root, service.state_dir),
        ("restart", "module-lifecycle"),
    ]


def test_restart_maps_guard_domain_error(tmp_path):
    from services.module_transactions.state import ModuleTransactionError

    def refuse(_root, _state):
        raise ModuleTransactionError(
            "operation_recovery_required", "recover the abandoned operation"
        )

    service, _ = make_service(
        make_panel(tmp_path),
        make_release(),
        ensure_restartable_operation=refuse,
    )

    with pytest.raises(ModuleLifecycleError) as raised:
        service.restart()

    assert (raised.value.code, raised.value.status) == (
        "operation_recovery_required",
        409,
    )


@pytest.mark.parametrize("failure", [False, RuntimeError("restart unavailable")])
def test_restart_maps_false_or_exceptional_dispatch_to_503(tmp_path, failure):
    def restart(_source):
        if isinstance(failure, Exception):
            raise failure
        return failure

    service, _ = make_service(
        make_panel(tmp_path),
        make_release(),
        ensure_restartable_operation=lambda _root, _state: None,
        restart_panel=restart,
    )

    with pytest.raises(ModuleLifecycleError) as raised:
        service.restart()

    assert (raised.value.code, raised.value.status) == (
        "module_restart_failed",
        503,
    )


def test_apply_refuses_before_touching_files_when_the_panel_cannot_be_restarted(tmp_path):
    panel = make_panel(tmp_path)
    launcher = LaunchRecorder()
    service, _ = make_service(panel, make_release(), launch_operation=launcher, restart_cmd=())
    preview = service.plan("install", "tool.terminal")

    with pytest.raises(ModuleLifecycleError) as raised:
        service.apply("install", "tool.terminal", preview["plan_id"])

    # Иначе исполнитель разложил бы файлы и только потом узнал, что
    # перезапустить панель нечем.
    assert raised.value.code == "panel_restart_unavailable"
    assert raised.value.status == 503
    assert launcher.plans == []
