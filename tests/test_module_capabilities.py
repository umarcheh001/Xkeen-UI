from __future__ import annotations

from pathlib import Path

from flask import Flask

from routes.capabilities import create_capabilities_blueprint
from services.capabilities import detect_capabilities, extend_capabilities_with_modules
from services.module_registry import MODULE_DEFINITIONS, MODULE_IDS, ModuleRegistry


def _available_which(name: str) -> str:
    return f"/usr/bin/{name}"


def _registry(tmp_path: Path, *, available: bool = True) -> ModuleRegistry:
    return ModuleRegistry(
        str(tmp_path),
        which=_available_which if available else lambda _name: None,
        environ={"ComSpec": "cmd.exe"} if available else {},
    )


def test_module_capabilities_preserve_legacy_payload_and_add_registry_projection(tmp_path):
    legacy = detect_capabilities({}, which=lambda _name: None)
    registry = _registry(tmp_path)

    payload = extend_capabilities_with_modules(legacy, registry)

    for key in ("websocket", "terminal", "runtime", "files", "remoteFs", "storageUsb"):
        assert payload[key] == legacy[key]

    meta = payload["moduleRegistry"]
    assert meta["available"] is True
    assert meta["runtime_gates_active"] is False
    assert meta["configured_module_ids"] == list(MODULE_IDS)
    assert meta["effective_module_ids"] == list(MODULE_IDS)

    modules = payload["modules"]
    assert list(modules) == list(MODULE_IDS)
    mihomo = modules["engine.mihomo"]
    assert mihomo["installed"] is True
    assert mihomo["enabled"] is True
    assert mihomo["available"] is True
    assert mihomo["effective_available"] is True
    assert mihomo["status"] == "enabled"
    assert mihomo["reason"] is None
    assert mihomo["frontend"] == {
        "bundles": ["panel-mihomo", "mihomo-generator-page"],
        "navigation_views": ["mihomo"],
    }
    assert modules["tool.files"]["frontend"]["bundles"] == ["file-manager-lazy"]
    assert modules["tool.terminal"]["frontend"]["navigation_views"] == ["commands"]


def test_module_capabilities_distinguish_disabled_from_environment_unavailable(tmp_path):
    registry = _registry(tmp_path)
    registry.set_enabled("integration.happ", False)

    payload = extend_capabilities_with_modules(
        detect_capabilities({}, which=lambda _name: None),
        registry,
    )
    happ = payload["modules"]["integration.happ"]

    assert happ["installed"] is True
    assert happ["enabled"] is False
    assert happ["available"] is True
    assert happ["effective_available"] is False
    assert happ["status"] == "disabled"
    assert happ["reason"] == "user_disabled"

    unavailable_registry = _registry(tmp_path / "unavailable", available=False)
    unavailable = extend_capabilities_with_modules(
        detect_capabilities({}, which=lambda _name: None),
        unavailable_registry,
    )
    xray = unavailable["modules"]["engine.xray"]
    happ_dependency = unavailable["modules"]["integration.happ"]

    assert xray["enabled"] is True
    assert xray["available"] is False
    assert xray["effective_available"] is False
    assert xray["reason"] == "system_requirements_unmet"
    assert set(xray["missing_requirement_ids"]) == {"xkeen", "xray"}
    assert happ_dependency["available"] is True
    assert happ_dependency["effective_available"] is False
    assert happ_dependency["reason"] == "dependency_unavailable"


def test_module_capabilities_keep_legacy_result_when_registry_state_is_unavailable():
    class BrokenRegistry:
        def get_registry(self):
            raise OSError("state is unavailable")

    legacy = detect_capabilities({}, which=lambda _name: None)
    payload = extend_capabilities_with_modules(legacy, BrokenRegistry())

    for key in ("websocket", "terminal", "runtime", "files", "remoteFs", "storageUsb"):
        assert payload[key] == legacy[key]
    assert payload["modules"] == {}
    assert payload["moduleRegistry"] == {
        "schema_version": 1,
        "api_version": None,
        "registry_version": None,
        "profile": None,
        "restart_required": False,
        "runtime_gates_active": False,
        "available": False,
        "reason": "module_registry_unavailable",
        "configured_module_ids": [],
        "effective_module_ids": [],
    }


def test_capabilities_route_exposes_module_contract(tmp_path):
    registry = _registry(tmp_path)
    app = Flask("module-capabilities")
    app.config["TESTING"] = True
    app.register_blueprint(create_capabilities_blueprint(registry))

    response = app.test_client().get("/api/capabilities")
    payload = response.get_json()

    assert response.status_code == 200
    assert {"websocket", "terminal", "runtime", "files", "remoteFs", "storageUsb"} <= set(payload)
    assert set(payload["modules"]) == set(MODULE_IDS)
    assert payload["moduleRegistry"]["available"] is True
    assert payload["moduleRegistry"]["runtime_gates_active"] is False


def test_frontend_bundle_mapping_stays_aligned_with_stage0_inventory():
    root = Path(__file__).resolve().parents[1]
    inventory = __import__("json").loads(
        (root / "docs" / "modular-panel-stage0-inventory.json").read_text(encoding="utf-8")
    )
    bundles = {item["id"]: item for item in inventory["frontend_bundles"]}

    for definition in MODULE_DEFINITIONS:
        for bundle_id in definition.frontend_bundles:
            assert bundle_id in bundles
            assert definition.id in bundles[bundle_id]["module_ids"]


def test_stage2_closure_is_reflected_in_documentation():
    root = Path(__file__).resolve().parents[1]
    plan = (root / "README-modular-panel-plan.md").read_text(encoding="utf-8")
    contract = (root / "docs" / "modular-panel-stage2-capabilities.md").read_text(
        encoding="utf-8"
    )
    docs_index = (root / "docs" / "README.md").read_text(encoding="utf-8")

    for fragment in (
        "## Этап 2. Расширение capabilities — закрыт",
        "Статус этапа: **закрыт 29 сентября 2026 года**.",
        "Критерий готовности: **выполнен**.",
        "docs/modular-panel-stage2-capabilities.md",
    ):
        assert fragment in plan

    for fragment in (
        "Статус:** закрыт 29 сентября 2026 года",
        "moduleRegistry",
        "runtime_gates_active: false",
        "Критерий готовности Этапа 2: **выполнен**.",
        "Этап 3 — Backend gates",
    ):
        assert fragment in contract

    assert "modular-panel-stage2-capabilities.md" in docs_index
