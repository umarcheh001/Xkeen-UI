"""FS endpoints: download + upload.

Extracted from routes.fs.blueprint to keep the blueprint module smaller.

Commit 5: starts pulling upload/download staging helpers into services.filemanager.transfer.
"""

from __future__ import annotations

import os
import shutil
import stat
import uuid
from typing import Any, Dict

from flask import Response, jsonify, request, send_file

from services.filemanager.transfer import save_filestorage_to_tmp, stream_file_then_cleanup
from services.xray_assets import ensure_xray_dat_assets


def _sync_uploaded_xray_dat_if_needed(path: str, *, core_log=None) -> None:
    uploaded_path = str(path or "").strip()
    if not uploaded_path or not uploaded_path.lower().endswith(".dat"):
        return

    dat_dir = os.environ.get("XRAY_DAT_DIR") or "/opt/etc/xray/dat"
    asset_dir = os.environ.get("XRAY_ASSET_DIR") or "/opt/sbin"

    try:
        uploaded_real = os.path.realpath(uploaded_path)
        dat_real = os.path.realpath(dat_dir)
        if os.path.commonpath([uploaded_real, dat_real]) != dat_real:
            return
    except Exception:
        return

    try:
        ensure_xray_dat_assets(
            dat_dir=dat_dir,
            asset_dir=asset_dir,
            log=(lambda line: core_log("info", line)) if callable(core_log) else None,
        )
    except Exception as exc:
        if callable(core_log):
            core_log("warning", "fs.upload.xray_assets_failed", error=str(exc), path=uploaded_real)


def register_transfer_endpoints(bp, deps: Dict[str, Any]) -> None:
    error_response = deps["error_response"]
    _require_enabled = deps["_require_enabled"]
    _get_session_or_404 = deps["_get_session_or_404"]
    _core_log = deps.get("_core_log")

    LOCALFS_ROOTS = deps["LOCALFS_ROOTS"]
    TMP_DIR = deps["TMP_DIR"]
    MAX_UPLOAD_MB = deps["MAX_UPLOAD_MB"]

    mgr = deps["mgr"]
    _lftp_quote = deps["_lftp_quote"]
    _parse_ls_line = deps["_parse_ls_line"]

    _local_resolve = deps["_local_resolve"]
    _local_is_protected_entry_abs = deps.get("_local_is_protected_entry_abs")

    _content_disposition_attachment = deps["_content_disposition_attachment"]
    _zip_directory = deps["_zip_directory"]

    _zip_precheck_or_confirm = deps["_zip_precheck_or_confirm"]
    _dir_walk_sum_bytes = deps["_dir_walk_sum_bytes"]
    _tmp_free_bytes = deps["_tmp_free_bytes"]
    _remote_estimate_tree_bytes = deps["_remote_estimate_tree_bytes"]
    _run_lftp_mirror_with_tmp_cap = deps["_run_lftp_mirror_with_tmp_cap"]

    MAX_ZIP_BYTES = deps.get("MAX_ZIP_BYTES")

    _apply_local_metadata_best_effort = deps.get("_apply_local_metadata_best_effort")

    @bp.get("/api/fs/download")
    def api_fs_download() -> Any:
        """Download a file from local sandbox or remote session.

        Query params:
          target=local|remote
          path=<full path>
          sid=<remote session id> (for target=remote)
        """
        if (resp := _require_enabled()) is not None:
            return resp
        target = str(request.args.get("target", "") or "").strip().lower()
        path = str(request.args.get("path", "") or "").strip()
        archive = str(request.args.get("archive", "") or request.args.get("as", "") or "").strip().lower()
        want_zip = archive in ("zip", "1", "true", "yes", "on")
        confirm = str(request.args.get("confirm", "") or "").strip().lower() in ("1", "true", "yes", "on")
        dry_run = str(request.args.get("dry_run", "") or request.args.get("preflight", "") or "").strip().lower() in (
            "1",
            "true",
            "yes",
            "on",
        )
        if target not in ("local", "remote"):
            return error_response("bad_target", 400, ok=False)
        if not path:
            return error_response("path_required", 400, ok=False)

        if target == "local":
            try:
                rp = _local_resolve(path, LOCALFS_ROOTS)
            except PermissionError:
                return error_response("Доступ к пути запрещён.", 403, ok=False, code="forbidden")

            # Distinguish missing path from wrong type so UI can show correct message.
            if not os.path.exists(rp):
                return error_response("not_found", 404, ok=False)

            if os.path.isdir(rp):
                if not want_zip:
                    return error_response("not_a_file", 400, ok=False)

                base = os.path.basename(rp.rstrip("/")) or "download"
                zip_name = base + ".zip"
                tmp_zip = os.path.join(TMP_DIR, f"xkeen_zip_local_{uuid.uuid4().hex}.zip")
                try:
                    est_bytes, est_items, est_trunc = None, 0, False
                    if MAX_ZIP_BYTES is not None or dry_run:
                        est_bytes, est_items, est_trunc = _dir_walk_sum_bytes(rp)

                    tmp_need = None
                    if isinstance(est_bytes, int) and est_bytes >= 0:
                        tmp_need = int(est_bytes * 1.20) + (8 * 1024 * 1024)
                    elif MAX_ZIP_BYTES is not None:
                        tmp_need = int(MAX_ZIP_BYTES * 1.20) + (8 * 1024 * 1024)

                    if dry_run:
                        return jsonify(
                            {
                                "ok": True,
                                "dry_run": True,
                                "kind": "download_dir_zip",
                                "target": "local",
                                "path": rp,
                                "estimated_bytes": est_bytes,
                                "estimate_items": est_items,
                                "estimate_truncated": bool(est_trunc),
                                "max_bytes": MAX_ZIP_BYTES,
                                "tmp_free_bytes": _tmp_free_bytes(),
                                "tmp_need_bytes": tmp_need,
                                "confirm_required": bool((MAX_ZIP_BYTES is not None) and (est_bytes is None or est_trunc)),
                            }
                        )

                    if (resp3 := _zip_precheck_or_confirm(
                        estimated_bytes=est_bytes,
                        truncated=bool(est_trunc),
                        confirm=bool(confirm),
                        kind="download_dir_zip_local",
                        tmp_need_bytes=tmp_need,
                    )) is not None:
                        return resp3

                    _zip_directory(rp, tmp_zip, root_name=base)
                    try:
                        size_bytes = int(os.path.getsize(tmp_zip))
                    except Exception:
                        size_bytes = None

                    headers = {
                        "Content-Disposition": _content_disposition_attachment(zip_name),
                        "Cache-Control": "no-store",
                    }
                    if isinstance(size_bytes, int) and size_bytes >= 0:
                        headers["Content-Length"] = str(size_bytes)

                    return Response(
                        stream_file_then_cleanup(tmp_zip, cleanup_files=[tmp_zip]),
                        mimetype="application/zip",
                        headers=headers,
                    )
                except Exception:
                    try:
                        if os.path.exists(tmp_zip):
                            os.remove(tmp_zip)
                    except Exception:
                        pass
                    return error_response("zip_failed", 400, ok=False)

            if not os.path.isfile(rp):
                return error_response("not_a_file", 400, ok=False)
            resp2 = send_file(
                rp,
                as_attachment=True,
                download_name=os.path.basename(rp),
                mimetype="application/octet-stream",
                conditional=True,
            )
            try:
                resp2.headers["Cache-Control"] = "no-store"
            except Exception:
                pass
            return resp2

        # remote
        sid = str(request.args.get("sid") or "").strip()
        if not sid:
            return error_response("sid_required", 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        rc, out, err = mgr._run_lftp(s, [f"cls -ld {_lftp_quote(path)}"], capture=True)
        if rc != 0:
            tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
            return error_response("not_found", 404, ok=False, details=tail)

        is_dir = False
        size_bytes = None
        try:
            text = (out or b"").decode("utf-8", errors="replace")
            for line in text.splitlines():
                item = _parse_ls_line(line)
                if not item:
                    continue
                is_dir = (str(item.get("type") or "") == "dir")
                try:
                    size_bytes = int(item.get("size", None))
                except Exception:
                    size_bytes = None
                break
        except Exception:
            is_dir = False
            size_bytes = None

        if is_dir:
            if not want_zip:
                return error_response("not_a_file", 400, ok=False)

            base = os.path.basename(path.rstrip("/")) or "download"
            zip_name = base + ".zip"
            tmp_root = os.path.join(TMP_DIR, f"xkeen_zip_remote_{sid}_{uuid.uuid4().hex}")
            tmp_dir = os.path.join(tmp_root, base)
            tmp_zip = os.path.join(TMP_DIR, f"xkeen_zip_remote_{sid}_{uuid.uuid4().hex}.zip")
            try:
                est_bytes, est_items, est_trunc = None, 0, False
                if MAX_ZIP_BYTES is not None or dry_run:
                    est_bytes, est_items, est_trunc = _remote_estimate_tree_bytes(s, path)

                tmp_need = None
                if isinstance(est_bytes, int) and est_bytes >= 0:
                    tmp_need = int(est_bytes * 2.20) + (32 * 1024 * 1024)
                elif MAX_ZIP_BYTES is not None:
                    tmp_need = int(MAX_ZIP_BYTES * 2.20) + (32 * 1024 * 1024)

                if dry_run:
                    return jsonify(
                        {
                            "ok": True,
                            "dry_run": True,
                            "kind": "download_dir_zip",
                            "target": "remote",
                            "sid": sid,
                            "path": path,
                            "estimated_bytes": est_bytes,
                            "estimate_items": est_items,
                            "estimate_truncated": bool(est_trunc),
                            "max_bytes": MAX_ZIP_BYTES,
                            "tmp_free_bytes": _tmp_free_bytes(),
                            "tmp_need_bytes": tmp_need,
                            "confirm_required": bool((MAX_ZIP_BYTES is not None) and (est_bytes is None or est_trunc)),
                        }
                    )

                if (resp3 := _zip_precheck_or_confirm(
                    estimated_bytes=est_bytes,
                    truncated=bool(est_trunc),
                    confirm=bool(confirm),
                    kind="download_dir_zip_remote",
                    tmp_need_bytes=tmp_need,
                )) is not None:
                    return resp3

                os.makedirs(tmp_dir, exist_ok=True)

                hard_cap = None
                if MAX_ZIP_BYTES is not None:
                    base_cap = est_bytes if isinstance(est_bytes, int) and est_bytes >= 0 else MAX_ZIP_BYTES
                    hard_cap = int(base_cap * 2.50) + (32 * 1024 * 1024)
                _run_lftp_mirror_with_tmp_cap(s, src=path, dst=tmp_dir, hard_cap_bytes=hard_cap)

                _zip_directory(tmp_dir, tmp_zip, root_name=base)
                try:
                    zsize = int(os.path.getsize(tmp_zip))
                except Exception:
                    zsize = None

                headers = {
                    "Content-Disposition": _content_disposition_attachment(zip_name),
                    "Cache-Control": "no-store",
                }
                if isinstance(zsize, int) and zsize >= 0:
                    headers["Content-Length"] = str(zsize)

                return Response(
                    stream_file_then_cleanup(tmp_zip, cleanup_files=[tmp_zip], cleanup_dirs=[tmp_root]),
                    mimetype="application/zip",
                    headers=headers,
                )

            except Exception as e:
                try:
                    if os.path.exists(tmp_zip):
                        os.remove(tmp_zip)
                except Exception:
                    pass
                try:
                    shutil.rmtree(tmp_root, ignore_errors=True)
                except Exception:
                    pass
                msg = str(e)
                det = None
                if msg == "tmp_limit_exceeded":
                    return error_response(
                        "tmp_limit_exceeded",
                        413,
                        ok=False,
                        max_bytes=MAX_ZIP_BYTES,
                        message="Создание архива прервано: превышен лимит использования /tmp (см. XKEEN_MAX_ZIP_MB).",
                    )
                if "mirror_failed:" in msg:
                    det = msg.split("mirror_failed:", 1)[1].strip()[-400:]
                return error_response("zip_failed", 400, ok=False, details=det)

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

    @bp.post("/api/fs/upload")
    def api_fs_upload() -> Any:
        """Upload a file to local sandbox or remote session."""
        if (resp := _require_enabled()) is not None:
            return resp

        overwrite = str(request.args.get("overwrite", "") or "").strip().lower() in ("1", "true", "yes", "on")
        create_parents = str(request.args.get("parents", "") or "").strip().lower() in ("1", "true", "yes", "on")
        target = str(request.args.get("target", "") or "").strip().lower()
        path = str(request.args.get("path", "") or "").strip()

        if target not in ("local", "remote"):
            return error_response("bad_target", 400, ok=False)
        if not path:
            return error_response("path_required", 400, ok=False)
        if "file" not in request.files:
            return error_response("file_required", 400, ok=False)
        f = request.files["file"]
        if not f:
            return error_response("file_required", 400, ok=False)

        raw_name = str(getattr(f, "filename", "") or "").strip()
        safe_fn = os.path.basename(raw_name) if raw_name else "upload.bin"
        if not safe_fn:
            safe_fn = "upload.bin"

        max_bytes = int(MAX_UPLOAD_MB) * 1024 * 1024

        if target == "local":
            dest = path
            if dest.endswith("/"):
                dest = dest.rstrip("/") + "/" + safe_fn
            else:
                try:
                    rp_probe = _local_resolve(dest, LOCALFS_ROOTS)
                    if os.path.isdir(rp_probe):
                        dest = os.path.join(dest, safe_fn)
                except Exception:
                    pass

            try:
                rp = _local_resolve(dest, LOCALFS_ROOTS)
            except PermissionError:
                return error_response("Доступ к пути запрещён.", 403, ok=False, code="forbidden")

            # Guard against accidental uploads into /tmp/mnt root (mount hub).
            # Those "loose" files are confusing and were historically undeletable.
            try:
                if callable(_local_is_protected_entry_abs) and _local_is_protected_entry_abs(rp):
                    return error_response("protected_path", 403, ok=False)
            except Exception:
                pass

            parent = os.path.dirname(rp)
            if parent and not os.path.isdir(parent):
                return error_response("parent_not_found", 400, ok=False)

            st0 = None
            try:
                if os.path.lexists(rp):
                    if os.path.isdir(rp):
                        return error_response("not_a_file", 409, ok=False, target="local", path=rp, type="dir")
                    if not overwrite:
                        etype = "file"
                        try:
                            stx = os.lstat(rp)
                            mode_i = int(getattr(stx, "st_mode", 0) or 0)
                            if stat.S_ISLNK(mode_i):
                                etype = "link"
                        except Exception:
                            etype = "file"
                        return error_response("exists", 409, ok=False, target="local", path=rp, type=etype)
                    try:
                        st0 = os.stat(rp)
                    except Exception:
                        st0 = None
            except Exception:
                st0 = None

            try:
                tmp_path, total = save_filestorage_to_tmp(
                    f,
                    tmp_dir=TMP_DIR,
                    prefix="xkeen_upload_local_",
                    max_bytes=max_bytes,
                )
            except ValueError as e:
                if str(e) == "too_large":
                    return error_response("upload_too_large", 413, ok=False, max_mb=MAX_UPLOAD_MB)
                return error_response("upload_failed", 400, ok=False)
            except Exception:
                return error_response("upload_failed", 400, ok=False)

            try:
                os.replace(tmp_path, rp)
            except Exception:
                try:
                    shutil.move(tmp_path, rp)
                except Exception:
                    try:
                        os.remove(tmp_path)
                    except Exception:
                        pass
                    return error_response("upload_failed", 400, ok=False)

            if callable(_apply_local_metadata_best_effort):
                _apply_local_metadata_best_effort(rp, st0)

            if callable(_core_log):
                _core_log("info", "fs.upload", target="local", path=str(rp), bytes=int(total), overwrite=bool(overwrite))

            _sync_uploaded_xray_dat_if_needed(rp, core_log=_core_log)

            return jsonify({"ok": True, "bytes": total, "path": rp})

        # remote
        sid = str(request.args.get("sid") or "").strip()
        if not sid:
            return error_response("sid_required", 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            return resp

        remote_path = path
        if remote_path.endswith("/"):
            remote_path = remote_path.rstrip("/") + "/" + safe_fn
        else:
            try:
                # best-effort detect dir via `cls -ld`
                rc, out, err = mgr._run_lftp(s, [f"cls -ld {_lftp_quote(remote_path)}"], capture=True)
                if rc == 0:
                    text = (out or b"").decode("utf-8", errors="replace")
                    for line in text.splitlines():
                        item = _parse_ls_line(line)
                        if not item:
                            continue
                        if str(item.get("type") or "") == "dir":
                            remote_path = remote_path.rstrip("/") + "/" + safe_fn
                        break
            except Exception:
                pass

        if not overwrite:
            try:
                rc, out, err = mgr._run_lftp(s, [f"cls -ld {_lftp_quote(remote_path)}"], capture=True)
                if rc == 0:
                    text = (out or b"").decode("utf-8", errors="replace")
                    for line in text.splitlines():
                        item = _parse_ls_line(line)
                        if not item:
                            continue
                        if str(item.get("type") or "") == "dir":
                            return error_response("not_a_file", 409, ok=False, target="remote", path=remote_path, type="dir")
                        return error_response("exists", 409, ok=False, target="remote", path=remote_path, type="file")
            except Exception:
                pass

        try:
            tmp_path, total = save_filestorage_to_tmp(
                f,
                tmp_dir=TMP_DIR,
                prefix=f"xkeen_upload_{sid}_",
                max_bytes=max_bytes,
            )
        except ValueError as e:
            if str(e) == "too_large":
                return error_response("upload_too_large", 413, ok=False, max_mb=MAX_UPLOAD_MB)
            return error_response("upload_failed", 400, ok=False)
        except Exception:
            return error_response("upload_failed", 400, ok=False)

        try:
            if create_parents:
                parent = os.path.dirname(remote_path.rstrip("/"))
                if parent and parent not in ("", "."):
                    rc_m, out_m, err_m = mgr._run_lftp(s, [f"mkdir -p {_lftp_quote(parent)}"], capture=True)
                    if rc_m != 0:
                        tail_err = (err_m.decode("utf-8", errors="replace")[-400:]).strip()
                        tail_out = (out_m.decode("utf-8", errors="replace")[-400:]).strip()
                        tail = tail_err or tail_out or f"rc={rc_m}"
                        return error_response("remote_mkdir_failed", 400, ok=False, details=tail)

            rc, out, err = mgr._run_lftp(s, [f"put {_lftp_quote(tmp_path)} -o {_lftp_quote(remote_path)}"], capture=True)
            if rc != 0:
                tail = (err.decode("utf-8", errors="replace")[-400:]).strip()
                return error_response("remote_put_failed", 400, ok=False, details=tail)

            if callable(_core_log):
                _core_log("info", "fs.upload", target="remote", sid=sid, path=remote_path, bytes=int(total), overwrite=bool(overwrite))

            return jsonify({"ok": True, "bytes": total})
        finally:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass
