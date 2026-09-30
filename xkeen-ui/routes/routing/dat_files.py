"""/api/routing/dat file endpoints owned by engine.xray.

The GeoIP/GeoSite card used to inspect, upload and download ``.dat`` files
through the file manager API (``/api/fs/*``), which belongs to ``tool.files``
and is not registered in profiles without it.  These endpoints cover exactly
the card's needs and nothing more: every path must end with ``.dat`` and stay
inside the same local allowlist as ``/api/routing/dat/update``.
"""

from __future__ import annotations

import os
import stat
import uuid
from typing import Any, Dict, List

from flask import Blueprint, jsonify, request, send_file

from routes.common.errors import error_response
from services.fs_common.local import (
    _local_allowed_roots,
    _local_resolve,
    _local_resolve_nofollow,
)


MAX_STAT_PATHS = 8
MAX_LIST_ITEMS = 500
_CHUNK_BYTES = 64 * 1024


def dat_max_bytes() -> int | None:
    """Size limit shared by URL updates and uploads (``XKEEN_MAX_DAT_MB``)."""

    raw = str(os.getenv("XKEEN_MAX_DAT_MB", "128") or "128").strip()
    try:
        max_mb = int(float(raw))
    except Exception:
        max_mb = 128
    return None if max_mb <= 0 else max_mb * 1024 * 1024


def _is_dat_name(path: str) -> bool:
    return str(path or "").strip().lower().endswith(".dat")


def _stat_item(requested: str, roots: List[str]) -> Dict[str, Any]:
    if not _is_dat_name(requested):
        return {"path": requested, "exists": False, "error": "forbidden"}
    try:
        ap = _local_resolve_nofollow(requested, roots)
    except PermissionError:
        return {"path": requested, "exists": False, "error": "forbidden"}
    if not os.path.lexists(ap):
        return {"path": requested, "exists": False}
    try:
        st = os.lstat(ap)
        is_link = stat.S_ISLNK(st.st_mode)
        if is_link:
            try:
                st = os.stat(ap)
            except OSError:
                return {"path": requested, "exists": False, "type": "link"}
        return {
            "path": requested,
            "exists": True,
            "type": "link" if is_link else "file",
            "size": int(st.st_size or 0),
            "mtime": int(st.st_mtime or 0),
        }
    except OSError:
        return {"path": requested, "exists": False, "error": "stat_failed"}


def _save_stream(stream: Any, tmp_path: str, max_bytes: int | None) -> int:
    total = 0
    with open(tmp_path, "wb") as handle:
        while True:
            chunk = stream.read(_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if max_bytes is not None and total > max_bytes:
                raise ValueError("size_limit")
            handle.write(chunk)
    return total


def register_dat_file_routes(bp: Blueprint) -> None:
    @bp.get("/api/routing/dat/files")
    def api_dat_files() -> Any:
        """List ``.dat`` files of one directory for the card's suggestions."""

        directory = str(request.args.get("dir") or "").strip()
        if not directory:
            return error_response("dir_required", 400, ok=False)
        try:
            rd = _local_resolve(directory, _local_allowed_roots())
        except PermissionError:
            return error_response("Доступ к каталогу запрещён.", 403, ok=False, code="forbidden")
        if not os.path.isdir(rd):
            return jsonify({"ok": True, "dir": directory, "items": []}), 200

        items: List[Dict[str, Any]] = []
        try:
            names = sorted(os.listdir(rd))
        except OSError:
            names = []
        for name in names:
            if len(items) >= MAX_LIST_ITEMS:
                break
            if not _is_dat_name(name):
                continue
            full = os.path.join(rd, name)
            try:
                lst = os.lstat(full)
                is_link = stat.S_ISLNK(lst.st_mode)
                st = os.stat(full) if is_link else lst
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            items.append(
                {
                    "name": name,
                    "type": "link" if is_link else "file",
                    "size": int(st.st_size or 0),
                    "mtime": int(st.st_mtime or 0),
                }
            )
        return jsonify({"ok": True, "dir": directory, "items": items}), 200

    @bp.post("/api/routing/dat/stat")
    def api_dat_stat() -> Any:
        """Report size/mtime of the configured GeoIP/GeoSite files."""

        data = request.get_json(silent=True) or {}
        raw_paths = data.get("paths")
        if not isinstance(raw_paths, list):
            return error_response("paths_required", 400, ok=False)
        paths = [str(item or "").strip() for item in raw_paths if str(item or "").strip()]
        if not paths:
            return error_response("paths_required", 400, ok=False)
        if len(paths) > MAX_STAT_PATHS:
            return error_response("too_many_paths", 400, ok=False)
        roots = _local_allowed_roots()
        return jsonify({"ok": True, "items": [_stat_item(path, roots) for path in paths]}), 200

    @bp.post("/api/routing/dat/upload")
    def api_dat_upload() -> Any:
        """Store an uploaded ``.dat`` file (multipart field ``file``)."""

        path = str(request.args.get("path") or "").strip()
        overwrite = str(request.args.get("overwrite") or "").strip().lower() in ("1", "true", "yes", "on")
        if not path:
            return error_response("path_required", 400, ok=False)
        if not _is_dat_name(path):
            return error_response("path_must_end_with_dat", 400, ok=False)
        upload = request.files.get("file")
        if upload is None:
            return error_response("file_required", 400, ok=False)
        try:
            rp = _local_resolve(path, _local_allowed_roots())
        except PermissionError:
            return error_response("Доступ к DAT-пути запрещён.", 403, ok=False, code="forbidden")

        if os.path.isdir(rp):
            return error_response("not_a_file", 409, ok=False, path=path)
        exists = os.path.exists(rp)
        if exists and not overwrite:
            return error_response("exists", 409, ok=False, path=path)

        parent = os.path.dirname(rp)
        try:
            if parent:
                os.makedirs(parent, exist_ok=True)
        except OSError:
            return error_response("Не удалось подготовить каталог для DAT-файла.", 500, ok=False, code="mkdir_failed")

        previous_mode = None
        if exists:
            try:
                previous_mode = stat.S_IMODE(os.stat(rp).st_mode)
            except OSError:
                previous_mode = None

        max_bytes = dat_max_bytes()
        # A unique name per upload keeps concurrent writers apart.
        tmp_path = f"{rp}.upload-{uuid.uuid4().hex}.tmp"
        try:
            size = _save_stream(upload.stream, tmp_path, max_bytes)
            if previous_mode is not None:
                try:
                    os.chmod(tmp_path, previous_mode)
                except OSError:
                    pass
            os.replace(tmp_path, rp)
        except ValueError:
            _remove_quietly(tmp_path)
            max_mb = (max_bytes or 0) // (1024 * 1024)
            return error_response("size_limit", 413, ok=False, max_mb=max_mb)
        except OSError:
            _remove_quietly(tmp_path)
            return error_response("Не удалось сохранить DAT-файл.", 500, ok=False, code="write_failed")
        return jsonify({"ok": True, "path": path, "size": size}), 200

    @bp.get("/api/routing/dat/download")
    def api_dat_download() -> Any:
        """Download one ``.dat`` file."""

        path = str(request.args.get("path") or "").strip()
        if not path:
            return error_response("path_required", 400, ok=False)
        if not _is_dat_name(path):
            return error_response("path_must_end_with_dat", 400, ok=False)
        try:
            rp = _local_resolve(path, _local_allowed_roots())
        except PermissionError:
            return error_response("Доступ к DAT-пути запрещён.", 403, ok=False, code="forbidden")
        if not os.path.isfile(rp):
            return error_response("not_found", 404, ok=False)
        return send_file(rp, as_attachment=True, download_name=os.path.basename(rp))


def _remove_quietly(path: str) -> None:
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass
