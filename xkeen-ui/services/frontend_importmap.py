"""Importmap entries of separately built modules.

A module is reached only by the name `xk-module/<id>`, so a change inside it
touches no build file of the core. The entries are worked out on the server for
the modules that are active: an absent or switched-off module simply has none.

The other way round a module reaches the core by `xk-core/<path under static>`:
the core publishes such files as entries of its build.
"""

from __future__ import annotations

import functools
import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any


SOURCE_FALLBACKS = {"tool.advanced-diagnostics": "js/features/resource_monitor.js"}

_BUILD_DIRNAME = "frontend-build"
_MODULE_KEY_PREFIX = "xk-module/"
_CORE_KEY_PREFIX = "xk-core/"
_MANIFEST_PREFIX = "module."
_MANIFEST_SUFFIX = ".json"
_CORE_MANIFEST_FILENAME = "manifest.build.json"


@functools.lru_cache(maxsize=32)
def _manifest_entry_file(path: str, mtime_ns: int) -> str | None:
    """The file of the only entry of a module manifest, cached by its mtime."""

    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, Mapping):
        return None
    entries = [item for item in payload.values() if isinstance(item, Mapping) and item.get("isEntry") is True]
    if len(entries) != 1:
        return None
    filename = entries[0].get("file")
    return filename if isinstance(filename, str) and filename else None


def _found_module_ids(manifests: Path) -> set[str]:
    found = set(SOURCE_FALLBACKS)
    for manifest in manifests.glob(f"{_MANIFEST_PREFIX}*{_MANIFEST_SUFFIX}"):
        found.add(manifest.name[len(_MANIFEST_PREFIX) : -len(_MANIFEST_SUFFIX)])
    return found


def _module_target(static_root: Path, manifests: Path, module_id: str) -> str | None:
    manifest = manifests / f"{_MANIFEST_PREFIX}{module_id}{_MANIFEST_SUFFIX}"
    try:
        mtime_ns = manifest.stat().st_mtime_ns
    except OSError:
        # The panel runs without a build too: the page then loads the sources.
        source = SOURCE_FALLBACKS.get(module_id)
        return source if source and (static_root / source).is_file() else None
    filename = _manifest_entry_file(str(manifest), mtime_ns)
    return f"{_BUILD_DIRNAME}/modules/{module_id}/{filename}" if filename else None


def build_module_importmap(panel_root: Path, active_module_ids: Iterable[str] | None) -> dict[str, str]:
    """`xk-module/<id>` to a path under `static/`; None means no activation data."""

    static_root = Path(panel_root) / "static"
    manifests = static_root / _BUILD_DIRNAME / ".vite"
    module_ids = _found_module_ids(manifests) if active_module_ids is None else {str(item) for item in active_module_ids}
    entries: dict[str, str] = {}
    for module_id in sorted(module_ids):
        target = _module_target(static_root, manifests, module_id)
        if target:
            entries[_MODULE_KEY_PREFIX + module_id] = target
    return entries


def build_core_importmap(manifest: Mapping[str, Any], public_entries: Mapping[str, str]) -> dict[str, str]:
    """`xk-core/<path>` to its hashed file; `public_entries` maps a path to a manifest key."""

    entries: dict[str, str] = {}
    for public_path, manifest_key in public_entries.items():
        entry = manifest.get(manifest_key)
        filename = entry.get("file") if isinstance(entry, Mapping) else None
        if isinstance(filename, str) and filename:
            entries[_CORE_KEY_PREFIX + public_path] = f"{_BUILD_DIRNAME}/{filename}"
    return entries


@functools.lru_cache(maxsize=8)
def _core_public_entries(path: str, mtime_ns: int) -> tuple[tuple[str, str], ...] | None:
    """The `xk-core/*` entries of one core manifest, cached by its mtime."""

    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, Mapping):
        return None
    public = {
        key: key
        for key, item in payload.items()
        if isinstance(key, str) and key.startswith("js/") and isinstance(item, Mapping) and item.get("isEntry") is True
    }
    return tuple(build_core_importmap(payload, public).items())


def build_core_public_importmap(panel_root: Path) -> dict[str, str]:
    """`xk-core/<path>` of every `js/` entry of the core build.

    A module reaches a file of the core by its source path under `static/`.
    With a build the name leads to the very chunk the core itself loads, so
    the shared state exists once. Without a build every such name is the
    source file itself: the prefix points at `static/`.
    """

    manifest = Path(panel_root) / "static" / _BUILD_DIRNAME / ".vite" / _CORE_MANIFEST_FILENAME
    try:
        mtime_ns = manifest.stat().st_mtime_ns
    except OSError:
        return {_CORE_KEY_PREFIX: ""}
    entries = _core_public_entries(str(manifest), mtime_ns)
    return dict(entries) if entries is not None else {_CORE_KEY_PREFIX: ""}
