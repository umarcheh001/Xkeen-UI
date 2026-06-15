"""/api/routing/fragments endpoint.

Moved from routes_routing.py as part of refactor checklist (B3 step 6).
"""

from __future__ import annotations

import os
from typing import Any

from flask import Blueprint, jsonify, request
from services.xray_config_files import is_sensitive_xray_fragment_name


def register_fragments_routes(bp: Blueprint, *, xray_configs_dir: str, routing_file: str) -> None:
    @bp.get("/api/routing/fragments")
    def api_list_routing_fragments() -> Any:
        """List routing fragment files in xray_configs_dir.

        Default: list Xray JSON fragments for the editor selector.
        Compatibility: /api/routing/fragments?all=1 is accepted and returns the same list.
        01_log.json is excluded because logs are managed in a dedicated UI card.
        """

        items = []
        current_name = os.path.basename(routing_file)
        try:
            if os.path.isdir(xray_configs_dir):
                for name in os.listdir(xray_configs_dir):
                    lname = str(name or "").lower()
                    if not lname.endswith(".json"):
                        continue
                    # Always exclude the log config: logs are managed in a dedicated UI card.
                    if lname == "01_log.json":
                        continue
                    full = os.path.join(xray_configs_dir, name)
                    if not os.path.isfile(full):
                        continue
                    try:
                        st = os.stat(full)
                        items.append({
                            "name": name,
                            "size": int(getattr(st, "st_size", 0) or 0),
                            "mtime": int(getattr(st, "st_mtime", 0) or 0),
                            "sensitive": is_sensitive_xray_fragment_name(name, kind="routing"),
                        })
                    except Exception:
                        items.append({
                            "name": name,
                            "sensitive": is_sensitive_xray_fragment_name(name, kind="routing"),
                        })
        except Exception:
            items = []

        try:
            items.sort(key=lambda it: str(it.get("name") or "").lower())
        except Exception:
            pass

        return jsonify({
            "ok": True,
            "dir": xray_configs_dir,
            "current": current_name,
            "items": items,
        })
