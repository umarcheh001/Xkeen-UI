"""tool.server-diagnostics: registry entry, optional profile module, explicit choice mark."""

from __future__ import annotations

import json
from pathlib import Path

from services.module_registry import (
    BLUEPRINT_OWNERS,
    MODULE_DEFINITIONS,
    MODULE_IDS,
    OPTIONAL_PROFILE_MODULES,
    PROFILE_PRESETS,
    _MODULE_INSTALL_MARKERS,
    ModuleRegistry,
    module_set_name,
)


MODULE_ID = "tool.server-diagnostics"
FULL = [module_id for module_id in MODULE_IDS if module_id != MODULE_ID]


def _registry(tmp_path: Path, modules: dict | None, *, profile: str = "full", installed: bool = True) -> ModuleRegistry:
    if modules is not None:
        state_modules = {module_id: {"enabled": True} for module_id in FULL}
        state_modules.update(modules)
        (tmp_path / "modules.json").write_text(
            json.dumps({"schema_version": 1, "profile": profile, "restart_required": False,
                        "editor": {"variant": "full"}, "modules": state_modules}),
            encoding="utf-8",
        )
    installed_modules = {module_id: True for module_id in FULL}
    installed_modules[MODULE_ID] = installed
    (tmp_path / "module-installed.json").write_text(
        json.dumps({"schema_version": 1, "modules": installed_modules}), encoding="utf-8"
    )
    return ModuleRegistry(str(tmp_path), which=lambda name: f"/usr/bin/{name}", environ={"ComSpec": "cmd.exe"})


def _state_item(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "modules.json").read_text(encoding="utf-8"))["modules"][MODULE_ID]


def test_module_is_registered_with_owner_text():
    definition = next(item for item in MODULE_DEFINITIONS if item.id == MODULE_ID)
    assert definition.name == "Диагностика серверов"
    assert definition.description == (
        "Проверка доступности серверов из конфигураций Xray и Mihomo. Нужен модуль Xray или Mihomo. "
        "Часть проверок отправляет адреса серверов во внешние сервисы (dns.google, cheburcheck.ru)."
    )
    assert definition.dependencies == ("core",)
    assert definition.removable and definition.can_disable
    assert definition.frontend_bundles == ("server-diagnostics-panel",)
    assert BLUEPRINT_OWNERS["provider_diagnostics"] == MODULE_ID
    assert _MODULE_INSTALL_MARKERS[MODULE_ID] == (
        "xkeen-ui/routes/provider_diagnostics.py",
        "xkeen-ui/services/provider_diagnostics.py",
    )
    assert OPTIONAL_PROFILE_MODULES == frozenset({MODULE_ID})


def test_presets_never_contain_optional_module():
    for name in ("full", "legacy-full", "xray-minimal", "mihomo-minimal"):
        assert MODULE_ID not in PROFILE_PRESETS[name]
    assert list(PROFILE_PRESETS["full"]) == FULL


def test_full_with_optional_module_is_still_full():
    assert module_set_name([*PROFILE_PRESETS["full"], MODULE_ID]) == "full"
    assert module_set_name(PROFILE_PRESETS["full"]) == "full"


def test_startup_switches_off_unchosen_module(tmp_path):
    registry = _registry(tmp_path, {MODULE_ID: {"enabled": True}})
    registry.initialize_for_startup()
    item = _state_item(tmp_path)
    assert item["enabled"] is False
    assert item["off_reason"] == "not_chosen"
    assert MODULE_ID not in registry.runtime_activation()["active_module_ids"]


def test_startup_switches_off_module_missing_from_old_state(tmp_path):
    registry = _registry(tmp_path, {})
    registry.initialize_for_startup()
    assert _state_item(tmp_path)["enabled"] is False
    assert MODULE_ID not in registry.runtime_activation()["active_module_ids"]


def test_missing_state_does_not_enable_optional_module(tmp_path):
    registry = _registry(tmp_path, None)
    registry.initialize_for_startup()
    assert _state_item(tmp_path)["enabled"] is False


def test_startup_keeps_chosen_module(tmp_path):
    registry = _registry(tmp_path, {MODULE_ID: {"enabled": True, "chosen": True}})
    registry.initialize_for_startup()
    assert _state_item(tmp_path) == {"enabled": True, "chosen": True}
    assert MODULE_ID in registry.runtime_activation()["active_module_ids"]


def test_enabling_marks_choice(tmp_path):
    registry = _registry(tmp_path, {MODULE_ID: {"enabled": False, "off_reason": "not_chosen"}})
    registry.initialize_for_startup()
    registry.set_enabled(MODULE_ID, True)
    item = _state_item(tmp_path)
    assert item["enabled"] is True and item["chosen"] is True
    assert "off_reason" not in item


def test_not_chosen_reason_is_reported(tmp_path):
    registry = _registry(tmp_path, {MODULE_ID: {"enabled": True}})
    registry.initialize_for_startup()
    item = next(module for module in registry.get_registry()["modules"] if module["id"] == MODULE_ID)
    assert item["off_reason"] == "not_chosen"


def test_apply_full_keeps_chosen_optional_module(tmp_path):
    registry = _registry(tmp_path, {MODULE_ID: {"enabled": True, "chosen": True}}, profile="custom")
    registry.set_profile("full")
    assert _state_item(tmp_path)["enabled"] is True


def test_apply_full_does_not_add_unchosen_optional_module(tmp_path):
    registry = _registry(tmp_path, {MODULE_ID: {"enabled": False}}, profile="custom")
    registry.set_profile("full")
    assert _state_item(tmp_path)["enabled"] is False


def test_apply_custom_with_module_marks_choice(tmp_path):
    registry = _registry(tmp_path, {})
    registry.set_profile("custom", module_ids=["core", "engine.xray", "tool.editor", MODULE_ID])
    item = _state_item(tmp_path)
    assert item["enabled"] is True and item["chosen"] is True


def test_safe_mode_does_not_activate_optional_module(tmp_path):
    _registry(tmp_path, {MODULE_ID: {"enabled": True, "chosen": True}})
    registry = ModuleRegistry(
        str(tmp_path), which=lambda name: f"/usr/bin/{name}",
        environ={"ComSpec": "cmd.exe", "XKEEN_UI_MODULE_SAFE_MODE": "legacy-full"},
    )
    assert MODULE_ID not in registry.runtime_activation()["active_module_ids"]
