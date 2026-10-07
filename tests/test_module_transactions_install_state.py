from __future__ import annotations

import importlib.util
import json
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from services.module_transactions import install_state
from services.module_transactions.install_state import rebuild_frontend_manifests, state_file_updates
from services.module_transactions.plan import build_plan, load_ownership_map
from tests.support.module_tx import FRONTEND, OWNERSHIP, file_bytes, make_panel


ROOT = Path(__file__).resolve().parents[1]
BRIDGE = "static/frontend-build/.vite/manifest.json"
BUILD = "static/frontend-build/.vite/manifest.build.json"


def _installer():
    spec = importlib.util.spec_from_file_location(
        "module_profile_install", ROOT / "xkeen-ui" / "scripts" / "module_profile_install.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _json(payload: bytes):
    return json.loads(payload.decode("utf-8"))


def test_manifests_of_an_untouched_panel_are_rebuilt_unchanged(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    frontend = load_ownership_map(panel.root).frontend

    rebuilt = rebuild_frontend_manifests(panel.root, frontend)

    assert set(rebuilt) == {BRIDGE, BUILD}
    assert rebuilt[BRIDGE] == panel.path(BRIDGE).read_bytes()
    assert rebuilt[BUILD] == panel.path(BUILD).read_bytes()
    assert list(_json(rebuilt[BRIDGE])) == ["static/js/pages/panel.entry.js"]
    # The entry of the absent page is gone together with links to it.
    assert _json(rebuilt[BUILD])["static/js/pages/panel.entry.js"]["dynamicImports"] == []


def test_manifest_gains_bridge_entry_when_its_file_appears(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    frontend = load_ownership_map(panel.root).frontend
    bridge_file = panel.path("static/frontend-build/assets/backups-bridge.js")
    bridge_file.write_bytes(b"bridge")

    rebuilt = rebuild_frontend_manifests(panel.root, frontend)

    assert _json(rebuilt[BRIDGE]) == FRONTEND["bridge"]
    assert _json(rebuilt[BUILD]) == FRONTEND["build"]


def test_manifest_loses_the_entry_when_its_file_is_gone(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.backups"))
    frontend = load_ownership_map(panel.root).frontend
    assert "static/js/pages/backups.entry.js" in panel.read_json(BRIDGE)
    panel.path("static/frontend-build/assets/backups-bridge.js").unlink()

    rebuilt = rebuild_frontend_manifests(panel.root, frontend)

    assert list(_json(rebuilt[BRIDGE])) == ["static/js/pages/panel.entry.js"]
    assert "static/js/pages/backups.entry.js" not in _json(rebuilt[BUILD])


def test_panel_built_without_a_frontend_keeps_its_manifests(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)

    assert rebuild_frontend_manifests(panel.root, {"bridge": {}, "build": {}}) == {}


def test_state_files_after_install(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    plan = build_plan("install", "tool.terminal", **panel.kwargs)

    updates = state_file_updates(panel.root, plan)

    assert set(updates) == {"modules.json", "module-installed.json", "install-profile.json", "install-managed.json"}
    modules = _json(updates["modules.json"])
    assert modules["profile"] == "custom"
    assert modules["modules"]["tool.terminal"] == {"enabled": True}
    assert modules["modules"]["engine.mihomo"] == {"enabled": False}
    assert modules["editor"] == {"variant": "light"}
    installed = _json(updates["module-installed.json"])["modules"]
    assert installed["tool.terminal"] is True and installed["engine.mihomo"] is False
    profile = _json(updates["install-profile.json"])
    assert profile["profile"] == "custom"
    assert profile["module_ids"] == ["core", "engine.xray", "tool.editor", "tool.terminal"]
    assert profile["editor_variant"] == "light"
    managed = _json(updates["install-managed.json"])["paths"]
    assert managed == sorted(managed)
    assert set(OWNERSHIP["tool.terminal"]) <= set(managed)
    assert set(OWNERSHIP["engine.xray"]) <= set(managed)


def test_state_files_after_remove(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    plan = build_plan("remove", "tool.terminal", **panel.kwargs)

    updates = state_file_updates(panel.root, plan)

    modules = _json(updates["modules.json"])
    assert modules["profile"] == "custom"
    assert modules["modules"]["tool.terminal"] == {"enabled": False}
    assert modules["modules"]["engine.xray"] == {"enabled": True}
    assert _json(updates["module-installed.json"])["modules"]["tool.terminal"] is False
    assert _json(updates["install-profile.json"])["module_ids"] == ["core", "engine.xray", "tool.editor"]
    managed = set(_json(updates["install-managed.json"])["paths"])
    assert not managed & set(OWNERSHIP["tool.terminal"])
    assert set(OWNERSHIP["engine.xray"]) <= managed


def test_repair_changes_no_state(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    plan = build_plan("repair", "engine.xray", **panel.kwargs)

    assert state_file_updates(panel.root, plan) == {}


def test_full_scope_state_files_describe_the_target_profile(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "engine.mihomo"))
    module_plan = build_plan("repair", "engine.xray", **panel.kwargs)
    plan = replace(
        module_plan,
        scope="profile",
        operation="profile-transition",
        module_id=None,
        target_profile={
            "profile": "mihomo-minimal",
            "module_ids": ["core", "engine.mihomo", "tool.editor"],
            "editor_variant": "light",
        },
        files_add=tuple(sorted(set(OWNERSHIP["core"]) | set(OWNERSHIP["engine.mihomo"]) | set(OWNERSHIP["tool.editor"]))),
        installed_after=("core", "engine.mihomo", "tool.editor"),
    )

    updates = state_file_updates(panel.root, plan)

    assert _json(updates["modules.json"])["profile"] == "mihomo-minimal"
    assert _json(updates["module-installed.json"])["modules"]["engine.xray"] is False
    assert _json(updates["module-installed.json"])["modules"]["engine.mihomo"] is True
    assert _json(updates["install-profile.json"])["module_ids"] == ["core", "engine.mihomo", "tool.editor"]
    assert _json(updates["install-managed.json"])["paths"] == list(plan.files_add)


def test_state_only_profile_transition_preserves_managed_paths(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    module_plan = build_plan("repair", "engine.xray", **panel.kwargs)
    plan = replace(
        module_plan,
        scope="profile",
        operation="profile-transition",
        module_id=None,
        target_profile={
            "profile": "custom",
            "module_ids": ["core", "engine.xray", "tool.editor"],
            "editor_variant": "light",
        },
        files_add=(),
        files_remove=(),
    )

    updates = state_file_updates(panel.root, plan)

    assert _json(updates["install-managed.json"])["paths"] == panel.read_json("install-managed.json")["paths"]


def test_install_keeps_fields_the_engine_does_not_know(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    modules = panel.read_json("modules.json")
    modules["modules"]["engine.xray"]["last_error"] = "boom"
    modules["future_field"] = {"a": 1}
    panel.path("modules.json").write_text(json.dumps(modules), encoding="utf-8")
    plan = build_plan("install", "tool.terminal", **panel.kwargs)

    updated = _json(state_file_updates(panel.root, plan)["modules.json"])

    assert updated["future_field"] == {"a": 1}
    assert updated["modules"]["engine.xray"] == {"enabled": True, "last_error": "boom"}


def test_missing_or_broken_state_files_are_not_invented(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    plan = build_plan("install", "tool.terminal", **panel.kwargs)
    panel.path("modules.json").unlink()
    panel.path("install-managed.json").write_text("{broken", encoding="utf-8")
    panel.path("install-profile.json").unlink()

    updates = state_file_updates(panel.root, plan)

    # Without modules.json the registry runs every installed module, which is
    # what an install wants; a list of managed files cannot be guessed.
    assert "modules.json" not in updates
    assert "install-managed.json" not in updates
    assert _json(updates["module-installed.json"])["modules"]["tool.terminal"] is True
    # The saved profile is what the next panel update reads; without it the
    # update would fall back to a preset and drop the module.
    assert _json(updates["install-profile.json"]) == {
        "schema_version": 1,
        "profile": "custom",
        "module_ids": ["core", "engine.xray", "tool.editor", "tool.terminal"],
        "editor_variant": "full",
    }


def test_module_order_matches_the_profile_installer() -> None:
    assert install_state.MODULE_ORDER == tuple(_installer().MODULE_IDS)


def test_profile_reinstall_after_an_engine_install_keeps_the_module(tmp_path: Path) -> None:
    installer = _installer()
    panel = make_panel(tmp_path)
    plan = build_plan("install", "tool.terminal", **panel.kwargs)
    for relative in plan.files_add:
        target = panel.path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(file_bytes(relative))
    for relative, payload in state_file_updates(panel.root, plan).items():
        panel.path(relative).write_bytes(payload)
    source = tmp_path / "release" / "xkeen-ui"
    for paths in OWNERSHIP.values():
        for relative in paths:
            if relative.startswith("static/frontend-build/") or relative == "module-ownership.json":
                continue
            target = source.joinpath(*relative.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"# release file\n")
    saved = panel.read_json("install-profile.json")

    installer.apply_profile(
        source, panel.root, saved["profile"], module_ids=saved["module_ids"], transaction_root=tmp_path / "profile-tx"
    )

    assert panel.path("static/js/pages/terminal.lazy.entry.js").read_bytes() == b"# release file\n"
    assert panel.read_json("module-installed.json")["modules"]["tool.terminal"] is True
    assert panel.read_json("modules.json")["modules"]["tool.terminal"]["enabled"] is True
    assert not panel.path("routes/mihomo.py").exists()


REAL_PANEL = ROOT / "xkeen-ui"
REAL_VITE = REAL_PANEL / "static" / "frontend-build" / ".vite"


@pytest.mark.skipif(not (REAL_VITE / "manifest.json").is_file(), reason="needs npm run frontend:build")
@pytest.mark.parametrize("profile", ["full", "xray-minimal", "mihomo-minimal"])
def test_manifests_rebuilt_from_untouched_profile_equal_installer_output(tmp_path: Path, profile: str) -> None:
    installer = _installer()
    target = tmp_path / "panel"
    target.mkdir()
    installer.apply_profile(REAL_PANEL, target, profile, transaction_root=tmp_path / "tx")
    frontend = {
        "bridge": json.loads((REAL_VITE / "manifest.json").read_text(encoding="utf-8")),
        "build": json.loads((REAL_VITE / "manifest.build.json").read_text(encoding="utf-8")),
    }

    rebuilt = rebuild_frontend_manifests(target, frontend)

    for relative in (BRIDGE, BUILD):
        written = json.loads(target.joinpath(*relative.split("/")).read_text(encoding="utf-8"))
        assert _json(rebuilt[relative]) == written, relative
