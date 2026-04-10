"""/api/remotefs/sessions endpoints (create/close).

Extracted from routes_remotefs.py.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response as _error_response


def register_sessions_endpoints(
    bp: Blueprint,
    *,
    require_enabled: Callable[[], Any | None],
    mgr: Any,
    normalize_security_options: Callable[..., tuple[Dict[str, Any], Dict[str, Any], List[str]]],
    classify_connect_error: Callable[[str], Dict[str, Any]],
    core_log: Callable[..., None] | None = None,
    error_response=_error_response,
) -> None:
    def _log(level: str, msg: str, **extra) -> None:
        try:
            if callable(core_log):
                core_log(level, msg, **extra)
        except Exception:
            pass

    @bp.post("/api/remotefs/sessions")
    def api_remotefs_create_session() -> Any:
        if (resp := require_enabled()) is not None:
            return resp

        data = request.get_json(silent=True) or {}
        protocol = str(data.get("protocol", "")).strip().lower()
        if protocol not in ("sftp", "ftp", "ftps"):
            return error_response("unsupported_protocol", 400, ok=False)

        host = str(data.get("host", "")).strip()
        if not host:
            return error_response("host_required", 400, ok=False)

        port_raw = data.get("port")
        default_port = 22 if protocol == "sftp" else 21
        try:
            if port_raw is None or str(port_raw).strip() == "":
                port = int(default_port)
            else:
                port = int(port_raw)
        except Exception:
            return error_response("bad_port", 400, ok=False)
        if port <= 0 or port > 65535:
            return error_response("bad_port", 400, ok=False)

        username = str(data.get("username", "")).strip()
        if not username:
            return error_response("username_required", 400, ok=False)

        auth = data.get("auth") or {}
        auth_type = str(auth.get("type", "password")).strip().lower()
        if auth_type not in ("password", "key"):
            return error_response("unsupported_auth", 400, ok=False)

        # Auth validation
        if auth_type == "password":
            password = str(auth.get("password", ""))
            if not password:
                return error_response("password_required", 400, ok=False)
        else:
            # key auth is only supported for SFTP
            if protocol != "sftp":
                return error_response("unsupported_auth", 400, ok=False)
            key_path = str(auth.get("key_path", "") or "").strip()
            key_data = auth.get("key_data") or auth.get("key")
            if key_data and isinstance(key_data, (bytes, bytearray)):
                key_data = key_data.decode("utf-8", errors="replace")
            key_data = str(key_data or "")
            if not key_path and not key_data:
                return error_response("key_required", 400, ok=False)
            if key_data and len(key_data) > 128_000:
                return error_response("key_too_large", 400, ok=False)
            password = ""

        options = data.get("options") or {}
        if not isinstance(options, dict):
            options = {}

        options, effective_sec, warnings = normalize_security_options(
            protocol,
            options,
            known_hosts_path=mgr.known_hosts_path or "",
            default_ca_file=mgr.default_ca_file,
        )

        try:
            s = mgr.create(protocol, host, port, username, auth_type, auth, options)
        except RuntimeError as e:
            msg = str(e)
            if msg == "too_many_sessions":
                return error_response("too_many_sessions", 429, ok=False)
            if msg == "feature_disabled":
                return error_response("feature_disabled", 404, ok=False)
            return error_response("create_failed", 400, ok=False)

        # light connectivity check
        rc, out, err = mgr._run_lftp(s, ["pwd"], capture=True)
        if rc != 0:
            mgr.close(s.session_id)
            tail = (err.decode("utf-8", errors="replace")[-800:]).strip()
            info = classify_connect_error(tail)
            _log(
                "warning",
                "remotefs.session_create_failed",
                protocol=protocol,
                host=host,
                port=port,
                username=username,
                kind=info.get("kind"),
                hint=info.get("hint"),
            )
            return error_response(
                "connect_failed",
                400,
                ok=False,
                kind=info.get("kind"),
                hint=info.get("hint"),
                security={**(effective_sec or {}), "protocol": protocol},
                warnings=warnings,
            )

        _log(
            "info",
            "remotefs.session_create",
            sid=s.session_id,
            protocol=s.protocol,
            host=s.host,
            port=s.port,
            username=s.username,
            auth=auth_type,
        )

        return jsonify(
            {
                "ok": True,
                "session_id": s.session_id,
                "protocol": s.protocol,
                "host": s.host,
                "port": s.port,
                "username": s.username,
                "features": {"stream_download": True, "upload": True},
                "security": {**(effective_sec or {}), "protocol": protocol},
                "warnings": warnings,
            }
        )

    @bp.delete("/api/remotefs/sessions/<sid>")
    def api_remotefs_close_session(sid: str) -> Any:
        if (resp := require_enabled()) is not None:
            return resp
        closed = mgr.close(sid)
        _log("info", "remotefs.session_close", sid=sid, closed=bool(closed))
        return jsonify({"ok": True, "closed": bool(closed)})
