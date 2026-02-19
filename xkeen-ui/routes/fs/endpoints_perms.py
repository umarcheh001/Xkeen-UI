from __future__ import annotations

from typing import Any, Dict

from flask import Blueprint, jsonify, request

from services.filemanager.perms import chmod_local, chown_local, parse_mode_value


def register_perms_endpoints(bp: Blueprint, deps: Dict[str, Any]) -> None:
    """Register chmod/chown endpoints."""

    error_response = deps['error_response']
    _require_enabled = deps['_require_enabled']
    _get_session_or_404 = deps['_get_session_or_404']
    _core_log = deps['_core_log']
    LOCALFS_ROOTS = deps['LOCALFS_ROOTS']
    mgr = deps['mgr']
    _lftp_quote = deps['_lftp_quote']
    _local_resolve = deps['_local_resolve']


    @bp.post('/api/fs/chmod')
    def api_fs_chmod() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str(data.get('target') or '').strip().lower()
        path_s = str(data.get('path') or '').strip()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path_s:
            return error_response('path_required', 400, ok=False)
        try:
            mode_i = parse_mode_value(data.get('mode'))
        except RuntimeError as e:
            return error_response(str(e), 400, ok=False)
        except Exception:
            return error_response('bad_mode', 400, ok=False)

        if target == 'local':
            try:
                rp = _local_resolve(path_s, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)
            try:
                chmod_local(rp, mode_i)
            except Exception:
                return error_response('chmod_failed', 400, ok=False)
            _core_log("info", "fs.chmod", target="local", path=path_s, mode=oct(mode_i))
            return jsonify({'ok': True, 'target': 'local', 'path': rp, 'mode': mode_i})

        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        rc, out, err = mgr._run_lftp(s, [f"chmod {mode_i:o} {_lftp_quote(path_s)}"], capture=True)
        if rc != 0:
            tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('chmod_failed', 400, ok=False, details=tail)
        _core_log("info", "fs.chmod", target="remote", sid=sid, path=path_s, mode=oct(mode_i))
        return jsonify({'ok': True, 'target': 'remote', 'sid': sid, 'path': path_s, 'mode': mode_i})


    @bp.post('/api/fs/chown')
    def api_fs_chown() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str(data.get('target') or '').strip().lower()
        path_s = str(data.get('path') or '').strip()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path_s:
            return error_response('path_required', 400, ok=False)
        uid = data.get('uid')
        gid = data.get('gid')
        try:
            uid_i = int(uid)
            gid_i = int(gid) if gid is not None else -1
        except Exception:
            return error_response('bad_owner', 400, ok=False)

        if target == 'local':
            try:
                rp = _local_resolve(path_s, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)
            try:
                chown_local(rp, uid_i, gid_i)
            except Exception:
                return error_response('chown_failed', 400, ok=False)
            _core_log("info", "fs.chown", target="local", path=path_s, uid=int(uid_i), gid=int(gid_i))
            return jsonify({'ok': True, 'target': 'local', 'path': rp, 'uid': uid_i, 'gid': gid_i})

        sid = str(data.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        if getattr(s, 'protocol', None) != 'sftp':
            return error_response('not_supported', 400, ok=False)
        owner = f"{uid_i}:{gid_i}" if gid_i >= 0 else str(uid_i)
        rc, out, err = mgr._run_lftp(s, [f"chown {owner} {_lftp_quote(path_s)}"], capture=True)
        if rc != 0:
            tail = (err.decode('utf-8', errors='replace')[-400:]).strip()
            return error_response('chown_failed', 400, ok=False, details=tail)
        _core_log("info", "fs.chown", target="remote", sid=sid, path=path_s, uid=int(uid_i), gid=int(gid_i))
        return jsonify({'ok': True, 'target': 'remote', 'sid': sid, 'path': path_s, 'uid': uid_i, 'gid': gid_i})
