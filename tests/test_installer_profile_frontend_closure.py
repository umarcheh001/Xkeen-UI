"""An installed profile must contain every script its pages load.

Pages load the source modules under ``static/js``. A module graph with one
missing file does not start at all, so a profile that leaves out a statically
imported script installs a panel whose scripts never run: the status stays at
"checking", there is no editor and the tabs do not switch.
"""

from __future__ import annotations

import importlib.util
import posixpath
import re
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "xkeen-ui"
SCRIPT = SOURCE / "scripts" / "module_profile_install.py"

FROM_IMPORT = re.compile(r"""\bfrom\s*['"](\.{1,2}/[^'"]+)['"]""")
BARE_IMPORT = re.compile(r"""^\s*import\s*['"](\.{1,2}/[^'"]+)['"]""", re.MULTILINE)
DYNAMIC_IMPORT = re.compile(r"""\bimport\(\s*['"](\.{1,2}/[^'"]+)['"]\s*\)""")
STATIC_REFERENCE = re.compile(r"""url_for\(\s*['"]static['"]\s*,\s*filename\s*=\s*['"]([^'"]+)['"]""")

PROFILES = ("xray-minimal", "mihomo-minimal", "full")


def _helper():
    spec = importlib.util.spec_from_file_location("module_profile_install_closure", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module", params=PROFILES)
def installed(request, tmp_path_factory):
    target = tmp_path_factory.mktemp(request.param) / "panel"
    helper = _helper()
    helper.commit_profile(helper.apply_profile(SOURCE, target, request.param))
    return request.param, target


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
        for specifier in DYNAMIC_IMPORT.findall(text):
            dependency = _resolve(rel, specifier)
            if dependency and (target / dependency).is_file():
                queue.append(dependency)
    return loaded, missing


def _bridges(target: Path) -> list[str]:
    assets = target / "static" / "frontend-build" / "assets"
    return sorted(path.relative_to(target).as_posix() for path in assets.glob("*-bridge.js"))


def test_pages_of_an_installed_profile_have_every_static_import(installed):
    profile, target = installed
    bridges = _bridges(target)
    assert "static/frontend-build/assets/panel-bridge.js" in bridges, profile

    loaded, missing = _browser_walk(target, bridges)

    assert missing == {}, profile
    assert "static/js/pages/panel.entry.js" in loaded, profile
    assert "static/js/pages/panel.module_loader.js" in loaded, profile


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
                         "pages/backups.entry.js", "pages/devtools.entry.js",
                         "features/backups.js"],
        "mihomo-minimal": ["pages/panel.routing.bundle.js", "features/xray_logs.js",
                           "features/routing_templates.js", "pages/file_manager.lazy.entry.js",
                           "pages/panel.editor.monaco.bundle.js", "pages/backups.entry.js",
                           "pages/devtools.entry.js", "features/backups.js"],
        "full": [],
    }[profile]
    for name in expected_absent:
        assert not (script_root / name).exists(), f"{profile}: {name}"
