"""File operations backend for the UI file manager.

This module serves /api/fileops/* (copy/move/delete jobs + progress).
It is extracted from routes_remotefs.py so local file manager operations
work even when RemoteFS (lftp) is unavailable/disabled.
"""

from __future__ import annotations

import os
import re
import stat
import time
import json
import uuid
import shutil
import base64
import hashlib
import shlex
import threading
from functools import partial
from services.fileops import FileOpJob, FileOpJobManager, SpoolManager, WsTokenManager
from services.fileops.runtime import FileOpsRuntime
from services.fileops.ops_copy_move import run_job_copy_move as _run_job_copy_move_impl
from services.fileops.ops_delete import run_job_delete as _run_job_delete_impl
from services.fileops.ops_archive import (
    normalize_zip as _normalize_zip_impl,
    normalize_unzip as _normalize_unzip_impl,
    run_job_zip as _run_job_zip_impl,
    run_job_unzip as _run_job_unzip_impl,
)
from services.fileops.ops_checksum import (
    normalize_checksum as _normalize_checksum_impl,
    run_job_checksum as _run_job_checksum_impl,
)
from services.fileops.ops_dirsize import (
    normalize_dirsize as _normalize_dirsize_impl,
    run_job_dirsize as _run_job_dirsize_impl,
)
from services.fileops.normalize import (
    normalize_sources as _normalize_sources_impl,
    normalize_delete as _normalize_delete_impl,
    compute_copy_move_conflicts as _compute_copy_move_conflicts_impl,
)
from services.utils.env import _env_bool, _read_int_env
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path

from flask import Blueprint, request, jsonify

from routes.common.errors import error_response

from .endpoints_http import register_http_endpoints
from .ws import register_ws_endpoints

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


# Optional gevent sleep (for WS streaming without blocking the server)
try:  # pragma: no cover
    from gevent import sleep as _ws_sleep  # type: ignore
except Exception:  # pragma: no cover
    def _ws_sleep(seconds: float) -> None:
        time.sleep(seconds)


def _now() -> float:
    return time.time()


def _gen_id(prefix: str = "rf") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# Shared helpers (moved out of routes_remotefs in commit 2)
from services.fs_common.local import (
    _local_allowed_roots,
    _local_remove_entry,
    _local_is_protected_entry_abs,
    _local_soft_delete,
    _local_resolve,
    _local_resolve_follow,
    _local_resolve_nofollow,
)
from services.fs_common.remote_parse import _parse_ls_line
from services.fs_common.lftp_quote import _lftp_quote

# Local FS backend helpers (best-effort metadata)
from services.fileops.local_backend import _copyfile_no_stat, _copytree_no_stat, _safe_move_no_stat

from services.fileops.remote_backend import (
    remote_stat_size as _remote_stat_size_fn,
    remote_free_bytes as _remote_free_bytes_fn,
    remote_du_bytes as _remote_du_bytes_fn,
    remote_is_dir as _remote_is_dir_fn,
    remote_exists as _remote_exists_fn,
    url_for_session_path as _url_for_session_path_fn,
    run_lftp_raw as _run_lftp_raw_fn,
    popen_lftp_raw as _popen_lftp_raw_fn,
    popen_lftp_quiet as _popen_lftp_quiet_fn,
    terminate_proc as _terminate_proc_fn,
    build_lftp_url_script as _build_lftp_url_script_fn,
)



# --- Local FS helpers (robust across filesystems) ---
# NOTE: implementation moved to services.fileops.local_backend in commit 10.


class _RemoteMgrStub:
    """Minimal Any-like stub used when remotefs is unavailable.

    Local-only jobs do not use remote operations; this prevents attribute errors
    if a client accidentally sends remote targets while RemoteFS is disabled.
    """
    enabled = False
    lftp_bin = "lftp"

    def __init__(self, *, tmp_dir: str = "/tmp", max_upload_mb: int = 200) -> None:
        self.tmp_dir = tmp_dir
        self.max_upload_mb = max_upload_mb

    def get(self, sid: str):
        return None

    def _run_lftp(self, *args, **kwargs):
        raise RuntimeError("feature_disabled")

    def _popen_lftp(self, *args, **kwargs):
        raise RuntimeError("feature_disabled")

    def _build_lftp_script(self, *args, **kwargs):
        raise RuntimeError("feature_disabled")


def create_fileops_blueprint(
    *,
    remotefs_mgr: Optional[Any] = None,
    tmp_dir: str = "/tmp",
    max_upload_mb: int = 200,
) -> Blueprint:
    bp = Blueprint("fileops", __name__)
    mgr: Any = remotefs_mgr if remotefs_mgr is not None else _RemoteMgrStub(tmp_dir=tmp_dir, max_upload_mb=max_upload_mb)

    # ---- FileOps spooling (used for remote→remote transfers) ----
    # Keep spool inside tmp_dir (RAM) by default. Can be overridden.
    FILEOPS_SPOOL_DIR = os.getenv("XKEEN_FILEOPS_SPOOL_DIR", os.path.join(tmp_dir, "xkeen_fileops_spool"))
    FILEOPS_SPOOL_MAX_MB = _read_int_env("XKEEN_FILEOPS_SPOOL_MAX_MB", int(max_upload_mb))
    if not FILEOPS_SPOOL_MAX_MB:
        FILEOPS_SPOOL_MAX_MB = int(max_upload_mb)
    if FILEOPS_SPOOL_MAX_MB < 16:
        FILEOPS_SPOOL_MAX_MB = 16
    FILEOPS_SPOOL_MAX_BYTES = FILEOPS_SPOOL_MAX_MB * 1024 * 1024

    # Cleanup old spool items (best-effort). Helps avoid leftovers after crashes/reboots.
    FILEOPS_SPOOL_CLEANUP_AGE_SECONDS = _read_int_env("XKEEN_FILEOPS_SPOOL_CLEANUP_AGE", 21600)
    if not FILEOPS_SPOOL_CLEANUP_AGE_SECONDS:
        FILEOPS_SPOOL_CLEANUP_AGE_SECONDS = 21600
    if FILEOPS_SPOOL_CLEANUP_AGE_SECONDS < 600:
        FILEOPS_SPOOL_CLEANUP_AGE_SECONDS = 600

    FILEOPS_REMOTE2REMOTE_DIRECT = _env_bool("XKEEN_FILEOPS_REMOTE2REMOTE_DIRECT", True)
    FILEOPS_FXP_ENABLED = _env_bool("XKEEN_FILEOPS_FXP", True)
    # Keep in sync with routes_remotefs.py
    _TLS_VERIFY_MODES = ("strict", "ca", "none")

    # FileOps must be available for local file manager regardless of remotefs state.
    def _require_enabled() -> Optional[Any]:
        return None

    # --------------------------- Two-panel file operations (MVP iteration 1) ---------------------------

    # --------------------------- FileOps WS tokens (one-time) ---------------------------

    _token_mgr = WsTokenManager(now_fn=_now)
    issue_fileops_ws_token = _token_mgr.issue
    validate_fileops_ws_token = _token_mgr.validate

    LOCALFS_ROOTS = _local_allowed_roots()

    # Resolve spool directory under the allowed local roots.
    try:
        _SPOOL_BASE = _local_resolve(FILEOPS_SPOOL_DIR, LOCALFS_ROOTS)
    except Exception:
        # fall back to tmp_dir
        try:
            _SPOOL_BASE = _local_resolve(os.path.join(tmp_dir, 'xkeen_fileops_spool'), LOCALFS_ROOTS)
        except Exception:
            _SPOOL_BASE = os.path.join(tmp_dir, 'xkeen_fileops_spool')

    # Spool manager (remote->remote transfers)
    _spool_mgr = SpoolManager(
        base_dir=_SPOOL_BASE,
        max_bytes=FILEOPS_SPOOL_MAX_BYTES,
        cleanup_age_seconds=FILEOPS_SPOOL_CLEANUP_AGE_SECONDS,
        now_fn=_now,
    )

    # Provide legacy helper names to minimize churn in the runner code.
    _spool_tmp_file = _spool_mgr.tmp_file
    _spool_tmp_dir = _spool_mgr.tmp_dir
    _dir_size_bytes = _spool_mgr.dir_size_bytes
    _spool_cleanup_stale = _spool_mgr.cleanup_stale
    _spool_check_limit = _spool_mgr.check_limit


    # In-memory job manager (service layer)
    jobmgr = FileOpJobManager(
        max_jobs=int(os.getenv('XKEEN_FILEOPS_MAX_JOBS', '100') or '100'),
        ttl_seconds=int(os.getenv('XKEEN_FILEOPS_JOB_TTL', '3600') or '3600'),
        workers=int(os.getenv('XKEEN_FILEOPS_WORKERS', '1') or '1'),
    )


    _SENTINEL = object()

    def _job_bump(job: FileOpJob) -> None:
        try:
            job.rev = int(getattr(job, 'rev', 0) or 0) + 1
        except Exception:
            pass

    def _job_set_state(job: FileOpJob, state: str, *, error: Any = _SENTINEL) -> None:
        job.state = state
        if error is not _SENTINEL:
            # allow clearing error by passing None
            job.error = error
        _job_bump(job)

    def _progress_set(job: FileOpJob, **kw: Any) -> None:
        try:
            if job.progress is None:
                job.progress = {}
            job.progress.update(kw)
            _job_bump(job)
        except Exception:
            pass

    def _ensure_local_path_allowed(path: str) -> str:
        """Resolve local path following symlinks (content operations)."""
        try:
            return _local_resolve_follow(path, LOCALFS_ROOTS)
        except PermissionError as e:
            raise RuntimeError(str(e))

    def _ensure_local_path_allowed_nofollow(path: str) -> str:
        """Resolve local path without following the final component (rename/unlink)."""
        try:
            return _local_resolve_nofollow(path, LOCALFS_ROOTS)
        except PermissionError as e:
            raise RuntimeError(str(e))

    # --- Remote (lftp-based) helpers (moved to services.fileops.remote_backend in commit 14) ---
    _remote_stat_size = partial(
        _remote_stat_size_fn,
        mgr,
        lftp_quote=_lftp_quote,
        parse_ls_line=_parse_ls_line,
    )
    _remote_free_bytes = partial(_remote_free_bytes_fn, mgr, lftp_quote=_lftp_quote)
    _remote_du_bytes = partial(_remote_du_bytes_fn, mgr, lftp_quote=_lftp_quote)
    _remote_is_dir = partial(
        _remote_is_dir_fn,
        mgr,
        lftp_quote=_lftp_quote,
        parse_ls_line=_parse_ls_line,
    )
    _remote_exists = partial(
        _remote_exists_fn,
        mgr,
        lftp_quote=_lftp_quote,
        parse_ls_line=_parse_ls_line,
    )

    _url_for_session_path = _url_for_session_path_fn
    _run_lftp_raw = partial(_run_lftp_raw_fn, mgr)
    _popen_lftp_raw = partial(_popen_lftp_raw_fn, mgr)
    _popen_lftp_quiet = partial(_popen_lftp_quiet_fn, mgr)
    _terminate_proc = _terminate_proc_fn
    _build_lftp_url_script = partial(
        _build_lftp_url_script_fn,
        tls_verify_modes=_TLS_VERIFY_MODES,
        fxp_enabled=bool(FILEOPS_FXP_ENABLED),
        lftp_quote=_lftp_quote,
    )

    # --- FileOps runtime (service context) ---
    _runtime = FileOpsRuntime(
        mgr=mgr,
        local_roots=LOCALFS_ROOTS,
        now_fn=_now,
        job_set_state=_job_set_state,
        progress_set=_progress_set,
        core_log=_core_log,
        ensure_local_follow=_ensure_local_path_allowed,
        ensure_local_nofollow=_ensure_local_path_allowed_nofollow,
        local_remove_entry=_local_remove_entry,
        local_soft_delete=_local_soft_delete,
        local_is_protected_entry_abs=_local_is_protected_entry_abs,
        lftp_quote=_lftp_quote,
        remote_stat_size=_remote_stat_size,
        remote_free_bytes=_remote_free_bytes,
        remote_du_bytes=_remote_du_bytes,
        remote_is_dir=_remote_is_dir,
        remote_exists=_remote_exists,
        url_for_session_path=_url_for_session_path,
        run_lftp_raw=_run_lftp_raw,
        popen_lftp_raw=_popen_lftp_raw,
        popen_lftp_quiet=_popen_lftp_quiet,
        terminate_proc=_terminate_proc,
        build_lftp_url_script=_build_lftp_url_script,
        spool_tmp_file=_spool_tmp_file,
        spool_tmp_dir=_spool_tmp_dir,
        dir_size_bytes=_dir_size_bytes,
        spool_cleanup_stale=_spool_cleanup_stale,
        spool_check_limit=_spool_check_limit,
        spool_base_dir=_SPOOL_BASE,
        spool_max_bytes=int(FILEOPS_SPOOL_MAX_BYTES),
        remote2remote_direct=bool(FILEOPS_REMOTE2REMOTE_DIRECT),
        fxp_enabled=bool(FILEOPS_FXP_ENABLED),
    )

    # --- Runners / normalization (moved to services.fileops in commit 13) ---
    def _run_job_copy_move(job: FileOpJob, spec: Dict[str, Any]) -> None:
        return _run_job_copy_move_impl(job, spec, _runtime)

    def _run_job_delete(job: FileOpJob, spec: Dict[str, Any]) -> None:
        return _run_job_delete_impl(job, spec, _runtime)

    def _run_job_zip(job: FileOpJob, spec: Dict[str, Any]) -> None:
        return _run_job_zip_impl(job, spec, _runtime)

    def _run_job_unzip(job: FileOpJob, spec: Dict[str, Any]) -> None:
        return _run_job_unzip_impl(job, spec, _runtime)

    def _run_job_checksum(job: FileOpJob, spec: Dict[str, Any]) -> None:
        return _run_job_checksum_impl(job, spec, _runtime)

    def _run_job_dirsize(job: FileOpJob, spec: Dict[str, Any]) -> None:
        return _run_job_dirsize_impl(job, spec, _runtime)

    def _normalize_sources(spec: Dict[str, Any]) -> None:
        return _normalize_sources_impl(spec, _runtime)

    def _normalize_delete(spec: Dict[str, Any]) -> None:
        return _normalize_delete_impl(spec, _runtime)

    def _normalize_zip(spec: Dict[str, Any]) -> Dict[str, Any]:
        return _normalize_zip_impl(spec, _runtime)

    def _normalize_unzip(spec: Dict[str, Any]) -> Dict[str, Any]:
        return _normalize_unzip_impl(spec, _runtime)

    def _normalize_checksum(spec: Dict[str, Any]) -> Dict[str, Any]:
        return _normalize_checksum_impl(spec, _runtime)

    def _normalize_dirsize(spec: Dict[str, Any]) -> Dict[str, Any]:
        return _normalize_dirsize_impl(spec, _runtime)

    def _compute_copy_move_conflicts(spec: Dict[str, Any]) -> List[Dict[str, Any]]:
        return _compute_copy_move_conflicts_impl(spec, _runtime)


    # --- Endpoint registration (split in commit 11) ---
    register_ws_endpoints(
        bp,
        {
            "require_enabled": _require_enabled,
            "issue_ws_token": issue_fileops_ws_token,
            "validate_ws_token": validate_fileops_ws_token,
            "jobmgr": jobmgr,
            "ws_sleep": _ws_sleep,
        },
    )
    register_http_endpoints(
        bp,
        {
            "require_enabled": _require_enabled,
            "jobmgr": jobmgr,
            "normalize_delete": _normalize_delete,
            "normalize_sources": _normalize_sources,
            "compute_copy_move_conflicts": _compute_copy_move_conflicts,
            "normalize_zip": _normalize_zip,
            "normalize_unzip": _normalize_unzip,
            "normalize_checksum": _normalize_checksum,
            "normalize_dirsize": _normalize_dirsize,
            "progress_set": _progress_set,
            "run_job_delete": _run_job_delete,
            "run_job_copy_move": _run_job_copy_move,
            "run_job_zip": _run_job_zip,
            "run_job_unzip": _run_job_unzip,
            "run_job_checksum": _run_job_checksum,
            "run_job_dirsize": _run_job_dirsize,
            "core_log": _core_log,
        },
    )

    return bp
