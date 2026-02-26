"""Build/version info helpers.

This module is intentionally tiny and defensive: it must never raise.

The UI (DevTools) can read a small JSON file (BUILD.json) written by install.sh
to display "current build" and later to compare with GitHub releases.

Default router install location: /opt/etc/xkeen-ui/BUILD.json
However, UI_STATE_DIR may be overridden, and dev setups may not have /opt.
So we try a few candidate locations.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from services.io import read_json


def _safe_read_json(path: str) -> Optional[Dict[str, Any]]:
    data = read_json(path, default=None)
    return data if isinstance(data, dict) else None


def _candidate_paths(ui_state_dir: Optional[str] = None) -> List[str]:
    paths: List[str] = []

    if ui_state_dir:
        paths.append(os.path.join(ui_state_dir, "BUILD.json"))

    # package root (…/xkeen-ui/)
    try:
        pkg_root = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
        paths.append(os.path.join(pkg_root, "BUILD.json"))
    except Exception:
        pass

    # cwd (dev)
    try:
        paths.append(os.path.abspath("./BUILD.json"))
    except Exception:
        pass

    # hard router default
    paths.append("/opt/etc/xkeen-ui/BUILD.json")

    # de-dup while keeping order
    seen = set()
    out: List[str] = []
    for p in paths:
        if p not in seen:
            out.append(p)
            seen.add(p)
    return out


def read_build_info(ui_state_dir: Optional[str] = None) -> Dict[str, Any]:
    """Return build info for UI.

    Never raises. Always returns a dict with stable keys.
    """

    env_repo = os.environ.get("XKEEN_UI_UPDATE_REPO") or "umarcheh001/Xkeen-UI"
    env_channel = os.environ.get("XKEEN_UI_UPDATE_CHANNEL") or "stable"

    info: Dict[str, Any] = {
        "ok": True,
        "exists": False,
        "path": "",
        "repo": env_repo,
        "channel": env_channel,
        "version": None,
        "commit": None,
        "built_utc": None,
        "source": None,
        "artifact": None,
    }

    for path in _candidate_paths(ui_state_dir):
        data = _safe_read_json(path)
        if not data:
            continue

        info["exists"] = True
        info["path"] = path
        # Allow missing keys; keep stable output schema.
        for k in ("repo", "channel", "version", "commit", "built_utc", "source", "artifact"):
            if k in data:
                info[k] = data.get(k)
        break

    return info
