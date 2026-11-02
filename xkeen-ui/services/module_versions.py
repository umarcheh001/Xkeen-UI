"""Versions of the panel modules.

Every module except ``core`` has a version of its own. ``module-versions.json``
travels in the panel archive and says which version of each module that panel
build carries; a module installed later from its own release records its
version in ``module-installed.json`` (key ``versions``), and that record wins.
``core`` has no version of its own: it is the panel.

Nothing here may raise: the registry reads this on every request.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Mapping

MODULE_VERSIONS_FILENAME = "module-versions.json"
INSTALLED_FILENAME = "module-installed.json"
BASE_MODULE_VERSION = "1.0.0"

_VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


def _is_version(value: object) -> bool:
    return isinstance(value, str) and _VERSION_RE.fullmatch(value) is not None


def _module_ids() -> tuple[str, ...]:
    # Imported here: the registry imports this module for its payloads.
    from services.module_registry import MODULE_IDS

    return tuple(module_id for module_id in MODULE_IDS if module_id != "core")


def _read_versions(path: Path) -> dict[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, Mapping):
        return {}
    return {str(key): value for key, value in data.items() if _is_version(value)}


def read_panel_module_versions(panel_root: Path) -> dict[str, str]:
    """The version of each module in this panel build.

    A missing or damaged file, or a module missing from it, reads as the base
    version: the build predates per-module versions.
    """

    found = _read_versions(Path(panel_root) / MODULE_VERSIONS_FILENAME)
    return {module_id: found.get(module_id, BASE_MODULE_VERSION) for module_id in _module_ids()}


def read_installed_module_versions(state_dir: Path, panel_root: Path) -> dict[str, str]:
    """The version of each module as installed on this router."""

    versions = read_panel_module_versions(panel_root)
    try:
        manifest = json.loads((Path(state_dir) / INSTALLED_FILENAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return versions
    recorded = manifest.get("versions") if isinstance(manifest, Mapping) else None
    if isinstance(recorded, Mapping):
        for module_id in versions:
            if _is_version(recorded.get(module_id)):
                versions[module_id] = recorded[module_id]
    return versions
