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


MODULE_IDS = (
    "core", "engine.xray", "engine.mihomo", "tool.editor", "tool.terminal",
    "tool.files", "tool.backups", "integration.happ", "tool.advanced-diagnostics",
)
PRESETS = {
    "full": MODULE_IDS,
    "legacy-full": MODULE_IDS,
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
    "tool.backups": ("templates/backups.html",),
    "integration.happ": ("routes/happ_decryptor.py", "services/happ_decryptor/__init__.py"),
    "tool.advanced-diagnostics": ("routes/devtools.py", "templates/devtools.html"),
}
STATE_FILES = {"modules.json", "module-installed.json", "install-profile.json", "install-managed.json"}
USER_TOP_LEVEL = {"xray-jsonc", "var", "bin"}
USER_FILES = {"secret.key", "devtools.env", "ui-settings.json", "branding.json", "terminal_theme.json", "terminal_theme.css"}
USER_PREFIXES = ("opt/etc/mihomo/profiles/", "opt/etc/mihomo/backup/")


def _user_owned(rel: str) -> bool:
    return (
        rel in STATE_FILES or rel in USER_FILES or rel == "install.sh"
        or rel == "opt/etc/mihomo/config.yaml"
        or rel.startswith(USER_PREFIXES)
        or rel.split("/", 1)[0] in USER_TOP_LEVEL
    )


class ProfileInstallError(RuntimeError):
    pass


def owner(path: str) -> str:
    """Conservative file ownership: ambiguous shared files stay with core."""
    p = path.replace("\\", "/").lower()
    if p.startswith("js/") or p.startswith("schemas/"):
        p = "static/" + p
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
        if "/.vite/" in p or name == "manifest.json":
            return "core"
        for token, module in (
            ("panel.routing.bundle", "engine.xray"),
            ("panel.mihomo.bundle", "engine.mihomo"),
            ("mihomo_generator", "engine.mihomo"),
            ("terminal.lazy", "tool.terminal"),
            ("file_manager", "tool.files"),
            ("backups", "tool.backups"),
            ("devtools", "tool.advanced-diagnostics"),
            ("editor_monaco", "editor-full"),
        ):
            if token in name:
                return module
        if any(token in name for token in ("mihomo", "clash")):
            return "engine.mihomo"
        if any(token in name for token in ("xray", "routing", "inbounds", "outbounds")):
            return "engine.xray"
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
        }:
            return "core"
        if p.startswith(("services/devtools/", "services/fs_common/")):
            return "core"
        if "happ_decryptor" in p or "mihomo_hwid" in p:
            return "integration.happ"
        if any(token in p for token in ("/fs/", "/remotefs/", "/fileops/", "/fs_common/", "filemanager", "storage_usb")):
            return "tool.files"
        if any(token in p for token in ("/devtools/", "devtools.py", "resource_monitor", "router_diagnostics", "system_resources")):
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
        if "devtools" in p:
            return "tool.advanced-diagnostics"
    if p.startswith("templates/"):
        if "mihomo" in p:
            return "engine.mihomo"
        if "xray" in p or "routing" in p:
            return "engine.xray"
        if "backups" in p:
            return "tool.backups"
        if "devtools" in p:
            return "tool.advanced-diagnostics"
    if p.startswith("opt/etc/mihomo/"):
        return "engine.mihomo"
    if p.startswith("opt/etc/xray/"):
        return "engine.xray"
    return "core"


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
    queue = list(selected_entries)
    while queue:
        entry = entries[queue.pop()]
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


_JS_FROM_IMPORT = re.compile(r"""\bfrom\s*['"](\.{1,2}/[^'"]+)['"]""")
_JS_BARE_IMPORT = re.compile(r"""^\s*import\s*['"](\.{1,2}/[^'"]+)['"]""", re.MULTILINE)
_JS_DYNAMIC_IMPORT = re.compile(r"""\bimport\(\s*['"](\.{1,2}/[^'"]+)['"]\s*\)""")
_TEMPLATE_STATIC_SCRIPT = re.compile(r"""filename\s*=\s*['"]([^'"]+\.m?js)['"]""")


def _js_dependency(rel: str, specifier: str) -> str | None:
    path = specifier.split("?", 1)[0].split("#", 1)[0]
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


def apply_profile(source: Path, target: Path, profile: str, *, module_ids=None, transaction_root=None) -> Path:
    source, target = Path(source).resolve(), Path(target).resolve()
    if source == target or source in target.parents or target in source.parents:
        raise ProfileInstallError("source and target must be separate directories")
    selected = _selected(profile, module_ids)
    variant = "full" if profile in ("full", "legacy-full") else "light"
    old_state_path = target / "modules.json"
    if old_state_path.is_file():
        try:
            old_state = json.loads(old_state_path.read_text(encoding="utf-8"))
            if old_state.get("profile") == profile:
                old_variant = old_state.get("editor", {}).get("variant")
                if old_variant in ("light", "full", "advanced"):
                    variant = old_variant
        except (OSError, ValueError, AttributeError):
            pass
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
    try:
        raw_managed = json.loads(old_manifest.read_text(encoding="utf-8"))["paths"]
        if not isinstance(raw_managed, list) or any(not isinstance(item, str) or not _safe_managed_path(item) for item in raw_managed):
            raise ValueError("invalid managed manifest")
        managed = {item for item in raw_managed if not _user_owned(item)}
    except (OSError, ValueError, KeyError, TypeError):
        managed = {
            rel for rel, _ in _files(target, source=False)
            if owner(rel) != "core" or rel.endswith(".gz") or rel.startswith("static/frontend-build/")
        }
    managed.update(STATE_FILES)
    managed.update(rel for rel, _ in _files(target, source=False) if rel.startswith("static/") and rel.endswith(".gz"))
    touched = set(source_files) | managed
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
    _write_json(root / "transaction.json", {"target": str(target), "absent": absent, "touched": sorted(touched)})
    try:
        for rel in sorted(managed - set(source_files) - STATE_FILES):
            destination = target / rel
            if destination.is_file():
                quarantine = root / "quarantine" / rel
                quarantine.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(destination, quarantine)
        for rel, path in source_files.items():
            destination = target / rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
        if frontend:
            _write_json(target / "static/frontend-build/.vite/manifest.build.json", frontend[1])
            if (source / "static/frontend-build/.vite/manifest.json").is_file():
                _write_json(target / "static/frontend-build/.vite/manifest.json", frontend[2])
        _write_json(target / "modules.json", _state(profile, selected, variant))
        _write_json(target / "module-installed.json", {"schema_version": 1, "modules": {
            module: module in selected and all((target / marker).is_file() for marker in INSTALL_MARKERS[module])
            for module in MODULE_IDS
        }})
        _write_json(target / "install-profile.json", {"schema_version": 1, "profile": profile, "module_ids": [module for module in MODULE_IDS if module in selected], "editor_variant": variant})
        _write_json(target / "install-managed.json", {"schema_version": 1, "paths": sorted(source_files)})
    except Exception:
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
    # Quarantine is retained for manual inspection and recovery on the router.
    return Path(root)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("apply", "commit", "rollback"))
    parser.add_argument("--source")
    parser.add_argument("--target")
    parser.add_argument("--profile")
    parser.add_argument("--module-ids", default="")
    parser.add_argument("--transaction")
    args = parser.parse_args(argv)
    if args.action == "apply":
        selected = args.module_ids.split(",") if args.module_ids else None
        print(apply_profile(args.source, args.target, args.profile, module_ids=selected, transaction_root=args.transaction))
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
