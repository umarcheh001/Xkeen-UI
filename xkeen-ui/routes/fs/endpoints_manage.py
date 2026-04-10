from __future__ import annotations

import os
from typing import Any, Dict

from flask import Blueprint, jsonify, request

from services.filemanager.local_ops import mkdir_local, rename_local, touch_local

def register_manage_endpoints(bp: Blueprint, deps: Dict[str, Any]) -> None:
    """Register mkdir/rename/touch endpoints."""

    error_response = deps['error_response']
    _require_enabled = deps['_require_enabled']
    _get_session_or_404 = deps['_get_session_or_404']
    _core_log = deps['_core_log']
    LOCALFS_ROOTS = deps['LOCALFS_ROOTS']
    mgr = deps['mgr']
    _lftp_quote = deps['_lftp_quote']
    _local_resolve = deps['_local_resolve']
    _local_resolve_nofollow = deps['_local_resolve_nofollow']
    _local_is_protected_entry_abs = deps['_local_is_protected_entry_abs']
    _remote_exists = deps['_remote_exists']


    @bp.post('/api/fs/mkdir')
    def api_fs_mkdir() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str(data.get('target') or '').strip().lower()
        path_s = str(data.get('path') or '').strip()
        parents = bool(data.get('parents', False))
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path_s:
            return error_response('path_required', 400, ok=False)

        if target == 'local':
            try:
                rp = _local_resolve(path_s, LOCALFS_ROOTS)
            except PermissionError:
                return error_response("Доступ к пути запрещён.", 403, ok=False, code="forbidden")
            try:
                mkdir_local(rp, parents=bool(parents))
            except FileExistsError:
                return error_response('exists', 409, ok=False)
            except Exception:
                return error_response('mkdir_failed', 400, ok=False)
            _core_log("info", "fs.mkdir", target="local", path=path_s, parents=bool(parents))
            return jsonify({'ok': True})

        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        cmd = f"mkdir {'-p ' if parents else ''}{_lftp_quote(path_s)}"
        rc, out, err = mgr._run_lftp(s, [cmd], capture=True)
        if rc != 0:
            tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('mkdir_failed', 400, ok=False, details=tail)
        return jsonify({'ok': True})


    @bp.post('/api/fs/rename')
    def api_fs_rename() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str(data.get('target') or '').strip().lower()
        src_p = str(data.get('src') or '').strip()
        dst_p = str(data.get('dst') or '').strip()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not src_p or not dst_p:
            return error_response('src_dst_required', 400, ok=False)

        if target == 'local':
            try:
                sp = _local_resolve_nofollow(src_p, LOCALFS_ROOTS)
                dp = _local_resolve_nofollow(dst_p, LOCALFS_ROOTS)
            except PermissionError:
                return error_response("Доступ к пути запрещён.", 403, ok=False, code="forbidden")
            if _local_is_protected_entry_abs(sp) or _local_is_protected_entry_abs(dp):
                return error_response('protected_path', 403, ok=False)
            try:
                rename_local(sp, dp)
            except FileNotFoundError:
                return error_response('not_found', 404, ok=False)
            except Exception:
                return error_response('rename_failed', 400, ok=False)
            _core_log("info", "fs.rename", target="local", src=src_p, dst=dst_p)
            return jsonify({'ok': True})

        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        rc, out, err = mgr._run_lftp(s, [f"mv {_lftp_quote(src_p)} {_lftp_quote(dst_p)}"], capture=True)
        if rc != 0:
            tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('rename_failed', 400, ok=False, details=tail)
        return jsonify({'ok': True})


    @bp.post('/api/fs/touch')
    def api_fs_touch() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str(data.get('target') or '').strip().lower()
        path_s = str(data.get('path') or '').strip()
        create_parents = bool(data.get('parents', True))
        create_only = bool(data.get('create_only', True))
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path_s:
            return error_response('path_required', 400, ok=False)

        if target == 'local':
            try:
                rp = _local_resolve(path_s, LOCALFS_ROOTS)
            except PermissionError:
                return error_response("Доступ к пути запрещён.", 403, ok=False, code="forbidden")
            try:
                skipped = touch_local(
                    rp,
                    create_parents=bool(create_parents),
                    create_only=bool(create_only),
                )
                if skipped:
                    _core_log("info", "fs.touch", target="local", path=path_s, skipped=True)
                    return jsonify({'ok': True, 'target': 'local', 'path': rp, 'skipped': True})
            except Exception:
                return error_response('touch_failed', 400, ok=False)
            _core_log("info", "fs.touch", target="local", path=path_s, skipped=False)
            return jsonify({'ok': True, 'target': 'local', 'path': rp})

        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        if create_only and _remote_exists(s, path_s):
            _core_log("info", "fs.touch", target="remote", sid=sid, path=path_s, skipped=True)
            return jsonify({'ok': True, 'target': 'remote', 'sid': sid, 'path': path_s, 'skipped': True})
        if create_parents:
            parent = os.path.dirname(path_s.rstrip('/'))
            if parent and parent not in ('', '.'):
                mgr._run_lftp(s, [f"mkdir -p {_lftp_quote(parent)}"], capture=True)
        rc, out, err = mgr._run_lftp(s, [f"put /dev/null -o {_lftp_quote(path_s)}"], capture=True)
        if rc != 0:
            tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('touch_failed', 400, ok=False, details=tail)
        _core_log("info", "fs.touch", target="remote", sid=sid, path=path_s, skipped=False)
        return jsonify({'ok': True, 'target': 'remote', 'sid': sid, 'path': path_s})
