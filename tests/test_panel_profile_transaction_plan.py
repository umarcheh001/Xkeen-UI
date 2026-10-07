from __future__ import annotations

import json
from pathlib import Path

import pytest

from services.module_transactions.plan import (
    build_panel_update_plan,
    build_profile_transition_plan,
)
from services.module_transactions.state import ModuleTransactionError
from tests.support.module_tx import ARCHITECTURE, FRONTEND, MODULE_ORDER, OWNERSHIP, make_panel


def _json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _target_source(tmp_path: Path) -> Path:
    root = tmp_path / "target" / "xkeen-ui"
    for paths in OWNERSHIP.values():
        for relative in paths:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"new {relative}\n", encoding="utf-8")
    _json(
        root / "module-ownership.json",
        {
            "schema_version": 1,
            "modules": {module_id: list(paths) for module_id, paths in OWNERSHIP.items()},
            "frontend": FRONTEND,
        },
    )
    return root


def _catalog(version: str, *, size: int = 100) -> dict[str, object]:
    return {
        "release_version": version,
        "panel": {
            "archive": f"xkeen-ui-panel-{version}.tar.gz",
            "size": size,
            "sha256": "a" * 64,
            "version": version,
            "signing_key_id": "release-2026",
            "architectures": [ARCHITECTURE],
        },
        "modules": [],
    }


def test_profile_transition_stays_on_release_and_uses_desired_registry_profile(tmp_path: Path) -> None:
    panel = make_panel(
        tmp_path,
        version="1.2.3",
        installed=("core", "tool.editor", "engine.xray", "engine.mihomo"),
    )
    target_source = _target_source(tmp_path)
    desired = panel.read_json("modules.json")
    desired["profile"] = "xray-minimal"
    desired["modules"]["engine.mihomo"]["enabled"] = False
    desired["physical_request"] = {
        "profile": "xray-minimal",
        "module_ids": ["core", "engine.xray", "tool.editor"],
        "editor_variant": "light",
    }
    _json(panel.path("modules.json"), desired)

    plan = build_profile_transition_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=_catalog("1.2.3"),
        target_panel_root=target_source,
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )

    assert plan.scope == "profile"
    assert plan.operation == "profile-transition"
    assert plan.module_id is None
    assert plan.source_version == plan.target_version == "1.2.3"
    assert plan.target_profile == {
        "profile": "xray-minimal",
        "module_ids": ["core", "engine.xray", "tool.editor"],
        "editor_variant": "light",
    }
    assert "routes/mihomo.py" in plan.files_remove
    # Релиз тот же: файлы остающегося движка уже на месте и не перекладываются.
    assert "routes/routing/__init__.py" not in plan.files_add
    assert plan.files_add == ()
    assert plan.archive is None
    assert "secret.key" not in set(plan.files_add) | set(plan.files_remove)


def test_profile_transition_refuses_already_matching_physical_payload(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, version="1.2.3")

    with pytest.raises(ModuleTransactionError) as raised:
        build_profile_transition_plan(
            panel_root=panel.root,
            state_dir=panel.state,
            catalog=_catalog("1.2.3"),
            target_panel_root=_target_source(tmp_path),
            architecture=ARCHITECTURE,
            free_bytes=1 << 40,
        )

    assert raised.value.code == "profile_transition_not_required"


def test_profile_transition_allows_state_only_profile_metadata_change(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, version="1.2.3")
    desired = panel.read_json("modules.json")
    desired["profile"] = "custom"
    desired["physical_request"] = {
        "profile": "custom",
        "module_ids": ["core", "engine.xray", "tool.editor"],
        "editor_variant": "light",
    }
    _json(panel.path("modules.json"), desired)

    plan = build_profile_transition_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=_catalog("1.2.3"),
        target_panel_root=_target_source(tmp_path),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )

    assert plan.target_profile == {
        "profile": "custom",
        "module_ids": ["core", "engine.xray", "tool.editor"],
        "editor_variant": "light",
    }
    assert plan.files_add == ()
    assert plan.files_remove == ()


def test_panel_update_requires_newer_release_and_preserves_custom_profile(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, version="1.2.3", installed=("core", "tool.files"))
    _json(
        panel.path("modules.json"),
        {
            "schema_version": 1,
            "profile": "custom",
            "restart_required": False,
            "editor": {"variant": "light"},
            "modules": {module_id: {"enabled": module_id in {"core", "tool.files"}} for module_id in MODULE_ORDER},
        },
    )

    plan = build_panel_update_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=_catalog("1.3.0", size=123),
        target_panel_root=_target_source(tmp_path),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )

    assert plan.scope == "panel"
    assert plan.operation == "panel-update"
    assert plan.source_version == "1.2.3"
    assert plan.target_version == plan.version == "1.3.0"
    assert plan.target_profile == {
        "profile": "custom",
        "module_ids": ["core", "tool.files"],
        "editor_variant": "light",
    }
    assert plan.archive is not None and plan.archive.size == 123
    assert plan.installed_after == ("core", "tool.files")


def test_panel_update_refuses_current_or_older_catalog(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, version="1.2.3")
    target_source = _target_source(tmp_path)

    for version in ("1.2.3", "1.2.2"):
        with pytest.raises(ModuleTransactionError) as raised:
            build_panel_update_plan(
                panel_root=panel.root,
                state_dir=panel.state,
                catalog=_catalog(version),
                target_panel_root=target_source,
                architecture=ARCHITECTURE,
                free_bytes=1 << 40,
            )
        assert raised.value.code == "panel_update_not_newer"
