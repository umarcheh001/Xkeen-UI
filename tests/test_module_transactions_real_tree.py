"""Модуль из настоящего пакета поверх настоящей урезанной установки.

Остальные тесты движка работают на маленьком придуманном дереве. Здесь всё
настоящее: дерево панели со сжатой статикой, карта владения, пакеты из
сборщика релиза, установщик профиля. Проверяется то, что на придуманном дереве
не увидеть: после установки и после удаления модуля в панели не остаётся ни
одного оборванного импорта, страница модуля находит свой мост сборки, а сжатые
копии действительно отдаются.
"""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import sys
from pathlib import Path

import pytest

from services.module_catalog_client import ModuleCatalogClient
from services.module_transactions.executor import run_operation
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_plan
from services.module_transactions.state import new_operation_id, read_status
from tests.support.module_tx import DirectoryTransport, STATE_PATHS, sign_release_directory


ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "xkeen-ui"
VERSION = "2.10.0"
ARCHITECTURE = "mipsel"
BOOKKEEPING = {f"module-catalog/catalog-{VERSION}.json", "module-operations/status.json"}
_TEMPLATE_LINK = re.compile(r"""{%-?\s*(?:include|extends|import|from)\s+['"]([^'"]+)['"]""")

pytestmark = pytest.mark.skipif(
    not (PANEL / "static" / "frontend-build" / ".vite" / "manifest.json").is_file(),
    reason="needs npm run frontend:build",
)


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class Built:
    pass


@pytest.fixture(scope="module")
def built(tmp_path_factory) -> Built:
    """One release built the way CI builds it: compressed tree, map, packages."""

    base = tmp_path_factory.mktemp("release")
    user_archive = _load("build_user_archive", ROOT / "scripts" / "build_user_archive.py")
    release_builder = _load("build_modular_panel_release", ROOT / "scripts" / "build_modular_panel_release.py")
    installer = _load("module_profile_install", PANEL / "scripts" / "module_profile_install.py")
    package_root = base / "package-root"
    tree = package_root / "xkeen-ui"
    shutil.copytree(
        PANEL, tree,
        ignore=shutil.ignore_patterns("__pycache__", ".DS_Store", "BUILD.json", "module-ownership.json", "*.gz"),
    )
    user_archive.precompress_static_assets(tree)
    user_archive.write_module_ownership_map(tree, strict=True)
    dist = base / "dist"
    release_builder.build_release(
        package_root, dist, version=VERSION, source_date_epoch=1_700_000_000, source_commit="c" * 40
    )
    keyring = sign_release_directory(dist)

    ownership = json.loads((tree / "module-ownership.json").read_text(encoding="utf-8"))["modules"]
    owner_of = {path: module for module, paths in ownership.items() for path in paths}
    edges: dict[str, set[str]] = {}
    for source, targets in release_builder._python_import_edges(tree, owner_of).items():
        edges.setdefault(source, set()).update(targets)
    for source, targets in release_builder._javascript_import_edges(tree, owner_of, installer).items():
        edges.setdefault(source, set()).update(targets)
    for relative in owner_of:
        if relative.startswith("templates/") and relative.endswith(".html"):
            markup = (tree / relative).read_text(encoding="utf-8")
            links = {"templates/" + name for name in _TEMPLATE_LINK.findall(markup)}
            edges.setdefault(relative, set()).update(link for link in links if link in owner_of)

    built = Built()
    built.tree, built.dist, built.keyring, built.installer = tree, dist, keyring, installer
    built.ownership, built.edges = ownership, edges
    return built


def _files(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts
    }


def _dangling(built: Built, present: set[str]) -> list[str]:
    return sorted(
        f"{source} -> {link}"
        for source in present
        for link in built.edges.get(source, ())
        if link not in present
    )


def _install_profile(built: Built, tmp_path: Path, profile: str) -> Path:
    panel = tmp_path / "xkeen-ui"
    panel.mkdir(parents=True)
    built.installer.apply_profile(built.tree, panel, profile, transaction_root=tmp_path / "profile-tx")
    (panel / "BUILD.json").write_text(json.dumps({"version": VERSION}), encoding="utf-8")
    return panel


def _operate(built: Built, panel: Path, operation: str, module_id: str) -> str:
    client = ModuleCatalogClient(
        panel,
        transport=DirectoryTransport(built.dist),
        keyring=built.keyring,
        platform_architecture=ARCHITECTURE,
        core_version=VERSION,
    )
    catalog = client.get_release_catalog(VERSION).catalog
    plan = build_plan(operation, module_id, panel_root=panel, state_dir=panel, catalog=catalog, architecture=ARCHITECTURE)
    journal = Journal.create(panel, plan, new_operation_id(), extra={})
    return run_operation(
        journal, state_dir=panel, client=client, architecture=ARCHITECTURE,
        restart=lambda: None, wait_healthy=lambda _phase: True,
    )


CASES = [
    ("xray-minimal", "tool.terminal"),
    ("xray-minimal", "tool.files"),
    ("xray-minimal", "tool.backups"),
    ("xray-minimal", "integration.happ"),
    ("xray-minimal", "tool.advanced-diagnostics"),
    ("xray-minimal", "engine.mihomo"),
    ("mihomo-minimal", "tool.terminal"),
    ("mihomo-minimal", "tool.files"),
    ("mihomo-minimal", "tool.backups"),
    ("mihomo-minimal", "integration.happ"),
    ("mihomo-minimal", "tool.advanced-diagnostics"),
    ("mihomo-minimal", "engine.xray"),
]


def test_reduced_profiles_start_without_dangling_imports(built: Built, tmp_path: Path) -> None:
    for profile in ("xray-minimal", "mihomo-minimal"):
        panel = _install_profile(built, tmp_path / profile, profile)

        assert _dangling(built, set(_files(panel))) == [], profile


@pytest.mark.parametrize(("profile", "module_id"), CASES)
def test_install_then_remove_over_a_real_reduced_profile(built: Built, tmp_path: Path, profile: str, module_id: str) -> None:
    from routes.ui_assets import resolve_precompressed_static

    panel = _install_profile(built, tmp_path, profile)
    before = _files(panel)
    module_files = set(built.ownership[module_id])

    assert _operate(built, panel, "install", module_id) == "committed", read_status(panel)

    installed = _files(panel)
    assert module_files <= set(installed)
    for relative in module_files:
        assert installed[relative] == (built.tree / relative).read_bytes(), relative
    assert _dangling(built, set(installed)) == []
    changed = {path for path in set(before) | set(installed) if before.get(path) != installed.get(path)}
    assert changed <= module_files | STATE_PATHS | BOOKKEEPING
    # Every bridge of the complete manifest whose file is now on disk is listed again.
    complete = json.loads((built.tree / "static/frontend-build/.vite/manifest.json").read_text(encoding="utf-8"))
    listed = json.loads((panel / "static/frontend-build/.vite/manifest.json").read_text(encoding="utf-8"))
    for name, entry in complete.items():
        on_disk = (panel / "static" / "frontend-build" / entry["file"]).is_file()
        assert (name in listed) == on_disk, name
    packed = sorted(path for path in module_files if path.endswith(".gz") and path.startswith("static/"))
    for relative in packed:
        source = relative[: -len(".gz")]
        assert (panel / relative).stat().st_mtime >= (panel / source).stat().st_mtime, relative
        served = resolve_precompressed_static(str(panel / "static"), source[len("static/"):], "gzip")
        assert served == str(panel / relative), relative
    profile_state = json.loads((panel / "install-profile.json").read_text(encoding="utf-8"))
    assert profile_state["profile"] == "custom" and module_id in profile_state["module_ids"]

    assert _operate(built, panel, "remove", module_id) == "committed", read_status(panel)

    after = _files(panel)
    assert not module_files & set(after)
    assert _dangling(built, set(after)) == []
    changed = {path for path in set(before) | set(after) if before.get(path) != after.get(path)}
    # What the profile installer had put there for this module leaves with it;
    # nothing else in the panel is touched.
    assert changed <= module_files | STATE_PATHS | BOOKKEEPING
    listed = json.loads((panel / "static/frontend-build/.vite/manifest.json").read_text(encoding="utf-8"))
    for name, entry in complete.items():
        on_disk = (panel / "static" / "frontend-build" / entry["file"]).is_file()
        assert (name in listed) == on_disk, name


def test_profile_update_after_a_module_install_keeps_the_module(built: Built, tmp_path: Path) -> None:
    panel = _install_profile(built, tmp_path, "xray-minimal")
    assert _operate(built, panel, "install", "tool.terminal") == "committed"
    saved = json.loads((panel / "install-profile.json").read_text(encoding="utf-8"))

    built.installer.apply_profile(
        built.tree, panel, saved["profile"], module_ids=saved["module_ids"], transaction_root=tmp_path / "update-tx"
    )

    present = set(_files(panel))
    assert set(built.installer.INSTALL_MARKERS["tool.terminal"]) <= present
    assert json.loads((panel / "module-installed.json").read_text(encoding="utf-8"))["modules"]["tool.terminal"] is True
    installed_flags = json.loads((panel / "module-installed.json").read_text(encoding="utf-8"))["modules"]
    assert installed_flags["engine.mihomo"] is False
    assert _dangling(built, present) == []
