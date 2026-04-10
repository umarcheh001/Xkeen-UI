from __future__ import annotations

from typing import Any, Dict

from flask import Blueprint, jsonify, request

from services.filemanager.trash import (
    clear_local_trash,
    remove_local,
    restore_local_from_trash,
)


def register_trash_endpoints(bp: Blueprint, deps: Dict[str, Any]) -> None:
    """Register remove/restore/trash/clear endpoints."""

    error_response = deps['error_response']
    _require_enabled = deps['_require_enabled']
    _get_session_or_404 = deps['_get_session_or_404']
    _core_log = deps['_core_log']
    LOCALFS_ROOTS = deps['LOCALFS_ROOTS']
    mgr = deps['mgr']
    _lftp_quote = deps['_lftp_quote']
    # NOTE: local path resolution + "not found" handling is done inside services.filemanager.trash.remove_local


    @bp.delete('/api/fs/remove')
    def api_fs_remove() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        target = str(request.args.get('target') or '').strip().lower()
        path_s = str(request.args.get('path') or '').strip()
        recursive = (request.args.get('recursive', '0') or '') in ('1', 'true', 'yes', 'on')
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path_s:
            return error_response('path_required', 400, ok=False)

        if target == 'local':
            # Trash by default; allow permanent delete with ?hard=1 or ?permanent=1.
            hard = (request.args.get('hard', '0') or '') in ('1', 'true', 'yes', 'on') or (request.args.get('permanent', '0') or '') in ('1', 'true', 'yes', 'on')
            try:
                info = remove_local(path_s, LOCALFS_ROOTS, hard=bool(hard))
            except PermissionError as e:
                code = str(e)
                if code == 'refuse_delete_mountpoint':
                    return error_response(code, 403, ok=False)
                return error_response(code or 'path_not_allowed', 403, ok=False)
            except FileNotFoundError:
                return error_response('not_found', 404, ok=False)
            except Exception:
                return error_response('remove_failed', 400, ok=False)
            _core_log("info", "fs.remove", target="local", path=path_s, hard=bool(hard), recursive=bool(recursive))
            return jsonify({'ok': True, 'delete': info})

        sid = str(request.args.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp
        if recursive:
            rc, out, err = mgr._run_lftp(s, [f"rm -r {_lftp_quote(path_s)}"], capture=True)
            if rc != 0:
                return error_response('remove_failed', 400, ok=False)
            _core_log("info", "fs.remove", target="remote", sid=sid, path=path_s, recursive=True)
            return jsonify({'ok': True})
        rc, out, err = mgr._run_lftp(s, [f"rm {_lftp_quote(path_s)}"], capture=True)
        if rc == 0:
            _core_log("info", "fs.remove", target="remote", sid=sid, path=path_s, recursive=False)
            return jsonify({'ok': True})
        rc2, out2, err2 = mgr._run_lftp(s, [f"rmdir {_lftp_quote(path_s)}"], capture=True)
        if rc2 != 0:
            return error_response('remove_failed', 400, ok=False)
        _core_log("info", "fs.remove", target="remote", sid=sid, path=path_s, recursive=False, rmdir=True)
        return jsonify({'ok': True})


    @bp.post('/api/fs/restore')
    def api_fs_restore() -> Any:
        """Restore entries from trash back to their original locations."""

        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str((data.get('target') or 'local')).strip().lower()
        if target != 'local':
            return error_response('bad_target', 400, ok=False)
        paths = data.get('paths')
        if not isinstance(paths, list):
            p1 = data.get('path')
            paths = [p1] if p1 else []
        paths = [str(x or '').strip() for x in paths if str(x or '').strip()]
        if not paths:
            return error_response('path_required', 400, ok=False)

        restored, errors = restore_local_from_trash(paths, LOCALFS_ROOTS)
        _core_log("info", "fs.restore", target="local", restored=len(restored), errors=len(errors))
        return jsonify({'ok': True, 'restored': restored, 'errors': errors})


    @bp.post('/api/fs/trash/clear')
    def api_fs_trash_clear() -> Any:
        """Permanently remove everything inside the local trash directory."""

        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        target = str((data.get('target') or 'local')).strip().lower()
        if target != 'local':
            return error_response('bad_target', 400, ok=False)

        try:
            res = clear_local_trash(LOCALFS_ROOTS)
        except PermissionError:
            return error_response("Доступ к корзине запрещён.", 403, ok=False, code="forbidden")
        except Exception:
            return error_response(
                "Не удалось очистить корзину.",
                400,
                ok=False,
                code="trash_clear_failed",
                hint="Подробности смотрите в server logs.",
            )

        _core_log(
            "info",
            "fs.trash_clear",
            deleted=int(res.get('deleted') or 0),
            meta_deleted=int(res.get('meta_deleted') or 0),
            errors=len(res.get('errors') or []),
        )
        return jsonify({'ok': True, **res})
