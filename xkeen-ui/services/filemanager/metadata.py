"""File metadata helpers.

Created for refactor checklist (B3 step 5): consolidate duplicated
_apply_local_metadata_best_effort implementation.

This module is Flask-agnostic.
"""

from __future__ import annotations

import os


def _apply_local_metadata_best_effort(dst_path: str, st0: os.stat_result | None) -> None:
    """Best-effort restore mode/owner when overwriting an existing file."""
    if st0 is None:
        return
    try:
        mode = int(getattr(st0, "st_mode", 0) or 0) & 0o7777
        if mode:
            try:
                os.chmod(dst_path, mode)
            except Exception:
                pass
        try:
            uid = int(getattr(st0, "st_uid", -1))
            gid = int(getattr(st0, "st_gid", -1))
            if uid >= 0 and gid >= 0:
                os.chown(dst_path, uid, gid)
        except Exception:
            pass
    except Exception:
        return


# Optional non-underscored alias for other modules.
apply_local_metadata_best_effort = _apply_local_metadata_best_effort
