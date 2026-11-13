#!/usr/bin/env python3
"""Apply a panel profile to a single official archive payload.

The installer's process owns the transaction until its service health check
succeeds. Runtime state and user configuration are kept outside the managed
file list and are never inferred from arbitrary files in the destination.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import posixpath
import re
import shutil
import sys
import tempfile
from pathlib import Path, PurePosixPath


_PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(_PACKAGE_ROOT))

from services.module_profile_plan import ProfilePlanError, build_profile_target, user_owned as _profile_user_owned
from services.module_registry import (
    CHOSEN_KEY,
    ENGINE_CORES,
    OFF_REASON_CORE_MISSING,
    OFF_REASON_NOT_CHOSEN,
    OPTIONAL_PROFILE_MODULES,
    core_binary_available,
)


MODULE_IDS = (
    "core", "engine.xray", "engine.mihomo", "tool.editor", "tool.terminal",
    "tool.files", "tool.backups", "integration.happ", "tool.advanced-diagnostics",
    "tool.server-diagnostics",
)
# No preset installs an optional module: it takes an explicit choice.
_FULL_MODULE_IDS = tuple(module for module in MODULE_IDS if module not in OPTIONAL_PROFILE_MODULES)
PRESETS = {
    "full": _FULL_MODULE_IDS,
    "legacy-full": _FULL_MODULE_IDS,
    "xray-minimal": ("core", "engine.xray", "tool.editor"),
    "mihomo-minimal": ("core", "engine.mihomo", "tool.editor"),
}
INSTALL_MARKERS = {
    "core": ("services/module_registry.py",),
    "engine.xray": ("routes/routing/__init__.py", "services/xray_subscriptions.py"),
    "engine.mihomo": ("routes/mihomo.py", "services/mihomo_subscriptions.py"),
    "tool.editor": ("static/js/pages/codemirror6.shared.js",),
    "tool.terminal": ("static/js/pages/terminal.lazy.entry.js",),
    "tool.files": ("static/js/pages/file_manager.lazy.entry.js",),
    "tool.backups": ("routes/backups.py",),
    "integration.happ": ("routes/happ_decryptor.py", "services/happ_decryptor/__init__.py"),
    "tool.advanced-diagnostics": ("routes/system_resources.py", "static/js/features/resource_monitor.js"),
    "tool.server-diagnostics": ("routes/provider_diagnostics.py", "services/provider_diagnostics.py"),
}
OWNERSHIP_OVERRIDES = "module-ownership-overrides.json"
STATE_FILES = {"modules.json", "module-installed.json", "install-profile.json", "install-managed.json", OWNERSHIP_OVERRIDES}
USER_TOP_LEVEL = {"xray-jsonc", "var", "bin"}
USER_FILES = {"secret.key", "devtools.env", "ui-settings.json", "branding.json", "module-update-channel.json", "module-notifications.json", "xkeen-last-core.json"}
USER_PREFIXES = (
    "opt/etc/mihomo/profiles/",
    "opt/etc/mihomo/backup/",
    "templates/routing/",
    "templates/observatory/",
)


def _user_owned(rel: str) -> bool:
    return _profile_user_owned(rel)


class ProfileInstallError(RuntimeError):
    pass


# Build files of a module built apart from the panel: its directory and manifest.
_SEPARATE_MODULE_BUILD_FILE = re.compile(
    r"^static/frontend-build/(?:modules/([^/]+)/|\.vite/module\.(.+)\.json(?:\.gz)?$)"
)


_SERVER_DIAGNOSTICS_TOKENS = ("provider_diagnostics", "server_diagnostics", "server-diagnostics")
_SERVER_DIAGNOSTICS_CORE_FILES = frozenset({
    "static/js/features/provider_diagnostics_hint.js",
    "static/js/pages/panel.server_diagnostics.bundle.js",
})


def owner(path: str) -> str:
    """Conservative file ownership: ambiguous shared files stay with core."""
    p = path.replace("\\", "/").lower()
    if p.startswith("js/") or p.startswith("schemas/"):
        p = "static/" + p
    # The server diagnostics window, its styles and button slots. The hint in
    # the engine error messages and the loader of the module stay in the core.
    if not p.startswith("static/frontend-build/") and any(
        token in p.rsplit("/", 1)[-1] for token in _SERVER_DIAGNOSTICS_TOKENS
    ):
        return "core" if p.removesuffix(".gz") in _SERVER_DIAGNOSTICS_CORE_FILES else "tool.server-diagnostics"
    if p in ("static/js/pages/panel.routing.bundle.js", "static/js/pages/panel.mihomo.bundle.js", "static/js/pages/mihomo_generator.entry.js", "static/js/pages/mihomo_generator.shell.shared.js"):
        return "core"
    name = p.rsplit("/", 1)[-1]
    if name.startswith("_") and p.startswith("static/frontend-build/"):
        name = name[1:]
    if p.startswith("static/monaco-editor/") or p.startswith("static/vendor/npm/@monaco-editor/"):
        return "editor-full"
    if p.startswith("static/vendor/npm/") and any(token in p for token in ("prettier", "monaco")):
        return "editor-full"
    if p.startswith("static/js/vendor/monaco-"):
        return "editor-full"
    if p.startswith("static/frontend-build/"):
        separate = _SEPARATE_MODULE_BUILD_FILE.match(p)
        if separate:
            return separate.group(1) or separate.group(2)
        if "/.vite/" in p or name == "manifest.json":
            return "core"
        for token, module in (
            ("terminal.lazy", "tool.terminal"),
            ("file_manager", "tool.files"),
            ("backups", "tool.backups"),
            ("resource_monitor", "tool.advanced-diagnostics"),
            ("editor_monaco", "editor-full"),
        ):
            if token in name:
                return module
        if name.startswith("panel.editor."):
            return "tool.editor"
        return "core"
    if p.startswith("static/xterm/") or p.startswith("static/js/terminal/"):
        return "tool.terminal"
    if p.startswith("static/schemas/mihomo-"):
        return "engine.mihomo"
    if p.startswith("static/schemas/xray-"):
        return "engine.xray"
    if p.startswith("templates/panel/"):
        if p == "templates/panel/slots/diagnostics_actions.html":
            # The link to the DevTools page, which stays without the module.
            return "core"
        if "/slots/backups_" in p:
            return "tool.backups"
        if "/mihomo" in p or "core_source_mihomo" in p:
            return "engine.mihomo"
        if "/routing" in p or "/xray" in p or "core_source_xray" in p:
            return "engine.xray"
        if "/commands" in p:
            return "tool.terminal"
        if "/files" in p:
            return "tool.files"
        if "/diagnostics" in p:
            return "tool.advanced-diagnostics"
    if p.startswith("routes/") or p.startswith("services/"):
        if p in {
            "services/xkeen_commands_catalog.py", "services/command_jobs.py",
            "services/xray_assets.py", "services/xray_backups.py",
            "services/xray_config_files.py", "services/xray_logs.py",
            "services/mihomo_hwid_sub.py",
            "services/dns_over_vless.py", "services/mihomo_dns.py",
            "services/xray_subscriptions.py", "services/happ_links.py",
            "services/filemanager/metadata.py",
            "routes/devtools.py",
            # The header summary and the Mihomo clients need these without the
            # diagnostics module; see also _PACKAGE_OWNER_OVERRIDES of the builder.
            "services/router_diagnostics.py", "services/system_resources.py",
            "services/system_resources_history/sensors.py",
        }:
            return "core"
        if p.startswith(("services/devtools/", "services/fs_common/")):
            return "core"
        if "happ_decryptor" in p or "mihomo_hwid" in p:
            return "integration.happ"
        if any(token in p for token in ("/fs/", "/remotefs/", "/fileops/", "/fs_common/", "filemanager", "storage_usb")):
            return "tool.files"
        if any(token in p for token in ("resource_monitor", "system_resources")):
            return "tool.advanced-diagnostics"
        if any(token in p for token in ("commands.py", "command_jobs.py", "ws_pty.py")):
            return "tool.terminal"
        if name in ("backups.py", "xray_backups.py", "mihomo_backups.py"):
            return "tool.backups"
        if "mihomo" in p:
            return "engine.mihomo"
        if any(token in p for token in ("xray", "routing/", "dns_over_vless", "geodat/")):
            return "engine.xray"
    if p.startswith("static/js/patches/"):
        # Loaded by a plain script tag of every page, whatever its name says.
        return "core"
    if p == "static/js/features/xray_log_line_class.js":
        # Shared by the Xray logs and the diagnostics in spite of the name,
        # as in _PACKAGE_OWNER_OVERRIDES of the release builder.
        return "core"
    if p.startswith("static/js/"):
        if any(token in p for token in ("monaco", "prettier", "diff_modal", "schema_quickfix", "schema_semantic")):
            return "editor-full"
        if any(token in p for token in ("editor", "codemirror", "schema_snippet")):
            return "tool.editor"
        if any(token in p for token in ("mihomo", "clash")):
            return "engine.mihomo"
        if any(token in p for token in ("xray", "routing", "inbounds", "outbounds", "balancer")):
            return "engine.xray"
        if any(token in p for token in ("file_manager", "fileops")):
            return "tool.files"
        if "commands" in p:
            return "tool.terminal"
        if "backups" in p:
            return "tool.backups"
        if "resource_monitor" in p:
            return "tool.advanced-diagnostics"
    if p.startswith("templates/"):
        if "mihomo" in p:
            return "engine.mihomo"
        if "xray" in p or "routing" in p:
            return "engine.xray"
        if "backups" in p:
            return "tool.backups"
    if p.startswith("opt/etc/mihomo/"):
        return "engine.mihomo"
    if p.startswith("opt/etc/xray/"):
        return "engine.xray"
    return "core"


# Static forms only, minified ones included: `from"xk-core/..."`, `import"xk-core/..."`.
_BUILT_CORE_PUBLIC_IMPORT = re.compile(r"""(?:\bfrom|\bimport)\s*["'`]xk-core/([^"'`]+)["'`]""")


def _built_core_public_imports(build: Path, filename) -> list[str]:
    if not isinstance(filename, str) or not filename.endswith((".js", ".mjs")):
        return []
    try:
        text = (build / filename).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return []
    return _BUILT_CORE_PUBLIC_IMPORT.findall(text)


def _frontend_files(root: Path, selected: set[str], variant: str) -> tuple[set[str], dict, dict] | None:
    build = root / "static/frontend-build"
    manifest = build / ".vite/manifest.build.json"
    if not manifest.is_file():
        return None
    try:
        entries = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ProfileInstallError("invalid frontend build manifest")
    if not isinstance(entries, dict):
        raise ProfileInstallError("invalid frontend build manifest")
    allowed = {"core", *selected}
    if variant != "light":
        allowed.add("editor-full")
    selected_entries = {
        key for key, entry in entries.items()
        if isinstance(entry, dict) and owner(str(entry.get("src") or "static/frontend-build/" + str(entry.get("file") or key))) in allowed
    }
    # Separately built modules are outside the core manifest, but their static
    # xk-core imports require the same closure as imports from core chunks.
    for path in build.glob("modules/**/*.js"):
        if owner(path.relative_to(root).as_posix()) in allowed:
            for dependency in _built_core_public_imports(build, path.relative_to(build).as_posix()):
                if dependency in entries:
                    selected_entries.add(dependency)
    queue = list(selected_entries)
    while queue:
        entry = entries[queue.pop()]
        # A built chunk names a core file `xk-core/<path>`, which the manifest
        # does not list among its imports; the entry `<path>` must come along.
        # `import("xk-core/...")` stays optional, as dynamicImports do.
        for dependency in _built_core_public_imports(build, entry.get("file")):
            if dependency in entries and dependency not in selected_entries:
                selected_entries.add(dependency)
                queue.append(dependency)
        for dependency in entry.get("imports", []):
            if dependency in entries and dependency not in selected_entries:
                selected_entries.add(dependency)
                queue.append(dependency)
        for dependency in entry.get("dynamicImports", []):
            if dependency in entries and owner(str(entries[dependency].get("src") or "static/frontend-build/" + str(entries[dependency].get("file") or dependency))) in allowed and dependency not in selected_entries:
                selected_entries.add(dependency)
                queue.append(dependency)
    selected_manifest = {}
    for key in selected_entries:
        entry = dict(entries[key])
        for field in ("imports", "dynamicImports"):
            if field in entry:
                entry[field] = [dependency for dependency in entry[field] if dependency in selected_entries]
        selected_manifest[key] = entry
    files = {"static/frontend-build/.vite/manifest.build.json"}
    for key in selected_entries:
        entry = entries[key]
        for field in ("file", "css", "assets"):
            values = entry.get(field, [])
            if isinstance(values, str):
                values = [values]
            for name in values:
                files.add("static/frontend-build/" + name)
                if (build / (name + ".gz")).is_file():
                    files.add("static/frontend-build/" + name + ".gz")
    for path in (*build.glob("modules/**/*"), *build.glob(".vite/module.*")):
        rel = path.relative_to(root).as_posix()
        if path.is_file() and owner(rel) in allowed:
            files.add(rel)
    bridge = build / ".vite/manifest.json"
    selected_bridge = {}
    if bridge.is_file():
        files.add("static/frontend-build/.vite/manifest.json")
        try:
            for key, entry in json.loads(bridge.read_text(encoding="utf-8")).items():
                if isinstance(entry, dict) and owner(str(entry.get("src") or "")) in allowed:
                    selected_bridge[key] = entry
                    files.add("static/frontend-build/" + str(entry["file"]))
        except (OSError, ValueError, KeyError, TypeError):
            raise ProfileInstallError("invalid frontend bridge manifest")
    return files, selected_manifest, selected_bridge


def _files(root: Path, *, source: bool = True):
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            if source:
                raise ProfileInstallError(f"symlink in panel payload: {path}")
            continue
        if path.is_file():
            rel = path.relative_to(root).as_posix()
            if _user_owned(rel):
                continue
            yield rel, path


def _selected(profile: str, module_ids: list[str] | None):
    if profile == "custom":
        selected = set(module_ids or [])
        if not selected or selected - set(MODULE_IDS) or "core" not in selected:
            raise ProfileInstallError("invalid custom module set")
        if ("engine.xray" in selected or "engine.mihomo" in selected) and "tool.editor" not in selected:
            raise ProfileInstallError("custom profile requires tool.editor")
    elif profile in PRESETS:
        selected = set(PRESETS[profile])
    else:
        raise ProfileInstallError(f"unknown profile: {profile}")
    return selected


def _state(profile: str, selected: set[str], variant: str):
    return {
        "schema_version": 1,
        "profile": profile,
        "restart_required": False,
        "editor": {"variant": variant},
        "modules": {module: {"enabled": module in selected} for module in MODULE_IDS},
    }


def _write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".new")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def _safe_managed_path(value: str) -> bool:
    path = PurePosixPath(value)
    return bool(value) and "\\" not in value and not path.is_absolute() and ".." not in path.parts and ":" not in value


RETIRED_FILES = "retired-files.json"


def _retired_paths(source: Path, target: Path, shipped) -> set[str]:
    """Files earlier builds laid that this build no longer ships.

    The archive builder lists them from git history (retired-files.json). The
    managed manifest exists only since 2026-10-02: a first modular install
    over a release without it guesses the managed set, core files stay out of
    the guess, and code the new build dropped stayed on the router for good.
    Files of the owner and panel state are never taken, whatever the list says.
    """

    try:
        raw = json.loads((source / RETIRED_FILES).read_text(encoding="utf-8"))["paths"]
    except (OSError, ValueError, KeyError, TypeError):
        return set()
    if not isinstance(raw, list):
        return set()
    found = set()
    for rel in raw:
        if not isinstance(rel, str) or not _safe_managed_path(rel) or _user_owned(rel):
            continue
        if rel in STATE_FILES or rel in shipped:
            continue
        path = target / rel
        if path.is_file() and not path.is_symlink():
            found.add(rel)
    return found


def _include_python_dependencies(source: Path, selected_files: dict[str, Path]) -> None:
    queue = [rel for rel in selected_files if rel.endswith(".py")]
    scanned = set()
    while queue:
        rel = queue.pop()
        if rel in scanned:
            continue
        scanned.add(rel)
        if rel == "routes/__init__.py":
            continue
        path = source / rel
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=rel)
        except (OSError, UnicodeError, SyntaxError) as error:
            raise ProfileInstallError(f"invalid Python payload {rel}: {error}") from error
        current_package = rel.removesuffix("/__init__.py").removesuffix(".py").replace("/", ".")
        if not rel.endswith("/__init__.py"):
            current_package = current_package.rpartition(".")[0]
        candidates = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                candidates.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    parts = current_package.split(".") if current_package else []
                    base = ".".join(parts[:len(parts) - node.level + 1] + ([base] if base else []))
                candidates.add(base)
                candidates.update(base + "." + alias.name for alias in node.names if alias.name != "*")
        for name in candidates:
            if not name.startswith(("services.", "routes.", "core.")):
                continue
            stem = name.replace(".", "/")
            for dependency in (stem + ".py", stem + "/__init__.py"):
                dep_path = source / dependency
                if dep_path.is_file() and dependency not in selected_files:
                    selected_files[dependency] = dep_path
                    queue.append(dependency)


# A module reaches a file of the core by the name `xk-core/<path under static>`.
_CORE_PUBLIC_PREFIX = "xk-core/"
_JS_FROM_IMPORT = re.compile(r"""\bfrom\s*['"](\.{1,2}/[^'"]+|xk-core/[^'"]+)['"]""")
_JS_BARE_IMPORT = re.compile(r"""^\s*import\s*['"](\.{1,2}/[^'"]+|xk-core/[^'"]+)['"]""", re.MULTILINE)
_JS_DYNAMIC_IMPORT = re.compile(r"""\bimport\(\s*['"](\.{1,2}/[^'"]+|xk-core/[^'"]+)['"]\s*\)""")
_TEMPLATE_STATIC_SCRIPT = re.compile(r"""filename\s*=\s*['"]([^'"]+\.m?js)['"]""")


def _js_dependency(rel: str, specifier: str) -> str | None:
    path = specifier.split("?", 1)[0].split("#", 1)[0]
    if path.startswith(_CORE_PUBLIC_PREFIX):
        dependency = posixpath.normpath("static/" + path[len(_CORE_PUBLIC_PREFIX):])
    else:
        dependency = posixpath.normpath(posixpath.join(posixpath.dirname(rel), path))
    if not dependency.startswith("static/") or not dependency.endswith((".js", ".mjs")):
        return None
    return dependency


def _include_js_dependencies(source: Path, selected_files: dict[str, Path]) -> None:
    """Add every script that a page of this profile needs before it can start.

    Pages load the source modules, and a module graph with one missing file
    does not start at all. Ownership is decided by file name, so a script of
    the panel core may import a file that the name rules give to a module
    that is not selected.

    The walk starts where a browser does: the bridge entries and the scripts
    named by the templates. A static import is always installed. A dynamic
    ``import()`` is followed only into a file that is selected anyway: that
    is how an optional module stays out of a smaller profile.
    """

    queue = [
        rel for rel in selected_files
        if rel.startswith("static/frontend-build/assets/") and rel.endswith("-bridge.js")
    ]
    for rel in sorted(selected_files):
        if not (rel.startswith("templates/") and rel.endswith(".html")):
            continue
        try:
            markup = (source / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise ProfileInstallError(f"invalid template payload {rel}: {error}") from error
        for filename in _TEMPLATE_STATIC_SCRIPT.findall(markup):
            script = "static/" + filename
            if script in selected_files:
                queue.append(script)

    scanned = set()
    while queue:
        rel = queue.pop()
        if rel in scanned:
            continue
        scanned.add(rel)
        try:
            text = (source / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            raise ProfileInstallError(f"invalid script payload {rel}: {error}") from error
        for specifier in _JS_FROM_IMPORT.findall(text) + _JS_BARE_IMPORT.findall(text):
            dependency = _js_dependency(rel, specifier)
            if not dependency or _user_owned(dependency) or not (source / dependency).is_file():
                continue
            if dependency not in selected_files:
                selected_files[dependency] = source / dependency
                compressed = dependency + ".gz"
                if (source / compressed).is_file():
                    selected_files[compressed] = source / compressed
            queue.append(dependency)
        for specifier in _JS_DYNAMIC_IMPORT.findall(text):
            dependency = _js_dependency(rel, specifier)
            if dependency and dependency in selected_files:
                queue.append(dependency)


TRANSACTION_SUFFIX = ".profile-transaction-"


def _drop_older_transactions(target: Path, transaction_root) -> None:
    """Keep one transaction per panel: the one that is about to start.

    Every install leaves a full copy of the replaced files next to the panel
    for manual recovery. Only the latest copy is of any use, and without this
    each update would add another one to the router storage.
    """

    if not transaction_root:
        return
    current = Path(transaction_root).resolve()
    prefix = target.name + TRANSACTION_SUFFIX
    if current.parent != target.parent or not current.name.startswith(prefix):
        return
    for sibling in target.parent.glob(prefix + "*"):
        if sibling != current and sibling.is_dir() and not sibling.is_symlink():
            shutil.rmtree(sibling, ignore_errors=True)


_EDITOR_VARIANTS = ("light", "full", "advanced")


def _physical_profile(raw, source: str):
    """A profile record that can be installed as it stands, or ``None``."""

    if not isinstance(raw, dict):
        return None
    profile, modules, variant = raw.get("profile"), raw.get("module_ids"), raw.get("editor_variant")
    if profile not in (*PRESETS, "custom") or variant not in _EDITOR_VARIANTS:
        return None
    if (
        not isinstance(modules, list)
        or any(not isinstance(module, str) for module in modules)
        or "core" not in modules
        or set(modules) - set(MODULE_IDS)
    ):
        return None
    ordered = [module for module in MODULE_IDS if module in modules]
    # Only Full takes optional modules on top (with_optional); any other preset
    # with one is the owner's own set and is installed as it stands.
    optional = OPTIONAL_PROFILE_MODULES if profile in ("full", "legacy-full") else frozenset()
    if profile != "custom" and set(PRESETS[profile]) != set(ordered) - optional:
        # The record names a preset but something else is installed: what is
        # installed wins, a preset must not quietly add or take modules away.
        profile = "custom"
    return {"profile": profile, "module_ids": ordered, "editor_variant": variant, "source": source}


def current_install(target: Path):
    """What an update over an existing panel installs when no profile is chosen.

    A profile the owner asked for and has not applied yet comes first;
    otherwise it is what already lies on the storage. Module switches are not
    consulted: a module that is switched off stays installed.
    """

    target = Path(target)
    try:
        state = json.loads((target / "modules.json").read_text(encoding="utf-8"))
        request = _physical_profile(state.get("physical_request"), "request") if isinstance(state, dict) else None
    except (OSError, ValueError):
        request = None
    if request is not None:
        return request
    try:
        return _physical_profile(json.loads((target / "install-profile.json").read_text(encoding="utf-8")), "installed")
    except (OSError, ValueError):
        return None


def _keep_switches(document: dict, old_state, selected) -> dict:
    """The new module state with the owner's switches and settings carried over."""

    result = json.loads(json.dumps(document))
    if not isinstance(old_state, dict):
        return result
    if old_state.get("profile") in (*PRESETS, "custom"):
        result["profile"] = old_state["profile"]
    old_editor = old_state.get("editor")
    if isinstance(old_editor, dict) and old_editor.get("variant") in _EDITOR_VARIANTS:
        result["editor"] = {"variant": old_editor["variant"]}
    old_modules = old_state.get("modules")
    if isinstance(old_modules, dict):
        for module in selected:
            item = old_modules.get(module)
            if module != "core" and isinstance(item, dict) and item.get("enabled") is False:
                result["modules"][module]["enabled"] = False
                if item.get("off_reason") in (OFF_REASON_CORE_MISSING, OFF_REASON_NOT_CHOSEN):
                    result["modules"][module]["off_reason"] = item["off_reason"]
            if module in OPTIONAL_PROFILE_MODULES and isinstance(item, dict) and item.get(CHOSEN_KEY) is True:
                result["modules"][module][CHOSEN_KEY] = True
    return result


def _mark_chosen(document: dict, chosen) -> dict:
    """Optional modules the owner named in this install keep the mark of the choice."""

    result = json.loads(json.dumps(document))
    for module in chosen:
        item = result["modules"].get(module)
        if isinstance(item, dict) and item.get("enabled"):
            item[CHOSEN_KEY] = True
            item.pop("off_reason", None)
    return result


def _engines_by_cores(document: dict, profile: str, selected, detect) -> dict:
    """Full on a router with one core: the module of the missing core is
    installed switched off. Both cores or none — both stay on, nothing is guessed.

    Only for a first install or a profile chosen anew: an update keeps the
    owner's switches as they are.
    """

    if profile not in ("full", "legacy-full"):
        return document
    engines = [module for module in ENGINE_CORES if module in selected]
    found = [module for module in engines if detect(ENGINE_CORES[module])]
    if len(found) != 1 or len(engines) < 2:
        return document
    result = json.loads(json.dumps(document))
    for module in engines:
        if module not in found:
            result["modules"][module]["enabled"] = False
            result["modules"][module]["off_reason"] = OFF_REASON_CORE_MISSING
            print(f"[*] Ядро {ENGINE_CORES[module]} на роутере не найдено: его модуль установлен выключенным.")
    return result


def apply_profile(
    source: Path,
    target: Path,
    profile: str,
    *,
    module_ids=None,
    transaction_root=None,
    editor_variant=None,
    keep_switches: bool = False,
    detect_core=core_binary_available,
    with_optional=(),
) -> Path:
    source, target = Path(source).resolve(), Path(target).resolve()
    if source == target or source in target.parents or target in source.parents:
        raise ProfileInstallError("source and target must be separate directories")
    extras = set(with_optional or ())
    if extras and profile not in ("full", "legacy-full"):
        raise ProfileInstallError("optional modules are added to the full profile only")
    if extras - OPTIONAL_PROFILE_MODULES:
        raise ProfileInstallError(f"not an optional module: {sorted(extras - OPTIONAL_PROFILE_MODULES)}")
    selected = _selected(profile, module_ids)
    variant = "full" if profile in ("full", "legacy-full") else "light"
    old_state_path = target / "modules.json"
    old_state = None
    if old_state_path.is_file():
        try:
            old_state = json.loads(old_state_path.read_text(encoding="utf-8"))
            if old_state.get("profile") == profile:
                old_variant = old_state.get("editor", {}).get("variant")
                if old_variant in ("light", "full", "advanced"):
                    variant = old_variant
        except (OSError, ValueError, AttributeError):
            old_state = None
    if keep_switches and profile in ("full", "legacy-full") and isinstance(old_state, dict):
        # An update keeps the optional modules the owner chose before.
        old_modules = old_state.get("modules") if isinstance(old_state.get("modules"), dict) else {}
        extras |= {
            module for module in OPTIONAL_PROFILE_MODULES
            if isinstance(old_modules.get(module), dict) and old_modules[module].get(CHOSEN_KEY) is True
        }
    # Optional modules the owner names now: the choice is explicit.
    explicit = set(extras) if with_optional else set()
    if profile == "custom":
        explicit |= selected & OPTIONAL_PROFILE_MODULES
    selected |= extras
    plan_profile, plan_modules = profile, module_ids
    if extras:
        plan_profile = "custom"
        plan_modules = [module for module in MODULE_IDS if module in selected]
    if editor_variant is not None:
        if editor_variant not in _EDITOR_VARIANTS:
            raise ProfileInstallError(f"unknown editor variant: {editor_variant}")
        variant = editor_variant
    profile_target = None
    try:
        profile_target = build_profile_target(
            source,
            profile=plan_profile,
            module_ids=plan_modules,
            editor_variant=variant,
        )
    except ProfilePlanError as error:
        if error.code != "profile_ownership_unavailable":
            raise ProfileInstallError(str(error)) from error
    if profile_target is not None:
        selected = set(profile_target.module_ids)
        source_files = {relative: source / relative for relative in profile_target.payload_files}
        frontend = (
            {relative for relative in profile_target.payload_files if relative.startswith("static/frontend-build/")},
            profile_target.frontend["build"],
            profile_target.frontend["bridge"],
        )
    else:
        frontend = _frontend_files(source, selected, variant)
        frontend_files = frontend[0] if frontend else None
        source_files = {
            rel: path for rel, path in _files(source)
            if (rel in frontend_files if frontend_files is not None and rel.startswith("static/frontend-build/")
                else owner(rel) in selected or (owner(rel) == "editor-full" and variant != "light"))
        }
        _include_python_dependencies(source, source_files)
        _include_js_dependencies(source, source_files)
    missing_markers = {
        module: [marker for marker in INSTALL_MARKERS[module] if marker not in source_files]
        for module in selected
    }
    missing_markers = {module: markers for module, markers in missing_markers.items() if markers}
    if missing_markers:
        raise ProfileInstallError(f"selected modules lack install markers: {missing_markers}")
    old_manifest = target / "install-managed.json"
    # Without the manifest of the previous install the managed set is a
    # guess, and quarantine may hold files the panel never put there.
    guessed = False
    try:
        raw_managed = json.loads(old_manifest.read_text(encoding="utf-8"))["paths"]
        if not isinstance(raw_managed, list) or any(not isinstance(item, str) or not _safe_managed_path(item) for item in raw_managed):
            raise ValueError("invalid managed manifest")
        managed = {item for item in raw_managed if not _user_owned(item)}
    except (OSError, ValueError, KeyError, TypeError):
        guessed = True
        managed = {
            rel for rel, _ in _files(target, source=False)
            if owner(rel) != "core" or rel.endswith(".gz") or rel.startswith("static/frontend-build/")
        }
    managed.update(STATE_FILES)
    managed.update(rel for rel, _ in _files(target, source=False) if rel.startswith("static/") and rel.endswith(".gz"))
    retired = _retired_paths(source, target, set(source_files)) - managed
    touched = set(source_files) | managed | retired
    _drop_older_transactions(target, transaction_root)
    old_bytes = sum((target / rel).stat().st_size for rel in touched if (target / rel).is_file())
    new_bytes = sum(path.stat().st_size for path in source_files.values())
    required = old_bytes + new_bytes + max(new_bytes // 5, 1024 * 1024)
    target.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(target).free < required:
        raise ProfileInstallError("insufficient disk space for profile backup and install")
    root = Path(transaction_root) if transaction_root else Path(tempfile.mkdtemp(prefix="xkeen-profile-", dir=str(target.parent)))
    root.mkdir(parents=True, exist_ok=True)
    backup = root / "backup"
    absent = []
    for rel in sorted(touched):
        destination = target / rel
        if destination.is_symlink():
            raise ProfileInstallError(f"symlink in managed install: {destination}")
        if destination.is_file():
            copy = backup / rel
            copy.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(destination, copy)
        else:
            absent.append(rel)
    _write_json(root / "transaction.json", {"target": str(target), "absent": absent, "touched": sorted(touched), "guessed": guessed})
    try:
        for rel in sorted(managed - set(source_files) - STATE_FILES):
            destination = target / rel
            if destination.is_file():
                quarantine = root / "quarantine" / rel
                quarantine.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(destination, quarantine)
        # Unlike the guessed quarantine these are surely ours: the backup above
        # brings them back on rollback, commit drops them.
        for rel in sorted(retired):
            moved = root / "retired" / rel
            moved.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(target / rel, moved)
        for rel, path in source_files.items():
            destination = target / rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
        if frontend:
            _write_json(target / "static/frontend-build/.vite/manifest.build.json", frontend[1])
            if (source / "static/frontend-build/.vite/manifest.json").is_file():
                _write_json(target / "static/frontend-build/.vite/manifest.json", frontend[2])
        if profile_target is not None:
            for filename, document in profile_target.state_files.items():
                if filename in ("modules.json", "install-profile.json") and isinstance(document, dict):
                    # A preset with optional modules was laid as their exact set.
                    document = {**document, "profile": profile}
                if filename == "modules.json" and keep_switches:
                    document = _keep_switches(dict(document), old_state, selected)
                elif filename == "modules.json":
                    document = _engines_by_cores(dict(document), profile, selected, detect_core)
                if filename == "modules.json":
                    document = _mark_chosen(document, explicit)
                _write_json(target / filename, document)
        else:
            modules_document = _state(profile, selected, variant)
            if keep_switches:
                modules_document = _keep_switches(modules_document, old_state, selected)
            else:
                modules_document = _engines_by_cores(modules_document, profile, selected, detect_core)
            _write_json(target / "modules.json", _mark_chosen(modules_document, explicit))
            _write_json(target / "module-installed.json", {"schema_version": 1, "modules": {
                module: module in selected and all((target / marker).is_file() for marker in INSTALL_MARKERS[module])
                for module in MODULE_IDS
            }})
            _write_json(target / "install-profile.json", {"schema_version": 1, "profile": profile, "module_ids": [module for module in MODULE_IDS if module in selected], "editor_variant": variant})
            _write_json(target / "install-managed.json", {"schema_version": 1, "paths": sorted(source_files)})
        # Every module is laid from this archive now: the files of modules
        # updated on their own are gone, and so are their versions, which the
        # record of installed modules written above no longer carries.
        if (target / OWNERSHIP_OVERRIDES).exists():
            _write_json(target / OWNERSHIP_OVERRIDES, {"schema_version": 1, "modules": {}})
    except BaseException:
        # An interrupt (Ctrl+C, a closed SSH session) must not leave a panel
        # that is half old and half new.
        rollback_profile(root)
        raise
    return root


def rollback_profile(root: Path):
    root = Path(root)
    transaction = json.loads((root / "transaction.json").read_text(encoding="utf-8"))
    target = Path(transaction["target"])
    for rel in transaction["absent"]:
        (target / rel).unlink(missing_ok=True)
    for path in (root / "backup").rglob("*"):
        if path.is_file():
            destination = target / path.relative_to(root / "backup")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)


def commit_profile(root: Path):
    """Drop the transaction once the service has started.

    The copy of the replaced files is a full second panel on the router
    storage and has no use after a successful start. Quarantine holds panel
    files the new build no longer ships; nothing restores from it, so it goes
    too. It is kept only when the previous install had no manifest: then the
    managed set was guessed and quarantine may hold files of the user.
    """

    root = Path(root)
    try:
        guessed = bool(json.loads((root / "transaction.json").read_text(encoding="utf-8")).get("guessed"))
    except (OSError, ValueError, AttributeError):
        guessed = True
    quarantine = root / "quarantine"
    if not guessed or not any(path.is_file() for path in quarantine.rglob("*")):
        shutil.rmtree(root, ignore_errors=True)
        return root
    shutil.rmtree(root / "backup", ignore_errors=True)
    shutil.rmtree(root / "retired", ignore_errors=True)
    (root / "transaction.json").unlink(missing_ok=True)
    return root


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("apply", "commit", "rollback", "current"))
    parser.add_argument("--source")
    parser.add_argument("--target")
    parser.add_argument("--profile")
    parser.add_argument("--module-ids", default="")
    parser.add_argument("--transaction")
    parser.add_argument("--editor-variant")
    parser.add_argument("--keep-switches", action="store_true")
    parser.add_argument("--with-optional", action="append", default=[])
    args = parser.parse_args(argv)
    if args.action == "current":
        current = current_install(args.target)
        if current is None:
            raise SystemExit(1)
        # One value per line, for the shell of the installer.
        print(f"profile={current['profile']}")
        print(f"modules={','.join(current['module_ids'])}")
        print(f"variant={current['editor_variant']}")
        return
    if args.action == "apply":
        selected = args.module_ids.split(",") if args.module_ids else None
        # The installer names the transaction itself; the path printed back
        # only stood as a bare line in its log.
        apply_profile(
            args.source,
            args.target,
            args.profile,
            module_ids=selected,
            transaction_root=args.transaction,
            editor_variant=args.editor_variant,
            keep_switches=args.keep_switches,
            with_optional=[module for item in args.with_optional for module in item.split(",") if module],
        )
    elif args.action == "rollback":
        rollback_profile(args.transaction)
    else:
        commit_profile(args.transaction)


if __name__ == "__main__":
    try:
        main()
    except (ProfileInstallError, OSError, ValueError) as error:
        print(f"profile install failed: {error}", file=sys.stderr)
        raise SystemExit(1)
