from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from flask import Flask

from services.cores import CoreRuntime
from routes.modules import create_modules_blueprint
from services.module_registry import (
    API_VERSION,
    PROFILE_PRESETS,
    LEGACY_FULL_PROFILE,
    MODULE_DEFINITIONS,
    MODULE_IDS,
    STATE_SCHEMA_VERSION,
    ModuleRegistry,
    ModuleRegistryError,
    core_binary_available,
)
from services.self_update.state import get_update_paths, release_lock, try_acquire_lock


def _available_which(name: str) -> str:
    return f"/usr/bin/{name}"


def _registry(tmp_path: Path, *, available: bool = True) -> ModuleRegistry:
    return ModuleRegistry(
        str(tmp_path),
        which=_available_which if available else lambda _name: None,
        environ={"ComSpec": "cmd.exe"} if available else {},
    )


def _module(payload: dict, module_id: str) -> dict:
    return next(item for item in payload["modules"] if item["id"] == module_id)


def test_explicit_core_binaries_are_available_to_registry(tmp_path):
    binary = tmp_path / "xray"
    binary.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    binary.chmod(0o755)
    assert core_binary_available("xray", which=lambda _name: None, environ={
        "XKEEN_XRAY_BINARY": str(binary),
    }) is True
    assert core_binary_available("xray", which=lambda _name: None, environ={
        "XKEEN_XRAY_BINARY": str(tmp_path / "missing"),
    }) is False


def test_missing_state_migrates_to_legacy_full_and_exposes_full_registry(tmp_path):
    registry = _registry(tmp_path)

    payload = registry.get_registry()
    state_path = tmp_path / "modules.json"

    assert state_path.is_file()
    assert payload["ok"] is True
    assert payload["api_version"] == API_VERSION
    assert payload["schema_version"] == STATE_SCHEMA_VERSION
    assert payload["profile"] == LEGACY_FULL_PROFILE
    assert payload["runtime_gates_active"] is False
    assert payload["configured_module_ids"] == list(PROFILE_PRESETS["full"])
    assert payload["effective_module_ids"] == list(PROFILE_PRESETS["full"])
    assert [item["id"] for item in payload["modules"]] == list(MODULE_IDS)
    assert all(item["status"] == "enabled" for item in payload["modules"] if item["id"] != "tool.server-diagnostics")
    assert payload["editor"] == {
        "variant": "full",
        "active_variant": "full",
        "available_variants": ["light", "full", "advanced"],
        "capabilities": ["codemirror", "monaco", "diff"],
        "requires_restart": False,
    }

    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state == {
        "schema_version": STATE_SCHEMA_VERSION,
        "profile": LEGACY_FULL_PROFILE,
        "restart_required": False,
        "editor": {"variant": "full"},
        "modules": {module_id: {"enabled": module_id != "tool.server-diagnostics"} for module_id in MODULE_IDS},
    }


def test_editor_variant_is_backward_compatible_and_persisted_atomically(tmp_path):
    state_path = tmp_path / "modules.json"
    state_path.write_text(
        json.dumps(
            {
                "schema_version": STATE_SCHEMA_VERSION,
                "profile": "xray-minimal",
                "restart_required": False,
                "modules": {module_id: {"enabled": True} for module_id in MODULE_IDS},
            }
        ),
        encoding="utf-8",
    )
    registry = _registry(tmp_path)

    initial = registry.get_registry()
    assert initial["editor"]["variant"] == "light"
    assert initial["editor"]["capabilities"] == ["codemirror", "schema-basic"]

    updated, changed = registry.set_editor_variant("advanced")
    assert changed is True
    assert updated["editor"]["variant"] == "advanced"
    assert updated["editor"]["capabilities"] == [
        "codemirror",
        "monaco",
        "diff",
        "prettier",
        "quick-fix",
        "schema-extended",
    ]
    assert updated["restart_required"] is True
    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    assert persisted["schema_version"] == STATE_SCHEMA_VERSION
    assert persisted["editor"] == {"variant": "advanced"}
    assert persisted["modules"]["engine.xray"]["enabled"] is True


def test_editor_variant_taken_back_before_restart_asks_for_no_restart(tmp_path):
    registry = _registry(tmp_path)
    before = registry.get_registry()
    assert before["restart_required"] is False
    variant = before["editor"]["variant"]
    other = "advanced" if variant != "advanced" else "light"

    assert registry.set_editor_variant(other)[0]["restart_required"] is True
    back, changed = registry.set_editor_variant(variant)

    assert changed is True
    assert back["editor"]["variant"] == variant
    assert back["restart_required"] is False


def test_editor_variant_keeps_a_pending_restart_of_another_cause(tmp_path):
    registry = _registry(tmp_path)
    variant = registry.get_registry()["editor"]["variant"]
    registry.set_enabled("tool.terminal", False)

    registry.set_editor_variant("advanced" if variant != "advanced" else "light")
    back, _ = registry.set_editor_variant(variant)

    assert back["restart_required"] is True


def test_editor_variant_leaves_a_module_switch_undoable_without_restart(tmp_path):
    registry = _registry(tmp_path)
    before = registry.get_registry()
    variant = before["editor"]["variant"]

    registry.set_enabled("tool.terminal", False)
    registry.set_editor_variant("advanced" if variant != "advanced" else "light")
    registry.set_editor_variant(variant)
    payload, _ = registry.set_enabled("tool.terminal", True)

    assert payload["restart_required"] is False
    assert payload["profile"] == before["profile"]


def test_module_switch_taken_back_keeps_the_restart_of_a_changed_editor_variant(tmp_path):
    registry = _registry(tmp_path)
    variant = registry.get_registry()["editor"]["variant"]

    registry.set_enabled("tool.terminal", False)
    registry.set_editor_variant("advanced" if variant != "advanced" else "light")
    payload, _ = registry.set_enabled("tool.terminal", True)

    assert payload["restart_required"] is True


def test_editor_variant_rejects_unknown_values(tmp_path):
    registry = _registry(tmp_path)
    registry.get_registry()

    try:
        registry.set_editor_variant("monaco")
    except ModuleRegistryError as error:
        assert error.code == "editor_variant_invalid"
        assert error.status == 400
        assert error.details["available_variants"] == ["light", "full", "advanced"]
    else:
        raise AssertionError("unknown editor variant must be rejected")


def test_user_mutations_refuse_live_lifecycle_lock(tmp_path, monkeypatch):
    update_dir = tmp_path / "update"
    monkeypatch.setenv("XKEEN_UI_UPDATE_DIR", str(update_dir))
    registry = _registry(tmp_path)
    registry.get_registry()
    before = (tmp_path / "modules.json").read_bytes()
    lock_file = get_update_paths(str(tmp_path))["lock_file"]
    acquired, _info = try_acquire_lock(lock_file)
    assert acquired is True

    try:
        mutations = (
            lambda: registry.set_editor_variant("advanced"),
            lambda: registry.set_enabled("tool.files", False),
            lambda: registry.set_profile("mihomo-minimal"),
        )
        for mutate in mutations:
            with pytest.raises(ModuleRegistryError) as raised:
                mutate()
            assert raised.value.code == "operation_in_progress"
            assert raised.value.status == 409
        assert (tmp_path / "modules.json").read_bytes() == before
    finally:
        release_lock(lock_file, owner_pid=os.getpid())


def test_v0_active_modules_state_migrates_to_schema_v1(tmp_path):
    (tmp_path / "modules.json").write_text(
        json.dumps(
            {
                "schemaVersion": 0,
                "active_modules": ["core", "tool.editor", "engine.mihomo"],
            }
        ),
        encoding="utf-8",
    )
    registry = _registry(tmp_path)

    payload = registry.get_registry()
    persisted = json.loads((tmp_path / "modules.json").read_text(encoding="utf-8"))

    assert payload["configured_module_ids"] == ["core", "engine.mihomo", "tool.editor"]
    assert _module(payload, "engine.mihomo")["status"] == "enabled"
    assert _module(payload, "tool.terminal")["status"] == "disabled"
    assert persisted["schema_version"] == STATE_SCHEMA_VERSION
    assert "schemaVersion" not in persisted
    assert "active_modules" not in persisted
    assert persisted["modules"]["core"]["enabled"] is True
    assert persisted["modules"]["engine.mihomo"]["enabled"] is True
    assert persisted["modules"]["tool.files"]["enabled"] is False


def test_system_availability_and_dependency_resolution_are_reported_without_runtime_gates(tmp_path):
    registry = _registry(tmp_path, available=False)

    payload = registry.get_registry()
    xray = _module(payload, "engine.xray")
    mihomo = _module(payload, "engine.mihomo")
    happ = _module(payload, "integration.happ")

    assert payload["runtime_gates_active"] is False
    assert xray["enabled"] is True
    assert xray["effective_enabled"] is False
    assert xray["available"] is False
    assert xray["status"] == "unavailable"
    assert xray["reason"] == "system_requirements_unmet"
    assert set(xray["missing_requirement_ids"]) == {"xkeen", "xray"}
    assert mihomo["status"] == "unavailable"
    assert happ["available"] is True
    assert happ["status"] == "enabled"
    assert happ["reason"] is None


def test_disable_rejects_enabled_dependents_and_persists_a_custom_change(tmp_path):
    registry = _registry(tmp_path)
    registry.get_registry()

    try:
        registry.set_enabled("tool.editor", False)
    except ModuleRegistryError as error:
        assert error.code == "module_required_by"
        assert error.status == 409
        assert set(error.details["dependent_module_ids"]) >= {
            "engine.xray",
            "engine.mihomo",
        }
    else:
        raise AssertionError("disabling a required dependency must fail")

    payload, changed = registry.set_enabled("integration.happ", False)
    persisted = json.loads((tmp_path / "modules.json").read_text(encoding="utf-8"))

    assert changed is True
    assert payload["profile"] == "custom"
    assert payload["restart_required"] is True
    assert payload["module"]["status"] == "disabled"
    assert payload["module"]["reason"] == "user_disabled"
    assert persisted["modules"]["integration.happ"]["enabled"] is False


def test_reversing_an_unrestarted_module_switch_restores_the_original_profile(tmp_path):
    registry = _registry(tmp_path)
    registry.get_registry()

    first, first_changed = registry.set_enabled("integration.happ", False)
    restored, restored_changed = registry.set_enabled("integration.happ", True)
    reloaded = _registry(tmp_path).get_registry()

    assert first_changed is True
    assert first["profile"] == "custom"
    assert first["restart_required"] is True
    assert restored_changed is True
    assert restored["profile"] == LEGACY_FULL_PROFILE
    assert restored["restart_required"] is False
    assert reloaded["profile"] == LEGACY_FULL_PROFILE
    assert reloaded["restart_required"] is False


def test_reversing_a_switch_restores_an_existing_custom_profile(tmp_path):
    registry = _registry(tmp_path)
    requested = [module_id for module_id in MODULE_IDS if module_id != "integration.happ"]
    registry.set_profile("custom", module_ids=requested, editor_variant="advanced")
    registry.initialize_for_startup()

    first, first_changed = registry.set_enabled("integration.happ", True)
    restored, restored_changed = registry.set_enabled("integration.happ", False)
    restored_registry = registry.get_registry()

    assert first_changed is True
    assert first["profile"] == "custom"
    assert first["restart_required"] is True
    assert restored_changed is True
    assert restored["profile"] == "custom"
    assert restored["restart_required"] is False
    assert restored_registry["editor"]["variant"] == "advanced"


def test_reversing_a_switch_keeps_the_restart_for_a_dependency_it_enabled(tmp_path):
    registry = _registry(tmp_path)
    registry.set_profile("custom", module_ids=["core"])
    registry.initialize_for_startup()

    first, _ = registry.set_enabled("engine.xray", True)
    registry.set_enabled("engine.mihomo", True)
    reversed_, _ = registry.set_enabled("engine.xray", False)

    assert "tool.editor" in first["configured_module_ids"]
    # The editor was switched on along the way and is still on: the set
    # differs from the one the panel started with. (Xray alone could not be
    # switched off again: it would be the last engine.)
    assert "tool.editor" in reversed_["configured_module_ids"]
    assert reversed_["restart_required"] is True
    assert reversed_["profile"] == "custom"


def test_reversing_a_switch_does_not_clear_an_existing_profile_restart(tmp_path):
    registry = _registry(tmp_path)
    registry.set_profile("xray-minimal")

    registry.set_enabled("integration.happ", True)
    restored, restored_changed = registry.set_enabled("integration.happ", False)

    assert restored_changed is True
    assert restored["profile"] == "xray-minimal"
    assert restored["restart_required"] is True


def test_enabling_a_module_repairs_its_declared_dependencies(tmp_path):
    (tmp_path / "modules.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "modules": {
                    module_id: {"enabled": module_id == "core"} for module_id in MODULE_IDS
                },
            }
        ),
        encoding="utf-8",
    )
    registry = _registry(tmp_path)

    payload, changed = registry.set_enabled("engine.mihomo", True)
    persisted = json.loads((tmp_path / "modules.json").read_text(encoding="utf-8"))

    assert changed is True
    assert payload["module"]["effective_enabled"] is True
    assert persisted["modules"]["engine.mihomo"]["enabled"] is True
    assert persisted["modules"]["tool.editor"]["enabled"] is True
    assert persisted["restart_required"] is True


def test_runtime_activation_preserves_legacy_full_and_gates_custom_profiles(tmp_path):
    legacy = _registry(tmp_path)
    legacy_activation = legacy.runtime_activation()

    assert legacy_activation["legacy_compatibility"] is True
    assert legacy_activation["runtime_gates_active"] is True
    assert legacy_activation["active_module_ids"] == list(PROFILE_PRESETS["full"])

    custom = _registry(tmp_path / "custom")
    custom.get_registry()
    custom.set_enabled("integration.happ", False)
    custom.set_enabled("engine.mihomo", False)
    custom_activation = custom.runtime_activation()

    assert custom_activation["legacy_compatibility"] is False
    assert "engine.mihomo" not in custom_activation["active_module_ids"]
    assert "integration.happ" not in custom_activation["active_module_ids"]
    assert "engine.xray" in custom_activation["active_module_ids"]
    assert "core" in custom_activation["active_module_ids"]
    assert custom_activation["inactive_modules"]["engine.mihomo"] == "user_disabled"


def test_is_runtime_active_uses_frozen_process_activation(tmp_path):
    registry = _registry(tmp_path)
    registry.get_registry()
    activation = {
        "schema_version": STATE_SCHEMA_VERSION,
        "profile": "custom",
        "runtime_gates_active": True,
        "active_module_ids": ["core", "tool.editor", "engine.xray"],
        "inactive_modules": {"engine.mihomo": "user_disabled"},
    }
    registry.set_runtime_activation(activation)

    registry.set_enabled("engine.mihomo", False)
    assert registry.is_runtime_active("engine.xray") is True
    assert registry.is_runtime_active("engine.mihomo") is False


def test_corrupt_state_is_backed_up_and_recovers_to_legacy_full(tmp_path):
    state_path = tmp_path / "modules.json"
    state_path.write_text("{not-json", encoding="utf-8")
    registry = _registry(tmp_path)

    payload = registry.get_registry()

    assert payload["profile"] == LEGACY_FULL_PROFILE
    assert payload["configured_module_ids"] == list(PROFILE_PRESETS["full"])
    assert payload["recovery_reason"] == "corrupt_state"
    assert list(tmp_path.glob("modules.json.bad.*"))


def test_unknown_future_schema_is_backed_up_and_recovers_safely(tmp_path):
    state_path = tmp_path / "modules.json"
    state_path.write_text(
        json.dumps(
            {
                "schema_version": STATE_SCHEMA_VERSION + 99,
                "profile": "custom",
                "modules": {"engine.xray": {"enabled": False}},
            }
        ),
        encoding="utf-8",
    )
    registry = _registry(tmp_path)
    original = state_path.read_bytes()

    payload = registry.get_registry()

    assert payload["profile"] == LEGACY_FULL_PROFILE
    assert payload["recovery_reason"] == "unknown_schema_version"
    assert list(tmp_path.glob("modules.json.bad.*"))
    assert state_path.read_bytes() == original
    try:
        registry.set_enabled("engine.xray", False)
    except ModuleRegistryError as error:
        assert error.code == "state_schema_newer"
        assert error.status == 409
    else:
        raise AssertionError("future schema must be read-only")


def test_environment_safe_mode_forces_legacy_full_runtime_activation(tmp_path):
    registry = ModuleRegistry(
        str(tmp_path),
        which=_available_which,
        environ={"ComSpec": "cmd.exe", "XKEEN_UI_MODULE_SAFE_MODE": "legacy-full"},
    )
    registry.set_runtime_activation(
        {
            "profile": "custom",
            "active_module_ids": ["core"],
            "runtime_gates_active": True,
        }
    )

    activation = registry.runtime_activation()

    assert activation["safe_mode"] is True
    assert activation["safe_mode_reason"] == "environment"
    assert activation["active_module_ids"] == list(PROFILE_PRESETS["full"])


def test_startup_blocks_deferred_disable_of_running_core(tmp_path, monkeypatch):
    monkeypatch.setattr("services.cores.core_runtime", lambda: CoreRuntime(("xray",)))
    state = {
        "schema_version": STATE_SCHEMA_VERSION,
        "profile": "custom",
        "restart_required": True,
        "modules": {
            module_id: {"enabled": module_id != "engine.xray"}
            for module_id in MODULE_IDS
        },
    }
    (tmp_path / "modules.json").write_text(json.dumps(state), encoding="utf-8")
    registry = _registry(tmp_path)

    snapshot = registry.initialize_for_startup()
    xray = _module(snapshot, "engine.xray")
    activation = registry.runtime_activation()
    persisted = json.loads((tmp_path / "modules.json").read_text(encoding="utf-8"))

    # The user's choice survives; only this process keeps the running core.
    assert xray["enabled"] is False
    assert xray["effective_enabled"] is True
    assert xray["status"] == "enabled"
    assert xray["blocked_reason"] == "deferred_disable_blocked"
    assert "engine.xray" in activation["active_module_ids"]
    assert persisted["modules"]["engine.xray"] == {"enabled": False}

    monkeypatch.setattr("services.cores.core_runtime", lambda: CoreRuntime())
    restarted = _registry(tmp_path)
    snapshot = restarted.initialize_for_startup()
    xray = _module(snapshot, "engine.xray")

    assert xray["status"] == "disabled"
    assert "blocked_reason" not in xray
    assert "engine.xray" not in restarted.runtime_activation()["active_module_ids"]


def test_startup_keeps_both_engines_while_both_processes_run(tmp_path, monkeypatch):
    """A hand-off at startup: each live engine keeps its module this process."""
    monkeypatch.setattr("services.cores.core_runtime", lambda: CoreRuntime(("xray", "mihomo")))
    state = {
        "schema_version": STATE_SCHEMA_VERSION,
        "profile": "custom",
        "restart_required": True,
        "modules": {
            module_id: {"enabled": module_id not in {"engine.xray", "engine.mihomo"}}
            for module_id in MODULE_IDS
        },
    }
    (tmp_path / "modules.json").write_text(json.dumps(state), encoding="utf-8")
    registry = _registry(tmp_path)

    snapshot = registry.initialize_for_startup()
    active = registry.runtime_activation()["active_module_ids"]

    for module_id in ("engine.xray", "engine.mihomo"):
        engine = _module(snapshot, module_id)
        assert engine["enabled"] is False
        assert engine["blocked_reason"] == "deferred_disable_blocked"
        assert module_id in active


def test_startup_drops_block_persisted_by_older_builds(tmp_path, monkeypatch):
    monkeypatch.setattr("services.cores.core_runtime", lambda: CoreRuntime())
    state = {
        "schema_version": STATE_SCHEMA_VERSION,
        "profile": "custom",
        "restart_required": False,
        "modules": {module_id: {"enabled": True} for module_id in MODULE_IDS},
    }
    state["modules"]["engine.xray"]["blocked_reason"] = "deferred_disable_blocked"
    (tmp_path / "modules.json").write_text(json.dumps(state), encoding="utf-8")

    snapshot = _registry(tmp_path).initialize_for_startup()

    assert "blocked_reason" not in _module(snapshot, "engine.xray")


def test_registry_failure_fallback_activates_only_installed_modules(tmp_path, monkeypatch):
    (tmp_path / "module-installed.json").write_text(
        json.dumps({"modules": {"engine.mihomo": False}}),
        encoding="utf-8",
    )
    registry = _registry(tmp_path)

    def broken_registry():
        raise OSError("state dir is not readable")

    monkeypatch.setattr(registry, "get_registry", broken_registry)
    activation = registry.runtime_activation()

    assert activation["reason"] == "module_registry_unavailable"
    assert "engine.mihomo" not in activation["active_module_ids"]
    assert activation["inactive_modules"]["engine.mihomo"] == "module_not_installed"
    assert "core" in activation["active_module_ids"]


def test_initialization_failure_does_not_disable_module_after_restart(tmp_path, monkeypatch):
    monkeypatch.setattr("services.cores.core_runtime", lambda: CoreRuntime())
    registry = _registry(tmp_path)
    registry.initialize_for_startup()
    registry.set_enabled("tool.files", False)
    registry.record_initialization_failure("engine.xray", RuntimeError("scheduler hiccup"))

    failed = _module(registry.get_registry(), "engine.xray")
    assert failed["status"] == "failed"
    assert failed["last_error"] == "scheduler hiccup"

    restarted = _registry(tmp_path)
    snapshot = restarted.initialize_for_startup()
    xray = _module(snapshot, "engine.xray")
    activation = restarted.runtime_activation()

    assert snapshot["profile"] == "custom"
    assert xray["status"] == "enabled"
    assert "last_error" not in xray
    assert "engine.xray" in activation["active_module_ids"]


def test_initialization_failure_keeps_future_schema_state_untouched(tmp_path):
    state_path = tmp_path / "modules.json"
    state_path.write_text(
        json.dumps({"schema_version": STATE_SCHEMA_VERSION + 1, "profile": "xray-minimal"}),
        encoding="utf-8",
    )
    original = state_path.read_bytes()
    registry = _registry(tmp_path)

    registry.record_initialization_failure("engine.mihomo", RuntimeError("boom"))

    assert state_path.read_bytes() == original
    assert _module(registry.get_registry(), "engine.mihomo")["status"] == "failed"


def test_future_schema_backup_is_taken_once_per_process(tmp_path, monkeypatch):
    stamps = iter(f"20260930T0000{index:02d}Z" for index in range(10))

    class _Clock:
        @staticmethod
        def now(_tz=None):
            class _Stamp:
                @staticmethod
                def strftime(_fmt):
                    return next(stamps)

            return _Stamp()

    monkeypatch.setattr("services.module_registry.datetime", _Clock)
    (tmp_path / "modules.json").write_text(
        json.dumps({"schema_version": STATE_SCHEMA_VERSION + 1}),
        encoding="utf-8",
    )
    registry = _registry(tmp_path)

    for _ in range(3):
        registry.get_registry()

    assert len(list(tmp_path.glob("modules.json.bad.*"))) == 1


def test_missing_module_manifest_keeps_safe_mode_from_importing_removed_engine(tmp_path):
    (tmp_path / "module-installed.json").write_text(
        json.dumps({"modules": {"engine.mihomo": False}}),
        encoding="utf-8",
    )
    registry = ModuleRegistry(
        str(tmp_path),
        which=_available_which,
        environ={"ComSpec": "cmd.exe", "XKEEN_UI_MODULE_SAFE_MODE": "legacy-full"},
    )

    payload = registry.get_registry()
    activation = registry.runtime_activation()

    assert _module(payload, "engine.mihomo")["status"] == "not_installed"
    assert "engine.mihomo" not in activation["active_module_ids"]


def test_module_api_contract_and_mutations(tmp_path):
    registry = _registry(tmp_path)
    app = Flask("module-registry-test")
    app.config["TESTING"] = True
    app.register_blueprint(create_modules_blueprint(registry))
    client = app.test_client()

    listed = client.get("/api/modules")
    assert listed.status_code == 200
    assert listed.headers["Cache-Control"] == "no-store"
    assert listed.get_json()["effective_module_ids"] == list(PROFILE_PRESETS["full"])
    assert listed.get_json()["editor"]["variant"] == "full"

    editor = client.patch("/api/modules/editor", json={"variant": "light"})
    assert editor.status_code == 200
    assert editor.get_json()["editor"]["variant"] == "light"
    assert editor.get_json()["restart_required"] is True

    unsupported_editor_field = client.patch(
        "/api/modules/editor",
        json={"variant": "full", "enabled": True},
    )
    assert unsupported_editor_field.status_code == 400
    assert unsupported_editor_field.get_json()["code"] == "unsupported_editor_fields"

    invalid_editor = client.patch("/api/modules/editor", json={"variant": "monaco"})
    assert invalid_editor.status_code == 400
    assert invalid_editor.get_json()["code"] == "editor_variant_invalid"

    missing_editor_variant = client.patch("/api/modules/editor", json={})
    assert missing_editor_variant.status_code == 400
    assert missing_editor_variant.get_json()["code"] == "editor_variant_required"

    detail = client.get("/api/modules/engine.mihomo")
    assert detail.status_code == 200
    assert detail.get_json()["module"]["id"] == "engine.mihomo"

    disabled = client.patch("/api/modules/integration.happ", json={"enabled": False})
    assert disabled.status_code == 200
    assert disabled.get_json()["changed"] is True
    assert disabled.get_json()["module"]["status"] == "disabled"

    enabled = client.post("/api/modules/integration.happ/enable")
    assert enabled.status_code == 200
    assert enabled.get_json()["changed"] is True
    assert enabled.get_json()["module"]["effective_enabled"] is True

    invalid = client.patch("/api/modules/tool.files", json={"enabled": "false"})
    assert invalid.status_code == 400
    assert invalid.get_json()["code"] == "invalid_enabled"

    core_disabled = client.post("/api/modules/core/disable")
    assert core_disabled.status_code == 409
    assert core_disabled.get_json()["code"] == "core_required"

    missing = client.get("/api/modules/not-real")
    assert missing.status_code == 404
    assert missing.get_json()["code"] == "module_not_found"


def test_profile_presets_are_canonical_and_include_expected_modules():
    assert set(PROFILE_PRESETS) == {
        "legacy-full",
        "full",
        "xray-minimal",
        "mihomo-minimal",
        "custom",
    }
    assert PROFILE_PRESETS["xray-minimal"] == (
        "core",
        "engine.xray",
        "tool.editor",
    )
    assert PROFILE_PRESETS["mihomo-minimal"] == (
        "core",
        "engine.mihomo",
        "tool.editor",
    )
    assert set(PROFILE_PRESETS["full"]) == set(MODULE_IDS) - {"tool.server-diagnostics"}


def test_profile_transition_is_atomic_and_returns_restart_diff(tmp_path):
    registry = _registry(tmp_path)
    registry.get_registry()

    payload, changed = registry.set_profile("xray-minimal")

    assert changed is True
    assert payload["profile"] == "xray-minimal"
    assert payload["restart_required"] is True
    assert payload["diff"]["profile"] == {
        "before": "legacy-full",
        "after": "xray-minimal",
    }
    assert payload["diff"]["will_activate_after_restart"] == [
        "core",
        "engine.xray",
        "tool.editor",
    ]
    assert set(payload["diff"]["will_deactivate_after_restart"]) == {
        module_id for module_id in MODULE_IDS if module_id not in PROFILE_PRESETS["xray-minimal"]
    }

    persisted = json.loads((tmp_path / "modules.json").read_text(encoding="utf-8"))
    assert persisted["profile"] == "xray-minimal"
    assert [module_id for module_id, item in persisted["modules"].items() if item["enabled"]] == [
        "core",
        "engine.xray",
        "tool.editor",
    ]


def test_custom_profile_requires_valid_module_set_and_keeps_dependencies(tmp_path):
    registry = _registry(tmp_path)
    registry.get_registry()

    payload, changed = registry.set_profile(
        "custom",
        module_ids=["core", "engine.mihomo", "tool.editor", "tool.backups"],
    )

    assert changed is True
    assert payload["profile"] == "custom"
    assert payload["diff"]["will_activate_after_restart"] == [
        "core",
        "engine.mihomo",
        "tool.editor",
        "tool.backups",
    ]

    try:
        registry.set_profile("custom", module_ids=["core", "engine.xray"])
    except ModuleRegistryError as error:
        assert error.code == "profile_dependency_missing"
        assert error.status == 400
        assert error.details["missing_module_ids"] == ["tool.editor"]
    else:
        raise AssertionError("custom profile must include declared dependencies")


def test_profile_api_rejects_unknown_profile_and_accepts_custom_module_ids(tmp_path):
    registry = _registry(tmp_path)
    app = Flask("profile-registry-test")
    app.config["TESTING"] = True
    app.register_blueprint(create_modules_blueprint(registry))
    client = app.test_client()

    unknown = client.post("/api/modules/profile", json={"profile": "no-such-profile"})
    assert unknown.status_code == 400
    assert unknown.get_json()["code"] == "profile_invalid"

    custom = client.post(
        "/api/modules/profile",
        json={
            "profile": "custom",
            "module_ids": ["core", "engine.xray", "tool.editor", "tool.backups"],
        },
    )
    assert custom.status_code == 200
    assert custom.get_json()["profile"] == "custom"
    assert custom.get_json()["changed"] is True
    assert custom.get_json()["diff"]["will_activate_after_restart"] == [
        "core",
        "engine.xray",
        "tool.editor",
        "tool.backups",
    ]


def test_patch_reports_eligibility_diff_after_leaving_legacy_full(tmp_path):
    registry = _registry(tmp_path, available=False)
    registry.get_registry()

    payload, changed = registry.set_enabled("integration.happ", False)

    assert changed is True
    assert "engine.xray" in payload["diff"]["will_deactivate_after_restart"]
    assert "engine.mihomo" in payload["diff"]["will_deactivate_after_restart"]
    assert payload["diff"]["unavailable_after_restart"]["engine.xray"] == "system_requirements_unmet"


def test_profile_route_honors_active_core_guard(tmp_path):
    registry = _registry(tmp_path)
    app = Flask("profile-guard-test")
    app.config["TESTING"] = True
    app.register_blueprint(create_modules_blueprint(
        registry,
        before_change=lambda module_id, enabled: {
            "code": "active_core_module", "message": "core is running", "status": 409
        } if module_id == "engine.mihomo" and not enabled else None,
    ))

    response = app.test_client().post("/api/modules/profile", json={"profile": "xray-minimal"})

    assert response.status_code == 409
    assert response.get_json()["code"] == "active_core_module"
    assert registry.get_registry()["profile"] == "legacy-full"

    mixed_case = app.test_client().post("/api/modules/profile", json={"profile": "XRAY-MINIMAL"})
    assert mixed_case.status_code == 409
    assert registry.get_registry()["profile"] == "legacy-full"


def test_registry_metadata_stays_aligned_with_stage0_module_snapshot():
    root = Path(__file__).resolve().parents[1]
    inventory = json.loads(
        (root / "docs" / "modular-panel-stage0-inventory.json").read_text(encoding="utf-8")
    )
    stage0_modules = {item["id"]: item for item in inventory["modules"]}
    # the size is what lands on the router: the package files, without tests and e2e
    package_sizes = {module_id: 0 for module_id in stage0_modules}
    for unit in inventory["units"]:
        if unit["path"].startswith("xkeen-ui/"):
            package_sizes[unit["module_id"]] += unit["size_bytes"]

    assert set(stage0_modules) == set(MODULE_IDS)
    for definition in MODULE_DEFINITIONS:
        stage0 = stage0_modules[definition.id]
        assert list(definition.dependencies) == stage0["depends_on"]
        assert definition.size_bytes == package_sizes[definition.id]
        assert definition.removable == stage0["removable"]


def test_registry_sizes_are_loaded_from_generated_manifest():
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads(
        (root / "xkeen-ui" / "module-sizes.json").read_text(encoding="utf-8")
    )
    sizes = manifest["modules"]

    assert {definition.id for definition in MODULE_DEFINITIONS} == set(sizes)
    assert all(definition.size_bytes == sizes[definition.id] for definition in MODULE_DEFINITIONS)


def test_optional_module_metadata_is_neutral_and_registry_owns_runtime_boundaries():
    metadata = {definition.id: definition for definition in MODULE_DEFINITIONS}

    integration = metadata["integration.happ"]
    visible = " ".join(
        [
            integration.name,
            integration.description,
            *(requirement.id for requirement in integration.system_requirements),
        ]
    ).lower()
    assert "happ" not in visible
    assert "decrypt" not in visible
    assert integration.name == "Расшифровка подписок"
    assert "update" not in metadata["tool.advanced-diagnostics"].description.lower()


def test_engine_descriptions_name_features_as_their_windows_do():
    # 16.10.2026: the owner reads these on the module tiles. Features are named
    # by the titles of their windows and cards, without the words of the code.
    metadata = {definition.id: definition for definition in MODULE_DEFINITIONS}

    xray = metadata["engine.xray"].description
    mihomo = metadata["engine.mihomo"].description
    assert "DNS-over-VLESS" in xray and "логи Xray" in xray
    assert "Защищённый DNS Mihomo" in mihomo and "логи Mihomo" in mihomo
    assert "базы доменов и адресов" in xray and "базы доменов и адресов" in mihomo
    for definition in MODULE_DEFINITIONS:
        for word in ("runtime", "Clash API", "telemetry", "PTY", "xterm", "shell policy", "geodat", "Routing"):
            assert word not in definition.description, (definition.id, word)


def test_subscription_link_utility_install_marker_ignores_core_helpers():
    from services.module_registry import _MODULE_INSTALL_MARKERS

    markers = _MODULE_INSTALL_MARKERS["integration.happ"]

    # happ_links/happ_payloads are core-owned and stay after module removal.
    assert all("happ_links" not in marker and "happ_payloads" not in marker for marker in markers)
    assert "xkeen-ui/routes/happ_decryptor.py" in markers


def test_editor_reports_non_disableable_while_an_engine_depends_on_it(tmp_path):
    registry = _registry(tmp_path)
    full = registry.get_registry()
    assert _module(full, "tool.editor")["can_disable"] is False

    # Without an engine the editor is free; such a set comes only from a profile:
    # the last engine cannot be switched off.
    registry.set_profile("custom", module_ids=["core", "tool.editor"])
    reduced = registry.get_registry()
    assert _module(reduced, "tool.editor")["can_disable"] is True


def test_an_engine_the_installer_left_off_says_why_until_switched_by_hand(tmp_path):
    registry = _registry(tmp_path)
    registry.get_registry()
    state_path = tmp_path / "modules.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["modules"]["engine.mihomo"] = {"enabled": False, "off_reason": "core_missing"}
    # A mark on a module that is on means nothing and is dropped.
    state["modules"]["engine.xray"] = {"enabled": True, "off_reason": "core_missing"}
    state_path.write_text(json.dumps(state), encoding="utf-8")

    payload = registry.get_registry()
    assert _module(payload, "engine.mihomo")["off_reason"] == "core_missing"
    assert "off_reason" not in _module(payload, "engine.xray")

    registry.set_enabled("engine.mihomo", True)
    registry.set_enabled("engine.mihomo", False)
    assert "off_reason" not in _module(registry.get_registry(), "engine.mihomo")


def test_the_last_enabled_engine_cannot_be_switched_off(tmp_path):
    registry = _registry(tmp_path)
    full = registry.get_registry()
    assert _module(full, "engine.xray")["can_disable"] is True
    assert _module(full, "engine.xray")["lock_reason"] is None

    registry.set_enabled("engine.mihomo", False)
    reduced = registry.get_registry()
    xray = _module(reduced, "engine.xray")
    assert xray["can_disable"] is False
    assert xray["lock_reason"] == "last_engine"
    # The switched-off engine is free to come back.
    assert _module(reduced, "engine.mihomo")["lock_reason"] is None
    assert _module(reduced, "tool.editor")["lock_reason"] == "editor_required"
    assert _module(reduced, "core")["lock_reason"] == "core"

    with pytest.raises(ModuleRegistryError) as refused:
        registry.set_enabled("engine.xray", False)
    assert refused.value.code == "last_engine_module"
    with pytest.raises(ModuleRegistryError):
        registry.check_disable("engine.xray")
    registry.check_disable("tool.terminal")

    # The mirror case: Mihomo alone.
    registry.set_enabled("engine.mihomo", True)
    registry.set_enabled("engine.xray", False)
    assert _module(registry.get_registry(), "engine.mihomo")["lock_reason"] == "last_engine"
    with pytest.raises(ModuleRegistryError):
        registry.set_enabled("engine.mihomo", False)


def test_stage1_closure_is_reflected_in_documentation():
    root = Path(__file__).resolve().parents[1]
    plan = (root / "README-modular-panel-plan.md").read_text(encoding="utf-8")
    contract = (root / "docs" / "modular-panel-stage1-module-registry.md").read_text(
        encoding="utf-8"
    )
    docs_index = (root / "docs" / "README.md").read_text(encoding="utf-8")

    for fragment in (
        "## Этап 1. Базовый Module Registry — закрыт",
        "Статус этапа: **закрыт 29 сентября 2026 года**.",
        "Критерий готовности: **выполнен**.",
        "docs/modular-panel-stage1-module-registry.md",
    ):
        assert fragment in plan

    for fragment in (
        "Статус:** закрыт 29 сентября 2026 года",
        "UI_STATE_DIR/modules.json",
        "GET   /api/modules",
        "runtime_gates_active: false",
        "Критерий готовности Этапа 1: **выполнен**.",
        "Этап 4 — разделение frontend shell и экранов",
    ):
        assert fragment in contract

    assert "modular-panel-stage1-module-registry.md" in docs_index


def test_legacy_registry_blueprint_without_lifecycle_keeps_old_api_available(tmp_path):
    app = Flask(__name__)
    app.register_blueprint(create_modules_blueprint(_registry(tmp_path)))
    client = app.test_client()

    assert client.get("/api/modules").status_code == 200
    unavailable = client.get("/api/modules/installed")
    assert unavailable.status_code == 503
    assert unavailable.get_json()["code"] == "module_lifecycle_unavailable"
