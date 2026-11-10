"""tool.server-diagnostics: ownership of files, presets and the explicit choice through installs and updates."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import build_modular_panel_release as builder
from services.module_profile_plan import PRESETS as PLAN_PRESETS, _selected_for_release
from services.module_registry import MODULE_IDS, ModuleRegistry, module_set_name
from services.module_transactions import install_state
from services.module_transactions.plan import build_panel_update_plan, build_plan
from tests.support.module_tx import ARCHITECTURE, MODULE_ORDER, make_panel, make_release
from tests.test_installer_profiles import _module as _installer, _source


MODULE_ID = "tool.server-diagnostics"
FULL = tuple(module for module in MODULE_ORDER if module != MODULE_ID)
WITH_MODULE = (*FULL, MODULE_ID)


def owner(path: str) -> str:
    return builder._stage7_module().owner(path)


@pytest.mark.parametrize(
    "path",
    [
        "routes/provider_diagnostics.py",
        "services/provider_diagnostics.py",
        "services/provider_diagnostics_extended.py",
        "static/js/features/provider_diagnostics.js",
        "templates/panel/modals/provider_diagnostics.html",
        "static/server-diagnostics.css",
        "templates/panel/slots/server_diagnostics_xray.html",
        "templates/panel/slots/server_diagnostics_mihomo.html",
        "static/frontend-build/modules/tool.server-diagnostics/provider_diagnostics-abc.js",
    ],
)
def test_module_files_belong_to_module(path):
    assert owner(path) == MODULE_ID


@pytest.mark.parametrize(
    "path,expected",
    [
        ("static/js/features/provider_diagnostics_hint.js", "core"),
        ("static/js/pages/panel.server_diagnostics.bundle.js", "core"),
        ("services/mihomo_rule_provider_inspector.py", "engine.mihomo"),
        ("templates/panel/screens/mihomo.html", "engine.mihomo"),
        ("templates/panel/screens/routing.html", "engine.xray"),
    ],
)
def test_neighbours_keep_their_owner(path, expected):
    assert owner(path) == expected


def test_release_ownership_gives_the_module_its_files_and_keeps_the_hint_in_core():
    ownership = builder.build_module_ownership(Path(__file__).resolve().parents[1])
    module_files = set(ownership[MODULE_ID])
    assert {
        "routes/provider_diagnostics.py",
        "services/provider_diagnostics.py",
        "static/js/features/provider_diagnostics.js",
        "static/server-diagnostics.css",
        "templates/panel/modals/provider_diagnostics.html",
        "templates/panel/slots/server_diagnostics_head.html",
        "templates/panel/slots/server_diagnostics_mihomo.html",
        "templates/panel/slots/server_diagnostics_xray.html",
    } <= module_files
    assert "static/js/features/provider_diagnostics_hint.js" in ownership["core"]
    assert "static/js/pages/panel.server_diagnostics.bundle.js" in ownership["core"]
    # The engine screens keep their owners: only the slots moved.
    assert "templates/panel/screens/routing.html" in ownership["engine.xray"]
    assert "templates/panel/screens/mihomo.html" in ownership["engine.mihomo"]


def test_installer_presets_never_contain_optional_module():
    helper = _installer()
    assert MODULE_ID in helper.MODULE_IDS
    assert tuple(helper.MODULE_IDS) == tuple(MODULE_IDS) == tuple(install_state.MODULE_ORDER)
    for name in ("full", "legacy-full", "xray-minimal", "mihomo-minimal"):
        assert MODULE_ID not in helper.PRESETS[name]
        assert MODULE_ID not in PLAN_PRESETS[name]


def _module_source(tmp_path: Path) -> Path:
    src = _source(tmp_path)
    for name in ("routes/provider_diagnostics.py", "services/provider_diagnostics.py"):
        (src / name).write_text("# server diagnostics", encoding="utf-8")
    return src


def _modules(dest: Path) -> dict:
    return json.loads((dest / "modules.json").read_text(encoding="utf-8"))


def test_plain_full_does_not_install_module(tmp_path):
    helper = _installer()
    dest = tmp_path / "installed"
    helper.commit_profile(helper.apply_profile(_module_source(tmp_path), dest, "full"))
    assert not (dest / "routes/provider_diagnostics.py").exists()
    assert _modules(dest)["modules"][MODULE_ID]["enabled"] is False


def test_full_with_optional_installs_module_and_marks_choice(tmp_path):
    helper = _installer()
    dest = tmp_path / "installed"
    helper.commit_profile(helper.apply_profile(_module_source(tmp_path), dest, "full", with_optional=[MODULE_ID]))
    state = _modules(dest)
    assert state["profile"] == "full"
    assert state["modules"][MODULE_ID] == {"enabled": True, "chosen": True}
    assert (dest / "routes/provider_diagnostics.py").is_file()
    assert helper.current_install(dest)["profile"] == "full"
    assert MODULE_ID in helper.current_install(dest)["module_ids"]


def test_with_optional_is_refused_for_other_profiles(tmp_path):
    helper = _installer()
    with pytest.raises(helper.ProfileInstallError):
        helper.apply_profile(_module_source(tmp_path), tmp_path / "installed", "xray-minimal", with_optional=[MODULE_ID])


def test_custom_with_module_marks_choice(tmp_path):
    helper = _installer()
    dest = tmp_path / "installed"
    helper.commit_profile(
        helper.apply_profile(
            _module_source(tmp_path), dest, "custom", module_ids=["core", "engine.xray", "tool.editor", MODULE_ID]
        )
    )
    assert _modules(dest)["modules"][MODULE_ID] == {"enabled": True, "chosen": True}


def test_reinstall_over_full_keeps_chosen_module(tmp_path):
    helper = _installer()
    src = _module_source(tmp_path)
    dest = tmp_path / "installed"
    helper.commit_profile(helper.apply_profile(src, dest, "full", with_optional=[MODULE_ID]))
    helper.commit_profile(helper.apply_profile(src, dest, "full", keep_switches=True))
    assert _modules(dest)["modules"][MODULE_ID] == {"enabled": True, "chosen": True}
    assert (dest / "routes/provider_diagnostics.py").is_file()


def test_release_full_skips_optional_module_not_installed():
    assert MODULE_ID not in _selected_for_release("full", None, WITH_MODULE, {})
    assert MODULE_ID not in _selected_for_release("legacy-full", None, WITH_MODULE, {})


def _full_panel(tmp_path: Path, installed, *, chosen: bool):
    panel = make_panel(tmp_path, installed=installed, profile="full", editor_variant="full")
    if MODULE_ID in installed and chosen:
        state = panel.read_json("modules.json")
        state["modules"][MODULE_ID]["chosen"] = True
        panel.path("modules.json").write_text(json.dumps(state), encoding="utf-8")
    return panel


def _update_plan(tmp_path: Path, panel):
    from tests.test_physical_profile_request import _listing

    release = make_release(version="2.11.0")
    return build_panel_update_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_archive=_listing(tmp_path, release),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )


def test_panel_update_of_full_does_not_add_module(tmp_path):
    plan = _update_plan(tmp_path, _full_panel(tmp_path, FULL, chosen=False))
    assert MODULE_ID not in plan.installed_after


def test_panel_update_keeps_installed_optional_module(tmp_path):
    plan = _update_plan(tmp_path, _full_panel(tmp_path, WITH_MODULE, chosen=True))
    assert MODULE_ID in plan.installed_after


def test_applying_full_again_keeps_the_chosen_module_on_disk(tmp_path):
    from services.module_transactions.plan import build_profile_transition_plan
    from tests.test_physical_profile_request import _listing

    panel = _full_panel(tmp_path, WITH_MODULE, chosen=True)
    ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool").set_profile("full")
    release = make_release()
    plan = build_profile_transition_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_archive=_listing(tmp_path, release),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )
    assert MODULE_ID in plan.installed_after
    assert not {"routes/provider_diagnostics.py", "services/provider_diagnostics.py"} & set(plan.files_remove)
    updates = install_state.state_file_updates(panel.root, plan)
    assert json.loads(updates["modules.json"])["profile"] == "full"
    assert json.loads(updates["install-profile.json"])["profile"] == "full"


def test_manager_install_of_optional_module_marks_choice_and_keeps_full_name(tmp_path):
    panel = _full_panel(tmp_path, FULL, chosen=False)
    plan = build_plan("install", MODULE_ID, **panel.kwargs)
    updates = install_state.state_file_updates(panel.root, plan)
    state = json.loads(updates["modules.json"])
    assert state["modules"][MODULE_ID]["chosen"] is True
    assert state["profile"] == "full"
    assert json.loads(updates["install-profile.json"])["profile"] == "full"
    enabled = [module for module, item in state["modules"].items() if item.get("enabled")]
    assert module_set_name(enabled) == "full"


def test_only_full_keeps_its_name_with_the_optional_module():
    helper = _installer()
    record = lambda profile, modules: helper._physical_profile(  # noqa: E731
        {"profile": profile, "module_ids": modules, "editor_variant": "light"}, "installed"
    )
    minimal = ["core", "engine.mihomo", "tool.editor"]
    # A minimal preset with the module is no preset: its update must keep the module.
    assert record("mihomo-minimal", [*minimal, MODULE_ID])["profile"] == "custom"
    assert record("mihomo-minimal", minimal)["profile"] == "mihomo-minimal"
    assert record("full", [*FULL, MODULE_ID])["profile"] == "full"


def test_panel_update_of_full_with_module_keeps_the_full_name_on_disk(tmp_path):
    panel = _full_panel(tmp_path, WITH_MODULE, chosen=True)
    plan = _update_plan(tmp_path, panel)
    updates = install_state.state_file_updates(panel.root, plan)
    assert json.loads(updates["install-profile.json"])["profile"] == "full"
    assert json.loads(updates["modules.json"])["profile"] == "full"


def test_registry_reads_installer_choice(tmp_path):
    helper = _installer()
    dest = tmp_path / "installed"
    helper.commit_profile(helper.apply_profile(_module_source(tmp_path), dest, "full", with_optional=[MODULE_ID]))
    registry = ModuleRegistry(str(dest), which=lambda name: f"/usr/bin/{name}", environ={"ComSpec": "cmd.exe"})
    registry.initialize_for_startup()
    assert _modules(dest)["modules"][MODULE_ID]["enabled"] is True
