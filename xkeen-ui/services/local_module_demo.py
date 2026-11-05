"""Disposable module state used by the macOS/local panel preview.

The router gets BUILD.json and the install manifests from the installer.  A
checkout launched directly from a developer machine has neither, so the
module screens otherwise cannot render even though all source files are
present.  This helper creates only missing, local state files; it never
downloads anything and never replaces an existing file.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Iterable, MutableMapping

from services.module_registry import MODULE_IDS


def enabled() -> bool:
    value = str(os.environ.get("XKEEN_UI_LOCAL_DEMO") or "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def configure_local_core_binaries(
    project_root: str | os.PathLike[str], *, environ: MutableMapping[str, str] | None = None
) -> dict[str, str]:
    """Expose locally downloaded diagnostic cores to a checkout's panel process."""
    env = environ if environ is not None else os.environ
    binaries = Path(project_root) / ".tmp" / "diagnostics-cores"
    configured = {}
    for variable, name in (("XKEEN_XRAY_BINARY", "xray"), ("MIHOMO_BIN", "mihomo")):
        candidate = binaries / name
        if variable not in env and candidate.is_file() and os.access(candidate, os.X_OK):
            env[variable] = str(candidate)
            configured[name] = str(candidate)
    return configured


def _write_if_missing(path: Path, payload: object) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def ensure_state(state_dir: str | os.PathLike[str], module_ids: Iterable[str] = MODULE_IDS) -> None:
    """Make a complete read-only lifecycle baseline for local visual testing."""

    root = Path(state_dir)
    ids = [str(module_id) for module_id in module_ids]
    _write_if_missing(
        root / "BUILD.json",
        {
            "version": "1.0.0",
            "commit": "local-dev",
            "dirty": True,
            "repo": "local checkout",
            "channel": "local",
            "built_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    )
    _write_if_missing(
        root / "module-installed.json",
        {"schema_version": 1, "modules": {module_id: True for module_id in ids}},
    )
    _write_if_missing(
        root / "install-profile.json",
        {
            "schema_version": 1,
            "profile": "full",
            "module_ids": ids,
            "editor_variant": "full",
        },
    )
