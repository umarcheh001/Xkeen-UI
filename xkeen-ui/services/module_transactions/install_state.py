"""What the shared files of the panel must say after a module operation.

Files of a module are its own; these belong to every module at once: the
frontend manifests and the records the profile installer keeps. The functions
only compute the new bytes, the journal writes them so they can be undone.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from .ownership_overrides import OVERRIDES_FILENAME, overrides_document, parse_overrides
from .plan import PHYSICAL_REQUEST_KEY, Plan


# Same order as ``MODULE_IDS`` of the profile installer; a test keeps them equal.
MODULE_ORDER = (
    "core", "engine.xray", "engine.mihomo", "tool.editor", "tool.terminal",
    "tool.files", "tool.backups", "integration.happ", "tool.advanced-diagnostics",
)
_FRONTEND_BUILD = "static/frontend-build/"
_MANIFEST_PATHS = {
    "bridge": _FRONTEND_BUILD + ".vite/manifest.json",
    "build": _FRONTEND_BUILD + ".vite/manifest.build.json",
}


def _dump(value: Any) -> bytes:
    # The format of the profile installer, so an untouched file stays byte-equal.
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _load(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def rebuild_frontend_manifests(panel_root: Path, frontend: Mapping[str, Mapping[str, Any]]) -> dict[str, bytes]:
    """The frontend manifests limited to what is really on disk.

    The installer of a reduced profile drops the entries of modules it does
    not install, and a page without its entry cannot find its bridge script.
    The panel build carries the complete manifests; an entry is kept when the
    file it points to exists.
    """

    panel_root = Path(panel_root)
    result: dict[str, bytes] = {}
    for key, relative in _MANIFEST_PATHS.items():
        complete = frontend.get(key) or {}
        if not complete:
            # A build without a frontend bundle: nothing to rebuild from.
            continue
        kept: dict[str, Any] = {}
        for name, entry in complete.items():
            if not isinstance(entry, Mapping):
                continue
            target = str(entry.get("file") or name)
            if panel_root.joinpath(*(_FRONTEND_BUILD + target).split("/")).is_file():
                kept[name] = dict(entry)
        for entry in kept.values():
            for link in ("imports", "dynamicImports"):
                if link in entry:
                    entry[link] = [name for name in entry[link] if name in kept]
        result[relative] = _dump(kept)
    return result


def _current_overrides(panel_root: Path) -> dict[str, tuple[str, ...]]:
    try:
        return parse_overrides(_load(Path(panel_root) / OVERRIDES_FILENAME))
    except (ValueError, TypeError):
        # The plan refuses a broken record; what replaces it starts empty.
        return {}


def _overrides_update(panel_root: Path, modules: Mapping[str, tuple[str, ...]]) -> dict[str, bytes]:
    """The record of the files of updated modules, when it has to change.

    An emptied record is written, not deleted: the journal then undoes a
    write like any other. Where no record exists and none is needed, there is
    nothing to write.
    """

    if not modules and not (Path(panel_root) / OVERRIDES_FILENAME).exists():
        return {}
    return {OVERRIDES_FILENAME: _dump(overrides_document(modules))}


def state_file_updates(panel_root: Path, plan: Plan) -> dict[str, bytes]:
    """New contents of the installer records, keyed by path under the panel root."""

    updates = _state_file_updates(panel_root, plan)
    if plan.scope == "panel":
        # A release is laid as a whole: no module keeps files of its own.
        updates.update(_overrides_update(panel_root, {}))
    elif plan.scope == "profile":
        if isinstance(plan.target_profile, Mapping) and isinstance(plan.target_profile.get("module_ids"), list):
            kept = {str(module_id) for module_id in plan.target_profile["module_ids"]}
            current = _current_overrides(panel_root)
            updates.update(
                _overrides_update(
                    panel_root, {module_id: files for module_id, files in current.items() if module_id in kept}
                )
            )
    elif plan.module_id is not None:
        current = _current_overrides(panel_root)
        current.pop(plan.module_id, None)
        if plan.operation != "remove" and plan.module_files is not None:
            # An update entry named the files itself; a release entry brings
            # the module back to the map of the panel.
            current[plan.module_id] = tuple(plan.module_files)
        updates.update(_overrides_update(panel_root, current))
    return updates


def _state_file_updates(panel_root: Path, plan: Plan) -> dict[str, bytes]:
    if plan.scope in {"panel", "profile"}:
        if not isinstance(plan.target_profile, Mapping):
            return {}
        profile = str(plan.target_profile.get("profile") or "")
        variant = str(plan.target_profile.get("editor_variant") or "")
        raw_modules = plan.target_profile.get("module_ids")
        if not profile or variant not in {"light", "full", "advanced"} or not isinstance(raw_modules, list):
            return {}
        selected = {str(module_id) for module_id in raw_modules}
        # A release may bring modules this build does not know: they are
        # recorded after the known ones, by their own names.
        recorded = (*MODULE_ORDER, *sorted(selected - set(MODULE_ORDER)))
        modules_state = _load(Path(panel_root) / "modules.json")
        modules_state = dict(modules_state) if isinstance(modules_state, dict) else {"schema_version": 1}
        if plan.scope == "profile" or not isinstance(modules_state.get("profile"), str):
            # A transition applies the requested profile. An update keeps the
            # owner's settings: the profile label and the editor variant there
            # describe what runs, not what is installed.
            modules_state["profile"] = profile
            modules_state["editor"] = {"variant": variant}
        modules_state["restart_required"] = False
        # The request is either applied now or superseded by this operation.
        modules_state.pop(PHYSICAL_REQUEST_KEY, None)
        current_modules = modules_state.get("modules")
        current_modules = dict(current_modules) if isinstance(current_modules, dict) else {}
        for module_id in recorded:
            item = current_modules.get(module_id)
            item = dict(item) if isinstance(item, dict) else {}
            # Installed is not the same as switched on: a module that stays
            # keeps its switch, a module that is not installed cannot run.
            item["enabled"] = module_id in selected and item.get("enabled") is not False
            current_modules[module_id] = item
        modules_state["modules"] = current_modules
        managed = _load(Path(panel_root) / "install-managed.json")
        managed_paths = managed.get("paths") if isinstance(managed, dict) else None
        current_paths = (
            {str(path) for path in managed_paths}
            if isinstance(managed_paths, list)
            and all(isinstance(path, str) for path in managed_paths)
            else set()
        )
        # A profile transition lays only what was missing: the rest of
        # the managed set is what was there before.
        target_paths = (current_paths - set(plan.files_remove)) | set(plan.files_add)
        installed_record: dict[str, Any] = {
            "schema_version": 1,
            "modules": {module_id: module_id in selected for module_id in recorded},
        }
        if plan.scope == "profile":
            # The release stays: a module that stays keeps the version it has.
            # An update of the panel lays the versions of its release.
            previous = _load(Path(panel_root) / "module-installed.json")
            versions = previous.get("versions") if isinstance(previous, dict) else None
            if isinstance(versions, dict):
                kept_versions = {key: value for key, value in versions.items() if key in selected}
                if kept_versions:
                    installed_record["versions"] = kept_versions
        return {
            "modules.json": _dump(modules_state),
            "module-installed.json": _dump(installed_record),
            "install-profile.json": _dump(
                {
                    "schema_version": 1,
                    "profile": profile,
                    "module_ids": [module_id for module_id in recorded if module_id in selected],
                    "editor_variant": variant,
                }
            ),
            "install-managed.json": _dump({"schema_version": 1, "paths": sorted(target_paths)}),
        }
    panel_root = Path(panel_root)
    if plan.operation == "repair":
        if not plan.files_remove:
            return {}
        # Files of an earlier update the laid entry no longer names.
        managed = _load(panel_root / "install-managed.json")
        paths = managed.get("paths") if isinstance(managed, dict) else None
        if not isinstance(paths, list) or not all(isinstance(item, str) for item in paths):
            return {}
        managed["paths"] = sorted((set(paths) | set(plan.files_add)) - set(plan.files_remove))
        return {"install-managed.json": _dump(managed)}
    present = plan.operation == "install"
    installed_after = set(plan.installed_after)
    updates: dict[str, bytes] = {}

    modules_state = _load(panel_root / "modules.json")
    variant = "full"
    if isinstance(modules_state, dict):
        editor = modules_state.get("editor")
        if isinstance(editor, dict) and editor.get("variant") in ("light", "full", "advanced"):
            variant = editor["variant"]
        if isinstance(modules_state.get("modules"), dict):
            # A preset would be applied again by the next panel update and
            # undo this operation; the actual set is a custom profile now.
            modules_state["profile"] = "custom"
            # An explicit module operation is newer than any profile request.
            modules_state.pop(PHYSICAL_REQUEST_KEY, None)
            item = modules_state["modules"].get(plan.module_id)
            item = dict(item) if isinstance(item, dict) else {}
            item["enabled"] = present
            modules_state["modules"][plan.module_id] = item
            updates["modules.json"] = _dump(modules_state)

    installed = _load(panel_root / "module-installed.json")
    modules = installed.get("modules") if isinstance(installed, dict) else None
    if isinstance(modules, dict):
        modules[plan.module_id] = present
    else:
        installed = {"schema_version": 1, "modules": {module: module in installed_after for module in MODULE_ORDER}}
    updates["module-installed.json"] = _dump(installed)

    profile = _load(panel_root / "install-profile.json")
    if not isinstance(profile, dict):
        profile = {"schema_version": 1, "editor_variant": variant}
    known = [module for module in MODULE_ORDER if module in installed_after]
    profile["profile"] = "custom"
    profile["module_ids"] = known + sorted(installed_after - set(MODULE_ORDER))
    updates["install-profile.json"] = _dump(
        {key: profile[key] for key in ("schema_version", "profile", "module_ids", "editor_variant") if key in profile}
        | {key: value for key, value in profile.items() if key not in ("schema_version", "profile", "module_ids", "editor_variant")}
    )

    managed = _load(panel_root / "install-managed.json")
    paths = managed.get("paths") if isinstance(managed, dict) else None
    if isinstance(paths, list) and all(isinstance(item, str) for item in paths):
        managed["paths"] = sorted((set(paths) | set(plan.files_add)) - set(plan.files_remove))
        updates["install-managed.json"] = _dump(managed)

    return updates
