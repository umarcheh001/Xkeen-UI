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
from tests.support.shared_build import build_once


ROOT = Path(__file__).resolve().parents[1]
PANEL = ROOT / "xkeen-ui"
VERSION = "2.10.0"
ARCHITECTURE = "mipsel"


def _next_module_version(module_id: str) -> str:
    # An update is newer than what the tree carries: module-versions.json moves
    # with every change of a module, so the test does not fix a number.
    versions = json.loads((ROOT / "module-versions.json").read_text(encoding="utf-8"))
    major, minor, patch = (int(part) for part in versions[module_id].split("."))
    return f"{major}.{minor}.{patch + 1}"


XRAY_UPDATE_VERSION = _next_module_version("engine.xray")
BOOKKEEPING = {f"module-catalog/catalog-{VERSION}.json", "module-operations/status.json", "module-operations/history.jsonl"}
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


def _build_release(base: Path, installer) -> dict:
    user_archive = _load("build_user_archive", ROOT / "scripts" / "build_user_archive.py")
    release_builder = _load("build_modular_panel_release", ROOT / "scripts" / "build_modular_panel_release.py")
    # Степень сжатия на установку не влияет, а занимает больше половины сборки.
    release_builder.ARCHIVE_COMPRESSLEVEL = 1
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

    return {
        "tree": str(tree),
        "dist": str(dist),
        "keyring": {key_id: key.hex() for key_id, key in keyring.items()},
        "ownership": ownership,
        "edges": {source: sorted(targets) for source, targets in edges.items()},
    }


@pytest.fixture(scope="session")
def built(tmp_path_factory) -> Built:
    """One release built the way CI builds it: compressed tree, map, packages.

    Сборка одна на весь прогон, в том числе параллельный: первый поток, которому
    она понадобилась, собирает её в общем каталоге, остальные ждут готовую.
    Поэтому тесты этого файла раздаются потокам поштучно (`SPLIT_TEST_FILES`),
    а собранное дерево и релиз никто из них не меняет.
    """

    installer = _load("module_profile_install", PANEL / "scripts" / "module_profile_install.py")
    base = build_once(
        tmp_path_factory,
        "real-tree-release",
        lambda base: (base / "built.json").write_text(json.dumps(_build_release(base, installer)), encoding="utf-8"),
    )
    data = json.loads((base / "built.json").read_text(encoding="utf-8"))
    built = Built()
    built.tree, built.dist, built.installer = Path(data["tree"]), Path(data["dist"]), installer
    built.keyring = {key_id: bytes.fromhex(key) for key_id, key in data["keyring"].items()}
    built.ownership = data["ownership"]
    built.edges = {source: set(targets) for source, targets in data["edges"].items()}
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


UPDATE_MARK = b"\n# module update\n"
ADDED_BODY = b"# added by the module update\n"


def _publish_update(built: Built, dist: Path, module_id: str, module_version: str, changed: str, added: str) -> dict[str, bytes]:
    """A copy of the release with a signed update of one module: one file changed, one added."""

    import gzip
    import hashlib
    import io
    import tarfile

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from tests.support.module_tx import _sign

    shutil.copytree(built.dist, dist)
    members: dict[str, bytes] = {}
    with tarfile.open(dist / f"xkeen-module-{module_id}-{VERSION}.tar.gz", "r:gz") as archive:
        for member in archive.getmembers():
            if member.isreg():
                members[member.name] = archive.extractfile(member).read()
    manifest = json.loads(members.pop("module-manifest.json"))
    payload = {name.removeprefix("payload/"): body for name, body in members.items()}
    payload[changed] = payload[changed] + UPDATE_MARK
    payload[added] = ADDED_BODY
    manifest.update(
        version=module_version,
        # An update of a module is for the panel release it was built against.
        min_core=VERSION,
        ownership=sorted(payload),
        max_size=sum(len(body) for body in payload.values()),
    )
    buffer = io.BytesIO()
    entries = [("module-manifest.json", json.dumps(manifest).encode("utf-8"))]
    entries += [("payload/" + relative, payload[relative]) for relative in sorted(payload)]
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as packed, tarfile.open(fileobj=packed, mode="w") as archive:
        for name, body in entries:
            info = tarfile.TarInfo(name)
            info.size = len(body)
            info.mtime = 1_700_000_000
            archive.addfile(info, io.BytesIO(body))
    body = buffer.getvalue()
    asset = f"xkeen-module-{module_id}-{module_version}.tar.gz"
    (dist / asset).write_bytes(body)

    catalog_bytes = (dist / "catalog.json").read_bytes()
    entry = dict(next(item for item in json.loads(catalog_bytes)["modules"] if item["id"] == module_id))
    entry.update(
        version=module_version, archive=asset, size=len(body), sha256=hashlib.sha256(body).hexdigest(),
        min_core=VERSION, ownership=sorted(payload),
    )
    document = {
        "kind": "xkeen-module-updates", "schema_version": 1, "panel_version": VERSION, "serial": 1, "modules": [entry],
    }
    updates_bytes = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    key = Ed25519PrivateKey.generate()
    (dist / "catalog.json.sig").write_bytes(_sign(key, catalog_bytes))
    (dist / "module-updates.json").write_bytes(updates_bytes)
    (dist / "module-updates.json.sig").write_bytes(_sign(key, updates_bytes))
    pem = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    return {"release-2026": pem}


def test_update_of_a_module_over_a_real_profile(built: Built, tmp_path: Path) -> None:
    module_id = "engine.xray"
    changed = sorted(path for path in built.ownership[module_id] if path.endswith(".py"))[0]
    added = "services/xray_module_update_probe.py"
    panel = _install_profile(built, tmp_path, "xray-minimal")
    modules_before = (panel / "modules.json").read_bytes()
    profile_before = (panel / "install-profile.json").read_bytes()
    before = _files(panel)
    keyring = _publish_update(built, tmp_path / "dist", module_id, XRAY_UPDATE_VERSION, changed, added)
    client = ModuleCatalogClient(
        panel, transport=DirectoryTransport(tmp_path / "dist"), keyring=keyring,
        platform_architecture=ARCHITECTURE, core_version=VERSION,
    )
    catalog = client.get_effective_catalog(VERSION).catalog
    plan = build_plan("update", module_id, panel_root=panel, state_dir=panel, catalog=catalog, architecture=ARCHITECTURE)

    result = run_operation(
        Journal.create(panel, plan, new_operation_id(), extra={}), state_dir=panel, client=client,
        architecture=ARCHITECTURE, restart=lambda: None, wait_healthy=lambda _phase: True,
    )

    assert result == "committed", read_status(panel)
    after = _files(panel)
    assert after[changed] == before[changed] + UPDATE_MARK
    assert after[added] == ADDED_BODY
    assert _dangling(built, set(after)) == []
    installed = json.loads((panel / "module-installed.json").read_text(encoding="utf-8"))
    assert installed["versions"] == {module_id: XRAY_UPDATE_VERSION}
    overrides = json.loads((panel / "module-ownership-overrides.json").read_text(encoding="utf-8"))
    assert overrides["modules"] == {module_id: sorted({*built.ownership[module_id], added})}
    assert added in json.loads((panel / "install-managed.json").read_text(encoding="utf-8"))["paths"]
    # The switch of the module and the profile label stay the owner's.
    assert (panel / "modules.json").read_bytes() == modules_before
    assert (panel / "install-profile.json").read_bytes() == profile_before
    touched = {path for path in set(before) | set(after) if before.get(path) != after.get(path)}
    bookkeeping = {path for path in touched if path.startswith(("module-catalog/", "module-operations/"))}
    assert touched - bookkeeping <= {changed, added} | STATE_PATHS | {"module-ownership-overrides.json"}
