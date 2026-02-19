"""/api/routing/fragments endpoint.

Moved from routes_routing.py as part of refactor checklist (B3 step 6).
"""

from __future__ import annotations

import os
from typing import Any

from flask import Blueprint, jsonify


def register_fragments_routes(bp: Blueprint, *, xray_configs_dir: str, routing_file: str) -> None:
    @bp.get("/api/routing/fragments")
    def api_list_routing_fragments() -> Any:
        """List routing fragment files in xray_configs_dir.

        Used by UI dropdown: /opt/etc/xray/configs/*routing*.json
        """
        items = []
        try:
            if os.path.isdir(xray_configs_dir):
                for name in os.listdir(xray_configs_dir):
                    lname = str(name or "").lower()
                    if not lname.endswith(".json"):
                        continue
                    if "routing" not in lname:
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
                        })
                    except Exception:
                        items.append({"name": name})
        except Exception:
            items = []

        try:
            items.sort(key=lambda it: str(it.get("name") or "").lower())
        except Exception:
            pass

        current_name = os.path.basename(routing_file)
        return jsonify({
            "ok": True,
            "dir": xray_configs_dir,
            "current": current_name,
            "items": items,
        })
