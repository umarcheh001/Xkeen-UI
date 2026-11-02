from __future__ import annotations

import json
import re
from dataclasses import replace
from types import SimpleNamespace

import pytest

from services.module_catalog_client import CatalogTransportError, official_release_asset_url
from services.module_lifecycle import ModuleLifecycleError, _plan_digest
from services.module_registry import MODULE_IDS, ModuleRegistry, module_set_name
from services.module_transactions.plan import build_plan
from tests.support.module_lifecycle import (
    LaunchRecorder,
    StaticCatalogRecorder,
    make_service,
    status_record,
)
from tests.support.module_tx import (
    MODULE_ORDER,
    ARCHITECTURE,
    OWNERSHIP,
    VERSION,
    catalog_document,
    make_panel,
    make_release,
    publish_module_updates,
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
    actions = {item["id"]: item["lifecycle_actions"] for item in payload["modules"]}
    assert actions == {
        "core": [],
        "engine.xray": ["repair", "remove"],
        "tool.editor": ["repair"],
    }
    assert catalog.requested_versions == []


def test_installed_exposes_authoritative_profile_transition_guard(tmp_path):
    panel = make_panel(tmp_path)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    service, _ = make_service(panel, make_release(), registry=registry)

    assert service.installed()["transition_required"] is False
    registry.set_profile("mihomo-minimal")
    assert service.installed()["transition_required"] is True
    assert service.profile_transition_status()["transition_required"] is True


def test_installed_tells_the_editor_variant_on_the_storage_from_the_chosen_one(tmp_path):
    panel = make_panel(tmp_path)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    service, _ = make_service(panel, make_release(), registry=registry)
    record = json.loads(panel.path("install-profile.json").read_text(encoding="utf-8"))
    record["editor_variant"] = "light"
    panel.path("install-profile.json").write_text(json.dumps(record), encoding="utf-8")

    registry.set_editor_variant("advanced")
    editor = service.installed()["editor"]

    assert editor["variant"] == "advanced"
    assert editor["installed_variant"] == "light"

    panel.path("install-profile.json").unlink()
    assert service.installed()["editor"]["installed_variant"] is None


def test_installed_tells_what_the_editor_transition_waits_for(tmp_path):
    panel = make_panel(tmp_path)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    service, _ = make_service(panel, make_release(), registry=registry)
    record = json.loads(panel.path("install-profile.json").read_text(encoding="utf-8"))
    record["editor_variant"] = "light"
    panel.path("install-profile.json").write_text(json.dumps(record), encoding="utf-8")

    registry.set_editor_variant("advanced")
    snapshot = service.installed()

    # The same modules are wanted: only the editor files are missing.
    assert snapshot["transition_required"] is True
    assert snapshot["transition_target"]["editor_variant"] == "advanced"
    assert sorted(snapshot["transition_target"]["module_ids"]) == sorted(snapshot["installed_module_ids"])


def test_editor_active_variant_is_the_one_the_running_panel_loaded(tmp_path):
    panel = make_panel(tmp_path)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    service, _ = make_service(panel, make_release(), registry=registry)
    registry.set_editor_variant("full")
    registry.initialize_for_startup()
    assert service.installed()["editor"]["active_variant"] == "full"

    registry.set_editor_variant("advanced")
    editor = service.installed()["editor"]
    assert (editor["variant"], editor["active_variant"]) == ("advanced", "full")

    # Taken back before the restart, there is nothing to wait for.
    registry.set_editor_variant("full")
    assert service.installed()["editor"]["active_variant"] == "full"

    registry.set_editor_variant("advanced")
    registry.initialize_for_startup()
    assert service.installed()["editor"]["active_variant"] == "advanced"


def test_installed_names_the_sets_by_their_modules_not_by_the_stored_label(tmp_path):
    panel = make_panel(tmp_path)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    service, _ = make_service(panel, make_release(), registry=registry)

    payload = service.installed()
    assert payload["installed_set"] == "xray-minimal"
    assert payload["enabled_set"] == "xray-minimal"

    # The stored label says "custom"; the names follow the modules, not the label.
    # (Xray is the only engine here and cannot be switched off to make a real change.)
    registry.set_profile("custom", module_ids=["core", "tool.editor", "engine.xray"])
    payload = service.installed()
    assert payload["installed_set"] == "xray-minimal"
    assert payload["enabled_set"] == "xray-minimal"


def test_update_channel_defaults_to_stable_and_persists(tmp_path):
    panel = make_panel(tmp_path)
    service, _ = make_service(panel, make_release())

    assert service.update_channel()["channel"] == "stable"
    assert service.set_update_channel("prerelease")["channel"] == "prerelease"
    assert service.update_channel()["channel"] == "prerelease"
    assert service.installed()["update_channel"] == "prerelease"
    assert make_service(panel, make_release())[0].update_channel()["channel"] == "prerelease"
    with pytest.raises(ModuleLifecycleError, match="choose stable or prerelease"):
        service.set_update_channel("main")


def test_notification_catalog_reads_signed_metadata_without_downloading_archives(tmp_path):
    panel = make_panel(tmp_path)
    current = catalog_document(VERSION, OWNERSHIP)
    future = catalog_document("2.11.0", OWNERSHIP)

    class NotificationCatalog:
        downloads = 0
        forced = []

        def get_catalog(self, *, force_refresh=False):
            self.forced.append(force_refresh)
            return SimpleNamespace(
                catalog=future,
                freshness="fresh",
                stale_reason=None,
                fetched_at=1234.0,
            )

        def get_release_catalog(self, version):
            assert version == VERSION
            return SimpleNamespace(catalog=current)

        def download_verified_panel_archive(self, *_args, **_kwargs):
            self.downloads += 1
            raise AssertionError("notification discovery must not download archives")

    catalog = NotificationCatalog()
    service, _ = make_service(
        panel,
        make_release(),
        catalog_factory=lambda _version, _architecture: catalog,
    )

    payload = service.notification_catalog(force_refresh=True)

    assert catalog.forced == [True]
    assert catalog.downloads == 0
    assert payload["source_version"] == VERSION
    assert payload["target_version"] == "2.11.0"
    assert payload["update_available"] is True
    assert payload["current_modules"] == current["modules"]
    assert payload["target_modules"] == future["modules"]


def test_module_set_name_knows_the_presets_and_nothing_else():
    assert module_set_name(MODULE_IDS) == "full"
    assert module_set_name(["tool.editor", "core", "engine.mihomo"]) == "mihomo-minimal"
    assert module_set_name(["core", "engine.xray", "tool.editor", "tool.terminal"]) == "custom"
    assert module_set_name([]) == "custom"


def test_installed_names_every_module_this_build_knows(tmp_path):
    # A status or a plan speaks of modules that are not installed, and the
    # catalog is not read until it is asked for: the names come with this answer.
    service, catalog = make_service(make_panel(tmp_path), make_release())

    payload = service.installed()

    assert payload["module_names"]["tool.terminal"] == "Терминал и команды"
    assert "tool.terminal" not in payload["installed_module_ids"]
    assert set(payload["module_names"]) == set(MODULE_ORDER)
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
    assert all(item["lifecycle_actions"] == [] for item in payload["modules"])
    assert catalog.requested_versions == []


def test_installed_keeps_local_sha_build_readable_without_lifecycle_actions(tmp_path):
    panel = make_panel(tmp_path, version="977784dd")
    panel.path("BUILD.json").write_text(
        json.dumps(
            {
                "version": "977784dd",
                "base_commit": "977784dd",
                "commit": "977784dd0123456789012345678901234567890",
                "dirty": False,
                "tree_sha256": "b" * 64,
                "release_date": "2026-10-09T09:10:11Z",
            }
        ),
        encoding="utf-8",
    )
    service, catalog = make_service(panel, make_release())

    payload = service.installed()

    assert payload["ok"] is True
    assert payload["panel_version"] is None
    assert payload["lifecycle"] == {
        "available": False,
        "code": "panel_version_unsupported",
    }
    assert payload["installed_module_ids"] == ["core", "engine.xray", "tool.editor"]
    assert all(item["lifecycle_actions"] == [] for item in payload["modules"])
    assert payload["build"] == {
        "exists": True,
        "version": "977784dd",
        "base_commit": "977784dd",
        "commit": "977784dd0123456789012345678901234567890",
        "dirty": False,
        "tree_sha256": "b" * 64,
        "built_utc": "2026-10-09T09:10:11Z",
        "repo": "umarcheh001/Xkeen-UI",
        "channel": "stable",
    }
    assert catalog.requested_versions == []


def test_local_demo_exposes_module_screens_without_catalog_or_router_state(tmp_path, monkeypatch):
    from services.local_module_demo import ensure_state

    state = tmp_path / "local-demo"
    monkeypatch.setenv("XKEEN_UI_LOCAL_DEMO", "1")
    ensure_state(state)
    registry = ModuleRegistry(str(state), which=lambda _name: "/bin/tool")
    service, catalog = make_service(
        SimpleNamespace(root=state, state=state),
        make_release(),
        registry=registry,
        local_demo=True,
    )

    installed = service.installed()

    assert installed["lifecycle"] == {"available": True, "code": None}
    assert installed["installed_module_ids"] == list(MODULE_IDS)
    assert len(service.available()["modules"]) == len(MODULE_IDS)
    assert service.panel_update_check()["freshness"] == "local"
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


def test_available_entry_keeps_catalog_version_and_adds_module_version(tmp_path):
    panel = make_panel(tmp_path, version="3.1.0")
    service, _ = make_service(panel, make_release("3.1.0"))

    modules = {item["id"]: item for item in service.available()["modules"]}

    assert modules["engine.xray"]["version"] == "3.1.0"
    assert modules["engine.xray"]["module_version"] == "1.0.0"
    assert modules["engine.xray"]["installed_version"] == "1.0.0"
    assert modules["tool.terminal"]["module_version"] == "1.0.0"
    assert modules["tool.terminal"]["installed_version"] is None
    assert all("module_version" in item and "installed_version" in item for item in modules.values())
    # core has no version of its own: its version is the panel's.
    assert modules["core"]["module_version"] == "3.1.0"
    assert modules["core"]["installed_version"] == "3.1.0"


def test_local_demo_available_entries_carry_module_versions(tmp_path, monkeypatch):
    from services.local_module_demo import ensure_state

    state = tmp_path / "local-demo"
    monkeypatch.setenv("XKEEN_UI_LOCAL_DEMO", "1")
    ensure_state(state)
    (state / "module-versions.json").write_text('{"tool.terminal": "1.4.0"}', encoding="utf-8")
    registry = ModuleRegistry(str(state), which=lambda _name: "/bin/tool")
    service, _ = make_service(
        SimpleNamespace(root=state, state=state), make_release(), registry=registry, local_demo=True
    )

    modules = {item["id"]: item for item in service.available()["modules"]}

    assert modules["core"]["module_version"] == modules["core"]["version"]
    assert modules["core"]["installed_version"] == modules["core"]["version"]
    for item in modules.values():
        assert item["installed_version"] in (None, item["module_version"]) or item["installed"] is True
        assert (item["installed_version"] is None) == (item["installed"] is False)
    absent = [item for item in modules.values() if item["installed"] is False]
    for item in absent:
        expected = "1.4.0" if item["id"] == "tool.terminal" else "1.0.0"
        assert item["module_version"] == expected


def test_available_module_version_follows_module_versions_file(tmp_path):
    panel = make_panel(tmp_path, version="3.1.0")
    (panel.root / "module-versions.json").write_text('{"engine.xray": "1.2.0"}', encoding="utf-8")
    service, _ = make_service(panel, make_release("3.1.0"))

    modules = {item["id"]: item for item in service.available()["modules"]}

    assert modules["engine.xray"]["installed_version"] == "1.2.0"
    assert modules["engine.xray"]["module_version"] == "1.2.0"


def test_available_calls_every_known_module_by_its_name(tmp_path):
    # The signed catalog speaks in ids only; the names are this build's own.
    service, _ = make_service(make_panel(tmp_path), make_release())

    modules = {item["id"]: item for item in service.available()["modules"]}

    assert "name" not in make_release().catalog["modules"][0]
    assert modules["tool.terminal"]["name"] == "Терминал и команды"
    assert modules["tool.terminal"]["description"].startswith("Командная строка роутера")
    assert all(item.get("name") for item in modules.values())


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
        def get_effective_catalog(self, _version, **_kwargs):
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
        def get_effective_catalog(self, _version, **_kwargs):
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
        ("upgrade", "tool.terminal", "module_operation_invalid", 400),
        ("update", "core", "module_operation_forbidden", 400),
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


# --- Новейшая запись каталога на экране модулей ------------------------------


def test_update_available_compares_module_versions(tmp_path):
    # 1.0.1 > 1.0.0, панель 3.1.0 не участвует
    panel = make_panel(tmp_path, version="3.1.0", installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    release = make_release("3.1.0")
    publish_module_updates(release, {"engine.xray": "1.0.1", "tool.files": "1.0.1", "tool.terminal": "1.0.0"})
    service, catalog = make_service(panel, release)

    payload = service.available()
    modules = {item["id"]: item for item in payload["modules"]}

    assert catalog.effective_requests == 1
    assert payload["update_stale_reason"] is None
    xray = modules["engine.xray"]
    # The entry keeps the release version; the module's own versions are compared.
    assert (xray["version"], xray["module_version"], xray["installed_version"]) == ("3.1.0", "1.0.1", "1.0.0")
    assert xray["update_available"] is True
    assert "update_entry" not in xray and "ownership" not in xray
    # Not installed: nothing to update, the newest entry is what an install lays.
    assert modules["tool.files"]["module_version"] == "1.0.1"
    assert modules["tool.files"]["update_available"] is False
    # The same version is no update.
    assert modules["tool.terminal"]["update_available"] is False
    assert modules["core"]["update_available"] is False
    assert modules["core"]["module_version"] == "3.1.0"

    # The operations act on the same newest entry.
    plan = service.plan("repair", "engine.xray")
    assert plan["applicable"] is True


def test_update_available_is_false_when_installed_is_already_newer(tmp_path):
    panel = make_panel(tmp_path, version="3.1.0")
    record = json.loads(panel.path("module-installed.json").read_text(encoding="utf-8"))
    record["versions"] = {"engine.xray": "1.0.2"}
    panel.path("module-installed.json").write_text(json.dumps(record), encoding="utf-8")
    release = make_release("3.1.0")
    publish_module_updates(release, {"engine.xray": "1.0.1"})
    service, _ = make_service(panel, release)

    modules = {item["id"]: item for item in service.available()["modules"]}

    assert modules["engine.xray"]["installed_version"] == "1.0.2"
    assert modules["engine.xray"]["update_available"] is False


def test_available_reports_why_the_update_catalog_is_stale(tmp_path):
    panel = make_panel(tmp_path)
    catalog = catalog_document(VERSION)

    class StaleUpdates(StaticCatalogRecorder):
        def get_effective_catalog(self, version, **_kwargs):
            return replace_namespace(self.get_release_catalog(version), freshness="stale", stale_reason="catalog_signature_invalid")

    def replace_namespace(snapshot, **changes):
        return SimpleNamespace(**{**vars(snapshot), **changes})

    recorder = StaleUpdates(catalog)
    service, _ = make_service(panel, make_release(), catalog_factory=lambda _version, _architecture: recorder)

    payload = service.available()

    assert payload["update_stale_reason"] == "catalog_signature_invalid"
    assert all(item["update_available"] is False for item in payload["modules"])


def test_local_build_never_offers_update(tmp_path):
    panel = make_panel(tmp_path, version="3.1.0")
    panel.path("BUILD.json").write_text(
        json.dumps({"version": "3.1.0+local.f46f1f10", "commit": "f" * 40}), encoding="utf-8"
    )
    release = make_release("3.1.0")
    publish_module_updates(release, {"engine.xray": "1.0.1"})
    service, catalog = make_service(panel, release)

    payload = service.available()
    modules = {item["id"]: item for item in payload["modules"]}

    assert payload["read_only"] is True
    assert catalog.effective_requests == 0
    assert payload["update_stale_reason"] is None
    assert modules["engine.xray"]["module_version"] == "1.0.0"
    assert all(item["update_available"] is False for item in modules.values())
    assert all(item["lifecycle_actions"] == [] for item in modules.values())


# --- Операция update на экране модулей ---------------------------------------


def test_lifecycle_actions_offer_update_only_when_one_is_available():
    from services.module_lifecycle import _lifecycle_actions

    assert _lifecycle_actions("engine.xray", True) == ["repair", "remove"]
    assert _lifecycle_actions("engine.xray", True, update_available=True) == ["update", "repair", "remove"]
    assert _lifecycle_actions("tool.editor", True, update_available=True) == ["update", "repair"]
    # Not installed: an install lays the newest entry anyway.
    assert _lifecycle_actions("tool.files", False, update_available=True) == ["install"]
    assert _lifecycle_actions("core", True, update_available=True) == []


def test_available_offers_update_for_a_module_with_a_newer_entry(tmp_path):
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    release = make_release()
    publish_module_updates(release, {"engine.xray": "1.0.1", "tool.editor": "1.0.1", "tool.files": "1.0.1"})
    service, _catalog = make_service(panel, release)

    modules = {item["id"]: item for item in service.available()["modules"]}

    assert modules["engine.xray"]["lifecycle_actions"] == ["update", "repair", "remove"]
    assert modules["tool.editor"]["lifecycle_actions"] == ["update", "repair"]
    assert modules["tool.terminal"]["lifecycle_actions"] == ["repair", "remove"]
    assert modules["tool.files"]["lifecycle_actions"] == ["install"]
    assert service.plan("update", "engine.xray")["applicable"] is True


def test_installed_newer_than_the_catalog_is_a_blocked_plan(tmp_path):
    panel = make_panel(tmp_path)
    record = json.loads(panel.path("module-installed.json").read_text(encoding="utf-8"))
    record["versions"] = {"engine.xray": "1.0.2"}
    panel.path("module-installed.json").write_text(json.dumps(record), encoding="utf-8")
    service, _catalog = make_service(panel, make_release())

    for operation in ("repair", "update"):
        payload = service.plan(operation, "engine.xray")

        assert payload["applicable"] is False
        assert [item["code"] for item in payload["blockers"]] == ["module_update_catalog_unavailable"]
        assert "catalog cannot be read" not in payload["blockers"][0]["message"]


# --- Обновления модулей на экране и в уведомлениях ---------------------------


def test_update_check_lists_module_updates_of_installed_modules(tmp_path):
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    release = make_release()
    publish_module_updates(release, {"engine.xray": "1.1.0", "tool.files": "1.0.1", "tool.terminal": "1.0.0"})
    service, _catalog = make_service(panel, release)

    payload = service.panel_update_check()

    # Only an installed module with a newer entry; the panel's own answer is untouched.
    assert payload["update_available"] is False
    assert payload["module_updates"] == [
        {"module_id": "engine.xray", "version": "1.1.0", "installed_version": "1.0.0"},
    ]
    assert payload["module_updates_stale_reason"] is None


def test_update_check_without_update_document_lists_nothing(tmp_path):
    panel = make_panel(tmp_path)
    service, _catalog = make_service(panel, make_release())

    payload = service.panel_update_check()

    assert payload["module_updates"] == []
    assert payload["module_updates_stale_reason"] is None


def test_update_check_keeps_the_panel_answer_when_module_updates_fail(tmp_path):
    panel = make_panel(tmp_path)
    release = make_release()
    service, catalog = make_service(panel, release)

    def unavailable(_version, **_kwargs):
        error = RuntimeError("offline")
        error.code = "catalog_transport_failed"
        raise error

    catalog.get_effective_catalog = unavailable

    payload = service.panel_update_check()

    assert payload["ok"] is True
    assert payload["module_updates"] == []
    assert payload["module_updates_stale_reason"] == "catalog_transport_failed"


def test_update_check_of_a_local_build_offers_no_module_update(tmp_path):
    panel = make_panel(tmp_path, version="3.1.0")
    panel.path("BUILD.json").write_text(
        json.dumps({"version": "3.1.0+local.f46f1f10", "commit": "f" * 40}), encoding="utf-8"
    )
    release = make_release("3.1.0")
    publish_module_updates(release, {"engine.xray": "1.0.1"})
    service, catalog = make_service(panel, release)

    payload = service.panel_update_check()

    assert payload["module_updates"] == []
    assert catalog.effective_requests == 0


def test_update_plan_names_both_module_versions(tmp_path):
    panel = make_panel(tmp_path)
    release = make_release()
    publish_module_updates(release, {"engine.xray": "1.1.0"})
    service, _catalog = make_service(panel, release)

    plan = service.plan("update", "engine.xray")

    assert plan["applicable"] is True
    assert (plan["installed_version"], plan["module_version"]) == ("1.0.0", "1.1.0")
    # An install has nothing installed to name.
    install = service.plan("install", "tool.terminal")
    assert install["installed_version"] is None
    assert install["module_version"] == "1.0.0"


def test_notification_catalog_lists_module_updates(tmp_path):
    panel = make_panel(tmp_path)
    release = make_release()
    publish_module_updates(release, {"engine.xray": "1.1.0"})
    service, _catalog = make_service(panel, release)

    payload = service.notification_catalog()

    assert payload["module_updates"] == [
        {"module_id": "engine.xray", "version": "1.1.0", "installed_version": "1.0.0"},
    ]


def test_public_status_carries_module_version_and_download_bytes():
    from services.module_lifecycle import _public_status

    public = _public_status(
        status_record(
            operation="update", module_id="engine.xray", module_version="1.1.0", step="downloading",
            downloaded_bytes=1024, total_bytes=4096,
        )
    )

    assert (public["module_version"], public["downloaded_bytes"], public["total_bytes"]) == ("1.1.0", 1024, 4096)


# --- Проверка обновлений модулей без сети не ждёт GitHub ----------------------


def _stale_panel_catalog(catalog):
    """The panel catalog answers from its copy: GitHub could not be reached."""

    real = catalog.client.get_release_catalog(catalog.client._core_version)

    def stale(**_kwargs):
        catalog.latest_requests += 1
        return replace(real, freshness="stale", stale_reason="catalog_transport_failed")

    catalog.get_catalog = stale


def _update_requests(release):
    return [url for url in release.transport.calls if "module-updates" in url or url.endswith("catalog.json")
            or url.endswith("catalog.json.sig")]


def test_offline_update_check_asks_github_nothing_more(tmp_path):
    panel = make_panel(tmp_path)
    release = make_release()
    publish_module_updates(release, {"engine.xray": "1.1.0"})
    service, catalog = make_service(panel, release)
    _stale_panel_catalog(catalog)
    release.transport.calls.clear()

    payload = service.panel_update_check()
    notes = service.notification_catalog()

    # Nothing cached of the module updates: they are "not checked", and no request waited for GitHub.
    assert _update_requests(release) == []
    assert payload["update_available"] is False and payload["freshness"] == "stale"
    assert payload["module_updates"] == [] and payload["module_updates_stale_reason"]
    assert notes["module_updates"] == [] and notes["module_updates_stale_reason"]


def test_offline_update_check_answers_module_updates_from_the_copy(tmp_path):
    panel = make_panel(tmp_path)
    release = make_release()
    publish_module_updates(release, {"engine.xray": "1.1.0"})
    service, catalog = make_service(panel, release)
    assert service.panel_update_check()["module_updates"]  # the copy is kept
    # A day later GitHub is out of reach.
    catalog.client._now = lambda: __import__("time").time() + 2 * 86400
    _stale_panel_catalog(catalog)
    release.transport.calls.clear()

    payload = service.panel_update_check()

    assert _update_requests(release) == []
    assert payload["module_updates"] == [
        {"module_id": "engine.xray", "version": "1.1.0", "installed_version": "1.0.0"},
    ]
    assert payload["module_updates_stale_reason"] == "catalog_transport_failed"


def test_failed_module_update_request_is_not_repeated_on_every_check(tmp_path):
    panel = make_panel(tmp_path)
    release = make_release()
    publish_module_updates(release, {"engine.xray": "1.1.0"})
    url = official_release_asset_url(VERSION, "module-updates.json")
    release.transport.fail[url] = CatalogTransportError("catalog_transport_failed", "timed out")
    service, _catalog = make_service(panel, release)

    service.panel_update_check()
    service.panel_update_check()
    service.notification_catalog()

    # One attempt waited for GitHub; the next checks remember it and do not wait again.
    assert release.transport.calls.count(url) == 1


def test_tiles_and_available_tab_agree_on_module_updates(tmp_path):
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    # The editor is recorded older than this build lays it: both screens offer the same.
    record = json.loads(panel.path("module-installed.json").read_text(encoding="utf-8"))
    record["versions"] = {"tool.editor": "0.9.0"}
    panel.path("module-installed.json").write_text(json.dumps(record), encoding="utf-8")
    release = make_release()
    publish_module_updates(release, {"engine.xray": "1.1.0", "tool.terminal": "1.0.0"})
    service, _catalog = make_service(panel, release)

    offers = {offer["module_id"]: offer["version"] for offer in service.panel_update_check()["module_updates"]}
    available = {
        item["id"]: item["module_version"] for item in service.available()["modules"] if item["update_available"]
    }

    assert offers == available
    assert set(offers) == {"engine.xray", "tool.editor"}


# --- GitHub недоступен: экран и планы не ждут его каждый раз ---------------------


def test_screen_and_plans_do_not_wait_for_unreachable_github_again(tmp_path):
    from services.module_catalog_client import ModuleCatalogClient

    panel = make_panel(tmp_path, version="3.1.0")
    release = make_release("3.1.0")
    publish_module_updates(release, {"engine.xray": "1.0.1"})
    service, recorder = make_service(panel, release)
    clock = [1_000_000.0]
    recorder.client = ModuleCatalogClient(
        panel.state,
        transport=release.transport,
        keyring=release.keyring,
        platform_architecture=ARCHITECTURE,
        core_version="3.1.0",
        now=lambda: clock[0],
    )
    updates_url = official_release_asset_url("3.1.0", "module-updates.json")
    assert service.available()["update_stale_reason"] is None

    # Копия устарела, а GitHub не отвечает: один запрос с ожиданием.
    clock[0] += 2 * 24 * 60 * 60
    release.transport.fail[updates_url] = CatalogTransportError("catalog_transport_timeout", "timed out")
    before = release.transport.calls.count(updates_url)
    assert service.available()["update_stale_reason"] == "catalog_transport_timeout"
    assert release.transport.calls.count(updates_url) == before + 1

    # Следующие открытия экрана и планы отвечают копией, не спрашивая снова.
    modules = {item["id"]: item for item in service.available()["modules"]}
    assert modules["engine.xray"]["update_available"] is True
    assert service.plan("repair", "engine.xray")["applicable"] is True
    assert service.plan("update", "engine.xray")["applicable"] is True
    assert release.transport.calls.count(updates_url) == before + 1
