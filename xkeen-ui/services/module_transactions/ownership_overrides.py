"""Which files a module really consists of after it was updated on its own.

The panel build carries the ownership map of its release. A module laid from a
signed update entry may consist of other files: the entry names them, and the
panel keeps that list next to its records, in ``module-ownership-overrides.json``.
An entry there replaces the module's list in the map as a whole; the frontend
manifests of the map stay as they are.

The file is panel state: the installer and a panel update bring it back to an
empty list, a module operation and a profile transition keep it in step with
what lies on the storage. Nothing here imports the signature library: undoing an
interrupted operation at boot reads the plan, not this file, but must not need it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from services.module_profile_plan import user_owned

from .plan import OwnershipMap, _safe_relative, load_ownership_map
from .state import ModuleTransactionError


OVERRIDES_FILENAME = "module-ownership-overrides.json"
SCHEMA_VERSION = 1


def _unavailable(error: BaseException | None = None) -> ModuleTransactionError:
    failure = ModuleTransactionError(
        "module_ownership_unavailable",
        "the record of the files of updated modules cannot be read",
    )
    if error is not None:
        failure.__cause__ = error
    return failure


def parse_overrides(data: Any) -> dict[str, tuple[str, ...]]:
    """The entries of a parsed overrides document; ``ValueError`` when it is not one."""

    if not isinstance(data, Mapping) or data.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("unsupported ownership overrides")
    modules = data.get("modules")
    if not isinstance(modules, Mapping):
        raise ValueError("invalid ownership overrides")
    result: dict[str, tuple[str, ...]] = {}
    for module_id, paths in modules.items():
        if (
            not isinstance(module_id, str)
            or not isinstance(paths, list)
            or any(not isinstance(path, str) for path in paths)
        ):
            raise ValueError("invalid ownership override entry")
        result[module_id] = tuple(sorted(set(paths)))
    return result


def read_overrides(state_dir: Path) -> dict[str, tuple[str, ...]]:
    """Module id to its own list of files; empty when no module was updated."""

    path = Path(state_dir) / OVERRIDES_FILENAME
    if not path.exists():
        return {}
    try:
        return parse_overrides(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError) as error:
        raise _unavailable(error) from error


def overrides_document(modules: Mapping[str, tuple[str, ...] | list[str]]) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "modules": {module_id: sorted(set(modules[module_id])) for module_id in sorted(modules)},
    }


def apply_overrides(
    base: Mapping[str, tuple[str, ...]], overrides: Mapping[str, tuple[str, ...]]
) -> dict[str, tuple[str, ...]]:
    """The module lists of ``base`` with every overridden list put in its place.

    Every path is checked: it must be a plain relative path, must not belong to
    the owner and must not be claimed by another module after the replacement.
    """

    for module_id in overrides:
        if module_id == "core" or module_id not in base:
            raise ModuleTransactionError(
                "module_ownership_conflict",
                "the files of a module the panel does not manage were recorded",
                module_id=module_id,
            )
    effective = {
        module_id: tuple(overrides.get(module_id, paths)) for module_id, paths in base.items()
    }
    for module_id, paths in overrides.items():
        foreign = {path for other, files in effective.items() if other != module_id for path in files}
        for path in paths:
            if not _safe_relative(path) or user_owned(path) or path in foreign:
                raise ModuleTransactionError(
                    "module_ownership_conflict",
                    "an updated module claims a path it must not manage",
                    module_id=module_id,
                    path=path,
                )
    return effective


def effective_ownership(panel_root: Path, state_dir: Path) -> OwnershipMap:
    """The ownership map of the panel with the lists of updated modules in place."""

    base = load_ownership_map(Path(panel_root))
    overrides = read_overrides(Path(state_dir))
    if not overrides:
        return base
    return OwnershipMap(modules=apply_overrides(base.modules, overrides), frontend=base.frontend)
