"""FS archive endpoints.

Split out of routes/fs/blueprint.py in Commit 6.

Endpoints:
  - POST /api/fs/archive
  - POST /api/fs/archive/create
  - POST /api/fs/archive/extract
  - GET  /api/fs/archive/list
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
import subprocess
import tarfile
import time
import uuid
import zipfile
from typing import Any, Dict, List, Tuple

from flask import Blueprint, Response, jsonify, request

from services.filemanager.archive import (
    is_safe_extract_path,
    join_local_cwd,
    list_archive_contents,
    normalize_selection_items,
    sanitize_archive_filename,
    sanitize_root_name,
    sanitize_zip_filename,
    zipinfo_is_symlink,
)
from services.filemanager.transfer import stream_file_then_cleanup


def register_archive_endpoints(bp: Blueprint, deps: Dict[str, Any]) -> None:
    error_response = deps["error_response"]
    _require_enabled = deps["_require_enabled"]
    _get_session_or_404 = deps["_get_session_or_404"]
    _core_log = deps["_core_log"]
    LOCALFS_ROOTS = deps["LOCALFS_ROOTS"]
    TMP_DIR = deps["TMP_DIR"]
    MAX_ZIP_BYTES = deps.get("MAX_ZIP_BYTES")
    mgr = deps.get("mgr")
    _lftp_quote = deps.get("_lftp_quote")
    _parse_ls_line = deps.get("_parse_ls_line")
    _local_resolve = deps["_local_resolve"]
    _content_disposition_attachment = deps["_content_disposition_attachment"]
    _zip_directory = deps["_zip_directory"]
    _zip_selection_local = deps["_zip_selection_local"]
    _zip_precheck_or_confirm = deps["_zip_precheck_or_confirm"]
    _dir_walk_sum_bytes = deps["_dir_walk_sum_bytes"]
    _tmp_free_bytes = deps["_tmp_free_bytes"]
    _remote_estimate_tree_bytes = deps["_remote_estimate_tree_bytes"]
    _run_lftp_mirror_with_tmp_cap = deps["_run_lftp_mirror_with_tmp_cap"]

    @bp.post("/api/fs/archive")
    def api_fs_archive() -> Any:
        """Download multiple selected files/folders as a ZIP archive."""
        if (resp := _require_enabled()) is not None:
            return resp

        target = str(request.args.get("target", "") or "").strip().lower()
        if target not in ("local", "remote"):
            return error_response("bad_target", 400, ok=False)

        confirm = str(request.args.get("confirm", "") or "").strip().lower() in ("1", "true", "yes", "on")

        data = request.get_json(silent=True) or {}
        dry_run = (
            str(request.args.get("dry_run", "") or request.args.get("preflight", "") or "").strip().lower() in ("1", "true", "yes", "on")
            or str(data.get("dry_run", "") or "").strip().lower() in ("1", "true", "yes", "on")
        )

        items_raw = data.get("items", None)
        if items_raw is None:
            items_raw = data.get("paths", None)
        if not isinstance(items_raw, list) or not items_raw:
            return error_response("items_required", 400, ok=False)
        if len(items_raw) > 200:
            return error_response("too_many_items", 400, ok=False, max_items=200)

        zip_name = sanitize_zip_filename(data.get("zip_name") or data.get("name") or "selection.zip")
        root_name = sanitize_root_name(data.get("root_name") or os.path.splitext(zip_name)[0] or "selection")

        items = normalize_selection_items(items_raw)
        if not items:
            return error_response("items_required", 400, ok=False)

        os.makedirs(TMP_DIR, exist_ok=True)
        tmp_zip = os.path.join(TMP_DIR, f"xkeen_zip_selection_{uuid.uuid4().hex}.zip")

        if target == "local":
            resolved: List[Tuple[str, str]] = []
            try:
                total_est: int | None = 0
                total_items = 0
                total_trunc = False
                for it in items:
                    try:
                        rp = _local_resolve(it["path"], LOCALFS_ROOTS)
                    except PermissionError as e:
                        raise RuntimeError(str(e))
                    if not os.path.exists(rp):
                        raise RuntimeError("not_found")
                    resolved.append((rp, str(it.get("name") or it["path"])))

                    if MAX_ZIP_BYTES is not None or dry_run:
                        est_b, est_n, est_t = _dir_walk_sum_bytes(rp)
                        total_items += int(est_n or 0)
                        if est_b is None:
                            total_est = None
                        elif total_est is not None:
                            try:
                                total_est += int(est_b)
                            except Exception:
                                total_est = None
                        if est_t:
                            total_trunc = True

                tmp_need = None
                if isinstance(total_est, int) and total_est >= 0:
                    tmp_need = int(total_est * 1.20) + (16 * 1024 * 1024)
                elif MAX_ZIP_BYTES is not None:
                    tmp_need = int(MAX_ZIP_BYTES * 1.20) + (16 * 1024 * 1024)

                if dry_run:
                    return jsonify(
                        {
                            "ok": True,
                            "dry_run": True,
                            "kind": "archive_selection",
                            "target": "local",
                            "zip_name": zip_name,
                            "root_name": root_name,
                            "estimated_bytes": total_est,
                            "estimate_items": total_items,
                            "estimate_truncated": bool(total_trunc),
                            "max_bytes": MAX_ZIP_BYTES,
                            "tmp_free_bytes": _tmp_free_bytes(),
                            "tmp_need_bytes": tmp_need,
                            "confirm_required": bool((MAX_ZIP_BYTES is not None) and (total_est is None or total_trunc)),
                        }
                    )

                if (
                    resp3 := _zip_precheck_or_confirm(
                        estimated_bytes=total_est,
                        truncated=bool(total_trunc),
                        confirm=bool(confirm),
                        kind="archive_selection_local",
                        tmp_need_bytes=tmp_need,
                    )
                ) is not None:
                    return resp3

                _zip_selection_local(resolved, tmp_zip, root_name=root_name)

                headers = {
                    "Content-Disposition": _content_disposition_attachment(zip_name),
                    "Cache-Control": "no-store",
                }
                try:
                    zsize = int(os.path.getsize(tmp_zip))
                    headers["Content-Length"] = str(zsize)
                except Exception:
                    pass
                return Response(
                    stream_file_then_cleanup(tmp_zip, cleanup_files=[tmp_zip]),
                    mimetype="application/zip",
                    headers=headers,
                )

            except Exception as e:
                try:
                    if os.path.exists(tmp_zip):
                        os.remove(tmp_zip)
                except Exception:
                    pass
                msg = str(e) or "zip_failed"
                if "Permission" in msg or "forbidden" in msg:
                    return error_response(msg, 403, ok=False)
                if msg == "not_found":
                    return error_response("not_found", 404, ok=False)
                return error_response("zip_failed", 400, ok=False)

        # remote
        sid = str(request.args.get("sid") or "").strip()
        if not sid:
            try:
                if os.path.exists(tmp_zip):
                    os.remove(tmp_zip)
            except Exception:
                pass
            return error_response("sid_required", 400, ok=False)
        s, resp = _get_session_or_404(sid)
        if resp is not None:
            try:
                if os.path.exists(tmp_zip):
                    os.remove(tmp_zip)
            except Exception:
                pass
            return resp

        total_est: int | None = None
        total_entries = 0
        total_trunc = False

        try:
            if MAX_ZIP_BYTES is not None or dry_run:
                total_est = 0
                for it in items:
                    est_b, est_n, est_t = _remote_estimate_tree_bytes(s, it["path"], max_nodes=8000)
                    total_entries += int(est_n or 0)
                    if est_b is None:
                        total_est = None
                    elif total_est is not None:
                        try:
                            total_est += int(est_b)
                        except Exception:
                            total_est = None
                    if est_t:
                        total_trunc = True

            tmp_need = None
            if isinstance(total_est, int) and total_est >= 0:
                tmp_need = int(total_est * 1.20) + (32 * 1024 * 1024)
            elif MAX_ZIP_BYTES is not None:
                tmp_need = int(MAX_ZIP_BYTES * 1.20) + (32 * 1024 * 1024)

            if dry_run:
                return jsonify(
                    {
                        "ok": True,
                        "dry_run": True,
                        "kind": "archive_selection",
                        "target": "remote",
                        "sid": sid,
                        "zip_name": zip_name,
                        "root_name": root_name,
                        "estimated_bytes": total_est,
                        "estimate_items": total_entries,
                        "estimate_truncated": bool(total_trunc),
                        "max_bytes": MAX_ZIP_BYTES,
                        "tmp_free_bytes": _tmp_free_bytes(),
                        "tmp_need_bytes": tmp_need,
                        "confirm_required": bool((MAX_ZIP_BYTES is not None) and (total_est is None or total_trunc)),
                    }
                )

            if (
                resp4 := _zip_precheck_or_confirm(
                    estimated_bytes=total_est,
                    truncated=bool(total_trunc),
                    confirm=bool(confirm),
                    kind="archive_selection_remote",
                    tmp_need_bytes=tmp_need,
                )
            ) is not None:
                return resp4

            tmp_root = os.path.join(TMP_DIR, f"xkeen_remote_zip_{uuid.uuid4().hex}")
            os.makedirs(tmp_root, exist_ok=True)

            def _remote_is_dir_guess(sess: Any, rpath: str) -> bool | None:
                """Return True/False if path exists and is dir/file, or None if unknown."""
                try:
                    rc, out, err = mgr._run_lftp(sess, [f"cls -ld {_lftp_quote(rpath)}"], capture=True)
                except Exception:
                    return None
                if rc != 0:
                    return None
                text = (out or b"").decode("utf-8", errors="replace")
                for line in text.splitlines():
                    try:
                        item = _parse_ls_line(line)
                    except Exception:
                        item = None
                    if item:
                        return item.get("type") == "dir"
                return None

            def _run_lftp_get_with_tmp_cap(sess: Any, *, src: str, dst: str, hard_cap_bytes: int | None) -> None:
                """Download a single remote file to local dst, enforcing a best-effort /tmp cap."""
                os.makedirs(os.path.dirname(dst) or TMP_DIR, exist_ok=True)
                cmd = f"get -- {_lftp_quote(src)} -o {_lftp_quote(dst)}"
                script = mgr._build_lftp_script(sess, [cmd])
                env = os.environ.copy()
                env.setdefault('LC_ALL', 'C')
                env.setdefault('LANG', 'C')

                start_free = _tmp_free_bytes()
                proc = subprocess.Popen(
                    [mgr.lftp_bin, '-c', script],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    env=env,
                    bufsize=0,
                )

                try:
                    while proc.poll() is None:
                        if isinstance(hard_cap_bytes, int) and hard_cap_bytes > 0 and isinstance(start_free, int) and start_free > 0:
                            cur_free = _tmp_free_bytes()
                            if isinstance(cur_free, int) and cur_free >= 0:
                                used = int(start_free - cur_free)
                                if used > hard_cap_bytes:
                                    try:
                                        proc.terminate()
                                    except Exception:
                                        pass
                                    raise RuntimeError('tmp_limit_exceeded')
                        time.sleep(0.25)

                    _out, _err = proc.communicate()
                    if int(proc.returncode or 0) != 0:
                        tail = ((_err or b'').decode('utf-8', errors='replace')[-400:]).strip()
                        raise RuntimeError('mirror_failed:' + tail)
                finally:
                    try:
                        if proc and proc.stderr:
                            proc.stderr.close()
                    except Exception:
                        pass

            try:
                used_names = set()
                for it in items:
                    rpath = str(it.get("path") or "").strip()
                    if not rpath:
                        continue
                    leaf = str(it.get("name") or os.path.basename(rpath.rstrip("/")) or "item").strip() or "item"
                    safe_leaf = re.sub(r"[^0-9A-Za-z._-]+", "_", leaf)[:128] or "item"

                    # Avoid collisions when multiple items share the same leaf.
                    stem, ext = os.path.splitext(safe_leaf)
                    cand = safe_leaf
                    n = 2
                    while cand in used_names:
                        cand = f"{stem}_{n}{ext}" if ext else f"{safe_leaf}_{n}"
                        n += 1
                    used_names.add(cand)

                    out_local = os.path.join(tmp_root, cand)

                    is_dir = it.get("is_dir")
                    if is_dir is None:
                        is_dir = _remote_is_dir_guess(s, rpath)

                    # Download into local temp (file or dir).
                    if is_dir is True:
                        _run_lftp_mirror_with_tmp_cap(s, src=rpath, dst=out_local, hard_cap_bytes=MAX_ZIP_BYTES)
                    elif is_dir is False:
                        _run_lftp_get_with_tmp_cap(s, src=rpath, dst=out_local, hard_cap_bytes=MAX_ZIP_BYTES)
                    else:
                        # Unknown type (server quirks). Try file first; if it fails, try mirror.
                        try:
                            _run_lftp_get_with_tmp_cap(s, src=rpath, dst=out_local, hard_cap_bytes=MAX_ZIP_BYTES)
                        except Exception:
                            _run_lftp_mirror_with_tmp_cap(s, src=rpath, dst=out_local, hard_cap_bytes=MAX_ZIP_BYTES)

                # create zip from tmp_root
                _zip_directory(tmp_root, tmp_zip, root_name=root_name)
                headers = {
                    "Content-Disposition": _content_disposition_attachment(zip_name),
                    "Cache-Control": "no-store",
                }
                try:
                    zsize = int(os.path.getsize(tmp_zip))
                    headers["Content-Length"] = str(zsize)
                except Exception:
                    pass

                return Response(
                    stream_file_then_cleanup(tmp_zip, cleanup_files=[tmp_zip], cleanup_dirs=[tmp_root]),
                    mimetype="application/zip",
                    headers=headers,
                )
            except Exception:
                raise

        except Exception as e:
            try:
                if os.path.exists(tmp_zip):
                    os.remove(tmp_zip)
            except Exception:
                pass
            try:
                shutil.rmtree(locals().get("tmp_root", ""), ignore_errors=True)
            except Exception:
                pass
            msg = str(e) or ""
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
            if msg == "not_found":
                return error_response("not_found", 404, ok=False)
            return error_response("zip_failed", 400, ok=False)

    # -------------------------- local archive create / extract / list --------------------------

    @bp.post("/api/fs/archive/create")
    def api_fs_archive_create() -> Any:
        """Create an archive file (.zip/.tar.gz) on the local filesystem."""
        if (resp := _require_enabled()) is not None:
            return resp

        data = request.get_json(silent=True) or {}
        target = str(data.get("target") or "local").strip().lower()
        if target != "local":
            return error_response("only_local_supported", 400, ok=False)

        cwd = str(data.get("cwd") or "").strip() or "/"
        fmt = str(data.get("format") or "zip").strip().lower()
        overwrite = bool(
            str(data.get("overwrite") or "").strip().lower() in ("1", "true", "yes", "on") or data.get("overwrite") is True
        )

        items_raw = data.get("items")
        if not isinstance(items_raw, list) or not items_raw:
            return error_response("items_required", 400, ok=False)

        items: List[Tuple[str, str]] = []
        for it in items_raw:
            pth = ""
            if isinstance(it, str):
                pth = str(it).strip()
            elif isinstance(it, dict):
                pth = str(it.get("path") or "").strip()
            if not pth:
                continue
            if not pth.startswith("/"):
                pth = join_local_cwd(cwd, pth)
            try:
                rp = _local_resolve(pth, LOCALFS_ROOTS)
            except PermissionError as e:
                return error_response(str(e) or "forbidden", 403, ok=False)
            except Exception:
                return error_response("bad_path", 400, ok=False)
            if not os.path.exists(rp):
                return error_response("not_found", 404, ok=False)
            base = os.path.basename(rp.rstrip("/")) or "item"
            base = base.replace("..", "_").replace("/", "_").replace("\\", "_") or "item"
            items.append((rp, base))
        if not items:
            return error_response("items_required", 400, ok=False)

        name = sanitize_archive_filename(data.get("name") or "archive", fmt)
        out_path = join_local_cwd(cwd, name)
        try:
            rp_out = _local_resolve(out_path, LOCALFS_ROOTS)
        except PermissionError as e:
            return error_response(str(e) or "forbidden", 403, ok=False)
        except Exception:
            return error_response("bad_path", 400, ok=False)

        if os.path.exists(rp_out) and not overwrite:
            return error_response("exists", 409, ok=False)

        os.makedirs(os.path.dirname(rp_out) or "/", exist_ok=True)
        os.makedirs(TMP_DIR, exist_ok=True)
        tmp_out = os.path.join(TMP_DIR, f"xkeen_archive_create_{uuid.uuid4().hex}.tmp")

        try:
            if fmt in ("tgz", "tar.gz", "tar_gz", "targz"):
                with tarfile.open(tmp_out, mode="w:gz") as tf:
                    for rp, base in items:
                        tf.add(rp, arcname=base, recursive=True)
            else:
                with zipfile.ZipFile(tmp_out, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
                    for rp, base in items:
                        if os.path.isdir(rp):
                            for root, dirs, files in os.walk(rp):
                                rel_root = os.path.relpath(root, rp)
                                rel_root = "" if rel_root == "." else rel_root
                                arc_dir = (base + ("/" + rel_root if rel_root else "")).rstrip("/") + "/"
                                if not dirs and not files:
                                    try:
                                        zf.writestr(arc_dir, b"")
                                    except Exception:
                                        pass
                                for fn in files:
                                    src = os.path.join(root, fn)
                                    rel = os.path.join(rel_root, fn) if rel_root else fn
                                    arc = base + "/" + rel.replace("\\", "/")
                                    zf.write(src, arc)
                        else:
                            zf.write(rp, base)

            try:
                os.replace(tmp_out, rp_out)
            except Exception:
                shutil.move(tmp_out, rp_out)

            sz = None
            try:
                sz = int(os.path.getsize(rp_out))
            except Exception:
                sz = None

            _core_log("info", "fs.archive.create", target="local", cwd=cwd, name=name, format=fmt, bytes=sz)
            return jsonify({"ok": True, "path": out_path, "name": name, "bytes": sz})
        except Exception as e:
            try:
                if os.path.exists(tmp_out):
                    os.remove(tmp_out)
            except Exception:
                pass
            msg = str(e) or "archive_create_failed"
            return error_response("archive_create_failed", 400, ok=False, details=msg[-400:])

    @bp.post("/api/fs/archive/extract")
    def api_fs_archive_extract() -> Any:
        """Extract .zip and .tar* archives on the local filesystem."""
        if (resp := _require_enabled()) is not None:
            return resp

        data = request.get_json(silent=True) or {}
        target = str(data.get("target") or "local").strip().lower()
        if target != "local":
            return error_response("only_local_supported", 400, ok=False)

        arch = str(data.get("archive") or "").strip()
        if not arch:
            return error_response("archive_required", 400, ok=False)

        cwd = str(data.get("cwd") or "").strip() or "/"
        dest = str(data.get("dest") or "").strip() or ""
        if not dest:
            dest = cwd
        if not dest.startswith("/"):
            dest = join_local_cwd(cwd, dest)

        create_dest = bool(
            str(data.get("create_dest") or "").strip().lower() in ("1", "true", "yes", "on") or data.get("create_dest") is True
        )
        strip_top_dir = bool(
            str(data.get("strip_top_dir") or "").strip().lower() in ("1", "true", "yes", "on") or data.get("strip_top_dir") is True
        )
        flatten = bool(str(data.get("flatten") or "").strip().lower() in ("1", "true", "yes", "on") or data.get("flatten") is True)
        overwrite = bool(
            str(data.get("overwrite") or "").strip().lower() in ("1", "true", "yes", "on") or data.get("overwrite") is True
        )

        try:
            rp_arch = _local_resolve(arch, LOCALFS_ROOTS)
        except PermissionError as e:
            return error_response(str(e) or "forbidden", 403, ok=False)
        except Exception:
            return error_response("bad_path", 400, ok=False)
        if not os.path.isfile(rp_arch):
            return error_response("not_found", 404, ok=False)

        try:
            rp_dest = _local_resolve(dest, LOCALFS_ROOTS)
        except PermissionError as e:
            return error_response(str(e) or "forbidden", 403, ok=False)
        except Exception:
            return error_response("bad_path", 400, ok=False)

        if not os.path.exists(rp_dest):
            if not create_dest:
                return error_response("dest_not_found", 404, ok=False)
            try:
                os.makedirs(rp_dest, exist_ok=True)
            except Exception:
                return error_response("mkdir_failed", 400, ok=False)
        if not os.path.isdir(rp_dest):
            return error_response("dest_not_dir", 400, ok=False)

        dest_root_abs = os.path.abspath(rp_dest)

        sel_raw = data.get("items")
        sel_exact = set()
        sel_dirs = []
        if isinstance(sel_raw, list):
            for x in sel_raw:
                try:
                    nm = str(x or "").replace("\\", "/").strip()
                except Exception:
                    nm = ""
                if not nm:
                    continue
                while nm.startswith("./"):
                    nm = nm[2:]
                is_dir = nm.endswith("/")
                nm2 = nm.strip("/")
                if not nm2 or nm2 in (".",):
                    continue
                if is_dir:
                    sel_dirs.append(nm2)
                else:
                    sel_exact.add(nm2)
        if len(sel_exact) + len(sel_dirs) > 10000:
            return error_response("too_many_items", 400, ok=False)

        def _want_member(nm0: str) -> bool:
            if not sel_exact and not sel_dirs:
                return True
            if nm0 in sel_exact:
                return True
            for d in sel_dirs:
                if nm0 == d or nm0.startswith(d + "/"):
                    return True
            return False

        lower = rp_arch.lower()
        extracted = 0
        skipped = 0
        renamed = 0

        def _flatten_member_name(nm_use: str) -> str:
            try:
                s = str(nm_use or "").replace("\\", "/").rstrip("/")
            except Exception:
                s = ""
            if not s or s in (".", "./"):
                return ""
            leaf = os.path.basename(s)
            if leaf in ("", ".", ".."): 
                return ""
            leaf = leaf.replace(":", "_")
            return leaf

        def _compute_strip_prefix(metas: list[tuple[str, bool]]) -> str:
            if not strip_top_dir:
                return ""
            roots: set[str | None] = set()
            for nm0, is_dir in metas:
                try:
                    nm0s = str(nm0 or "").lstrip("/").strip()
                except Exception:
                    nm0s = ""
                if not nm0s:
                    continue
                parts = [p for p in nm0s.split("/") if p]
                if not parts:
                    continue
                if len(parts) == 1:
                    if is_dir:
                        continue
                    roots.add(None)
                    continue
                roots.add(parts[0])
            if len(roots) == 1 and None not in roots:
                root = next(iter(roots))
                if root and root not in (".", ".."): 
                    return root + "/"
            return ""

        def _unique_leaf(parent_abs: str, leaf: str, *, is_dir: bool) -> str:
            base = os.path.basename(str(leaf or "").strip())
            if not base:
                base = "item"
            if is_dir:
                stem, ext = base, ""
            else:
                stem, ext = os.path.splitext(base)
                stem = stem or base
            for i in range(1, 1000):
                cand = f"{stem} ({i}){ext}" if ext else f"{stem} ({i})"
                if not os.path.exists(os.path.join(parent_abs, cand)):
                    return cand
            return f"{stem} ({int(time.time())}){ext}" if ext else f"{stem} ({int(time.time())})"

        def _ensure_parent_dirs(nm_use: str) -> str:
            nm_use = nm_use.replace("\\", "/").lstrip("/")
            parts = [p for p in nm_use.split("/") if p]
            if not parts:
                return ""
            safe = []
            for p in parts:
                if p in (".", ".."): 
                    continue
                safe.append(p)
            return "/".join(safe)

        try:
            if lower.endswith(".zip"):
                with zipfile.ZipFile(rp_arch, "r") as zf:
                    members = zf.infolist()
                    metas: list[tuple[str, bool]] = []
                    for zi in members:
                        nm0 = (zi.filename or "").replace("\\", "/").lstrip("/")
                        while nm0.startswith("./"):
                            nm0 = nm0[2:]
                        if not nm0 or nm0 in (".", "./"):
                            continue
                        is_dir = bool(nm0.endswith("/"))
                        metas.append((nm0, is_dir))
                    strip_prefix = _compute_strip_prefix(metas)

                    seen_flat: dict[str, int] = {}

                    def _apply_dir_map(name: str) -> str:
                        nm_use = name
                        if strip_prefix and nm_use.startswith(strip_prefix):
                            nm_use = nm_use[len(strip_prefix) :]
                        return nm_use.lstrip("/")

                    for zi in members:
                        nm0 = (zi.filename or "").replace("\\", "/").lstrip("/")
                        while nm0.startswith("./"):
                            nm0 = nm0[2:]
                        if not nm0 or nm0 in (".", "./"):
                            continue
                        is_dir = bool(nm0.endswith("/"))
                        nm0s = nm0.rstrip("/")
                        if not _want_member(nm0s):
                            continue

                        nm_use = _apply_dir_map(nm0).rstrip("/")
                        if not nm_use:
                            continue
                        if zipinfo_is_symlink(zi):
                            skipped += 1
                            continue

                        if flatten:
                            leaf = _flatten_member_name(nm_use)
                            if not leaf:
                                skipped += 1
                                continue
                            base = leaf
                            n = seen_flat.get(base, 0)
                            if n:
                                stem, ext = os.path.splitext(base)
                                stem = stem or base
                                base = f"{stem} ({n}){ext}" if ext else f"{stem} ({n})"
                            seen_flat[leaf] = n + 1
                            rel = base
                        else:
                            rel = nm_use

                        rel = _ensure_parent_dirs(rel)
                        if not rel:
                            skipped += 1
                            continue
                        if not is_safe_extract_path(dest_root_abs, rel):
                            skipped += 1
                            continue
                        out = os.path.abspath(os.path.join(dest_root_abs, rel))

                        if is_dir:
                            os.makedirs(out, exist_ok=True)
                            continue

                        if os.path.exists(out):
                            parent_abs = os.path.dirname(out) or dest_root_abs
                            leaf = os.path.basename(out)
                            if (not overwrite) or os.path.isdir(out):
                                new_leaf = _unique_leaf(parent_abs, leaf, is_dir=False)
                                rel_parent = "/".join([p for p in rel.split("/")[:-1] if p])
                                rel2 = (rel_parent + "/" + new_leaf) if rel_parent else new_leaf
                                out = os.path.abspath(os.path.join(dest_root_abs, rel2))
                                renamed += 1

                        os.makedirs(os.path.dirname(out) or dest_root_abs, exist_ok=True)
                        with zf.open(zi, "r") as src, open(out, "wb") as dst_fp:
                            shutil.copyfileobj(src, dst_fp, length=256 * 1024)
                        extracted += 1

            elif (
                lower.endswith(".tar")
                or lower.endswith(".tar.gz")
                or lower.endswith(".tgz")
                or lower.endswith(".tar.xz")
                or lower.endswith(".txz")
                or lower.endswith(".tar.bz2")
                or lower.endswith(".tbz")
                or lower.endswith(".tbz2")
            ):
                with tarfile.open(rp_arch, "r:*") as tf:
                    members = tf.getmembers()
                    metas: list[tuple[str, bool]] = []
                    for ti in members:
                        nm0 = (ti.name or "").replace("\\", "/").lstrip("/")
                        while nm0.startswith("./"):
                            nm0 = nm0[2:]
                        if not nm0 or nm0 in (".", "./"):
                            continue
                        is_dir = bool(ti.isdir() or nm0.endswith("/"))
                        metas.append((nm0, is_dir))
                    strip_prefix = _compute_strip_prefix(metas)

                    seen_flat: dict[str, int] = {}

                    def _apply_dir_map(name: str) -> str:
                        nm_use = name
                        if strip_prefix and nm_use.startswith(strip_prefix):
                            nm_use = nm_use[len(strip_prefix) :]
                        nm_use = nm_use.lstrip("/")
                        return nm_use

                    for ti in members:
                        nm0 = (ti.name or "").replace("\\", "/").lstrip("/")
                        while nm0.startswith("./"):
                            nm0 = nm0[2:]
                        if not nm0 or nm0 in (".", "./"):
                            continue
                        is_dir = bool(ti.isdir() or nm0.endswith("/"))
                        nm0s = nm0.rstrip("/")
                        if not _want_member(nm0s):
                            continue

                        nm_use = _apply_dir_map(nm0).rstrip("/")
                        if not nm_use:
                            continue

                        if ti.issym() or ti.islnk():
                            skipped += 1
                            continue

                        if flatten:
                            leaf = _flatten_member_name(nm_use)
                            if not leaf:
                                skipped += 1
                                continue
                            base = leaf
                            n = seen_flat.get(base, 0)
                            if n:
                                stem, ext = os.path.splitext(base)
                                stem = stem or base
                                base = f"{stem} ({n}){ext}" if ext else f"{stem} ({n})"
                            seen_flat[leaf] = n + 1
                            rel = base
                        else:
                            rel = nm_use

                        rel = _ensure_parent_dirs(rel)
                        if not rel:
                            skipped += 1
                            continue
                        if not is_safe_extract_path(dest_root_abs, rel):
                            skipped += 1
                            continue
                        out = os.path.abspath(os.path.join(dest_root_abs, rel))

                        if is_dir:
                            os.makedirs(out, exist_ok=True)
                            continue

                        if os.path.exists(out):
                            parent_abs = os.path.dirname(out) or dest_root_abs
                            leaf = os.path.basename(out)
                            if (not overwrite) or os.path.isdir(out):
                                new_leaf = _unique_leaf(parent_abs, leaf, is_dir=False)
                                rel_parent = "/".join([p for p in rel.split("/")[:-1] if p])
                                rel = (rel_parent + "/" + new_leaf) if rel_parent else new_leaf
                                out = os.path.abspath(os.path.join(dest_root_abs, rel))
                                renamed += 1

                        os.makedirs(os.path.dirname(out) or dest_root_abs, exist_ok=True)
                        src = tf.extractfile(ti)
                        if src is None:
                            skipped += 1
                            continue
                        with src, open(out, "wb") as dst_fp:
                            shutil.copyfileobj(src, dst_fp, length=256 * 1024)
                        extracted += 1

            else:
                return error_response("unsupported_archive", 400, ok=False)

            _core_log(
                "info",
                "fs.archive.extract",
                target="local",
                archive=arch,
                dest=dest,
                extracted=extracted,
                skipped=skipped,
                renamed=renamed,
            )
            return jsonify({"ok": True, "archive": arch, "dest": dest, "extracted": extracted, "skipped": skipped, "renamed": renamed})
        except Exception as e:
            msg = str(e) or "extract_failed"
            return error_response("extract_failed", 400, ok=False, details=msg[-400:])

    @bp.get("/api/fs/archive/list")
    def api_fs_archive_list() -> Any:
        """List contents of an archive (.zip/.tar*). Local only."""
        if (resp := _require_enabled()) is not None:
            return resp

        target = str(request.args.get("target") or "local").strip().lower()
        if target != "local":
            return error_response("only_local_supported", 400, ok=False)

        arch = str(request.args.get("path") or request.args.get("archive") or "").strip()
        if not arch:
            return error_response("path_required", 400, ok=False)

        try:
            max_items = int(request.args.get("max") or 2000)
        except Exception:
            max_items = 2000
        max_items = max(1, min(max_items, 10000))

        try:
            rp_arch = _local_resolve(arch, LOCALFS_ROOTS)
        except PermissionError as e:
            return error_response(str(e) or "forbidden", 403, ok=False)
        except Exception:
            return error_response("bad_path", 400, ok=False)
        if not os.path.isfile(rp_arch):
            return error_response("not_found", 404, ok=False)

        try:
            items, truncated = list_archive_contents(rp_arch, max_items=max_items)
            return jsonify({"ok": True, "path": arch, "items": items, "truncated": bool(truncated)})
        except ValueError:
            return error_response("unsupported_archive", 400, ok=False)
        except Exception as e:
            msg = str(e) or "archive_list_failed"
            return error_response("archive_list_failed", 400, ok=False, details=msg[-400:])
