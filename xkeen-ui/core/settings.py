"""Centralized Settings for Xkeen UI.

Goal (Commit A): introduce a single, explicit settings object without changing
runtime behavior.

Today the effective directories are computed in :mod:`core.paths` at import
time. This module provides a lightweight wrapper that reuses the exact same
resolution logic (and environment variables) but makes it easier to pass
configuration around explicitly.

No behavior changes intended.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Settings:
    """Resolved runtime settings.

    Attributes:
        ui_state_dir: Writable directory for UI state (auth, secrets, misc).
        base_etc_dir: Base directory for configuration files.
        base_var_dir: Base directory for variable data (logs, runtime files).
    """

    ui_state_dir: str
    base_etc_dir: str
    base_var_dir: str

    @classmethod
    def from_env(cls) -> "Settings":
        """Resolve settings using the same logic as :mod:`core.paths`.

        This keeps the current behavior intact while providing a single object
        that can be passed into initializers/routes/services.
        """

        # Import locally to avoid creating new import-time side effects.
        from .paths import get_ui_state_dir, choose_base_dir

        ui_state_dir = get_ui_state_dir()
        base_etc_dir = choose_base_dir("/opt/etc", f"{ui_state_dir}/etc")
        base_var_dir = choose_base_dir("/opt/var", f"{ui_state_dir}/var")
        return cls(ui_state_dir=ui_state_dir, base_etc_dir=base_etc_dir, base_var_dir=base_var_dir)
