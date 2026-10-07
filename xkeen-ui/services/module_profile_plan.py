"""Pure ownership-based planning for physical panel profiles."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, Sequence

from services.module_registry import MODULE_DEFINITIONS, MODULE_IDS


PRESETS: Mapping[str, tuple[str, ...]] = {
    "full": tuple(MODULE_IDS),
    "legacy-full": tuple(MODULE_IDS),
    "xray-minimal": ("core", "engine.xray", "tool.editor"),
    "mihomo-minimal": ("core", "engine.mihomo", "tool.editor"),
}
EDITOR_VARIANTS = frozenset({"light", "full", "advanced"})
STATE_FILENAMES = ("modules.json", "module-installed.json", "install-profile.json", "install-managed.json")
_USER_TOP_LEVEL = {"xray-jsonc", "var", "bin"}
_USER_FILES = {
    "install.sh",
    "secret.key",
    "devtools.env",
    "ui-settings.json",
    "branding.json",
    "terminal_theme.json",
    "terminal_theme.css",
    *STATE_FILENAMES,
}
_USER_PREFIXES = ("opt/etc/mihomo/profiles/", "opt/etc/mihomo/backup/")


class ProfilePlanError(ValueError):
    def __init__(self, code: str, message: str, **details: Any):
        self.code = code
        self.details = details
        super().__init__(f"{code}: {message}")


@dataclass(frozen=True, slots=True)
class ProfileTarget:
    profile: str
    module_ids: tuple[str, ...]
    editor_variant: str
    payload_files: tuple[str, ...]
    state_files: Mapping[str, Mapping[str, Any]]
    frontend: Mapping[str, Mapping[str, Any]]


def _fail(code: str, message: str, **details: Any) -> None:
    raise ProfilePlanError(code, message, **details)


def user_owned(relative: str) -> bool:
    return (
        relative in _USER_FILES
        or relative == "opt/etc/mihomo/config.yaml"
        or relative.startswith(_USER_PREFIXES)
        or relative.split("/", 1)[0] in _USER_TOP_LEVEL
    )


def _safe_relative(value: str) -> bool:
    path = PurePosixPath(value)
    return (
        bool(value)
        and "\\" not in value
        and ":" not in value
        and not path.is_absolute()
        and all(part not in {"", ".", ".."} for part in path.parts)
        and path.as_posix() == value
    )


def _load_ownership(panel_source: Path) -> tuple[dict[str, tuple[str, ...]], dict[str, dict[str, Any]]]:
    try:
        raw = json.loads((panel_source / "module-ownership.json").read_text(encoding="utf-8"))
        if not isinstance(raw, Mapping) or raw.get("schema_version") != 1:
            raise ValueError("unsupported schema")
        raw_modules = raw["modules"]
        raw_frontend = raw["frontend"]
        if not isinstance(raw_modules, Mapping) or not isinstance(raw_frontend, Mapping):
            raise ValueError("invalid ownership map")
        if set(raw_modules) != set(MODULE_IDS):
            raise ValueError("incomplete module ownership")
        modules: dict[str, tuple[str, ...]] = {}
        claimed: set[str] = set()
        for module_id in MODULE_IDS:
            paths = raw_modules[module_id]
            if not isinstance(paths, list) or any(not isinstance(path, str) for path in paths):
                raise ValueError("invalid ownership paths")
            normalized = tuple(sorted(paths))
            if len(normalized) != len(set(normalized)):
                raise ValueError("duplicate ownership path")
            for relative in normalized:
                if not _safe_relative(relative) or user_owned(relative) or relative in claimed:
                    raise ValueError("unsafe ownership path")
                if not (panel_source / relative).is_file():
                    raise ValueError("owned payload is missing")
                claimed.add(relative)
            modules[module_id] = normalized
        bridge = raw_frontend.get("bridge", {})
        build = raw_frontend.get("build", {})
        if not isinstance(bridge, Mapping) or not isinstance(build, Mapping):
            raise ValueError("invalid frontend manifests")
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ProfilePlanError(
            "profile_ownership_unavailable",
            "panel ownership metadata cannot build a physical profile",
        ) from error
    return modules, {"bridge": dict(bridge), "build": dict(build)}


def _selected_modules(profile: str, requested: Sequence[str] | None) -> tuple[str, ...]:
    if profile in PRESETS:
        if requested is not None:
            _fail("profile_modules_forbidden", "canonical profiles do not accept module_ids")
        selected = set(PRESETS[profile])
    elif profile == "custom":
        if not isinstance(requested, Sequence) or isinstance(requested, (str, bytes)):
            _fail("profile_modules_invalid", "custom profile requires module_ids")
        selected = {str(module_id) for module_id in requested}
        if not selected or "core" not in selected or selected - set(MODULE_IDS):
            _fail("profile_modules_invalid", "custom profile contains invalid modules")
    else:
        _fail("profile_unknown", "profile is not supported", profile=profile)

    definitions = {definition.id: definition for definition in MODULE_DEFINITIONS}
    missing = sorted(
        dependency
        for module_id in selected
        for dependency in definitions[module_id].dependencies
        if dependency not in selected
    )
    if missing:
        _fail("profile_dependency_missing", "profile omits required modules", module_ids=sorted(set(missing)))
    conflicts = sorted(
        conflict
        for module_id in selected
        for conflict in definitions[module_id].conflicts
        if conflict in selected
    )
    if conflicts:
        _fail("profile_module_conflict", "profile contains conflicting modules", module_ids=sorted(set(conflicts)))
    return tuple(module_id for module_id in MODULE_IDS if module_id in selected)


def _editor_full_path(relative: str) -> bool:
    lowered = relative.lower()
    return (
        lowered.startswith("static/monaco-editor/")
        or lowered.startswith("static/js/vendor/monaco-")
        or (
            lowered.startswith("static/vendor/npm/")
            and any(token in lowered for token in ("prettier", "monaco"))
        )
    )


def _frontend_for_payload(
    frontend: Mapping[str, Mapping[str, Any]], payload: set[str]
) -> dict[str, dict[str, Any]]:
    build = frontend["build"]
    selected = {
        key
        for key, entry in build.items()
        if isinstance(key, str)
        and isinstance(entry, Mapping)
        and isinstance(entry.get("file"), str)
        and f"static/frontend-build/{entry['file']}" in payload
    }
    queue = list(selected)
    while queue:
        entry = build[queue.pop()]
        for dependency in entry.get("imports", ()) if isinstance(entry, Mapping) else ():
            if dependency in build and dependency not in selected:
                selected.add(dependency)
                queue.append(dependency)
    normalized_build: dict[str, Any] = {}
    for key in sorted(selected):
        entry = dict(build[key])
        for field in ("imports", "dynamicImports"):
            if isinstance(entry.get(field), list):
                entry[field] = [item for item in entry[field] if item in selected]
        normalized_build[key] = entry
    bridge = {
        key: dict(entry)
        for key, entry in sorted(frontend["bridge"].items())
        if isinstance(entry, Mapping)
        and isinstance(entry.get("file"), str)
        and f"static/frontend-build/{entry['file']}" in payload
    }
    return {"bridge": bridge, "build": normalized_build}


def build_profile_target(
    panel_source: Path,
    *,
    profile: str,
    module_ids: Sequence[str] | None,
    editor_variant: str | None,
) -> ProfileTarget:
    """Return the exact declarative payload and state for one physical profile."""

    source = Path(panel_source)
    modules, frontend_source = _load_ownership(source)
    selected = _selected_modules(str(profile), module_ids)
    default_variant = "full" if profile in {"full", "legacy-full"} else "light"
    variant = default_variant if editor_variant is None else str(editor_variant)
    if variant not in EDITOR_VARIANTS:
        _fail("profile_editor_variant_invalid", "editor variant is not supported")
    if "tool.editor" not in selected and editor_variant not in {None, "light"}:
        _fail("profile_editor_variant_invalid", "editor variant requires the editor module")

    payload = {path for module_id in selected for path in modules[module_id]}
    if variant == "light":
        payload = {path for path in payload if not _editor_full_path(path)}
    payload_files = tuple(sorted(payload))
    frontend = _frontend_for_payload(frontend_source, payload)
    module_set = set(selected)
    state_files: dict[str, Mapping[str, Any]] = {
        "modules.json": {
            "schema_version": 1,
            "profile": profile,
            "restart_required": False,
            "editor": {"variant": variant},
            "modules": {module_id: {"enabled": module_id in module_set} for module_id in MODULE_IDS},
        },
        "module-installed.json": {
            "schema_version": 1,
            "modules": {module_id: module_id in module_set for module_id in MODULE_IDS},
        },
        "install-profile.json": {
            "schema_version": 1,
            "profile": profile,
            "module_ids": list(selected),
            "editor_variant": variant,
        },
        "install-managed.json": {"schema_version": 1, "paths": list(payload_files)},
    }
    return ProfileTarget(
        profile=profile,
        module_ids=selected,
        editor_variant=variant,
        payload_files=payload_files,
        state_files=state_files,
        frontend=frontend,
    )


def profile_transition_diff(installed_state: Mapping[str, Any], target: ProfileTarget) -> dict[str, Any]:
    """Return a deterministic physical diff from installed manifests to a target."""

    raw_modules = installed_state.get("module_ids", ())
    if isinstance(raw_modules, Mapping):
        current_modules = {str(key) for key, value in raw_modules.items() if value is True}
    elif isinstance(raw_modules, Sequence) and not isinstance(raw_modules, (str, bytes)):
        current_modules = {str(item) for item in raw_modules}
    else:
        current_modules = set()
    raw_paths = installed_state.get("paths", ())
    current_paths = {
        str(item)
        for item in raw_paths
        if isinstance(raw_paths, Sequence) and not isinstance(raw_paths, (str, bytes)) and isinstance(item, str)
    }
    target_modules = set(target.module_ids)
    target_paths = set(target.payload_files)
    return {
        "profile_from": installed_state.get("profile"),
        "profile_to": target.profile,
        "editor_variant_from": installed_state.get("editor_variant"),
        "editor_variant_to": target.editor_variant,
        "modules_add": sorted(target_modules - current_modules),
        "modules_remove": sorted(current_modules - target_modules),
        "files_add": sorted(target_paths - current_paths),
        "files_remove": sorted(current_paths - target_paths),
    }
