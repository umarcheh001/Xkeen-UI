"""Mihomo path helpers.

Extracted from legacy app.py.

This module is intentionally small: it only derives paths for Mihomo
config and templates and performs a best-effort copy of bundled templates
into the runtime templates directory.
"""

from __future__ import annotations

import os
import shutil
from typing import Tuple


def _project_root_dir() -> str:
    """Return the xkeen-ui project root directory."""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def init_mihomo_paths(config_path: str) -> Tuple[str, str, str, str]:
    """Compute and initialize Mihomo paths.

    Returns (MIHOMO_CONFIG_FILE, MIHOMO_ROOT_DIR, MIHOMO_TEMPLATES_DIR, MIHOMO_DEFAULT_TEMPLATE).

    Notes:
    - ``MIHOMO_TEMPLATES_DIR`` may be overridden via the env var MIHOMO_TEMPLATES_DIR.
    - In dev environments the templates directory may be empty; we copy bundled templates
      from ``opt/etc/mihomo/templates`` if available.
    """

    mihomo_config_file = str(config_path)
    mihomo_root_dir = os.path.dirname(mihomo_config_file)
    mihomo_templates_dir = os.environ.get(
        "MIHOMO_TEMPLATES_DIR", os.path.join(mihomo_root_dir, "templates")
    )
    mihomo_default_template = os.path.join(mihomo_templates_dir, "custom.yaml")

    # Best-effort ensure templates exist (dev/macOS convenience).
    try:
        os.makedirs(mihomo_templates_dir, exist_ok=True)
        bundled = os.path.join(_project_root_dir(), "opt", "etc", "mihomo", "templates")
        if os.path.isdir(bundled):
            existing = set(os.listdir(mihomo_templates_dir))
            for name in os.listdir(bundled):
                if name in existing:
                    continue
                src = os.path.join(bundled, name)
                dst = os.path.join(mihomo_templates_dir, name)
                if os.path.isfile(src):
                    shutil.copy2(src, dst)
    except Exception as e:  # noqa: BLE001
        # Do not fail the app on template copy errors, but leave a trace for support.
        try:
            from core.logging import core_log_once
            core_log_once(
                "warning",
                "mihomo_templates_copy_failed",
                "mihomo templates copy failed (non-fatal)",
                error=str(e),
                templates_dir=mihomo_templates_dir,
            )
        except Exception:
            pass

    return mihomo_config_file, mihomo_root_dir, mihomo_templates_dir, mihomo_default_template
