"""What the shared files of the panel must say after a module operation.

Files of a module are its own; these belong to every module at once: the
frontend manifests and the records the profile installer keeps. The functions
only compute the new bytes, the journal writes them so they can be undone.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from .plan import Plan


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


def state_file_updates(panel_root: Path, plan: Plan) -> dict[str, bytes]:
    """New contents of the installer records, keyed by path under the panel root."""

    if plan.operation == "repair":
        return {}
    panel_root = Path(panel_root)
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
