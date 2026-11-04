"""Guards of the line between the core and the modules built apart from it."""

from __future__ import annotations

import posixpath
import re
from pathlib import Path

import pytest

from scripts import build_modular_panel_release as builder
from tests.support.panel_render import ROOT


PANEL = ROOT / "xkeen-ui"
STATIC = PANEL / "static"
BUILD = STATIC / "frontend-build"


def separate_modules() -> dict[str, str]:
    """`SEPARATE_MODULES` of vite.module.config.mjs: module id to its entry file."""

    text = (ROOT / "vite.module.config.mjs").read_text(encoding="utf-8")
    table = re.search(r"SEPARATE_MODULES\s*=\s*\{(.*?)\n\};", text, re.S).group(1)
    return dict(re.findall(r"'([^']+)'\s*:\s*\{\s*entry:\s*'([^']+)'", table))


def owner(path: str) -> str:
    return builder._stage7_module().owner(path)


_PACKAGE_OWNERS: dict[str, str] | None = None


def package_owner(path: str) -> str:
    """Owner of a `static/js/...` file by the package map the release is cut by."""

    global _PACKAGE_OWNERS
    if _PACKAGE_OWNERS is None:
        ownership = builder.build_module_ownership(ROOT)
        _PACKAGE_OWNERS = {
            relative: ("tool.editor" if module_id == "editor-full" else module_id)
            for module_id, paths in ownership.items()
            for relative in paths
        }
    return _PACKAGE_OWNERS.get(path, "core")


def test_logs_shell_belongs_to_xray() -> None:
    assert package_owner("static/js/pages/logs_shell.shared.js") == "engine.xray"


def test_package_owner_follows_overrides() -> None:
    assert package_owner("static/js/features/github.js") == "engine.xray"
    assert package_owner("static/js/features/xray_log_line_class.js") == "core"


_SOURCE_COMMENTS = re.compile(r"/\*.*?\*/|(?<![:\w'\"`])//[^\n]*", re.S)
_STATIC_FROM = re.compile(r"""\b(?:import|export)\s*(?:[\w$*{},\s]*?)\s*from\s*["']([^"']+)["']""")
_STATIC_BARE = re.compile(r"""\bimport\s*["']([^"']+)["']""")


def static_specifiers(text: str, *, strip_comments: bool) -> list[str]:
    """Specifiers of static `import`/`export ... from`; `import()` is not static."""

    if strip_comments:
        text = _SOURCE_COMMENTS.sub("", text)
    return _STATIC_FROM.findall(text) + _STATIC_BARE.findall(text)


def resolve(importer: str, specifier: str) -> str | None:
    """Path of a relative specifier under static/, None for a bare name."""

    if specifier.startswith("/static/"):
        return specifier[len("/static/") :]
    if not specifier.startswith("."):
        return None
    return posixpath.normpath(posixpath.join(posixpath.dirname(importer), specifier))


def test_separate_modules_table_is_read() -> None:
    assert separate_modules() == {"tool.advanced-diagnostics": "js/features/resource_monitor.js"}


def test_no_static_import_crosses_a_separated_module_boundary() -> None:
    modules = separate_modules()
    assert modules
    offenders: list[str] = []
    seen_owners: set[str] = set()

    # Sources: the core does not import the module's files, the module does not
    # import the core's (the core is reached by a bare name, `xk-core/...`).
    for source in sorted((STATIC / "js").rglob("*.js")):
        relative = source.relative_to(STATIC).as_posix()
        who = package_owner("static/" + relative)
        seen_owners.add(who)
        text = source.read_text(encoding="utf-8")
        for specifier in static_specifiers(text, strip_comments=True):
            target = resolve(relative, specifier)
            if target is None:
                if who in modules and specifier.startswith(("assets/", "frontend-build/")):
                    offenders.append(f"{relative} -> {specifier}")
                continue
            there = package_owner("static/" + target)
            if who != there and (who in modules or there in modules):
                offenders.append(f"{relative} ({who}) -> {target} ({there})")

    # The walk must have looked at both sides, or a green run proves nothing.
    assert "core" in seen_owners
    for module_id in modules:
        assert module_id in seen_owners, module_id

    assert offenders == []


def test_built_bundles_do_not_cross_a_separated_module_boundary() -> None:
    modules = separate_modules()
    if not all((BUILD / "modules" / module_id).is_dir() for module_id in modules) or not (BUILD / "assets").is_dir():
        pytest.skip("frontend build not found: run npm run frontend:build")
    offenders: list[str] = []
    module_bundles = 0
    core_bundles = 0

    # The build: the module's bundle imports nothing outside its own directory
    # (no relative path into the core, no core chunk `assets/*`); the core's
    # bundles do not import the module's directory.
    for module_id in modules:
        module_dir = f"frontend-build/modules/{module_id}"
        for built in sorted((BUILD / "modules" / module_id).glob("*.js")):
            module_bundles += 1
            relative = f"{module_dir}/{built.name}"
            for specifier in static_specifiers(built.read_text(encoding="utf-8"), strip_comments=False):
                target = resolve(relative, specifier)
                if specifier.startswith("assets/") or "/assets/" in specifier:
                    offenders.append(f"{relative} -> {specifier}")
                elif target is not None and posixpath.dirname(target) != module_dir:
                    offenders.append(f"{relative} -> {target}")
    for built in sorted(BUILD.rglob("*.js")):
        relative = built.relative_to(STATIC).as_posix()
        if relative.startswith("frontend-build/modules/"):
            continue
        core_bundles += 1
        for specifier in static_specifiers(built.read_text(encoding="utf-8"), strip_comments=False):
            target = resolve(relative, specifier)
            if target is not None and target.startswith("frontend-build/modules/"):
                offenders.append(f"{relative} -> {target}")

    assert module_bundles >= 1
    assert core_bundles >= 1
    assert offenders == []


def test_xray_module_files_are_owned_by_xray_and_its_loader_by_the_core() -> None:
    assert package_owner("static/js/pages/xray.module.entry.js") == "engine.xray"
    assert package_owner("static/js/pages/xray.module.bundle.js") == "engine.xray"
    assert package_owner("static/js/pages/panel.routing.bundle.js") == "core"
    assert package_owner("static/js/features/module_parts.js") == "core"


_DYNAMIC_IMPORT = re.compile(r"""\bimport\s*\(\s*["'`]([^"'`$]+)["'`]""")

# The only core files that may name a file of the Xray module in `import()`:
# the shared bridge of module parts and the loader of the Xray screens.
_XRAY_DYNAMIC_IMPORTERS = {
    "js/features/module_parts.js",
    "js/pages/panel.routing.bundle.js",
}


def test_core_reaches_xray_only_through_module_parts() -> None:
    offenders: list[str] = []
    allowed_seen: list[str] = []
    core_files = 0

    for source in sorted((STATIC / "js").rglob("*.js")):
        relative = source.relative_to(STATIC).as_posix()
        if package_owner("static/" + relative) != "core":
            continue
        core_files += 1
        text = _SOURCE_COMMENTS.sub("", source.read_text(encoding="utf-8"))
        for specifier in _DYNAMIC_IMPORT.findall(text):
            target = resolve(relative, specifier.split("?", 1)[0])
            if target is None or package_owner("static/" + target) != "engine.xray":
                continue
            crossing = f"{relative} -> {target}"
            if relative in _XRAY_DYNAMIC_IMPORTERS:
                allowed_seen.append(crossing)
            else:
                offenders.append(crossing)

    # The walk must have looked at core files and found the allowed way in,
    # or a green run proves nothing.
    assert core_files >= 100
    assert allowed_seen
    assert offenders == []


# Core files that mention the diagnostics module or its history on purpose:
# the placeholder of the header summary, and the sensors and sums that the header
# summary and the Mihomo clients need without the module (see the owner overrides).
ALLOWED = {
    "templates/panel/slots/resource_monitor_unavailable.html",
    "services/system_resources.py",
    "services/system_resources_history/sensors.py",
    "services/router_diagnostics.py",
}

_MODULE_PATH_MARKERS = ("resource_monitor", "system_resources_history")
_TOP_LEVEL_IMPORT = re.compile(r"^(?:from|import)\s+(services\.system_resources_history[\w.]*|routes\.system_resources)", re.M)


def test_core_contains_no_module_marked_files(shared_panel_source_root: Path) -> None:
    core = builder.build_module_ownership(shared_panel_source_root)["core"]
    offenders: set[str] = set()
    for path in core:
        if any(token in path for token in _MODULE_PATH_MARKERS):
            offenders.add(path)
            continue
        source = PANEL / path
        if source.suffix != ".py" or not source.is_file():
            continue
        # A top-level import of a module's file makes the core fail without it.
        for imported in _TOP_LEVEL_IMPORT.findall(source.read_text(encoding="utf-8")):
            file = imported.replace(".", "/")
            candidates = [file + ".py", file + "/__init__.py"]
            if any(owner(item) != "core" for item in candidates if (PANEL / item).is_file()):
                offenders.add(path)

    assert offenders - ALLOWED == set()
    assert ALLOWED == {
        "templates/panel/slots/resource_monitor_unavailable.html",
        "services/system_resources.py",
        "services/system_resources_history/sensors.py",
        "services/router_diagnostics.py",
    }
