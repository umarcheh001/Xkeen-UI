from __future__ import annotations

import json
from pathlib import Path

from flask import Flask

from routes.modules import create_modules_blueprint
from services.module_registry import (
    API_VERSION,
    LEGACY_FULL_PROFILE,
    MODULE_DEFINITIONS,
    MODULE_IDS,
    STATE_SCHEMA_VERSION,
    ModuleRegistry,
    ModuleRegistryError,
)


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
    assert payload["configured_module_ids"] == list(MODULE_IDS)
    assert payload["effective_module_ids"] == list(MODULE_IDS)
    assert [item["id"] for item in payload["modules"]] == list(MODULE_IDS)
    assert all(item["status"] == "enabled" for item in payload["modules"])

    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state == {
        "schema_version": STATE_SCHEMA_VERSION,
        "profile": LEGACY_FULL_PROFILE,
        "restart_required": False,
        "modules": {module_id: {"enabled": True} for module_id in MODULE_IDS},
    }


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
    assert legacy_activation["active_module_ids"] == list(MODULE_IDS)

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
    assert payload["configured_module_ids"] == list(MODULE_IDS)
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
    assert activation["active_module_ids"] == list(MODULE_IDS)


def test_startup_blocks_deferred_disable_of_running_core(tmp_path, monkeypatch):
    monkeypatch.setattr("services.cores.detect_running_core", lambda: "xray")
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

    assert xray["enabled"] is True
    assert xray["effective_enabled"] is True
    assert xray["blocked_reason"] == "deferred_disable_blocked"


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
    assert listed.get_json()["effective_module_ids"] == list(MODULE_IDS)

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


def test_registry_metadata_stays_aligned_with_stage0_module_snapshot():
    root = Path(__file__).resolve().parents[1]
    inventory = json.loads(
        (root / "docs" / "modular-panel-stage0-inventory.json").read_text(encoding="utf-8")
    )
    stage0_modules = {item["id"]: item for item in inventory["modules"]}

    assert set(stage0_modules) == set(MODULE_IDS)
    for definition in MODULE_DEFINITIONS:
        stage0 = stage0_modules[definition.id]
        assert list(definition.dependencies) == stage0["depends_on"]
        assert definition.size_bytes == stage0["size_bytes"]
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

    assert "happ" not in metadata["integration.happ"].name.lower()
    assert "happ" not in metadata["integration.happ"].description.lower()
    assert "update" not in metadata["tool.advanced-diagnostics"].description.lower()


def test_editor_reports_non_disableable_while_an_engine_depends_on_it(tmp_path):
    registry = _registry(tmp_path)
    full = registry.get_registry()
    assert _module(full, "tool.editor")["can_disable"] is False

    registry.set_enabled("engine.xray", False)
    registry.set_enabled("engine.mihomo", False)
    reduced = registry.get_registry()
    assert _module(reduced, "tool.editor")["can_disable"] is True


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
