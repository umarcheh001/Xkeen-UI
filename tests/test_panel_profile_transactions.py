from __future__ import annotations

import json
from pathlib import Path

from services.module_transactions.executor import run_operation
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_panel_update_plan, build_profile_transition_plan
from services.module_transactions.state import read_status
from tests.support.module_tx import (
    ARCHITECTURE,
    FRONTEND,
    MODULE_ORDER,
    OWNERSHIP,
    changed_paths,
    file_bytes,
    make_panel,
    make_release,
    snapshot,
)


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _target_source(tmp_path: Path, version: str) -> Path:
    root = tmp_path / f"target-{version}" / "xkeen-ui"
    for paths in OWNERSHIP.values():
        for relative in paths:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(file_bytes(relative, version))
    _write_json(
        root / "module-ownership.json",
        {
            "schema_version": 1,
            "modules": {module_id: list(paths) for module_id, paths in OWNERSHIP.items()},
            "frontend": FRONTEND,
        },
    )
    return root


def _set_desired(panel, profile: str, selected: set[str], variant: str = "light") -> None:
    state = panel.read_json("modules.json")
    state["profile"] = profile
    state["editor"] = {"variant": variant}
    state["modules"] = {module_id: {"enabled": module_id in selected} for module_id in MODULE_ORDER}
    _write_json(panel.path("modules.json"), state)


def _run(panel, plan, release, *, healthy: bool = True, on_step=None):
    journal = Journal.create(panel.root, plan, "full-scope-operation", extra={})
    restarts: list[str] = []
    result = run_operation(
        journal,
        state_dir=panel.state,
        client=release.client(panel.state),
        architecture=ARCHITECTURE,
        restart=lambda: restarts.append("restart"),
        wait_healthy=lambda phase: healthy,
        on_step=on_step,
    )
    return result, journal, restarts


def test_profile_transition_commits_exact_target_and_preserves_user_files(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "engine.xray", "tool.editor"))
    selected = {"core", "engine.mihomo", "tool.editor"}
    _set_desired(panel, "mihomo-minimal", selected)
    release = make_release()
    plan = build_profile_transition_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_panel_root=_target_source(tmp_path, release.version),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )
    secret = panel.path("secret.key").read_bytes()

    result, journal, restarts = _run(panel, plan, release)

    assert result == "committed"
    assert not journal.dir.exists()
    assert restarts == ["restart"]
    assert panel.path("routes/mihomo.py").read_bytes() == file_bytes("routes/mihomo.py")
    assert not panel.path("routes/routing/__init__.py").exists()
    assert panel.path("secret.key").read_bytes() == secret
    assert panel.read_json("install-profile.json")["profile"] == "mihomo-minimal"


def test_panel_update_commits_new_release_and_preserves_custom_profile(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    _set_desired(panel, "custom", {"core", "tool.files"})
    release = make_release(version="2.11.0")
    plan = build_panel_update_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_panel_root=_target_source(tmp_path, release.version),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )

    result, _, _ = _run(panel, plan, release)

    assert result == "committed"
    assert panel.path("app.py").read_bytes() == file_bytes("app.py", "2.11.0")
    assert panel.read_json("BUILD.json")["version"] == "2.11.0"
    assert panel.read_json("install-profile.json")["profile"] == "custom"
    assert panel.read_json("install-profile.json")["module_ids"] == ["core", "tool.files"]


def test_corrupt_panel_archive_is_refused_before_mutation(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    _set_desired(panel, "mihomo-minimal", {"core", "engine.mihomo", "tool.editor"})
    release = make_release()
    plan = build_profile_transition_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_panel_root=_target_source(tmp_path, release.version),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )
    before = snapshot(panel.root)
    release.transport.responses[release.panel_url] = b"x" * len(release.panel)

    result, journal, restarts = _run(panel, plan, release)

    assert result == "interrupted"
    assert not journal.dir.exists()
    assert restarts == []
    assert changed_paths(before, snapshot(panel.root)) <= {
        "module-catalog/catalog-2.10.0.json",
        "module-operations/status.json",
    }
    assert read_status(panel.state)["error_code"] == "catalog_archive_checksum_mismatch"


def test_full_scope_health_failure_rolls_back_every_changed_file(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    _set_desired(panel, "mihomo-minimal", {"core", "engine.mihomo", "tool.editor"})
    release = make_release()
    plan = build_profile_transition_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_panel_root=_target_source(tmp_path, release.version),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )
    before = snapshot(panel.root)

    result, journal, restarts = _run(panel, plan, release, healthy=False)

    assert result == "rolled_back"
    assert not journal.dir.exists()
    assert restarts == ["restart", "restart"]
    assert changed_paths(before, snapshot(panel.root)) <= {
        "module-catalog/catalog-2.10.0.json",
        "module-operations/status.json",
    }
