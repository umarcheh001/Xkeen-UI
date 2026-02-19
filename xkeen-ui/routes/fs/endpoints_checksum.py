from __future__ import annotations

import os
from typing import Any, Dict

from flask import Blueprint, jsonify, request

from services.filemanager.checksum import hash_file, hash_stream


def register_checksum_endpoints(bp: Blueprint, deps: Dict[str, Any]) -> None:
    """Register checksum endpoint."""

    error_response = deps['error_response']
    _require_enabled = deps['_require_enabled']
    _get_session_or_404 = deps['_get_session_or_404']
    LOCALFS_ROOTS = deps['LOCALFS_ROOTS']
    mgr = deps['mgr']
    _lftp_quote = deps['_lftp_quote']
    _local_resolve = deps['_local_resolve']
    _remote_stat_type_size = deps['_remote_stat_type_size']


    @bp.get('/api/fs/checksum')
    def api_fs_checksum() -> Any:
        """Compute md5 and sha256 for a single file."""

        if (resp := _require_enabled()) is not None:
            return resp

        target = str(request.args.get('target', '') or '').strip().lower()
        path = str(request.args.get('path', '') or '').strip()
        if target not in ('local', 'remote'):
            return error_response('bad_target', 400, ok=False)
        if not path:
            return error_response('path_required', 400, ok=False)

        CHUNK = 256 * 1024

        if target == 'local':
            try:
                rp = _local_resolve(path, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e), 403, ok=False)

            if os.path.isdir(rp):
                return error_response('not_a_file', 400, ok=False)
            if not os.path.isfile(rp):
                return error_response('not_found', 404, ok=False)

            try:
                md5_hex, sha_hex, total = hash_file(rp, chunk_bytes=CHUNK)
            except Exception:
                return error_response('read_failed', 400, ok=False)

            try:
                size_bytes = int(os.path.getsize(rp))
            except Exception:
                size_bytes = int(total)

            return jsonify({
                'ok': True,
                'target': 'local',
                'path': rp,
                'size': size_bytes,
                'md5': md5_hex,
                'sha256': sha_hex,
            })

        # remote
        sid = str(request.args.get('sid') or '').strip()
        if not sid:
            return error_response('sid_required', 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        rtype, rsize = _remote_stat_type_size(s, path)
        if rtype is None:
            return error_response('not_found', 404, ok=False)
        if rtype == 'dir':
            return error_response('not_a_file', 400, ok=False)

        p2 = None
        stdout = None
        stderr = None
        try:
            p2 = mgr._popen_lftp(s, [f"cat {_lftp_quote(path)}"])
            stdout = p2.stdout
            stderr = p2.stderr
            if stdout is None:
                raise RuntimeError('no_stdout')

            md5_hex, sha_hex, total = hash_stream(stdout, chunk_bytes=CHUNK)

            try:
                rc = p2.wait(timeout=3)
            except Exception:
                rc = None
            if rc is not None and int(rc) != 0:
                return error_response('read_failed', 400, ok=False)

            return jsonify({
                'ok': True,
                'target': 'remote',
                'sid': sid,
                'path': path,
                'size': rsize if isinstance(rsize, int) else int(total),
                'md5': md5_hex,
                'sha256': sha_hex,
            })
        except Exception:
            return error_response('read_failed', 400, ok=False)
        finally:
            try:
                if stdout:
                    stdout.close()
            except Exception:
                pass
            try:
                if stderr:
                    stderr.close()
            except Exception:
                pass
            try:
                if p2:
                    try:
                        if getattr(p2, 'poll', None) and p2.poll() is None:
                            try:
                                p2.terminate()
                            except Exception:
                                pass
                    except Exception:
                        pass
                    try:
                        p2.wait(timeout=1)
                    except Exception:
                        pass
            except Exception:
                pass
