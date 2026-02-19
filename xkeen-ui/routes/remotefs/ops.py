"""/api/remotefs/sessions/<sid>/* endpoints (list/stat/mkdir/rename/remove).

Extracted from routes_remotefs.py.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Tuple

from flask import Blueprint, jsonify, request

from routes.common.errors import error_response as _error_response
from services.fs_common.lftp_quote import _lftp_quote
from services.fs_common.remote_parse import _parse_ls_line


def register_ops_endpoints(
    bp: Blueprint,
    *,
    get_session_or_404: Callable[[str], Tuple[Any | None, Any | None]],
    mgr: Any,
    core_log: Callable[..., None] | None = None,
    error_response=_error_response,
) -> None:
    def _log(level: str, msg: str, **extra) -> None:
        try:
            if callable(core_log):
                core_log(level, msg, **extra)
        except Exception:
            pass

    @bp.get("/api/remotefs/sessions/<sid>/list")
    def api_remotefs_list(sid: str) -> Any:
        s, resp = get_session_or_404(sid)
        if resp is not None:
            return resp
        path = str(request.args.get("path", ".") or ".")
        path = path.strip()
        path_q = _lftp_quote(path)

        cmd = "cls -l" if (not path or path in (".",)) else f"cls -l {path_q}"
        rc, out, err = mgr._run_lftp(s, [cmd], capture=True)
        if rc != 0:
            tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
            return error_response("list_failed", 400, ok=False, details=tail)

        text = out.decode("utf-8", errors="replace")
        items: List[Dict[str, Any]] = []
        for line in text.splitlines():
            item = _parse_ls_line(line)
            if item is not None:
                items.append(item)
        return jsonify({"ok": True, "path": path, "items": items})

    @bp.get("/api/remotefs/sessions/<sid>/stat")
    def api_remotefs_stat(sid: str) -> Any:
        s, resp = get_session_or_404(sid)
        if resp is not None:
            return resp
        path = request.args.get("path", "")
        if not path:
            return error_response("path_required", 400, ok=False)
        path_q = _lftp_quote(path)

        rc, out, err = mgr._run_lftp(s, [f"cls -ld {path_q}"], capture=True)
        if rc != 0:
            tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
            return error_response("stat_failed", 400, ok=False, details=tail)

        text = out.decode("utf-8", errors="replace")
        first = None
        for line in text.splitlines():
            first = _parse_ls_line(line)
            if first:
                break
        if not first:
            return error_response("stat_unavailable", 404, ok=False)
        return jsonify({"ok": True, "path": path, "item": first})

    @bp.post("/api/remotefs/sessions/<sid>/mkdir")
    def api_remotefs_mkdir(sid: str) -> Any:
        s, resp = get_session_or_404(sid)
        if resp is not None:
            return resp
        data = request.get_json(silent=True) or {}
        path = str(data.get("path", "")).strip()
        if not path:
            return error_response("path_required", 400, ok=False)
        parents = bool(data.get("parents", False))
        cmd = f"mkdir {'-p ' if parents else ''}{_lftp_quote(path)}"
        rc, out, err = mgr._run_lftp(s, [cmd], capture=True)
        if rc != 0:
            tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
            return error_response("mkdir_failed", 400, ok=False, details=tail)
        _log("info", "remotefs.mkdir", sid=sid, path=path, parents=bool(parents))
        return jsonify({"ok": True})

    @bp.post("/api/remotefs/sessions/<sid>/rename")
    def api_remotefs_rename(sid: str) -> Any:
        s, resp = get_session_or_404(sid)
        if resp is not None:
            return resp
        data = request.get_json(silent=True) or {}
        src = str(data.get("src", "")).strip()
        dst = str(data.get("dst", "")).strip()
        if not src or not dst:
            return error_response("src_dst_required", 400, ok=False)
        rc, out, err = mgr._run_lftp(s, [f"mv {_lftp_quote(src)} {_lftp_quote(dst)}"], capture=True)
        if rc != 0:
            tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
            return error_response("rename_failed", 400, ok=False, details=tail)
        _log("info", "remotefs.rename", sid=sid, src=src, dst=dst)
        return jsonify({"ok": True})

    @bp.delete("/api/remotefs/sessions/<sid>/remove")
    def api_remotefs_remove(sid: str) -> Any:
        s, resp = get_session_or_404(sid)
        if resp is not None:
            return resp
        path = request.args.get("path", "")
        if not path:
            return error_response("path_required", 400, ok=False)
        recursive = request.args.get("recursive", "0") in ("1", "true", "yes", "on")

        if recursive:
            cmds = [f"rm -r {_lftp_quote(path)}"]
            rc, out, err = mgr._run_lftp(s, cmds, capture=True)
            if rc != 0:
                tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
                return error_response("remove_failed", 400, ok=False, details=tail)
            _log("info", "remotefs.remove", sid=sid, path=path, recursive=True)
            _log("info", "remotefs.remove", sid=sid, path=path, recursive=False, rmdir=True)
        return jsonify({"ok": True})

        # non-recursive: try rm then rmdir
        rc, out, err = mgr._run_lftp(s, [f"rm {_lftp_quote(path)}"], capture=True)
        if rc == 0:
            _log("info", "remotefs.remove", sid=sid, path=path, recursive=False)
            return jsonify({"ok": True})
        rc2, out2, err2 = mgr._run_lftp(s, [f"rmdir {_lftp_quote(path)}"], capture=True)
        if rc2 != 0:
            tail = (err2.decode("utf-8", errors="replace")[-400:]).strip()
            return error_response("remove_failed", 400, ok=False, details=tail)
        return jsonify({"ok": True})
