"""/api/remotefs/capabilities endpoint.

Extracted from routes_remotefs.py.
"""

from __future__ import annotations

from typing import Any, Callable

from flask import Blueprint, jsonify


def register_capabilities_endpoints(
    bp: Blueprint,
    *,
    require_enabled: Callable[[], Any | None],
    mgr: Any,
    hostkey_policies,
    tls_verify_modes,
) -> None:
    @bp.get("/api/remotefs/capabilities")
    def api_remotefs_capabilities() -> Any:
        """Capabilities for the remote file manager (security defaults, modes)."""
        if (resp := require_enabled()) is not None:
            return resp
        return jsonify(
            {
                "ok": True,
                "security": {
                    "sftp": {
                        "hostkey_policies": list(hostkey_policies),
                        "default_policy": "accept_new",
                        "known_hosts_path": mgr.known_hosts_path,
                        "auth_types": ["password", "key"],
                        "supports_key_upload": True,
                        "supports_key_path": True,
                        "supports_passphrase": True,
                    },
                    "ftps": {
                        "tls_verify_modes": list(tls_verify_modes),
                        "default_mode": "none",
                        "default_ca_file": mgr.default_ca_file,
                    },
                },
                "fileops": {
                    "overwrite_modes": ["replace", "skip", "ask"],
                    "supports_dry_run": True,
                    "supports_decisions": True,
                },
                "fs_admin": {
                    "local": {"chmod": True, "chown": True, "touch": True, "stat_batch": True},
                    "remote": {
                        "chmod": True,
                        "chown": True,
                        "chown_protocols": ["sftp"],
                        "touch": True,
                        "stat_batch": True,
                    },
                },
            }
        )
