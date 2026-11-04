"""An installed profile must contain every script its pages load.

Pages load the source modules under ``static/js``. A module graph with one
missing file does not start at all, so a profile that leaves out a statically
imported script installs a panel whose scripts never run: the status stays at
"checking", there is no editor and the tabs do not switch.
"""

from __future__ import annotations

import importlib.util
import json
import posixpath
import re
import shutil
import stat
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "xkeen-ui"
SCRIPT = SOURCE / "scripts" / "module_profile_install.py"

FROM_IMPORT = re.compile(r"""\bfrom\s*['"](\.{1,2}/[^'"]+)['"]""")
BARE_IMPORT = re.compile(r"""^\s*import\s*['"](\.{1,2}/[^'"]+)['"]""", re.MULTILINE)
DYNAMIC_IMPORT = re.compile(r"""\bimport\(\s*['"](\.{1,2}/[^'"]+)['"]\s*\)""")
# A built chunk of a module names a core file `xk-core/<path>`; the page finds
# it through the importmap prefix `xk-core/` -> `/static/`.
CORE_PUBLIC_IMPORT = re.compile(r"""(?:\bfrom|\bimport)\s*["'`]xk-core/([^"'`]+)["'`]""")
STATIC_REFERENCE = re.compile(r"""url_for\(\s*['"]static['"]\s*,\s*filename\s*=\s*['"]([^'"]+)['"]""")

PROFILES = (("xray-minimal", "light"), ("xray-minimal", "full"),
            ("mihomo-minimal", "light"), ("full", "full"))


def _helper():
    spec = importlib.util.spec_from_file_location("module_profile_install_closure", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module", params=PROFILES)
def installed(request, tmp_path_factory, profile_source):
    profile, variant = request.param
    target = tmp_path_factory.mktemp(f"{profile}-{variant}") / "panel"
    helper = _helper()
    helper.commit_profile(helper.apply_profile(profile_source, target, profile, editor_variant=variant))
    return profile, target


@pytest.fixture(scope="module")
def profile_source(tmp_path_factory) -> Path:
    """Preserve generated frontend assets while excluding local Mihomo state."""

    destination = tmp_path_factory.mktemp("profile-source") / "xkeen-ui"

    def ignore_runtime_mihomo_state(directory: str, names: list[str]) -> set[str]:
        relative = Path(directory).relative_to(SOURCE)
        ignored = {
            name
            for name in names
            if not stat.S_ISREG((Path(directory) / name).lstat().st_mode)
            and not stat.S_ISDIR((Path(directory) / name).lstat().st_mode)
            and not stat.S_ISLNK((Path(directory) / name).lstat().st_mode)
        }
        if relative == Path("opt/etc/mihomo"):
            ignored.update({"config.yaml", "profiles"})
        return ignored

    shutil.copytree(SOURCE, destination, symlinks=True, ignore=ignore_runtime_mihomo_state)
    return destination


def test_profile_source_keeps_frontend_assets_without_local_mihomo_state(profile_source: Path):
    assert (profile_source / "static/frontend-build/assets/panel-bridge.js").is_file()
    assert not (profile_source / "opt/etc/mihomo/config.yaml").exists()
    assert not (profile_source / "opt/etc/mihomo/mihomo-api.sock").exists()


def _resolve(rel: str, specifier: str) -> str | None:
    path = specifier.split("?", 1)[0].split("#", 1)[0]
    dependency = posixpath.normpath(posixpath.join(posixpath.dirname(rel), path))
    return dependency if dependency.endswith((".js", ".mjs")) else None


def _browser_walk(target: Path, roots: list[str]) -> tuple[set[str], dict[str, str]]:
    """Follow the scripts as a browser would; return (loaded, missing static imports)."""

    loaded: set[str] = set()
    missing: dict[str, str] = {}
    queue = list(roots)
    while queue:
        rel = queue.pop()
        if rel in loaded:
            continue
        loaded.add(rel)
        text = (target / rel).read_text(encoding="utf-8")
        for specifier in FROM_IMPORT.findall(text) + BARE_IMPORT.findall(text):
            dependency = _resolve(rel, specifier)
            if not dependency or not (SOURCE / dependency).is_file():
                continue
            if (target / dependency).is_file():
                queue.append(dependency)
            else:
                missing.setdefault(dependency, rel)
        for public in CORE_PUBLIC_IMPORT.findall(text):
            dependency = "static/" + public
            if (target / dependency).is_file():
                queue.append(dependency)
            else:
                missing.setdefault("xk-core/" + public, rel)
        for specifier in DYNAMIC_IMPORT.findall(text):
            dependency = _resolve(rel, specifier)
            if dependency and (target / dependency).is_file():
                queue.append(dependency)
    return loaded, missing


def _bridges(target: Path) -> list[str]:
    assets = target / "static" / "frontend-build" / "assets"
    return sorted(path.relative_to(target).as_posix() for path in assets.glob("*-bridge.js"))


def test_browser_walk_detects_missing_runtime_core_source(tmp_path):
    build = tmp_path / "static/frontend-build"
    (build / ".vite").mkdir(parents=True)
    (build / "assets").mkdir()
    (build / "assets/core.js").write_text("export {}", encoding="utf-8")
    (build / ".vite/manifest.build.json").write_text(
        json.dumps({"js/features/shared.js": {"file": "assets/core.js"}}), encoding="utf-8"
    )
    root = "static/frontend-build/module.js"
    (tmp_path / root).write_text('import "xk-core/js/features/shared.js";', encoding="utf-8")

    _, missing = _browser_walk(tmp_path, [root])
    assert missing == {"xk-core/js/features/shared.js": root}


def test_pages_of_an_installed_profile_have_every_static_import(installed):
    profile, target = installed
    bridges = _bridges(target)
    assert "static/frontend-build/assets/panel-bridge.js" in bridges, profile

    loaded, missing = _browser_walk(target, bridges)

    assert missing == {}, profile
    assert "static/js/pages/panel.entry.js" in loaded, profile
    assert "static/js/pages/panel.module_loader.js" in loaded, profile


def test_installed_xray_chunks_find_their_runtime_core_sources(installed):
    profile, target = installed
    if profile == "mihomo-minimal":
        pytest.skip("only profiles with Xray load its chunks")
    module = target / "static/frontend-build/modules/engine.xray"
    chunks = sorted(path.relative_to(target).as_posix() for path in module.glob("*.js"))
    assert chunks, profile
    loaded, missing = _browser_walk(target, chunks)
    assert "static/js/features/module_parts.js" in loaded, profile
    assert missing == {}, profile


def test_installed_templates_reference_only_installed_static_files(installed):
    profile, target = installed
    missing = {}
    for path in (target / "templates").rglob("*.html"):
        rel = path.relative_to(target).as_posix()
        for filename in STATIC_REFERENCE.findall(path.read_text(encoding="utf-8")):
            if not (target / "static" / filename).is_file():
                missing.setdefault(filename, rel)

    assert missing == {}, profile


def test_minimal_profiles_still_leave_optional_modules_out(installed):
    # The walk installs static imports only: an optional module is reached
    # through import() and has to stay out of a smaller profile.
    profile, target = installed
    script_root = target / "static" / "js"

    expected_absent = {
        "xray-minimal": ["pages/panel.mihomo.bundle.js", "features/mihomo_panel.js",
                         "features/mihomo_generator.js", "pages/mihomo_generator.entry.js",
                         "pages/file_manager.lazy.entry.js", "pages/panel.editor.monaco.bundle.js",
                         "pages/backups.entry.js", "features/resource_monitor.js",
                         "features/backups.js"],
        "mihomo-minimal": ["features/xray_logs.js",
                           "features/routing_templates.js", "pages/file_manager.lazy.entry.js",
                           "pages/panel.editor.monaco.bundle.js", "pages/backups.entry.js",
                           "features/resource_monitor.js", "features/backups.js"],
        "full": [],
    }[profile]
    variant = json.loads((target / "install-profile.json").read_text(encoding="utf-8"))["editor_variant"]
    if variant != "light" and "pages/panel.editor.monaco.bundle.js" in expected_absent:
        expected_absent.remove("pages/panel.editor.monaco.bundle.js")
    for name in expected_absent:
        assert not (script_root / name).exists(), f"{profile}: {name}"


def test_mihomo_minimal_profile_has_no_xray_module_files(installed):
    profile, target = installed
    if profile != "mihomo-minimal":
        pytest.skip("only the Mihomo profile excludes Xray")
    build = target / "static/frontend-build"
    assert not (build / "modules/engine.xray").exists()
    assert not (build / ".vite/module.engine.xray.json").exists()
