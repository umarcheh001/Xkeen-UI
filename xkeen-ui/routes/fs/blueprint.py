"""Filesystem API facade for the router UI.

This blueprint exposes the UI-stable endpoints under /api/fs/*.

- Local operations are always available (within configured local roots).
- Remote operations are available only when the RemoteFS manager is present
  in app.extensions as "xkeen.remotefs_mgr" and is enabled.

The UI already uses /api/fs/* with a "target" selector (local|remote). This
facade keeps that contract stable while allowing RemoteFS to be optional.
"""

from __future__ import annotations

import os
import json
import stat
import uuid
import shutil
import subprocess
import time
import hashlib
import zipfile
import tarfile
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, request, jsonify, current_app, Response, send_file
from werkzeug.local import LocalProxy

from services.utils.env import _read_int_env
from services.filemanager.metadata import _apply_local_metadata_best_effort as _apply_local_metadata_best_effort_impl
from services.filemanager.local_ops import (
    tmp_free_bytes as _tmp_free_bytes_impl,
    dir_walk_sum_bytes as _dir_walk_sum_bytes_impl,
    dir_size_bytes_best_effort as _dir_size_bytes_best_effort_impl,
)

from .endpoints_list import register_list_endpoints
from .endpoints_readwrite import register_readwrite_endpoints
from .endpoints_transfer import register_transfer_endpoints
from .endpoints_archive import register_archive_endpoints
from .endpoints_manage import register_manage_endpoints
from .endpoints_trash import register_trash_endpoints
from .endpoints_perms import register_perms_endpoints
from .endpoints_checksum import register_checksum_endpoints

# --- core.log helpers (never fail) ---
try:
    from services.logging_setup import core_logger as _get_core_logger
    _CORE_LOGGER = _get_core_logger()
except Exception:
    _CORE_LOGGER = None


def _core_log(level: str, msg: str, **extra) -> None:
    if _CORE_LOGGER is None:
        return
    try:
        if extra:
            try:
                # keep it compact
                tail = ", ".join(f"{k}={v}" for k, v in extra.items())
            except Exception:
                tail = repr(extra)
            full = f"{msg} | {tail}"
        else:
            full = msg
        fn = getattr(_CORE_LOGGER, str(level or "info").lower(), None)
        if callable(fn):
            fn(full)
        else:
            _CORE_LOGGER.info(full)
    except Exception:
        pass



# Shared helpers (moved out of routes_remotefs in commit 2)
from routes.common.errors import error_response
from services.fs_common.local import (
    _local_allowed_roots,
    _local_is_allowed,
    _local_resolve,
    _local_norm_abs,
    _local_resolve_follow,
    _local_resolve_nofollow,
    _local_remove_entry,
    _local_soft_delete,
    _local_restore_from_trash,
    _local_trash_dirs,
    _local_trash_stats,
    _TRASH_META_DIRNAME,
    _local_is_protected_entry_abs,
    _local_item_from_stat,
)
from services.fs_common.http import _sanitize_download_filename, _content_disposition_attachment
from services.fs_common.archive_zip import _zip_directory, _zip_selection_local
from services.fs_common.lftp_quote import _lftp_quote
from services.fs_common.remote_parse import _parse_ls_line

# Optional: auto-snapshot Xray config fragments on overwrite.
try:
    from services.xray_backups import snapshot_before_overwrite as _snapshot_before_overwrite
except Exception:
    _snapshot_before_overwrite = None


def create_fs_blueprint(
    *,
    tmp_dir: str = "/tmp",
    max_upload_mb: int = 200,
    xray_configs_dir: str | None = None,
    backup_dir: str | None = None,
) -> Blueprint:
    """Create /api/fs/* facade blueprint.

    Args:
        tmp_dir: temp directory used for local zip/write/upload staging.
        max_upload_mb: max upload size limit used by /api/fs/upload.
    """

    bp = Blueprint("fs", __name__)

    # Allowed local roots (UI sandbox).
    LOCALFS_ROOTS = _local_allowed_roots()

    # For snapshotting (rollback) only when writing inside XRAY_CONFIGS_DIR.
    try:
        _XRAY_CONFIGS_DIR_REAL = os.path.realpath(str(xray_configs_dir or "")) if xray_configs_dir else ""
    except Exception:
        _XRAY_CONFIGS_DIR_REAL = ""
    try:
        _BACKUP_DIR = str(backup_dir or "") if backup_dir else ""
        _BACKUP_DIR_REAL = os.path.realpath(_BACKUP_DIR) if _BACKUP_DIR else ""
    except Exception:
        _BACKUP_DIR = ""
        _BACKUP_DIR_REAL = ""

    # Local staging config (do NOT depend on remotefs manager existing).
    TMP_DIR = str(tmp_dir or "/tmp")
    MAX_UPLOAD_MB = int(max_upload_mb or 200)

    # ZIP creation can easily exhaust /tmp (often tmpfs/RAM on routers).
    # Configure a hard server-side cap via env:
    #   - XKEEN_MAX_ZIP_MB (preferred)
    #   - MAX_ZIP_MB (fallback)
    # 0 / empty disables the limit.

    MAX_ZIP_MB = _read_int_env('XKEEN_MAX_ZIP_MB', _read_int_env('MAX_ZIP_MB', 0))
    MAX_ZIP_BYTES: int | None = None
    if isinstance(MAX_ZIP_MB, int) and MAX_ZIP_MB > 0:
        MAX_ZIP_BYTES = int(MAX_ZIP_MB) * 1024 * 1024

    # Upper bound for how many entries we will stat/parse when estimating archive size.
    # Keeps estimation from hanging on huge trees.
    MAX_ZIP_ESTIMATE_ITEMS = max(10_000, min(500_000, _read_int_env('XKEEN_MAX_ZIP_ESTIMATE_ITEMS', 200_000)))

    def _fmt_mb(n: int | None) -> str:
        try:
            if n is None:
                return ''
            return f"{(float(n) / (1024.0 * 1024.0)):.1f} MiB"
        except Exception:
            return ''


    def _apply_local_metadata_best_effort(dst_path: str, st0: os.stat_result | None) -> None:
        """Best-effort preserve mode/owner/group when overwriting a local file."""
        _apply_local_metadata_best_effort_impl(dst_path, st0)

    def _tmp_free_bytes() -> int | None:
        return _tmp_free_bytes_impl(TMP_DIR)

    def _dir_walk_sum_bytes(root: str) -> tuple[int | None, int, bool]:
        return _dir_walk_sum_bytes_impl(root, max_items=MAX_ZIP_ESTIMATE_ITEMS)

    def _remote_estimate_tree_bytes(sess: Any, rpath: str, *, max_nodes: int | None = None) -> tuple[int | None, int, bool]:
        """Best-effort recursive size estimate for remote trees.

        Uses streaming `cls -lR` output parsing to avoid loading huge listings into RAM.
        Returns (bytes|None, entries_count, truncated).
        """
        total = 0
        entries = 0
        truncated = False

        cap = MAX_ZIP_ESTIMATE_ITEMS
        if isinstance(max_nodes, int) and max_nodes > 0:
            cap = min(MAX_ZIP_ESTIMATE_ITEMS, int(max_nodes))

        p = None
        stdout = None
        stderr = None
        buf = b''

        def _handle_line(line: str) -> None:
            nonlocal total, entries
            item = _parse_ls_line(line)
            if not item:
                return
            t = str(item.get('type') or '')
            if t == 'dir':
                return
            # Treat non-dir as file-ish (file/link).
            try:
                total += int(item.get('size') or 0)
            except Exception:
                pass

        try:
            # Some protocols may not support -R; treat failures as unknown.
            p = mgr._popen_lftp(sess, [f"cls -lR {_lftp_quote(rpath)}"])
            stdout = p.stdout
            stderr = p.stderr
            if stdout is None:
                return None, 0, True
            while True:
                chunk = stdout.read(64 * 1024)
                if not chunk:
                    break
                buf += chunk
                while True:
                    idx = buf.find(b'\n')
                    if idx < 0:
                        break
                    line_b = buf[:idx]
                    buf = buf[idx + 1:]
                    entries += 1
                    if entries > cap:
                        truncated = True
                        try:
                            p.terminate()
                        except Exception:
                            pass
                        break
                    try:
                        _handle_line(line_b.decode('utf-8', errors='replace'))
                    except Exception:
                        pass
                if truncated:
                    break

            # flush last line
            if not truncated and buf:
                try:
                    entries += 1
                    _handle_line(buf.decode('utf-8', errors='replace'))
                except Exception:
                    pass

            try:
                rc = p.wait(timeout=2) if p else 0
            except Exception:
                rc = 0
            if int(rc or 0) != 0:
                return None, int(entries), True
            return int(total), int(entries), bool(truncated)
        except Exception:
            return None, int(entries), True
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

    def _remote_stat_type_size(sess: Any, rpath: str) -> tuple[str | None, int | None]:
        """Return (type, size) for remote path, best-effort."""
        try:
            rc, out, err = mgr._run_lftp(sess, [f"cls -ld {_lftp_quote(rpath)}"], capture=True)
            if rc != 0:
                return None, None
            text = (out or b'').decode('utf-8', errors='replace')
            for line in text.splitlines():
                item = _parse_ls_line(line)
                if not item:
                    continue
                t = str(item.get('type') or '') or None
                sz = None
                try:
                    sz = int(item.get('size'))
                except Exception:
                    sz = None
                return t, sz
        except Exception:
            return None, None
        return None, None

    def _zip_precheck_or_confirm(*, estimated_bytes: int | None, truncated: bool, confirm: bool, kind: str, tmp_need_bytes: int | None = None) -> Any | None:
        """Return a Flask response if we should block/ask-confirm, else None."""
        if MAX_ZIP_BYTES is None:
            return None

        # Hard reject if we can estimate and it's over the configured cap.
        if isinstance(estimated_bytes, int) and estimated_bytes >= 0 and estimated_bytes > MAX_ZIP_BYTES:
            return error_response(
                'zip_too_large',
                413,
                ok=False,
                estimated_bytes=int(estimated_bytes),
                max_bytes=int(MAX_ZIP_BYTES),
                hint=f"Оценка: {_fmt_mb(int(estimated_bytes))}. Лимит: {_fmt_mb(int(MAX_ZIP_BYTES))}.",
            )

        # If estimate is missing/truncated, require explicit confirmation to proceed.
        if (estimated_bytes is None or truncated) and not confirm:
            return error_response(
                'confirm_required',
                409,
                ok=False,
                estimated_bytes=estimated_bytes,
                estimate_truncated=bool(truncated),
                max_bytes=int(MAX_ZIP_BYTES),
                kind=str(kind or ''),
                message='Размер архива оценить точно не удалось. Создание ZIP может занять много места в /tmp.',
            )

        # tmp free space check (best-effort)
        if isinstance(tmp_need_bytes, int) and tmp_need_bytes > 0:
            free = _tmp_free_bytes()
            if isinstance(free, int) and free >= 0 and free < tmp_need_bytes:
                return error_response(
                    'tmp_no_space',
                    507,
                    ok=False,
                    required_bytes=int(tmp_need_bytes),
                    free_bytes=int(free),
                    message=f"Недостаточно места в /tmp для создания архива. Нужно ~{_fmt_mb(int(tmp_need_bytes))}, доступно ~{_fmt_mb(int(free))}.",
                )

        return None

    def _run_lftp_mirror_with_tmp_cap(sess: Any, *, src: str, dst: str, hard_cap_bytes: int | None) -> None:
        """Run lftp mirror (remote->local) and abort if /tmp usage grows too much.

        This is a best-effort safety net: we track global free space in TMP_DIR
        rather than measuring dst tree size.
        """
        cmd = f"mirror --verbose -- {_lftp_quote(src)} {_lftp_quote(dst)}"
        script = mgr._build_lftp_script(sess, [cmd])
        env = os.environ.copy()
        env.setdefault('LC_ALL', 'C')
        env.setdefault('LANG', 'C')

        start_free = _tmp_free_bytes()
        proc = subprocess.Popen([mgr.lftp_bin, '-c', script], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env, bufsize=0)

        try:
            # Poll + enforce cap while the mirror runs.
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

    # Remote manager proxy (available only when remote blueprint is registered).
    mgr = LocalProxy(lambda: current_app.extensions.get("xkeen.remotefs_mgr"))

    def _infer_target() -> str:
        # Try args, then form, then JSON (best-effort).
        try:
            t = request.args.get("target")
            if t:
                return str(t).strip().lower()
        except Exception:
            pass
        try:
            t = request.form.get("target")
            if t:
                return str(t).strip().lower()
        except Exception:
            pass
        try:
            data = request.get_json(silent=True)
            if isinstance(data, dict) and data.get("target"):
                return str(data.get("target") or "").strip().lower()
        except Exception:
            pass
        return ""

    def _require_enabled() -> Optional[Any]:
        """Remote gating for /api/fs/*.

        The original implementation gated everything under remotefs. Here we
        only gate remote actions; local actions must remain available.
        """
        target = _infer_target()
        if target != "remote":
            return None
        mgr_obj = current_app.extensions.get("xkeen.remotefs_mgr")
        if not mgr_obj or not getattr(mgr_obj, "enabled", False):
            return error_response("feature_disabled", 404, ok=False)
        return None

    def _get_session_or_404(sid: str):
        if (resp := _require_enabled()) is not None:
            return None, resp
        mgr_obj = current_app.extensions.get("xkeen.remotefs_mgr")
        if not mgr_obj:
            return None, error_response("feature_disabled", 404, ok=False)
        s = mgr_obj.get(sid)
        if not s:
            return None, error_response("session_not_found", 404, ok=False)
        try:
            mgr_obj._touch(sid)
        except Exception:
            pass
        return s, None

    def _remote_is_dir(sess: Any, rpath: str) -> bool | None:
        """Return True/False if path exists and is dir/file, or None if missing."""
        try:
            rc, out, err = mgr._run_lftp(sess, [f"cls -ld {_lftp_quote(rpath)}"], capture=True)
        except Exception:
            return None
        if rc != 0:
            return None
        text = out.decode("utf-8", errors="replace")
        for line in text.splitlines():
            item = _parse_ls_line(line)
            if item:
                return item.get("type") == "dir"
        return None

    def _remote_exists(sess: Any, rpath: str) -> bool:
        return _remote_is_dir(sess, rpath) is not None

    def _dir_size_bytes_best_effort(path_abs: str, *, timeout_s: float = 3.0) -> tuple[int | None, str | None]:
        return _dir_size_bytes_best_effort_impl(path_abs, timeout_s=timeout_s)

    # Extracted endpoints
    register_list_endpoints(
        bp,
        {
            "error_response": error_response,
            "_require_enabled": _require_enabled,
            "_get_session_or_404": _get_session_or_404,
            "LOCALFS_ROOTS": LOCALFS_ROOTS,
            "mgr": mgr,
            "_lftp_quote": _lftp_quote,
            "_parse_ls_line": _parse_ls_line,
            "_local_norm_abs": _local_norm_abs,
            "_local_resolve": _local_resolve,
            "_local_resolve_nofollow": _local_resolve_nofollow,
            "_local_is_allowed": _local_is_allowed,
            "_local_item_from_stat": _local_item_from_stat,
            "_local_trash_dirs": _local_trash_dirs,
            "_local_trash_stats": _local_trash_stats,
            "_TRASH_META_DIRNAME": _TRASH_META_DIRNAME,
            "dir_size_bytes_best_effort": _dir_size_bytes_best_effort,
        },
    )


    # Extracted endpoints: download + upload
    register_transfer_endpoints(
        bp,
        {
            "error_response": error_response,
            "_require_enabled": _require_enabled,
            "_get_session_or_404": _get_session_or_404,
            "_core_log": _core_log,
            "LOCALFS_ROOTS": LOCALFS_ROOTS,
            "TMP_DIR": TMP_DIR,
            "MAX_UPLOAD_MB": MAX_UPLOAD_MB,
            "mgr": mgr,
            "_lftp_quote": _lftp_quote,
            "_parse_ls_line": _parse_ls_line,
            "_local_resolve": _local_resolve,
            "_content_disposition_attachment": _content_disposition_attachment,
            "_zip_directory": _zip_directory,
            "_zip_precheck_or_confirm": _zip_precheck_or_confirm,
            "_dir_walk_sum_bytes": _dir_walk_sum_bytes,
            "_tmp_free_bytes": _tmp_free_bytes,
            "_remote_estimate_tree_bytes": _remote_estimate_tree_bytes,
            "_run_lftp_mirror_with_tmp_cap": _run_lftp_mirror_with_tmp_cap,
            "MAX_ZIP_BYTES": MAX_ZIP_BYTES,
            "_apply_local_metadata_best_effort": _apply_local_metadata_best_effort,
        },
    )


    
    # Extracted endpoints
    register_readwrite_endpoints(
        bp,
        {
            "error_response": error_response,
            "_require_enabled": _require_enabled,
            "_get_session_or_404": _get_session_or_404,
            "_core_log": _core_log,
            "LOCALFS_ROOTS": LOCALFS_ROOTS,
            "TMP_DIR": TMP_DIR,
            "mgr": mgr,
            "_lftp_quote": _lftp_quote,
            "_parse_ls_line": _parse_ls_line,
            "_local_resolve": _local_resolve,
            "_apply_local_metadata_best_effort": _apply_local_metadata_best_effort,
            "_snapshot_before_overwrite": _snapshot_before_overwrite,
            "_BACKUP_DIR": _BACKUP_DIR,
            "_BACKUP_DIR_REAL": _BACKUP_DIR_REAL,
            "_XRAY_CONFIGS_DIR_REAL": _XRAY_CONFIGS_DIR_REAL,
        },
    )




    # Extracted endpoints: archive selection + create/extract/list
    register_archive_endpoints(
        bp,
        {
            'error_response': error_response,
            '_require_enabled': _require_enabled,
            '_get_session_or_404': _get_session_or_404,
            '_core_log': _core_log,
            'LOCALFS_ROOTS': LOCALFS_ROOTS,
            'TMP_DIR': TMP_DIR,
            'MAX_ZIP_BYTES': MAX_ZIP_BYTES,
            'mgr': mgr,
            '_lftp_quote': _lftp_quote,
            '_parse_ls_line': _parse_ls_line,
            '_local_resolve': _local_resolve,
            '_content_disposition_attachment': _content_disposition_attachment,
            '_zip_directory': _zip_directory,
            '_zip_selection_local': _zip_selection_local,
            '_zip_precheck_or_confirm': _zip_precheck_or_confirm,
            '_dir_walk_sum_bytes': _dir_walk_sum_bytes,
            '_tmp_free_bytes': _tmp_free_bytes,
            '_remote_estimate_tree_bytes': _remote_estimate_tree_bytes,
            '_run_lftp_mirror_with_tmp_cap': _run_lftp_mirror_with_tmp_cap,
        },
    )

    # Extracted endpoints: mkdir/rename/touch
    register_manage_endpoints(
        bp,
        {
            'error_response': error_response,
            '_require_enabled': _require_enabled,
            '_get_session_or_404': _get_session_or_404,
            '_core_log': _core_log,
            'LOCALFS_ROOTS': LOCALFS_ROOTS,
            'mgr': mgr,
            '_lftp_quote': _lftp_quote,
            '_local_resolve': _local_resolve,
            '_local_resolve_nofollow': _local_resolve_nofollow,
            '_local_is_protected_entry_abs': _local_is_protected_entry_abs,
            '_remote_exists': _remote_exists,
        },
    )

    # Extracted endpoints: remove/restore/trash/clear
    register_trash_endpoints(
        bp,
        {
            'error_response': error_response,
            '_require_enabled': _require_enabled,
            '_get_session_or_404': _get_session_or_404,
            '_core_log': _core_log,
            'LOCALFS_ROOTS': LOCALFS_ROOTS,
            'mgr': mgr,
            '_lftp_quote': _lftp_quote,
            '_local_resolve_nofollow': _local_resolve_nofollow,
        },
    )

    # Extracted endpoints: chmod/chown
    register_perms_endpoints(
        bp,
        {
            'error_response': error_response,
            '_require_enabled': _require_enabled,
            '_get_session_or_404': _get_session_or_404,
            '_core_log': _core_log,
            'LOCALFS_ROOTS': LOCALFS_ROOTS,
            'mgr': mgr,
            '_lftp_quote': _lftp_quote,
            '_local_resolve': _local_resolve,
        },
    )

    # Extracted endpoint: checksum
    register_checksum_endpoints(
        bp,
        {
            'error_response': error_response,
            '_require_enabled': _require_enabled,
            '_get_session_or_404': _get_session_or_404,
            'LOCALFS_ROOTS': LOCALFS_ROOTS,
            'mgr': mgr,
            '_lftp_quote': _lftp_quote,
            '_local_resolve': _local_resolve,
            '_remote_stat_type_size': _remote_stat_type_size,
        },
    )




    return bp

