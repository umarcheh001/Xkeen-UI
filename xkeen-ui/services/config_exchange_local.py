"""Local import/export of user configs.

PR15: moved from app.py.

Invariants:
- Keep bundle schema stable (version, generated_at, files[], repo{}).
- Do NOT write to 04_outbounds.json.
"""

from __future__ import annotations

import os
import time
from typing import Any, Dict, List

from services.xkeen_lists import PORT_PROXYING_FILE, PORT_EXCLUDE_FILE, IP_EXCLUDE_FILE, XKEEN_CONFIG_FILE
from services.xray_config_files import ROUTING_FILE, OUTBOUNDS_FILE
from utils.fs import load_text, save_text
from utils.jsonio import load_json, save_json


def _xray_config_dir() -> str:
    return os.path.dirname(ROUTING_FILE)


def build_user_configs_bundle(
    *,
    github_owner: str = "",
    github_repo: str = "",
) -> Dict[str, Any]:
    """Collect user configs into a single bundle JSON object.

    Includes:
      - all *.json files from Xray config dir, except 04_outbounds.json
      - xkeen/*.lst files
    """
    files: List[Dict[str, Any]] = []
    xray_dir = _xray_config_dir()

    # All Xray JSON configs except OUTBOUNDS_FILE.
    if os.path.isdir(xray_dir):
        for fname in sorted(os.listdir(xray_dir)):
            if not fname.endswith(".json"):
                continue
            full_path = os.path.join(xray_dir, fname)
            if os.path.abspath(full_path) == os.path.abspath(OUTBOUNDS_FILE):
                continue

            data = load_json(full_path, default=None)
            if data is not None:
                files.append({"path": f"xray/{fname}", "kind": "json", "content": data})

    # *.lst from /opt/etc/xkeen
    lst_files = {
        "xkeen/port_proxying.lst": PORT_PROXYING_FILE,
        "xkeen/port_exclude.lst": PORT_EXCLUDE_FILE,
        "xkeen/ip_exclude.lst": IP_EXCLUDE_FILE,
        "xkeen/xkeen.json": XKEEN_CONFIG_FILE,
    }
    for logical_path, real_path in lst_files.items():
        content = load_text(real_path, default="")
        files.append({"path": logical_path, "kind": "text", "content": content})

    bundle: Dict[str, Any] = {
        "version": 1,
        "generated_at": int(time.time()),
        "files": files,
        "repo": {"owner": github_owner, "name": github_repo},
    }
    return bundle


def apply_user_configs_bundle(bundle: Dict[str, Any]) -> None:
    """Apply a bundle by writing its files into their expected locations."""
    if not isinstance(bundle, dict):
        raise ValueError("bundle must be a dict")

    files = bundle.get("files", [])
    if not isinstance(files, list):
        raise ValueError("bundle.files must be a list")

    xray_dir = _xray_config_dir()

    for item in files:
        if not isinstance(item, dict):
            continue

        path = item.get("path")
        kind = item.get("kind")
        content = item.get("content")

        if not path or kind not in ("json", "text"):
            continue

        basename = os.path.basename(str(path))
        real_path: str | None = None

        # xkeen.json (lives in /opt/etc/xkeen)
        if basename == os.path.basename(XKEEN_CONFIG_FILE):
            real_path = XKEEN_CONFIG_FILE
        # JSON configs
        elif basename.endswith(".json"):
            if basename == os.path.basename(OUTBOUNDS_FILE):
                continue
            real_path = os.path.join(xray_dir, basename)
        # LST files
        elif basename == os.path.basename(PORT_PROXYING_FILE):
            real_path = PORT_PROXYING_FILE
        elif basename == os.path.basename(PORT_EXCLUDE_FILE):
            real_path = PORT_EXCLUDE_FILE
        elif basename == os.path.basename(IP_EXCLUDE_FILE):
            real_path = IP_EXCLUDE_FILE

        if not real_path:
            continue

        if kind == "json":
            if not isinstance(content, (dict, list)):
                continue
            save_json(real_path, content)
        else:
            if not isinstance(content, str):
                content = str(content)
            save_text(real_path, content)
