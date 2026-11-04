"""Guards of the line between the core and the modules built apart from it."""

from __future__ import annotations

import json
import posixpath
import re
import shutil
import subprocess
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
    assert separate_modules() == {
        "tool.advanced-diagnostics": "js/features/resource_monitor.js",
        "engine.xray": "js/pages/xray.module.entry.js",
    }


def test_xray_build_has_only_its_directory() -> None:
    manifest = BUILD / '.vite/manifest.build.json'
    if not manifest.is_file():
        pytest.skip('frontend build not found')
    entries = json.loads(manifest.read_text(encoding='utf-8'))
    assert [entry['src'] for entry in entries.values()
            if entry.get('src') and owner(entry['src']) == 'engine.xray'] == []


def test_build_files_of_xray_names_are_core_outside_the_module() -> None:
    assert owner('static/js/pages/panel.routing.bundle.js') == 'core'
    assert owner('static/frontend-build/assets/panel.routing.bundle-X.js') == 'core'
    assert owner('static/frontend-build/assets/xk-core-0123456789-X.js') == 'core'
    assert owner('static/frontend-build/modules/engine.xray/routing-X.js') == 'engine.xray'
    assert owner('static/frontend-build/assets/panel.mihomo.bundle-X.js') == 'engine.mihomo'


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
            target = resolve(relative, specifier.split('?', 1)[0])
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
            if specifier == 'xk-module/engine.xray':
                if relative in _XRAY_DYNAMIC_IMPORTERS:
                    allowed_seen.append(relative)
                else:
                    offenders.append(f'{relative} -> {specifier}')
                continue
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


XRAY = "engine.xray"


def _js_sources() -> list[tuple[str, Path]]:
    return [
        (source.relative_to(STATIC).as_posix(), source)
        for source in sorted((STATIC / "js").rglob("*.js"))
        if not source.relative_to(STATIC).as_posix().startswith("js/vendor/npm/")
    ]


def test_xray_sources_reach_core_only_by_public_name() -> None:
    offenders: list[str] = []
    xray_files = 0
    public_names = 0

    for relative, source in _js_sources():
        if package_owner("static/" + relative) != XRAY:
            continue
        xray_files += 1
        text = _SOURCE_COMMENTS.sub("", source.read_text(encoding="utf-8"))
        specifiers = static_specifiers(text, strip_comments=False) + _DYNAMIC_IMPORT.findall(text)
        for specifier in specifiers:
            if specifier.startswith("xk-core/"):
                public_names += 1
                continue
            target = resolve(relative, specifier.split("?", 1)[0])
            if target is not None and package_owner("static/" + target) != XRAY:
                offenders.append(f"{relative} -> {specifier}")

    # The walk must have seen the module and its way into the core.
    assert xray_files >= 40
    assert public_names >= 30
    assert offenders == []


def core_public_paths() -> list[str]:
    """`collectCorePublicPaths` of vite.config.mjs: what the core publishes."""

    if shutil.which("node") is None:
        pytest.skip("node is not available in this environment")
    script = (
        "import { collectCorePublicPaths, staticRoot } from './vite.config.mjs';\n"
        "console.log(JSON.stringify(collectCorePublicPaths(staticRoot)));\n"
    )
    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# What the Xray module imports from the core build by the name xk-core/<path>.
# A path here is a promise to every module built against it: renaming or
# removing one is a release of the panel and of the modules that use it.
CORE_PUBLIC_SURFACE = [
    "js/features/backup_actions_loader.js",
    "js/features/core_source.js",
    "js/features/dns_guard_text.js",
    "js/features/dns_operation_recovery.js",
    "js/features/module_parts.js",
    "js/features/restart_log.js",
    "js/features/xkeen_runtime.js",
    "js/features/xkeen_texts.js",
    "js/features/xray_log_line_class.js",
    "js/ui/config_dirty_state.js",
    "js/ui/config_shell.js",
    "js/ui/country_flags.js",
    "js/ui/editor_schema.js",
    "js/ui/formatters.js",
    "js/ui/happ_decryptor_link.js",
    "js/ui/operator_icons.js",
    "js/ui/prettier_loader.js",
    "js/ui/schema_quickfixes.js",
    "js/ui/schema_semantic_validation.js",
    "js/util/strip_json_comments.js",
    "js/vendor/codemirror_json_schema.js",
]


def test_core_public_surface_is_listed() -> None:
    assert core_public_paths() == CORE_PUBLIC_SURFACE


def test_core_public_surface_belongs_to_core() -> None:
    # The core build carries the editor too, and Xray does not install without
    # it: a profile that has Xray has every package Xray depends on.
    allowed = set(builder._registry_definition(ROOT, XRAY).dependencies)
    assert allowed == {"core", "tool.editor"}
    offenders: list[str] = []
    paths = core_public_paths()
    assert "js/features/module_parts.js" in paths

    advanced_editor: list[str] = []
    for public in paths:
        assert (STATIC / public).is_file(), public
        by_package = package_owner("static/" + public)
        by_name = owner("static/" + public)
        if by_name == "editor-full":
            # The installer leaves these out of the light editor unless a kept
            # file imports them statically: tests/test_installer_xk_core_closure.py
            # checks that it follows such names.
            advanced_editor.append(public)
            by_name = "tool.editor"
        if by_package not in allowed or by_name not in allowed:
            offenders.append(f"{public}: package {by_package}, name {by_name}")

    assert offenders == []
    assert advanced_editor == [
        "js/ui/prettier_loader.js",
        "js/ui/schema_quickfixes.js",
        "js/ui/schema_semantic_validation.js",
    ]


# A quoted string that does not start right after a word or another quote, so
# the gap between two literals on one line is not taken for one.
_STRING_LITERAL = re.compile(r"""(?<![\w'"`\\])(['"])([^'"`\\\n]{12,}?)\1(?![\w'"`])""")
_CODE_LIKE = re.compile(r"[(){};=]|\?\s|\|\||&&|\.js$")


def _distinctive_literals(public: str, texts: dict[str, str]) -> list[str]:
    """Plain text literals of one source that no other source of static/js has."""

    found: list[str] = []
    for match in _STRING_LITERAL.finditer(_SOURCE_COMMENTS.sub("", texts[public])):
        literal = match.group(2)
        if _CODE_LIKE.search(literal) or not re.search(r"[A-Za-zА-Яа-я]{4}", literal):
            continue
        if literal not in found and all(literal not in text for other, text in texts.items() if other != public):
            found.append(literal)
    return found


def test_importmap_targets_are_the_chunks_core_loads() -> None:
    manifest_path = BUILD / ".vite" / "manifest.build.json"
    if not manifest_path.is_file() or not (BUILD / "assets").is_dir():
        pytest.skip("frontend build not found: run npm run frontend:build")
    from services.frontend_importmap import build_core_importmap

    # The pages of today run the sources through bridges, and the importmap
    # then gives the prefix (tests/test_frontend_importmap.py). This is what a
    # page running the built graph would get: each entry's own file.
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    paths = core_public_paths()
    importmap = build_core_importmap(manifest, {public: public for public in paths})
    texts = {relative: source.read_text(encoding="utf-8") for relative, source in _js_sources()}
    built = {
        item.relative_to(STATIC).as_posix(): item.read_text(encoding="utf-8")
        for item in sorted((BUILD / "assets").glob("*.js"))
    }
    offenders: list[str] = []
    checked_bodies: set[str] = set()

    for public in paths:
        entry = manifest.get(public)
        if not isinstance(entry, dict) or entry.get("isEntry") is not True:
            offenders.append(f"{public}: not an entry of the core build")
            continue
        target = importmap.get("xk-core/" + public)
        if target != f"frontend-build/{entry['file']}":
            offenders.append(f"{public}: importmap {target!r}, manifest {entry['file']!r}")
        # The body of a public file is emitted once: the entry itself or a
        # shared chunk the entry re-exports. A second copy would be a second
        # instance of its state. A literal that only this source has marks the
        # body; the minifier keeps such text as it is.
        for literal in _distinctive_literals(public, texts):
            holders = [name for name, text in built.items() if literal in text]
            if holders:
                checked_bodies.add(public)
            if len(holders) > 1:
                offenders.append(f"{public}: {literal!r} in {holders}")

    targets = [value for key, value in importmap.items() if key.startswith("xk-core/js/")]
    assert len(targets) == len(set(targets))
    # Most public files have such a mark, or a green run proves nothing.
    assert len(checked_bodies) >= len(paths) * 2 // 3, sorted(set(paths) - checked_bodies)
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
