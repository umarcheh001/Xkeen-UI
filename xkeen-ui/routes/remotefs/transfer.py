"""/api/remotefs/sessions/<sid>/(download|upload) endpoints.

Extracted from routes_remotefs.py.
"""

from __future__ import annotations

import os
import uuid
from typing import Any, Callable, Tuple

from flask import Blueprint, Response, jsonify, request

from routes.common.errors import error_response as _error_response
from services.fs_common.lftp_quote import _lftp_quote
from services.fs_common.remote_parse import _parse_ls_line
from services.fs_common.http import _content_disposition_attachment


def register_transfer_endpoints(
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

    @bp.get("/api/remotefs/sessions/<sid>/download")
    def api_remotefs_download(sid: str) -> Any:
        s, resp = get_session_or_404(sid)
        if resp is not None:
            return resp
        path = request.args.get("path", "")
        if not path:
            return error_response("path_required", 400, ok=False)

        rc, out, err = mgr._run_lftp(s, [f"cls -ld {_lftp_quote(path)}"], capture=True)
        if rc != 0:
            return error_response("not_found", 404, ok=False)

        size_bytes: int | None = None
        try:
            text = (out or b"").decode("utf-8", errors="replace")
            for line in text.splitlines():
                item = _parse_ls_line(line)
                if not item:
                    continue
                if str(item.get("type") or "") == "dir":
                    return error_response("not_a_file", 400, ok=False)
                sz = item.get("size", None)
                if isinstance(sz, int) and sz >= 0:
                    size_bytes = int(sz)
                else:
                    try:
                        size_bytes = int(sz)
                    except Exception:
                        size_bytes = None
                break
        except Exception:
            size_bytes = None

        p = mgr._popen_lftp(s, [f"cat {_lftp_quote(path)}"])
        stdout = p.stdout
        stderr = p.stderr

        def _gen():
            try:
                assert stdout is not None
                while True:
                    chunk = stdout.read(64 * 1024)
                    if not chunk:
                        break
                    yield chunk
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
                    p.wait(timeout=1)
                except Exception:
                    pass

        filename = os.path.basename(path.rstrip("/")) or "download"
        headers = {
            "Content-Disposition": _content_disposition_attachment(filename),
            "Cache-Control": "no-store",
        }
        if isinstance(size_bytes, int) and size_bytes >= 0:
            headers["Content-Length"] = str(size_bytes)
        return Response(_gen(), mimetype="application/octet-stream", headers=headers)

    @bp.post("/api/remotefs/sessions/<sid>/upload")
    def api_remotefs_upload(sid: str) -> Any:
        s, resp = get_session_or_404(sid)
        if resp is not None:
            return resp

        remote_path = request.args.get("path", "")
        if not remote_path:
            return error_response("path_required", 400, ok=False)

        if "file" not in request.files:
            return error_response("file_required", 400, ok=False)

        f = request.files["file"]
        if not f:
            return error_response("file_required", 400, ok=False)

        max_bytes = int(mgr.max_upload_mb) * 1024 * 1024
        os.makedirs(mgr.tmp_dir, exist_ok=True)
        tmp_path = os.path.join(mgr.tmp_dir, f"xkeen_upload_{sid}_{uuid.uuid4().hex}.tmp")

        total = 0
        try:
            with open(tmp_path, "wb") as outfp:
                while True:
                    chunk = f.stream.read(64 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError("too_large")
                    outfp.write(chunk)
        except ValueError as e:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            if str(e) == "too_large":
                return error_response("upload_too_large", 413, ok=False, max_mb=mgr.max_upload_mb)
            return error_response("upload_failed", 400, ok=False)
        except Exception:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
            return error_response("upload_failed", 400, ok=False)

        try:
            rc, out, err = mgr._run_lftp(
                s,
                [f"put {_lftp_quote(tmp_path)} -o {_lftp_quote(remote_path)}"],
                capture=True,
            )
            if rc != 0:
                return error_response("remote_put_failed", 400, ok=False)
            _log("info", "remotefs.upload", sid=sid, path=remote_path, bytes=int(total))
            return jsonify({"ok": True, "bytes": total})
        finally:
            try:
                os.remove(tmp_path)
            except Exception:
                pass
