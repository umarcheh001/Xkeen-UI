from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.module_profile_plan import (
    ProfilePlanError,
    build_profile_target,
    profile_transition_diff,
)
from services.module_registry import MODULE_IDS


def _panel(tmp_path: Path) -> Path:
    root = tmp_path / "xkeen-ui"
    modules = {module_id: [] for module_id in MODULE_IDS}
    modules.update(
        {
            "core": ["app.py", "module-ownership.json", "static/frontend-build/assets/panel.js"],
            "engine.xray": ["routes/routing.py", "static/frontend-build/assets/xray.js"],
            "engine.mihomo": ["routes/mihomo.py", "static/frontend-build/assets/mihomo.js"],
            "tool.editor": ["static/js/editor.js", "static/monaco-editor/editor.js"],
            "tool.files": ["routes/files.py"],
        }
    )
    build = {
        "panel": {"file": "assets/panel.js", "imports": []},
        "xray": {"file": "assets/xray.js", "imports": ["panel"]},
        "mihomo": {"file": "assets/mihomo.js", "imports": ["panel"]},
    }
    ownership = {
        "schema_version": 1,
        "modules": modules,
        "frontend": {"bridge": {}, "build": build},
    }
    for paths in modules.values():
        for relative in paths:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("payload\n", encoding="utf-8")
    (root / "module-ownership.json").write_text(json.dumps(ownership), encoding="utf-8")
    return root


@pytest.mark.parametrize(
    ("profile", "module_ids", "variant"),
    [
        ("full", tuple(MODULE_IDS), "full"),
        ("legacy-full", tuple(MODULE_IDS), "full"),
        ("xray-minimal", ("core", "engine.xray", "tool.editor"), "light"),
        ("mihomo-minimal", ("core", "engine.mihomo", "tool.editor"), "light"),
    ],
)
def test_profile_target_builds_canonical_presets(
    tmp_path: Path, profile: str, module_ids: tuple[str, ...], variant: str
) -> None:
    target = build_profile_target(_panel(tmp_path), profile=profile, module_ids=None, editor_variant=None)

    assert target.profile == profile
    assert target.module_ids == module_ids
    assert target.editor_variant == variant
    assert target.state_files["modules.json"]["profile"] == profile
    assert target.state_files["module-installed.json"]["modules"]["core"] is True
    assert target.state_files["install-profile.json"]["module_ids"] == list(module_ids)
    assert target.state_files["install-managed.json"]["paths"] == list(target.payload_files)


def test_minimal_target_uses_ownership_and_trims_frontend_manifest(tmp_path: Path) -> None:
    target = build_profile_target(
        _panel(tmp_path),
        profile="xray-minimal",
        module_ids=None,
        editor_variant=None,
    )

    assert "routes/routing.py" in target.payload_files
    assert "routes/mihomo.py" not in target.payload_files
    assert "static/monaco-editor/editor.js" not in target.payload_files
    assert set(target.frontend["build"]) == {"panel", "xray"}


def test_custom_target_validates_dependencies_and_editor_variant(tmp_path: Path) -> None:
    panel = _panel(tmp_path)

    target = build_profile_target(
        panel,
        profile="custom",
        module_ids=["tool.files", "tool.editor", "core"],
        editor_variant="advanced",
    )

    assert target.module_ids == ("core", "tool.editor", "tool.files")
    assert target.editor_variant == "advanced"
    with pytest.raises(ProfilePlanError, match="profile_dependency_missing"):
        build_profile_target(
            panel,
            profile="custom",
            module_ids=["core", "engine.xray"],
            editor_variant="light",
        )
    with pytest.raises(ProfilePlanError, match="profile_modules_invalid"):
        build_profile_target(panel, profile="custom", module_ids=["core", "unknown"], editor_variant=None)


def test_profile_transition_diff_is_sorted_and_deterministic(tmp_path: Path) -> None:
    target = build_profile_target(
        _panel(tmp_path),
        profile="mihomo-minimal",
        module_ids=None,
        editor_variant=None,
    )
    installed = {
        "profile": "xray-minimal",
        "module_ids": ["tool.editor", "engine.xray", "core"],
        "editor_variant": "light",
        "paths": ["static/js/editor.js", "app.py", "routes/routing.py"],
    }

    assert profile_transition_diff(installed, target) == {
        "profile_from": "xray-minimal",
        "profile_to": "mihomo-minimal",
        "editor_variant_from": "light",
        "editor_variant_to": "light",
        "modules_add": ["engine.mihomo"],
        "modules_remove": ["engine.xray"],
        "files_add": [
            "module-ownership.json",
            "routes/mihomo.py",
            "static/frontend-build/assets/mihomo.js",
            "static/frontend-build/assets/panel.js",
        ],
        "files_remove": ["routes/routing.py"],
    }
