from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from services.module_catalog_client import ModuleCatalogClient
from services.module_registry import ModuleRegistry
from services.module_transactions.executor import run_operation
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_panel_update_plan, build_profile_transition_plan
from services.module_transactions.state import new_operation_id
from tests.support.module_tx import DirectoryTransport, sign_release_directory
from tests.test_module_transactions_real_tree import (
    ARCHITECTURE,
    Built,
    VERSION,
    _dangling,
    _files,
    _install_profile,
    built,
)


ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _client(panel: Path, dist: Path, keyring: dict[str, bytes], version: str) -> ModuleCatalogClient:
    return ModuleCatalogClient(
        panel,
        transport=DirectoryTransport(dist),
        keyring=keyring,
        platform_architecture=ARCHITECTURE,
        core_version=version,
    )


def _run(panel: Path, plan, client: ModuleCatalogClient) -> str:
    journal = Journal.create(panel, plan, new_operation_id(), extra={})
    return run_operation(
        journal,
        state_dir=panel,
        client=client,
        architecture=ARCHITECTURE,
        restart=lambda: None,
        wait_healthy=lambda _phase: True,
    )


def _assert_imports(panel: Path, expected: str, excluded: str) -> None:
    env = dict(os.environ, PYTHONPATH=str(panel), XKEEN_UI_STATE_DIR=str(panel))
    process = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "from services.module_registry import ModuleRegistry; "
                "original = ModuleRegistry._is_requirement_available; "
                "ModuleRegistry._is_requirement_available = lambda self, key: "
                "True if key in ('xkeen', 'xray', 'mihomo') else original(self, key); "
                "import app; print(app.app.extensions['xkeen.module_activation']['active_module_ids'])"
            ),
        ],
        cwd=panel,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert process.returncode == 0, process.stderr
    assert expected in process.stdout
    assert excluded not in process.stdout


def test_real_tree_profile_transition_commits_importable_panel(built: Built, tmp_path: Path) -> None:
    panel = _install_profile(built, tmp_path, "xray-minimal")
    secret = panel / "secret.key"
    secret.write_bytes(b"user-secret\n")
    registry = ModuleRegistry(str(panel), which=lambda _name: "/bin/tool")
    registry.set_profile("mihomo-minimal")
    client = _client(panel, built.dist, built.keyring, VERSION)
    catalog = client.get_release_catalog(VERSION).catalog
    plan = build_profile_transition_plan(
        panel_root=panel,
        state_dir=panel,
        catalog=catalog,
        target_panel_root=built.tree,
        architecture=ARCHITECTURE,
    )

    assert _run(panel, plan, client) == "committed"

    present = set(_files(panel))
    assert _dangling(built, present) == []
    assert secret.read_bytes() == b"user-secret\n"
    assert json.loads((panel / "install-profile.json").read_text(encoding="utf-8"))["profile"] == "mihomo-minimal"
    _assert_imports(panel, "engine.mihomo", "engine.xray")


def test_real_tree_panel_update_preserves_profile_and_user_state(built: Built, tmp_path: Path) -> None:
    panel = _install_profile(built, tmp_path / "installed", "xray-minimal")
    secret = panel / "secret.key"
    secret.write_bytes(b"user-secret\n")
    package_root = tmp_path / "next-release"
    target = package_root / "xkeen-ui"
    shutil.copytree(built.tree, target)
    changed = target / "app.py"
    changed.write_bytes(changed.read_bytes() + b"\n# stage 8.5 update proof\n")
    release_builder = _load("build_modular_panel_release_next", ROOT / "scripts" / "build_modular_panel_release.py")
    dist = tmp_path / "next-dist"
    release_builder.build_release(
        package_root,
        dist,
        version="2.11.0",
        source_date_epoch=1_700_000_001,
        source_commit="d" * 40,
    )
    keyring = sign_release_directory(dist)
    client = _client(panel, dist, keyring, "2.11.0")
    catalog = client.get_release_catalog("2.11.0").catalog
    plan = build_panel_update_plan(
        panel_root=panel,
        state_dir=panel,
        catalog=catalog,
        target_panel_root=target,
        architecture=ARCHITECTURE,
    )

    assert _run(panel, plan, client) == "committed"

    assert (panel / "app.py").read_bytes() == changed.read_bytes()
    assert json.loads((panel / "BUILD.json").read_text(encoding="utf-8"))["version"] == "2.11.0"
    assert json.loads((panel / "install-profile.json").read_text(encoding="utf-8"))["profile"] == "xray-minimal"
    assert secret.read_bytes() == b"user-secret\n"
    _assert_imports(panel, "engine.xray", "engine.mihomo")
