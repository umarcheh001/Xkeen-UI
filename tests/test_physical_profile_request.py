"""«Включён» и «установлен» — разные вещи.

Переключатель модуля решает только, работает ли модуль. Какие файлы лежат на
накопителе, меняют явные действия: запрос профиля с переходом, установка и
удаление модуля. Обновление панели сохраняет установленное — выключенный
модуль обновляется вместе со всеми и остаётся выключенным.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.module_lifecycle import ModuleLifecycleError
from services.module_registry import ModuleRegistry
from services.module_transactions.executor import run_operation
from services.module_transactions.journal import Journal
from services.module_transactions.plan import (
    build_panel_update_plan,
    build_plan,
    build_profile_transition_plan,
    installed_panel_listing,
)
from services.module_transactions.state import ModuleTransactionError
from services.panel_package_contract import validate_panel_archive
from tests.support.module_lifecycle import LaunchRecorder, make_service
from tests.support.module_tx import (
    ARCHITECTURE,
    MODULE_ORDER,
    OWNERSHIP,
    file_bytes,
    make_panel,
    make_release,
)


FULL = tuple(MODULE_ORDER)
TERMINAL = set(OWNERSHIP["tool.terminal"])
WITHOUT_TERMINAL = [module for module in FULL if module != "tool.terminal"]


def _registry(panel) -> ModuleRegistry:
    return ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")


def _state(panel) -> dict:
    return panel.read_json("modules.json")


def _listing(tmp_path: Path, release) -> dict:
    archive = tmp_path / "checked" / "panel.tar.gz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(release.panel)
    return validate_panel_archive(archive, release.catalog["panel"], platform_architecture=ARCHITECTURE)


def _run(panel, plan, client) -> str:
    journal = Journal.create(panel.root, plan, "physical-request-operation", extra={})
    return run_operation(
        journal,
        state_dir=panel.state,
        client=client,
        architecture=ARCHITECTURE,
        restart=lambda: None,
        wait_healthy=lambda _phase: True,
    )


# --- реестр: кто создаёт запрос физического профиля ------------------------------


def test_profile_request_is_recorded_and_survives_a_reload(tmp_path):
    panel = make_panel(tmp_path)

    payload, _changed = _registry(panel).set_profile("mihomo-minimal")

    expected = {
        "profile": "mihomo-minimal",
        "module_ids": ["core", "engine.mihomo", "tool.editor"],
        "editor_variant": "light",
    }
    assert payload["physical_request"] == expected
    assert _state(panel)["physical_request"] == expected
    assert _registry(panel).get_registry()["physical_request"] == expected


def test_custom_profile_request_keeps_the_chosen_modules(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)

    _registry(panel).set_profile("custom", module_ids=WITHOUT_TERMINAL, editor_variant="full")

    request = _state(panel)["physical_request"]
    assert request["profile"] == "custom"
    assert request["module_ids"] == WITHOUT_TERMINAL
    assert request["editor_variant"] == "full"


def test_a_toggle_asks_for_nothing_physical(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    registry = _registry(panel)

    payload, changed = registry.set_enabled("tool.terminal", False)

    assert changed is True
    assert "physical_request" not in _state(panel)
    assert registry.get_registry()["physical_request"] is None
    assert payload["module"]["enabled"] is False


def test_a_toggle_leaves_a_pending_request_as_it_was(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    registry = _registry(panel)
    registry.set_profile("xray-minimal")
    before = _state(panel)["physical_request"]

    registry.set_enabled("tool.editor", True)
    registry.set_enabled("engine.xray", False)

    assert _state(panel)["physical_request"] == before


def test_a_richer_editor_over_a_light_install_is_a_physical_request(tmp_path):
    panel = make_panel(tmp_path)  # установлен лёгкий редактор

    _registry(panel).set_editor_variant("full")

    assert _state(panel)["physical_request"] == {
        "profile": "xray-minimal",
        "module_ids": ["core", "engine.xray", "tool.editor"],
        "editor_variant": "full",
    }


@pytest.mark.parametrize(("installed", "wanted"), [("full", "advanced"), ("full", "light"), ("advanced", "full")])
def test_other_editor_changes_are_settings_only(tmp_path, installed, wanted):
    panel = make_panel(tmp_path)
    profile = panel.read_json("install-profile.json")
    profile["editor_variant"] = installed
    panel.path("install-profile.json").write_text(json.dumps(profile), encoding="utf-8")

    _registry(panel).set_editor_variant(wanted)

    assert _state(panel)["editor"] == {"variant": wanted}
    assert "physical_request" not in _state(panel)


def test_editor_change_updates_a_pending_request(tmp_path):
    panel = make_panel(tmp_path)
    registry = _registry(panel)
    registry.set_profile("mihomo-minimal")

    registry.set_editor_variant("advanced")

    assert _state(panel)["physical_request"]["editor_variant"] == "advanced"
    assert _state(panel)["physical_request"]["profile"] == "mihomo-minimal"


@pytest.mark.parametrize(
    "broken",
    [
        "full",
        {"profile": "full"},
        {"profile": "nonsense", "module_ids": ["core"], "editor_variant": "light"},
        {"profile": "custom", "module_ids": ["tool.files"], "editor_variant": "light"},
        {"profile": "custom", "module_ids": ["core", "unknown"], "editor_variant": "light"},
        {"profile": "custom", "module_ids": ["core"], "editor_variant": "huge"},
    ],
)
def test_a_malformed_request_in_the_state_file_is_dropped(tmp_path, broken):
    panel = make_panel(tmp_path)
    state = _state(panel)
    state["physical_request"] = broken
    panel.path("modules.json").write_text(json.dumps(state), encoding="utf-8")

    assert _registry(panel).get_registry()["physical_request"] is None


# --- сервис: что блокирует, а что нет ----------------------------------------------


def test_a_disabled_module_blocks_nothing(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0", installed=FULL)
    registry = _registry(panel)
    registry.set_enabled("tool.terminal", False)
    restarts: list[str] = []
    service, _ = make_service(
        panel,
        make_release(version="2.11.0"),
        registry=registry,
        restart_panel=lambda source: restarts.append(source) or True,
        ensure_restartable_operation=lambda _root, _state: None,
    )

    status = service.profile_transition_status()
    check = service.panel_update_check()
    update = service.plan("panel-update", None)
    service.restart()

    assert status == {"transition_required": False, "transition_target": None}
    assert check["update_available"] is True
    assert update["applicable"] is True
    assert restarts == ["module-lifecycle"]


def test_a_disabled_module_can_still_be_repaired_or_removed(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    registry = _registry(panel)
    registry.set_enabled("tool.terminal", False)
    service, _ = make_service(panel, make_release(), registry=registry)

    assert service.plan("repair", "tool.terminal")["applicable"] is True
    removal = service.plan("remove", "tool.terminal")
    assert removal["applicable"] is True
    assert set(removal["files_remove"]) == TERMINAL


def test_an_unapplied_profile_request_is_what_blocks(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    registry = _registry(panel)
    registry.set_profile("xray-minimal")
    service, _ = make_service(panel, make_release(), registry=registry)

    status = service.profile_transition_status()

    assert status["transition_required"] is True
    assert status["transition_target"]["profile"] == "xray-minimal"
    for refused in (service.restart, service.panel_update_check, lambda: service.plan("repair", "tool.files")):
        with pytest.raises(ModuleLifecycleError) as raised:
            refused()
        assert raised.value.code == "profile_transition_required"


def test_a_request_for_what_is_already_installed_blocks_nothing(tmp_path):
    panel = make_panel(tmp_path)
    registry = _registry(panel)
    registry.set_profile("xray-minimal")
    service, _ = make_service(panel, make_release(), registry=registry)

    assert service.profile_transition_status()["transition_required"] is False
    assert service.plan("repair", "engine.xray")["applicable"] is True


def test_transition_without_a_request_is_not_required(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    registry = _registry(panel)
    registry.set_enabled("tool.terminal", False)
    service, _ = make_service(panel, make_release(), registry=registry)

    payload = service.plan("profile-transition", None)

    assert payload["applicable"] is False
    assert payload["blockers"][0]["code"] == "profile_transition_not_required"


# --- обновление панели сохраняет установленное -------------------------------------


def test_panel_update_keeps_a_disabled_module_installed_and_disabled(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0", installed=FULL)
    _registry(panel).set_enabled("tool.terminal", False)
    labels_before = (_state(panel)["profile"], _state(panel)["editor"])
    release = make_release(version="2.11.0")

    plan = build_panel_update_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_archive=_listing(tmp_path, release),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )

    assert TERMINAL <= set(plan.files_add)
    assert plan.files_remove == ()
    assert "tool.terminal" in plan.installed_after

    assert _run(panel, plan, release.client(panel.state)) == "committed"

    # Выключенный модуль обновился вместе со всеми: смеси версий на диске нет.
    assert all(panel.path(path).read_bytes() == file_bytes(path, "2.11.0") for path in TERMINAL)
    assert panel.read_json("module-installed.json")["modules"]["tool.terminal"] is True
    assert "tool.terminal" in panel.read_json("install-profile.json")["module_ids"]
    state = _state(panel)
    assert state["modules"]["tool.terminal"]["enabled"] is False
    assert state["modules"]["tool.files"]["enabled"] is True
    assert (state["profile"], state["editor"]) == labels_before


def test_panel_update_keeps_the_installed_editor_not_the_requested_setting(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0")
    state = _state(panel)
    state["editor"] = {"variant": "advanced"}  # настройка без физического запроса
    panel.path("modules.json").write_text(json.dumps(state), encoding="utf-8")
    release = make_release(version="2.11.0")

    plan = build_panel_update_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_archive=_listing(tmp_path, release),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )

    assert plan.target_profile["editor_variant"] == "light"
    assert plan.target_profile["profile"] == "xray-minimal"


def test_panel_update_of_a_set_that_is_no_preset_keeps_exactly_that_set(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    release = make_release(version="2.11.0")

    plan = build_panel_update_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_archive=_listing(tmp_path, release),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )

    # Запись об установке называет набор «xray-minimal», но лежит другое:
    # обновление не подменяет установленное пресетом.
    assert plan.target_profile == {
        "profile": "custom",
        "module_ids": ["core", "tool.files"],
        "editor_variant": "light",
    }
    assert plan.installed_after == ("core", "tool.files")


# --- переход профиля исполняет запрос, а не переключатели ---------------------------


def _transition(panel, release, listing):
    return build_profile_transition_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_archive=listing,
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )


def test_transition_ignores_toggles_without_a_request(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    _registry(panel).set_enabled("tool.terminal", False)

    with pytest.raises(ModuleTransactionError) as raised:
        _transition(panel, make_release(), installed_panel_listing(panel.root))

    assert raised.value.code == "profile_transition_not_required"


def test_transition_applies_the_request_and_forgets_it(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    registry = _registry(panel)
    registry.set_profile("custom", module_ids=WITHOUT_TERMINAL, editor_variant="light")
    registry.set_enabled("tool.files", False)  # выключен уже после запроса
    release = make_release()
    plan = _transition(panel, release, installed_panel_listing(panel.root))

    assert set(plan.files_remove) == TERMINAL
    assert _run(panel, plan, release.client(panel.state)) == "committed"

    state = _state(panel)
    assert "physical_request" not in state
    assert state["modules"]["tool.terminal"]["enabled"] is False
    # Оставшийся модуль сохраняет своё положение переключателя.
    assert state["modules"]["tool.files"]["enabled"] is False
    assert state["modules"]["tool.backups"]["enabled"] is True
    assert panel.read_json("module-installed.json")["modules"]["tool.files"] is True
    service, _ = make_service(panel, release, registry=_registry(panel))
    assert service.profile_transition_status()["transition_required"] is False


def test_a_module_operation_supersedes_a_stale_request(tmp_path):
    panel = make_panel(tmp_path)
    _registry(panel).set_profile("xray-minimal")  # совпадает с установленным
    assert "physical_request" in _state(panel)
    release = make_release()
    plan = build_plan("install", "tool.terminal", **{**panel.kwargs, "catalog": release.catalog})

    assert _run(panel, plan, release.client(panel.state)) == "committed"

    assert "physical_request" not in _state(panel)
    service, _ = make_service(panel, release, registry=_registry(panel))
    assert service.profile_transition_status()["transition_required"] is False


def test_apply_of_a_full_install_request_launches_the_transition(tmp_path):
    panel = make_panel(tmp_path)
    registry = _registry(panel)
    registry.set_profile("full")
    launcher = LaunchRecorder()
    service, _ = make_service(panel, make_release(), registry=registry, launch_operation=launcher)

    reviewed = service.plan("profile-transition", None)
    service.apply("profile-transition", None, reviewed["plan_id"])

    assert reviewed["target_profile"]["profile"] == "full"
    assert launcher.plans[-1].installed_after == tuple(MODULE_ORDER)
