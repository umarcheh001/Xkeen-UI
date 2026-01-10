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
import subprocess
import base64
import hashlib
import shlex
import threading
import queue
import secrets
from urllib.parse import quote as _url_quote
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from pathlib import Path

from flask import Blueprint, request, jsonify

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


def error_response(message: str, status: int = 400, *, ok: bool | None = None, **extra: Any) -> Any:
    payload: Dict[str, Any] = {"error": message}
    if ok is not None:
        payload["ok"] = ok
    payload.update(extra)
    return jsonify(payload), status


def _now() -> float:
    return time.time()


def _gen_id(prefix: str = "rf") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# Reuse the local path allowlist/resolve helpers and RemoteFs session types.
# These imports have no side effects (no lftp calls) and keep behavior consistent.
from routes_remotefs import (  # noqa: E402
    RemoteFsManager,
    RemoteFsSession,
    _local_allowed_roots,
    _local_remove_entry,
    _local_is_protected_entry_abs,
    _local_soft_delete,
    _local_resolve,
    _local_resolve_follow,
    _local_resolve_nofollow,
    _parse_ls_line,
    _lftp_quote,
)


# --- Local FS helpers (robust across filesystems) ---
# shutil.move/copytree rely on copystat/copy2, which can fail on some mounts
# (exFAT/NTFS/FAT, certain FUSE drivers) and break basic file manager actions.
# We intentionally treat metadata copy as best-effort.


def _copyfile_no_stat(src: str, dst: str) -> None:
    """Copy file bytes and try (but never require) metadata."""
    os.makedirs(os.path.dirname(dst) or '.', exist_ok=True)
    shutil.copyfile(src, dst, follow_symlinks=False)
    try:
        shutil.copystat(src, dst, follow_symlinks=False)
    except Exception:
        pass


def _copytree_no_stat(src_dir: str, dst_dir: str) -> None:
    """Recursively copy a directory without failing on metadata errors."""
    os.makedirs(dst_dir, exist_ok=True)
    with os.scandir(src_dir) as it:
        for entry in it:
            sp = entry.path
            dp = os.path.join(dst_dir, entry.name)
            try:
                if entry.is_symlink():
                    try:
                        os.symlink(os.readlink(sp), dp)
                    except FileExistsError:
                        pass
                    continue
                if entry.is_dir(follow_symlinks=False):
                    _copytree_no_stat(sp, dp)
                else:
                    _copyfile_no_stat(sp, dp)
            except Exception:
                # Best-effort: continue copying other entries.
                continue
    try:
        shutil.copystat(src_dir, dst_dir, follow_symlinks=False)
    except Exception:
        pass


def _safe_move_no_stat(src: str, dst: str) -> None:
    """Move path, falling back to copy+delete, without strict metadata."""
    try:
        os.rename(src, dst)
        return
    except Exception:
        pass

    st = os.lstat(src)
    if stat.S_ISLNK(st.st_mode):
        os.symlink(os.readlink(src), dst)
        os.unlink(src)
        return

    if stat.S_ISDIR(st.st_mode):
        _copytree_no_stat(src, dst)
        shutil.rmtree(src, ignore_errors=True)
        return

    _copyfile_no_stat(src, dst)
    try:
        os.unlink(src)
    except IsADirectoryError:
        shutil.rmtree(src, ignore_errors=True)


class _RemoteMgrStub:
    """Minimal RemoteFsManager-like stub used when remotefs is unavailable.

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
    remotefs_mgr: Optional[RemoteFsManager] = None,
    tmp_dir: str = "/tmp",
    max_upload_mb: int = 200,
) -> Blueprint:
    bp = Blueprint("fileops", __name__)
    mgr: Any = remotefs_mgr if remotefs_mgr is not None else _RemoteMgrStub(tmp_dir=tmp_dir, max_upload_mb=max_upload_mb)

    # ---- FileOps spooling (used for remote→remote transfers) ----
    # Keep spool inside tmp_dir (RAM) by default. Can be overridden.
    FILEOPS_SPOOL_DIR = os.getenv("XKEEN_FILEOPS_SPOOL_DIR", os.path.join(tmp_dir, "xkeen_fileops_spool"))
    try:
        FILEOPS_SPOOL_MAX_MB = int(os.getenv("XKEEN_FILEOPS_SPOOL_MAX_MB", str(max_upload_mb)) or str(max_upload_mb))
    except Exception:
        FILEOPS_SPOOL_MAX_MB = int(max_upload_mb)
    if FILEOPS_SPOOL_MAX_MB < 16:
        FILEOPS_SPOOL_MAX_MB = 16
    FILEOPS_SPOOL_MAX_BYTES = FILEOPS_SPOOL_MAX_MB * 1024 * 1024

    # Cleanup old spool items (best-effort). Helps avoid leftovers after crashes/reboots.
    try:
        FILEOPS_SPOOL_CLEANUP_AGE_SECONDS = int(os.getenv("XKEEN_FILEOPS_SPOOL_CLEANUP_AGE", "21600") or "21600")
    except Exception:
        FILEOPS_SPOOL_CLEANUP_AGE_SECONDS = 21600
    if FILEOPS_SPOOL_CLEANUP_AGE_SECONDS < 600:
        FILEOPS_SPOOL_CLEANUP_AGE_SECONDS = 600

    def _env_bool(name: str, default: bool = True) -> bool:
        v = (os.getenv(name, "") or "").strip().lower()
        if not v:
            return bool(default)
        if v in ("1", "true", "yes", "on", "+"):
            return True
        if v in ("0", "false", "no", "off", "-"):
            return False
        return bool(default)

    FILEOPS_REMOTE2REMOTE_DIRECT = _env_bool("XKEEN_FILEOPS_REMOTE2REMOTE_DIRECT", True)
    FILEOPS_FXP_ENABLED = _env_bool("XKEEN_FILEOPS_FXP", True)

    # FileOps must be available for local file manager regardless of remotefs state.
    def _require_enabled() -> Optional[Any]:
        return None

    # --------------------------- Two-panel file operations (MVP iteration 1) ---------------------------


    # --------------------------- FileOps WS tokens (one-time) ---------------------------

    FILEOPS_WS_TOKENS: Dict[str, float] = {}  # token -> expires_ts

    def issue_fileops_ws_token(ttl_seconds: int = 60) -> str:
        token = secrets.token_urlsafe(24)
        FILEOPS_WS_TOKENS[token] = _now() + int(ttl_seconds)
        return token

    def validate_fileops_ws_token(token: str) -> bool:
        try:
            token = (token or '').strip()
        except Exception:
            token = ''
        if not token:
            return False
        exp = FILEOPS_WS_TOKENS.get(token)
        if not exp:
            return False
        if _now() > float(exp):
            FILEOPS_WS_TOKENS.pop(token, None)
            return False
        # one-time
        FILEOPS_WS_TOKENS.pop(token, None)
        return True

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

    def _spool_ensure_dir() -> str:
        try:
            os.makedirs(_SPOOL_BASE, exist_ok=True)
        except Exception:
            pass
        return _SPOOL_BASE

    def _spool_tmp_file(*, ext: str = '') -> str:
        base = _spool_ensure_dir()
        name = f"spool_{uuid.uuid4().hex[:10]}"
        if ext:
            if not ext.startswith('.'):
                ext = '.' + ext
            name += ext
        return os.path.join(base, name)

    def _spool_tmp_dir() -> str:
        base = _spool_ensure_dir()
        p = os.path.join(base, f"spooldir_{uuid.uuid4().hex[:10]}")
        try:
            os.makedirs(p, exist_ok=True)
        except Exception:
            pass
        return p

    def _dir_size_bytes(path: str, *, stop_after: int | None = None) -> int:
        """Compute directory/file size in bytes (best-effort).

        stop_after: if provided, returns a value > stop_after as soon as it is exceeded.
        """
        total = 0
        p = path
        try:
            if os.path.isfile(p):
                return int(os.path.getsize(p))
        except Exception:
            return 0

        stack: List[str] = [p]
        while stack:
            cur = stack.pop()
            try:
                with os.scandir(cur) as it:
                    for entry in it:
                        try:
                            if entry.is_symlink():
                                continue
                            if entry.is_dir(follow_symlinks=False):
                                stack.append(entry.path)
                                continue
                            if entry.is_file(follow_symlinks=False):
                                try:
                                    total += int(entry.stat(follow_symlinks=False).st_size or 0)
                                except Exception:
                                    pass
                                if stop_after is not None and total > stop_after:
                                    return total
                        except Exception:
                            continue
            except Exception:
                continue
        return total

    def _spool_cleanup_stale() -> None:
        """Best-effort cleanup of stale spool items left after crashes."""
        if not FILEOPS_SPOOL_CLEANUP_AGE_SECONDS:
            return
        base = _spool_ensure_dir()
        cutoff = _now() - float(FILEOPS_SPOOL_CLEANUP_AGE_SECONDS)
        try:
            with os.scandir(base) as it:
                for entry in it:
                    name = entry.name
                    if not (name.startswith('spool_') or name.startswith('spooldir_')):
                        continue
                    try:
                        st = entry.stat(follow_symlinks=False)
                        if float(st.st_mtime) > cutoff:
                            continue
                    except Exception:
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            shutil.rmtree(entry.path)
                        else:
                            os.remove(entry.path)
                    except Exception:
                        pass
        except Exception:
            pass

    # Cleanup stale items at startup (best-effort). Also called at the start of each job.
    _spool_cleanup_stale()

    def _spool_check_limit(size_bytes: int) -> None:
        if size_bytes <= 0:
            return
        if size_bytes > FILEOPS_SPOOL_MAX_BYTES:
            raise RuntimeError('spool_limit_exceeded')

    @dataclass
    class FileOpJob:
        job_id: str
        op: str
        created_ts: float
        state: str = 'queued'
        rev: int = 0
        started_ts: float | None = None
        finished_ts: float | None = None
        progress: Dict[str, Any] = None  # type: ignore
        error: str | None = None
        cancel_flag: threading.Event = None  # type: ignore
        _proc: subprocess.Popen | None = None

        def to_dict(self) -> Dict[str, Any]:
            return {
                'job_id': self.job_id,
                'op': self.op,
                'state': self.state,
                'created_ts': self.created_ts,
                'started_ts': self.started_ts,
                'finished_ts': self.finished_ts,
                'progress': self.progress or {},
                'error': self.error,
            }

    class FileOpJobManager:
        def __init__(self, *, max_jobs: int = 100, ttl_seconds: int = 3600, workers: int = 1) -> None:
            self.max_jobs = max_jobs
            self.ttl_seconds = ttl_seconds
            self.workers = max(1, min(4, int(workers or 1)))
            self._lock = threading.Lock()
            self._jobs: Dict[str, FileOpJob] = {}

            # queued execution (iteration 2)
            self._queue: "queue.Queue[tuple[str, Any, Any]]" = queue.Queue()
            self._workers_started = False
            self._workers: List[threading.Thread] = []

        @staticmethod
        def _bump(job: FileOpJob) -> None:
            try:
                job.rev = int(getattr(job, 'rev', 0) or 0) + 1
            except Exception:
                pass

        def cleanup(self) -> None:
            now = _now()
            with self._lock:
                dead = [jid for jid, j in self._jobs.items() if j.finished_ts and (now - j.finished_ts) > self.ttl_seconds]
                for jid in dead:
                    self._jobs.pop(jid, None)

        def create(self, op: str) -> FileOpJob:
            self.cleanup()
            with self._lock:
                if len(self._jobs) >= self.max_jobs:
                    finished = [(jid, j.finished_ts or 0) for jid, j in self._jobs.items()]
                    finished.sort(key=lambda t: t[1])
                    for jid, _ in finished[: max(1, len(self._jobs) - self.max_jobs + 1)]:
                        self._jobs.pop(jid, None)

                jid = _gen_id('job')
                job = FileOpJob(
                    job_id=jid,
                    op=op,
                    created_ts=_now(),
                    progress={'files_done': 0, 'files_total': 0, 'bytes_done': 0, 'bytes_total': 0, 'current': None},
                    cancel_flag=threading.Event(),
                )
                self._jobs[jid] = job
                self._bump(job)
                return job

        def get(self, jid: str) -> FileOpJob | None:
            self.cleanup()
            with self._lock:
                return self._jobs.get(jid)

        def _start_workers(self) -> None:
            with self._lock:
                if self._workers_started:
                    return
                self._workers_started = True
                for i in range(self.workers):
                    t = threading.Thread(target=self._worker_loop, name=f'fileops-worker-{i}', daemon=True)
                    t.start()
                    self._workers.append(t)

        def submit(self, job: FileOpJob, runner: Any, spec: Any) -> None:
            self._start_workers()
            # keep job queued
            try:
                job.state = 'queued'
                self._bump(job)
            except Exception:
                pass
            self._queue.put((job.job_id, runner, spec))

        def cancel(self, jid: str) -> bool:
            job = self.get(jid)
            if not job:
                return False
            job.cancel_flag.set()

            # If queued, mark immediately
            if job.state == 'queued':
                job.error = None
                _job_set_state(job, 'canceled')
                job.finished_ts = _now()
                self._bump(job)
                return True

            try:
                if job._proc is not None and job.state == 'running':
                    job._proc.terminate()
            except Exception:
                pass
            self._bump(job)
            return True

        def _worker_loop(self) -> None:
            while True:
                try:
                    jid, runner, spec = self._queue.get()
                except Exception:
                    continue

                job = self.get(jid)
                if not job:
                    try:
                        self._queue.task_done()
                    except Exception:
                        pass
                    continue

                # Job was canceled while waiting in queue
                if job.cancel_flag.is_set() and job.state == 'canceled':
                    try:
                        self._queue.task_done()
                    except Exception:
                        pass
                    continue

                # If queued but cancel_flag set: mark canceled
                if job.cancel_flag.is_set() and job.state == 'queued':
                    job.state = 'canceled'
                    job.error = None
                    job.finished_ts = _now()
                    self._bump(job)
                    try:
                        self._queue.task_done()
                    except Exception:
                        pass
                    continue

                try:
                    runner(job, spec)
                except Exception:
                    if job.state not in ('done', 'error', 'canceled'):
                        job.state = 'error'
                        job.error = 'worker_error'
                        job.finished_ts = _now()
                        self._bump(job)
                finally:
                    try:
                        self._queue.task_done()
                    except Exception:
                        pass
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

    def _remote_stat_size(sess: RemoteFsSession, rpath: str) -> int | None:
        rc, out, err = mgr._run_lftp(sess, [f"cls -ld {_lftp_quote(rpath)}"], capture=True)
        if rc != 0:
            return None
        text = out.decode('utf-8', errors='replace')
        for line in text.splitlines():
            item = _parse_ls_line(line)
            if item:
                try:
                    return int(item.get('size') or 0)
                except Exception:
                    return None
        return None


    def _parse_df_free_bytes(text: str) -> int | None:
        """Parse lftp `df` output and return available bytes (best-effort).

        We expect something similar to POSIX df output, but formats vary by protocol.
        """
        try:
            lines = [ln.strip() for ln in (text or '').splitlines() if ln.strip()]
            if not lines:
                return None
            # Drop header-like lines
            data_lines = [ln for ln in lines if not re.search(r"\bFilesystem\b|\bMounted\b|\bUse%\b", ln, re.I)]
            if not data_lines:
                data_lines = lines[-1:]

            # Use the last data line
            ln = data_lines[-1]
            parts = re.split(r"\s+", ln)
            # Extract purely integer tokens
            nums: List[int] = []
            for tok in parts:
                if tok.isdigit():
                    try:
                        nums.append(int(tok))
                    except Exception:
                        pass
            # Typical: <fs> <blocks> <used> <avail> <use%> <mnt>
            if len(nums) >= 3:
                return int(nums[2])
            # Sometimes: <blocks> <used> <avail> ...
            if len(nums) == 2:
                # no reliable mapping
                return None
            return None
        except Exception:
            return None


    def _remote_free_bytes(sess: RemoteFsSession, path: str) -> int | None:
        """Return free bytes on remote filesystem for a given path (best-effort).

        If protocol/server doesn't support df, returns None.
        """
        p = str(path or '').strip() or '.'
        # Try byte-precise first; fall back to KiB blocks.
        for cmd, mul in ((f"df -B1 {_lftp_quote(p)}", 1), (f"df -k {_lftp_quote(p)}", 1024)):
            try:
                rc, out, err = mgr._run_lftp(sess, [cmd], capture=True)
                if rc != 0:
                    continue
                txt = (out or b'').decode('utf-8', errors='replace')
                avail = _parse_df_free_bytes(txt)
                if avail is None:
                    continue
                return int(avail) * int(mul)
            except Exception:
                continue
        return None


    def _remote_du_bytes(sess: RemoteFsSession, path: str) -> int | None:
        """Best-effort remote directory size in bytes.

        Works only when lftp supports `du -b` for the given protocol.
        """
        p = str(path or '').strip() or '.'
        # Prefer explicit bytes.
        for cmd in (f"du -sb {_lftp_quote(p)}", f"du -s -b {_lftp_quote(p)}"):
            try:
                rc, out, err = mgr._run_lftp(sess, [cmd], capture=True)
                if rc != 0:
                    continue
                txt = (out or b'').decode('utf-8', errors='replace')
                m = re.search(r"(^|\s)(\d+)(\s|$)", txt.strip())
                if m:
                    return int(m.group(2))
            except Exception:
                continue
        return None

    def _remote_is_dir(sess: RemoteFsSession, rpath: str) -> bool | None:
        rc, out, err = mgr._run_lftp(sess, [f"cls -ld {_lftp_quote(rpath)}"], capture=True)
        if rc != 0:
            return None
        text = out.decode('utf-8', errors='replace')
        for line in text.splitlines():
            item = _parse_ls_line(line)
            if item:
                return item.get('type') == 'dir'
        return None

    def _remote_exists(sess: RemoteFsSession, rpath: str) -> bool:
        return _remote_is_dir(sess, rpath) is not None

    def _url_for_session_path(sess: RemoteFsSession, path: str) -> str:
        """Build a URL with embedded credentials for lftp URL-style commands.

        Used for remote→remote transfers (mirror/get -o) so lftp can initiate FXP when possible.
        Credentials never touch disk and are not logged.
        """
        p = (path or '').strip() or '/'
        if not p.startswith('/'):
            p = '/' + p
        user = _url_quote(sess.username or '', safe='')
        pwd = _url_quote(sess.password or '', safe='')
        host = sess.host
        port = int(sess.port)
        # Keep slashes in path, escape everything else
        p_enc = _url_quote(p, safe='/')
        return f"{sess.protocol}://{user}:{pwd}@{host}:{port}{p_enc}"

    def _run_lftp_raw(script: str) -> Tuple[int, bytes, bytes]:
        env = os.environ.copy()
        env.setdefault('LC_ALL', 'C')
        env.setdefault('LANG', 'C')
        p = subprocess.Popen([mgr.lftp_bin, '-c', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        out, err = p.communicate()
        return int(p.returncode or 0), out or b'', err or b''

    def _popen_lftp_raw(script: str) -> subprocess.Popen:
        env = os.environ.copy()
        env.setdefault('LC_ALL', 'C')
        env.setdefault('LANG', 'C')
        return subprocess.Popen([mgr.lftp_bin, '-c', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, bufsize=0)

    def _popen_lftp_quiet(sess: RemoteFsSession, commands: List[str]) -> subprocess.Popen:
        """Run lftp with stdout suppressed to avoid pipe buffer deadlocks.

        Useful for long-running mirror operations where we want to poll/cancel/limit spool size.
        """
        script = mgr._build_lftp_script(sess, commands)
        env = os.environ.copy()
        env.setdefault('LC_ALL', 'C')
        env.setdefault('LANG', 'C')
        return subprocess.Popen([mgr.lftp_bin, '-c', script], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env, bufsize=0)

    def _terminate_proc(proc: subprocess.Popen) -> None:
        try:
            proc.terminate()
        except Exception:
            pass
        time.sleep(0.2)
        try:
            if proc.poll() is None:
                proc.kill()
        except Exception:
            pass

    def _build_lftp_url_script(src_sess: RemoteFsSession, dst_sess: RemoteFsSession, commands: List[str]) -> str:
        # Conservative settings for router usage
        timeout = max(int(src_sess.options.get('timeout_sec', 10) or 10), int(dst_sess.options.get('timeout_sec', 10) or 10))

        def _mode(sess: RemoteFsSession) -> str:
            m = str(sess.options.get('tls_verify_mode') or 'none').strip().lower()
            return m if m in _TLS_VERIFY_MODES else 'none'

        m1 = _mode(src_sess)
        m2 = _mode(dst_sess)
        tls_verify = (m1 != 'none') and (m2 != 'none')
        strict_host = (m1 == 'strict') and (m2 == 'strict')
        ca_file = src_sess.options.get('tls_ca_file') or dst_sess.options.get('tls_ca_file')

        parts = [
            'set cmd:fail-exit yes',
            'set cmd:interactive false',
            f'set net:timeout {timeout}',
            'set net:max-retries 1',
            'set net:persist-retries 0',
        ]
        # Enable FXP for FTP/FTPS pairs (lftp will fallback to client-side copy if FXP is not possible).
        parts.append(f"set ftp:use-fxp {'yes' if FILEOPS_FXP_ENABLED else 'no'}")
        # TLS verification settings for FTPS URLs
        parts.append(f"set ssl:verify-certificate {'yes' if tls_verify else 'no'}")
        parts.append(f"set ssl:check-hostname {'yes' if strict_host else 'no'}")
        if ca_file:
            parts.append(f"set ssl:ca-file {_lftp_quote(str(ca_file))}")
        parts.extend(commands)
        parts.append('bye')
        return '; '.join(parts)

    def _run_job_copy_move(job: FileOpJob, spec: Dict[str, Any]) -> None:
        # spec is validated at API layer; this function runs in background.
        _job_set_state(job, 'running')
        job.started_ts = _now()

        # --- local helpers for safety ---
        def _same_local(a: str, b: str) -> bool:
            """Best-effort check whether two local paths point to the same inode."""
            try:
                if os.path.exists(a) and os.path.exists(b):
                    return os.path.samefile(a, b)
            except Exception:
                pass
            try:
                return os.path.realpath(a) == os.path.realpath(b)
            except Exception:
                return False

        def _next_copy_path_local(dst_path: str) -> str:
            """Return a non-existing path for duplicating a file/dir in the same folder.

            Example: file.bin -> file (2).bin -> file (3).bin
            """
            ddir = os.path.dirname(dst_path) or '.'
            base = os.path.basename(dst_path)
            # split ext for files; dirs keep ext=''
            stem, ext = os.path.splitext(base)
            # If stem already ends with " (N)", strip it before adding a new one.
            m = re.match(r"^(.*)\s\((\d+)\)$", stem)
            if m:
                stem = m.group(1)
            for i in range(2, 10000):
                cand = os.path.join(ddir, f"{stem} ({i}){ext}")
                if not os.path.exists(cand):
                    return cand
            raise RuntimeError('dst_name_exhausted')

        # Best-effort cleanup of stale spool items left after crashes.
        # (This runs quickly if the directory is empty.)
        try:
            _spool_cleanup_stale()
        except Exception:
            pass

        src = spec['src']
        dst = spec['dst']
        opts = spec.get('options') or {}
        overwrite = str(opts.get('overwrite', 'replace') or 'replace').strip().lower()
        if overwrite not in ('replace', 'skip', 'ask'):
            overwrite = 'replace'
        decisions = opts.get('decisions') if isinstance(opts.get('decisions'), dict) else {}
        default_action = str(opts.get('default_action') or opts.get('overwrite_default') or '').strip().lower() or None
        if default_action not in (None, 'replace', 'skip'):
            default_action = None

        # Free space check on remote destination before mirror/put (best-effort).
        # Enabled by default; silently skipped if protocol/server doesn't support `df`.
        check_free_space = bool(opts.get('check_free_space', True))

        def _check_remote_free(ds_sess: RemoteFsSession, dst_path: str, need_bytes: int, *, label: str = 'remote') -> None:
            if not check_free_space:
                return
            try:
                nb = int(need_bytes or 0)
            except Exception:
                nb = 0
            if nb <= 0:
                return
            try:
                free_b = _remote_free_bytes(ds_sess, dst_path)
            except Exception:
                free_b = None
            if free_b is None:
                return
            if int(free_b) < nb:
                # Attach some context for UI/logs.
                try:
                    _progress_set(job, current={
                        'path': str(dst_path),
                        'name': os.path.basename(str(dst_path).rstrip('/')) or str(dst_path),
                        'phase': 'precheck',
                        'is_dir': True,
                    },
                    check={'need_bytes': int(nb), 'free_bytes': int(free_b), 'where': str(label)})
                except Exception:
                    pass
                raise RuntimeError('remote_no_space')

        src_target = src['target']
        dst_target = dst['target']

        # normalized list of source entries: [{'path':..., 'name':..., 'is_dir':bool}]
        sources = spec['sources']
        _progress_set(job, files_total=len(sources), files_done=0, bytes_done=0, bytes_total=spec.get('bytes_total') or 0)

        def mark_done():
            _progress_set(job, files_done=(job.progress.get('files_done', 0) or 0) + 1)

        def _decide_overwrite_action(*, spath: str, sname: str, dpath: str) -> str:
            """Return 'replace' or 'skip' when destination exists."""
            if overwrite in ('replace', 'skip'):
                return overwrite
            # overwrite == 'ask'
            action = None
            try:
                if isinstance(decisions, dict):
                    action = decisions.get(spath) or decisions.get(dpath) or decisions.get(sname)
            except Exception:
                action = None
            if not action and default_action:
                action = default_action
            action_s = str(action or '').strip().lower()
            if action_s not in ('replace', 'skip'):
                raise RuntimeError('conflict_needs_decision')
            return action_s

        try:
            for ent in sources:
                if job.cancel_flag.is_set():
                    raise RuntimeError('canceled')
                spath = ent['path']
                sname = ent['name']
                is_dir = bool(ent.get('is_dir'))
                _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'copy', 'is_dir': is_dir})

                # determine destination path (TC-like): if destination is treated as a directory, create it if missing.
                dst_path = dst['path']
                dst_is_dir = bool(dst.get('is_dir')) or dst_path.endswith('/') or len(sources) > 1
                if dst_is_dir:
                    if dst_target == 'local':
                        ddir = _ensure_local_path_allowed(dst_path)
                        try:
                            os.makedirs(ddir, exist_ok=True)
                        except Exception:
                            raise RuntimeError('dst_not_dir')
                        dpath = os.path.join(ddir, sname)
                    else:
                        ddir = dst_path.rstrip('/')
                        if not ddir:
                            ddir = '/'
                        # best-effort create directory on remote
                        ds0 = mgr.get(dst.get('sid'))
                        if not ds0:
                            raise RuntimeError('session_not_found')
                        if ddir != '/':
                            mgr._run_lftp(ds0, [f"mkdir -p {_lftp_quote(ddir)}"], capture=True)
                        dpath = (ddir.rstrip('/') + '/' + sname) if ddir != '/' else ('/' + sname)
                else:
                    dpath = dst_path
                    # ensure parent exists
                    if dst_target == 'local':
                        dp_abs = _ensure_local_path_allowed_nofollow(dpath)
                        os.makedirs(os.path.dirname(dp_abs) or '/tmp', exist_ok=True)
                        dpath = dp_abs
                    else:
                        ds0 = mgr.get(dst.get('sid'))
                        if not ds0:
                            raise RuntimeError('session_not_found')
                        parent = os.path.dirname(dpath.rstrip('/'))
                        if parent and parent not in ('', '.'):
                            mgr._run_lftp(ds0, [f"mkdir -p {_lftp_quote(parent)}"], capture=True)

                # --- same-target fast path for move ---
                if job.op == 'move' and src_target == dst_target:
                    if src_target == 'local':
                        sp = _ensure_local_path_allowed_nofollow(spath)
                        dp = _ensure_local_path_allowed_nofollow(dpath)

                        # Protect Keenetic /tmp/mnt mount labels from being moved/renamed.
                        if _local_is_protected_entry_abs(sp) or _local_is_protected_entry_abs(dp):
                            raise RuntimeError('protected_path')

                        # Moving onto itself is a no-op; never delete the source.
                        if _same_local(sp, dp):
                            mark_done();
                            continue

                        if os.path.exists(dp):
                            action = _decide_overwrite_action(spath=sp, sname=sname, dpath=dp)
                            if action == 'skip':
                                mark_done();
                                continue
                            try:
                                _local_remove_entry(dp, LOCALFS_ROOTS, recursive=True)
                            except PermissionError as e:
                                raise RuntimeError(str(e))
                            except Exception:
                                pass
                        try:
                            # Robust across different mounts/FS types (EXDEV, copystat failures).
                            _safe_move_no_stat(sp, dp)
                        except Exception as e:
                            raise RuntimeError(str(e) or 'move_failed')
                        mark_done();
                        continue
                    if src_target == 'remote':
                        ss = mgr.get(src['sid'])
                        if not ss:
                            raise RuntimeError('session_not_found')

                        # Remote move onto itself is a no-op.
                        if str(spath) == str(dpath):
                            mark_done();
                            continue

                        if _remote_exists(ss, dpath):
                            action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dpath))
                            if action == 'skip':
                                mark_done();
                                continue
                            mgr._run_lftp(ss, [f"rm -r {_lftp_quote(dpath)}"], capture=True)
                        rc, out, err = mgr._run_lftp(ss, [f"mv {_lftp_quote(spath)} {_lftp_quote(dpath)}"], capture=True)
                        if rc != 0:
                            raise RuntimeError('remote_move_failed')
                        mark_done();
                        continue

                # --- copy routes ---
                if src_target == 'remote' and dst_target == 'local':
                    ss = mgr.get(src['sid'])
                    if not ss:
                        raise RuntimeError('session_not_found')
                    dp = _ensure_local_path_allowed_nofollow(dpath)
                    if _local_is_protected_entry_abs(dp):
                        raise RuntimeError('protected_path')
                    # overwrite policy
                    if os.path.exists(dp):
                        action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dp))
                        if action == 'skip':
                            mark_done();
                            continue
                        try:
                            _local_remove_entry(dp, LOCALFS_ROOTS, recursive=True)
                        except PermissionError as e:
                            raise RuntimeError(str(e))
                        except Exception:
                            pass
                    # directory: mirror; file: cat stream
                    if is_dir:
                        os.makedirs(dp, exist_ok=True)
                        cmd = f"mirror --verbose -- {_lftp_quote(spath)} {_lftp_quote(dp)}"
                        proc = mgr._popen_lftp(ss, [cmd])
                        job._proc = proc
                        out, err = proc.communicate()
                        if proc.returncode != 0:
                            raise RuntimeError('mirror_failed')
                        mark_done();
                    else:
                        os.makedirs(os.path.dirname(dp) or '/tmp', exist_ok=True)
                        tmp = dp + '.part.' + uuid.uuid4().hex[:6]
                        size_total = _remote_stat_size(ss, spath) or 0
                        # update bytes_total incrementally
                        if (job.progress.get('bytes_total', 0) or 0) == 0 and size_total:
                            _progress_set(job, bytes_total=int(size_total))
                        proc = mgr._popen_lftp(ss, [f"cat {_lftp_quote(spath)}"])
                        job._proc = proc
                        stdout = proc.stdout
                        stderr = proc.stderr
                        done = 0
                        try:
                            with open(tmp, 'wb') as fp:
                                while True:
                                    if job.cancel_flag.is_set():
                                        raise RuntimeError('canceled')
                                    chunk = stdout.read(64*1024) if stdout else b''
                                    if not chunk:
                                        break
                                    fp.write(chunk)
                                    done += len(chunk)
                                    _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + len(chunk))
                            rc = proc.wait()
                            if rc != 0:
                                raise RuntimeError('download_failed')
                            os.rename(tmp, dp)
                        finally:
                            try:
                                if stdout: stdout.close()
                            except Exception:
                                pass
                            try:
                                if stderr: stderr.close()
                            except Exception:
                                pass
                            try:
                                if os.path.exists(tmp):
                                    os.remove(tmp)
                            except Exception:
                                pass
                        mark_done();

                elif src_target == 'local' and dst_target == 'remote':
                    ds = mgr.get(dst['sid'])
                    if not ds:
                        raise RuntimeError('session_not_found')
                    sp = _ensure_local_path_allowed(spath)
                    if is_dir:
                        # Pre-check free space on remote destination (best-effort).
                        try:
                            need_b = _dir_size_bytes(sp)
                            _check_remote_free(ds, dpath, int(need_b), label=f"{ds.protocol}://{ds.host}")
                        except RuntimeError:
                            raise
                        except Exception:
                            pass
                        # mirror -R local_dir -> remote_dir
                        cmd = f"mirror -R --verbose -- {_lftp_quote(sp)} {_lftp_quote(dpath)}"
                        proc = mgr._popen_lftp(ds, [cmd])
                        job._proc = proc
                        out, err = proc.communicate()
                        if proc.returncode != 0:
                            raise RuntimeError('mirror_failed')
                        mark_done();
                    else:
                        try:
                            st = os.stat(sp)
                            size_total = int(st.st_size or 0)
                        except Exception:
                            size_total = 0
                        if (job.progress.get('bytes_total', 0) or 0) == 0 and size_total:
                            _progress_set(job, bytes_total=int(size_total))
                        # Pre-check free space on remote destination (best-effort).
                        try:
                            if size_total:
                                _check_remote_free(ds, dpath, int(size_total), label=f"{ds.protocol}://{ds.host}")
                        except RuntimeError:
                            raise
                        except Exception:
                            pass
                        # overwrite policy (best-effort)
                        if _remote_exists(ds, dpath):
                            action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dpath))
                            if action == 'skip':
                                mark_done();
                                continue
                            mgr._run_lftp(ds, [f"rm -r {_lftp_quote(dpath)}"], capture=True)
                        proc = mgr._popen_lftp(ds, [f"put {_lftp_quote(sp)} -o {_lftp_quote(dpath)}"])
                        job._proc = proc
                        out, err = proc.communicate()
                        if proc.returncode != 0:
                            raise RuntimeError('upload_failed')
                        # No reliable per-byte progress here without parsing; mark done at end.
                        _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + size_total)
                        mark_done();

                elif src_target == 'local' and dst_target == 'local':
                    sp = _ensure_local_path_allowed(spath)
                    dp = _ensure_local_path_allowed_nofollow(dpath)

                    # COPY onto itself is a common UX case when both panels point to the same dir.
                    # Never delete the source; instead, auto-pick a free "(2)/(3)…" name.
                    if _same_local(sp, dp):
                        dp = _next_copy_path_local(dp)

                    if _local_is_protected_entry_abs(dp):
                        raise RuntimeError('protected_path')

                    if os.path.exists(dp):
                        action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dp))
                        if action == 'skip':
                            mark_done();
                            continue
                        try:
                            _local_remove_entry(dp, LOCALFS_ROOTS, recursive=True)
                        except PermissionError as e:
                            raise RuntimeError(str(e))
                        except Exception:
                            pass
                    if is_dir:
                        try:
                            _copytree_no_stat(sp, dp)
                        except Exception as e:
                            raise RuntimeError(str(e) or 'copy_failed')
                        mark_done();
                    else:
                        os.makedirs(os.path.dirname(dp) or '/tmp', exist_ok=True)
                        size_total = 0
                        try:
                            size_total = os.stat(sp).st_size
                        except Exception:
                            pass
                        if (job.progress.get('bytes_total', 0) or 0) == 0 and size_total:
                            _progress_set(job, bytes_total=int(size_total or 0))
                        with open(sp, 'rb') as r, open(dp + '.part.' + uuid.uuid4().hex[:6], 'wb') as w:
                            tmp = w.name
                            while True:
                                if job.cancel_flag.is_set():
                                    raise RuntimeError('canceled')
                                chunk = r.read(64*1024)
                                if not chunk:
                                    break
                                w.write(chunk)
                                _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + len(chunk))
                        os.rename(tmp, dp)
                        try:
                            if os.path.exists(tmp):
                                os.remove(tmp)
                        except Exception:
                            pass
                        mark_done();

                elif src_target == 'remote' and dst_target == 'remote':
                    ss = mgr.get(src['sid'])
                    ds = mgr.get(dst['sid'])
                    if not ss or not ds:
                        raise RuntimeError('session_not_found')

                    # COPY onto itself on the same remote session could otherwise delete the source
                    # when overwrite=replace (we remove destination first). Auto-pick a free name.
                    if job.op == 'copy' and src.get('sid') == dst.get('sid') and str(spath) == str(dpath):
                        base = os.path.basename(str(dpath).rstrip('/'))
                        parent = os.path.dirname(str(dpath).rstrip('/')) or '/'
                        stem, ext = os.path.splitext(base)
                        m = re.match(r"^(.*)\s\((\d+)\)$", stem)
                        if m:
                            stem = m.group(1)
                        picked = None
                        for i in range(2, 10000):
                            nm = f"{stem} ({i}){ext}"
                            cand = (parent.rstrip('/') + '/' + nm) if parent != '/' else ('/' + nm)
                            if not _remote_exists(ds, cand):
                                picked = cand
                                break
                        if picked:
                            dpath = picked

                    # overwrite policy on destination
                    if _remote_exists(ds, dpath):
                        action = _decide_overwrite_action(spath=str(spath), sname=str(sname), dpath=str(dpath))
                        if action == 'skip':
                            mark_done();
                            continue
                        # best-effort remove
                        mgr._run_lftp(ds, [f"rm -r {_lftp_quote(dpath)}"], capture=True)

                    if not is_dir:
                        # First try server-side copy if same session.
                        if src.get('sid') == dst.get('sid'):
                            rc, out, err = mgr._run_lftp(ss, [f"cp {_lftp_quote(spath)} {_lftp_quote(dpath)}"], capture=True)
                            if rc == 0:
                                # No bytes streamed; still advance progress to keep UI consistent.
                                sz = _remote_stat_size(ss, spath) or 0
                                if sz:
                                    _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + int(sz))
                                mark_done();
                                continue

                        # For FTP/FTPS pairs try lftp URL-form copy first (FXP when possible).
                        if FILEOPS_REMOTE2REMOTE_DIRECT and ss.protocol in ('ftp', 'ftps') and ds.protocol in ('ftp', 'ftps'):
                            try:
                                src_url = _url_for_session_path(ss, spath)
                                dst_url = _url_for_session_path(ds, dpath)
                                _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'fxp', 'is_dir': False})
                                script = _build_lftp_url_script(ss, ds, [f"get {_lftp_quote(src_url)} -o {_lftp_quote(dst_url)}"])
                                proc = _popen_lftp_raw(script)
                                job._proc = proc
                                try:
                                    while proc.poll() is None:
                                        if job.cancel_flag.is_set():
                                            try:
                                                proc.terminate()
                                            except Exception:
                                                pass
                                            time.sleep(0.2)
                                            try:
                                                if proc.poll() is None:
                                                    proc.kill()
                                            except Exception:
                                                pass
                                            raise RuntimeError('canceled')
                                        time.sleep(0.2)
                                    out, err = proc.communicate()
                                    if proc.returncode == 0:
                                        sz = _remote_stat_size(ss, spath) or 0
                                        if sz:
                                            _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + int(sz))
                                        mark_done();
                                        continue
                                finally:
                                    job._proc = None
                            except RuntimeError:
                                raise
                            except Exception:
                                # fall back to spooling route; clean up possible partial dest
                                try:
                                    mgr._run_lftp(ds, [f"rm -r {_lftp_quote(dpath)}"], capture=True)
                                except Exception:
                                    pass
                                pass

                        # Fallback: spool to local tmp then upload.
                        base_usage = 0
                        if FILEOPS_SPOOL_MAX_BYTES:
                            # account for existing spool usage (other jobs/leftovers)
                            base_usage = _dir_size_bytes(_SPOOL_BASE, stop_after=FILEOPS_SPOOL_MAX_BYTES + 1)
                        size_total = _remote_stat_size(ss, spath) or 0
                        if FILEOPS_SPOOL_MAX_BYTES and size_total:
                            _spool_check_limit(int(base_usage + int(size_total)))
                        tmp = _spool_tmp_file(ext='bin')
                        try:
                            _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'download', 'is_dir': False})
                            done = 0
                            proc = mgr._popen_lftp(ss, [f"cat {_lftp_quote(spath)}"])
                            job._proc = proc
                            stdout = proc.stdout
                            stderr = proc.stderr
                            try:
                                with open(tmp, 'wb') as fp:
                                    while True:
                                        if job.cancel_flag.is_set():
                                            raise RuntimeError('canceled')
                                        chunk = stdout.read(64*1024) if stdout else b''
                                        if not chunk:
                                            break
                                        fp.write(chunk)
                                        done += len(chunk)
                                        if FILEOPS_SPOOL_MAX_BYTES and (base_usage + done) > FILEOPS_SPOOL_MAX_BYTES:
                                            try:
                                                _terminate_proc(proc)
                                            except Exception:
                                                pass
                                            raise RuntimeError('spool_limit_exceeded')
                                        _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + len(chunk))
                                rc = proc.wait()
                                if rc != 0:
                                    raise RuntimeError('download_failed')
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
                                job._proc = None

                            _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'upload', 'is_dir': False})
                            proc2 = mgr._popen_lftp(ds, [f"put {_lftp_quote(tmp)} -o {_lftp_quote(dpath)}"])
                            job._proc = proc2
                            try:
                                out, err = proc2.communicate()
                                if proc2.returncode != 0:
                                    raise RuntimeError('upload_failed')
                            finally:
                                job._proc = None
                        finally:
                            try:
                                if os.path.exists(tmp):
                                    os.remove(tmp)
                            except Exception:
                                pass
                        mark_done();

                    else:
                        # For FTP/FTPS pairs try lftp URL-form mirror first (FXP when possible).
                        if FILEOPS_REMOTE2REMOTE_DIRECT and ss.protocol in ('ftp', 'ftps') and ds.protocol in ('ftp', 'ftps'):
                            try:
                                # Pre-check free space on destination (best-effort).
                                try:
                                    need_b = _remote_du_bytes(ss, spath) or 0
                                    if need_b:
                                        _check_remote_free(ds, dpath, int(need_b), label=f"{ds.protocol}://{ds.host}")
                                except RuntimeError:
                                    raise
                                except Exception:
                                    pass
                                src_url = _url_for_session_path(ss, spath)
                                dst_url = _url_for_session_path(ds, dpath)
                                _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'fxp', 'is_dir': True})
                                script = _build_lftp_url_script(ss, ds, [f"mirror --verbose -- {_lftp_quote(src_url)} {_lftp_quote(dst_url)}"])
                                proc = _popen_lftp_raw(script)
                                job._proc = proc
                                try:
                                    while proc.poll() is None:
                                        if job.cancel_flag.is_set():
                                            try:
                                                proc.terminate()
                                            except Exception:
                                                pass
                                            time.sleep(0.2)
                                            try:
                                                if proc.poll() is None:
                                                    proc.kill()
                                            except Exception:
                                                pass
                                            raise RuntimeError('canceled')
                                        time.sleep(0.2)
                                    out, err = proc.communicate()
                                    if proc.returncode == 0:
                                        mark_done();
                                        continue
                                finally:
                                    job._proc = None
                            except RuntimeError:
                                raise
                            except Exception:
                                # fall back to spooling route; clean up possible partial dest
                                try:
                                    mgr._run_lftp(ds, [f"rm -r {_lftp_quote(dpath)}"], capture=True)
                                except Exception:
                                    pass
                                pass

                        # Directory copy fallback: mirror down to spool dir then mirror -R up.
                        tmpd = _spool_tmp_dir()
                        try:
                            _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'download', 'is_dir': True})
                            base_usage = 0
                            if FILEOPS_SPOOL_MAX_BYTES:
                                base_usage = _dir_size_bytes(_SPOOL_BASE, stop_after=FILEOPS_SPOOL_MAX_BYTES + 1)
                                if base_usage >= FILEOPS_SPOOL_MAX_BYTES:
                                    raise RuntimeError('spool_limit_exceeded')
                            remaining = max(0, FILEOPS_SPOOL_MAX_BYTES - base_usage) if FILEOPS_SPOOL_MAX_BYTES else 0
                            last_sz = 0

                            proc1 = _popen_lftp_quiet(ss, [f"mirror -- {_lftp_quote(spath)} {_lftp_quote(tmpd)}"])
                            job._proc = proc1
                            try:
                                while proc1.poll() is None:
                                    if job.cancel_flag.is_set():
                                        _terminate_proc(proc1)
                                        raise RuntimeError('canceled')

                                    if FILEOPS_SPOOL_MAX_BYTES:
                                        sz = _dir_size_bytes(tmpd, stop_after=remaining + 1)
                                        if sz > remaining:
                                            _terminate_proc(proc1)
                                            raise RuntimeError('spool_limit_exceeded')
                                        if sz > last_sz:
                                            _progress_set(job, bytes_done=(job.progress.get('bytes_done', 0) or 0) + int(sz - last_sz))
                                            last_sz = sz

                                    time.sleep(0.5)

                                # Drain stderr to avoid leaving pipes open
                                try:
                                    if proc1.stderr:
                                        proc1.stderr.read()
                                except Exception:
                                    pass

                                if proc1.returncode != 0:
                                    raise RuntimeError('mirror_failed')
                            finally:
                                try:
                                    if proc1.stderr:
                                        proc1.stderr.close()
                                except Exception:
                                    pass
                                job._proc = None

                            _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'upload', 'is_dir': True})
                            # Pre-check free space on destination before mirror -R (best-effort).
                            try:
                                need_b = int(last_sz or 0) or _dir_size_bytes(tmpd)
                                if need_b:
                                    _check_remote_free(ds, dpath, int(need_b), label=f"{ds.protocol}://{ds.host}")
                            except RuntimeError:
                                raise
                            except Exception:
                                pass
                            proc2 = _popen_lftp_quiet(ds, [f"mirror -R -- {_lftp_quote(tmpd)} {_lftp_quote(dpath)}"])
                            job._proc = proc2
                            try:
                                while proc2.poll() is None:
                                    if job.cancel_flag.is_set():
                                        _terminate_proc(proc2)
                                        raise RuntimeError('canceled')
                                    time.sleep(0.5)
                                try:
                                    if proc2.stderr:
                                        proc2.stderr.read()
                                except Exception:
                                    pass
                                if proc2.returncode != 0:
                                    raise RuntimeError('mirror_failed')
                            finally:
                                try:
                                    if proc2.stderr:
                                        proc2.stderr.close()
                                except Exception:
                                    pass
                                job._proc = None
                        finally:
                            job._proc = None
                            try:
                                shutil.rmtree(tmpd)
                            except Exception:
                                pass
                        mark_done();

                else:
                    raise RuntimeError('route_not_supported')

                # If move across targets (or across different remote sessions): delete source after copy
                if job.op == 'move' and (src_target != dst_target or (src_target == 'remote' and src.get('sid') != dst.get('sid'))):
                    if src_target == 'local':
                        try:
                            _local_remove_entry(spath, LOCALFS_ROOTS, recursive=True)
                        except Exception:
                            pass
                    else:
                        ss = mgr.get(src['sid'])
                        if ss:
                            mgr._run_lftp(ss, [f"rm -r {_lftp_quote(spath)}"], capture=True)

            _job_set_state(job, 'done')
            job.finished_ts = _now()
            job._proc = None
        except RuntimeError as e:
            if str(e) == 'canceled' or job.cancel_flag.is_set():
                _job_set_state(job, 'canceled', error=None)
            else:
                _job_set_state(job, 'error', error=str(e))
            job.finished_ts = _now()
            try:
                if job._proc is not None:
                    job._proc.terminate()
            except Exception:
                pass
            job._proc = None
        except Exception as e:
            _job_set_state(job, 'error', error='unexpected_error')
            job.finished_ts = _now()
            try:
                if job._proc is not None:
                    job._proc.terminate()
            except Exception:
                pass
            job._proc = None


    def _run_job_delete(job: FileOpJob, spec: Dict[str, Any]) -> None:
        # spec validated at API layer; runs in background.
        _job_set_state(job, 'running')
        job.started_ts = _now()

        src = spec['src']
        sources = spec['sources']
        src_target = src['target']

        _progress_set(job, files_total=len(sources), files_done=0, bytes_done=0, bytes_total=0)

        trash_summary = {'moved': 0, 'permanent': 0, 'trash_full': 0, 'too_large': 0}
        last_trash_stats: Dict[str, Any] | None = None

        def _add_note(msg: str) -> None:
            try:
                notes = job.progress.get('notes') if isinstance(job.progress, dict) else None
                if not isinstance(notes, list):
                    notes = []
                notes.append(str(msg))
                # keep last 50 notes
                notes = notes[-50:]
                _progress_set(job, notes=notes)
            except Exception:
                pass


        def mark_done():
            _progress_set(job, files_done=(job.progress.get('files_done', 0) or 0) + 1)

        try:
            for ent in sources:
                if job.cancel_flag.is_set():
                    raise RuntimeError('canceled')

                spath = ent['path']
                sname = ent.get('name') or ''
                is_dir = bool(ent.get('is_dir'))

                _progress_set(job, current={'path': spath, 'name': sname, 'phase': 'delete', 'is_dir': is_dir})

                if src_target == 'local':
                    # Default behaviour: move to trash (/opt/var/trash) with restore metadata.
                    # When deleting inside the trash directory, we do a hard delete.
                    opts = spec.get('options') or {}
                    hard = bool(opts.get('hard') or opts.get('permanent') or opts.get('force'))
                    try:
                        info = _local_soft_delete(spath, LOCALFS_ROOTS, hard=hard)
                        try:
                            if isinstance(info, dict) and isinstance(info.get('trash'), dict):
                                last_trash_stats = info.get('trash')  # type: ignore
                        except Exception:
                            pass
                        try:
                            mode = str((info or {}).get('mode') or '')
                            reason = str((info or {}).get('reason') or '')
                            if mode == 'trash':
                                trash_summary['moved'] += 1
                            else:
                                trash_summary['permanent'] += 1
                                if reason == 'trash_full':
                                    trash_summary['trash_full'] += 1
                                    _add_note(f"Корзина заполнена — {sname or spath} удалён(о) навсегда")
                                elif reason == 'too_large_for_trash':
                                    trash_summary['too_large'] += 1
                                    _add_note(f"Слишком большой для корзины — {sname or spath} удалён(о) навсегда")
                        except Exception:
                            pass

                    except PermissionError as e:
                        raise RuntimeError(str(e))
                    except Exception as e:
                        # Do not silently ignore delete failures; otherwise UI will show "done"
                        # while the file stays in place.
                        raise RuntimeError(str(e) or 'delete_failed')
                    mark_done();
                else:
                    ss = mgr.get(src['sid'])
                    if not ss:
                        raise RuntimeError('session_not_found')
                    # best-effort remote delete
                    if is_dir:
                        mgr._run_lftp(ss, [f"rm -r {_lftp_quote(spath)}"], capture=True)
                    else:
                        mgr._run_lftp(ss, [f"rm {_lftp_quote(spath)}"], capture=True)
                    mark_done();

            # Attach trash summary (for UI notifications)
            if src_target == 'local':
                notice = None
                try:
                    if trash_summary.get('trash_full', 0):
                        # Trash is full: further deletes will be permanent.
                        pct = None
                        if last_trash_stats and last_trash_stats.get('percent') is not None:
                            pct = last_trash_stats.get('percent')
                        notice = f"Корзина заполнена{f' ({pct}%)' if pct is not None else ''}. Удаляемые файлы будут удаляться сразу — очистите корзину."
                    elif last_trash_stats and last_trash_stats.get('is_near_full'):
                        pct = last_trash_stats.get('percent')
                        notice = f"Корзина почти заполнена{f' ({pct}%)' if pct is not None else ''}. Рекомендуется очистить корзину."
                except Exception:
                    notice = None
                _progress_set(job, trash={'summary': trash_summary, 'stats': last_trash_stats, 'notice': notice})

            _job_set_state(job, 'done')
            job.finished_ts = _now()
            job._proc = None

        except RuntimeError as e:
            if str(e) == 'canceled' or job.cancel_flag.is_set():
                _job_set_state(job, 'canceled', error=None)
            else:
                _job_set_state(job, 'error', error=str(e))
            job.finished_ts = _now()
            try:
                if job._proc is not None:
                    job._proc.terminate()
            except Exception:
                pass
            job._proc = None

        except Exception:
            _job_set_state(job, 'error', error='unexpected_error')
            job.finished_ts = _now()
            try:
                if job._proc is not None:
                    job._proc.terminate()
            except Exception:
                pass
            job._proc = None


    def _normalize_sources(spec: Dict[str, Any]) -> None:
        # Mutates spec: adds spec['sources'] and spec['bytes_total']
        src = spec.get('src') or {}
        dst = spec.get('dst') or {}
        if not isinstance(src, dict) or not isinstance(dst, dict):
            raise RuntimeError('bad_request')
        src_target = str(src.get('target') or '').strip().lower()
        dst_target = str(dst.get('target') or '').strip().lower()
        if src_target not in ('local', 'remote') or dst_target not in ('local', 'remote'):
            raise RuntimeError('bad_target')
        src['target'] = src_target
        dst['target'] = dst_target

        # remote sessions
        if src_target == 'remote':
            sid = str(src.get('sid') or '').strip()
            if not sid:
                raise RuntimeError('sid_required')
            src['sid'] = sid
        if dst_target == 'remote':
            sid = str(dst.get('sid') or '').strip()
            if not sid:
                raise RuntimeError('sid_required')
            dst['sid'] = sid

        # sources list
        sources: List[Dict[str, Any]] = []
        if isinstance(src.get('paths'), list):
            cwd = str(src.get('cwd') or '').strip() or ''
            for n in src.get('paths'):
                nm = str(n or '').strip()
                if not nm:
                    continue
                full = (cwd.rstrip('/') + '/' + nm) if (src_target == 'remote') else os.path.join(cwd or '', nm)
                sources.append({'path': full, 'name': os.path.basename(nm.rstrip('/')) or nm, 'is_dir': nm.endswith('/')})
        else:
            spath = str(src.get('path') or '').strip()
            if not spath:
                raise RuntimeError('path_required')
            sources.append({'path': spath, 'name': os.path.basename(spath.rstrip('/')) or spath, 'is_dir': spath.endswith('/')})

        if not sources:
            raise RuntimeError('no_sources')

        # dst path
        dpath = str(dst.get('path') or '').strip()
        if not dpath:
            raise RuntimeError('path_required')
        dst['path'] = dpath

        # Determine is_dir flags if not explicit
        dst_is_dir_explicit = bool(dst.get('is_dir'))
        dst_is_dir = dst_is_dir_explicit or dpath.endswith('/') or len(sources) > 1

        # If not explicitly a directory destination, but the destination exists and is a directory,
        # treat it as a directory destination (TC-like behavior).
        if not dst_is_dir and not dst_is_dir_explicit:
            try:
                if dst_target == 'local':
                    rp = _ensure_local_path_allowed(dpath)
                    if os.path.isdir(rp):
                        dst_is_dir = True
                else:
                    ds = mgr.get(dst.get('sid'))
                    if not ds:
                        raise RuntimeError('session_not_found')
                    if _remote_is_dir(ds, dpath) is True:
                        dst_is_dir = True
            except PermissionError:
                raise
            except RuntimeError:
                raise
            except Exception:
                pass

        dst['is_dir'] = dst_is_dir

        # Enrich source is_dir where possible
        bytes_total = 0
        if src_target == 'local':
            for ent in sources:
                rp = _ensure_local_path_allowed(ent['path'])
                ent['path'] = rp
                try:
                    st = os.lstat(rp)
                    ent['is_dir'] = os.path.isdir(rp)
                    if os.path.isfile(rp):
                        bytes_total += int(st.st_size or 0)
                except Exception:
                    pass
        else:
            ss = mgr.get(src['sid'])
            if not ss:
                raise RuntimeError('session_not_found')
            for ent in sources:
                rpath = ent['path']
                is_dir = _remote_is_dir(ss, rpath)
                if is_dir is True:
                    ent['is_dir'] = True
                elif is_dir is False:
                    ent['is_dir'] = False
                    sz = _remote_stat_size(ss, rpath)
                    if sz:
                        bytes_total += int(sz)
                # if None: leave as-is

        spec['src'] = src
        spec['dst'] = dst
        spec['sources'] = sources
        spec['bytes_total'] = bytes_total


    def _compute_dst_path_for_entry(dst: Dict[str, Any], dst_target: str, sources: List[Dict[str, Any]], ent: Dict[str, Any]) -> str:
        """Compute destination path for a given source entry.

        Does not create anything; just returns the resolved path string.
        """
        dst_path = str(dst.get('path') or '')
        sname = str(ent.get('name') or '')
        dst_is_dir = bool(dst.get('is_dir'))
        if dst_is_dir or dst_path.endswith('/') or len(sources) > 1:
            if dst_target == 'local':
                ddir = _ensure_local_path_allowed(dst_path)
                return os.path.join(ddir, sname)
            ddir = dst_path.rstrip('/')
            if not ddir:
                ddir = '/'
            return (ddir.rstrip('/') + '/' + sname) if ddir != '/' else ('/' + sname)
        return dst_path


    def _compute_copy_move_conflicts(spec: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Return a list of conflicting entries for copy/move (destination exists)."""
        src = spec.get('src') or {}
        dst = spec.get('dst') or {}
        sources = spec.get('sources') or []
        if not isinstance(src, dict) or not isinstance(dst, dict) or not isinstance(sources, list):
            return []
        src_target = src.get('target')
        dst_target = dst.get('target')

        ds = None
        if dst_target == 'remote':
            ds = mgr.get(dst.get('sid'))

        conflicts: List[Dict[str, Any]] = []
        for ent in sources:
            try:
                dpath = _compute_dst_path_for_entry(dst, dst_target, sources, ent)
            except Exception:
                continue
            exists = False
            try:
                if dst_target == 'local':
                    dp = _ensure_local_path_allowed(dpath)
                    exists = os.path.exists(dp)
                    dpath_resolved = dp
                else:
                    if not ds:
                        raise RuntimeError('session_not_found')
                    exists = bool(_remote_exists(ds, dpath))
                    dpath_resolved = dpath
            except Exception:
                dpath_resolved = dpath
                exists = False

            if exists:
                conflicts.append({
                    'kind': 'exists',
                    'src_path': ent.get('path'),
                    'src_name': ent.get('name'),
                    'dst_path': dpath_resolved,
                    'is_dir': bool(ent.get('is_dir')),
                })
        return conflicts

    def _normalize_delete(spec: Dict[str, Any]) -> None:
        # Mutates spec: adds spec['sources']
        src = spec.get('src') or {}
        if not isinstance(src, dict):
            raise RuntimeError('bad_request')

        src_target = str(src.get('target') or '').strip().lower()
        if src_target not in ('local', 'remote'):
            raise RuntimeError('bad_target')
        src['target'] = src_target

        if src_target == 'remote':
            sid = str(src.get('sid') or '').strip()
            if not sid:
                raise RuntimeError('sid_required')
            src['sid'] = sid

        # sources list
        sources = []
        if isinstance(src.get('paths'), list):
            cwd = str(src.get('cwd') or '').strip() or ''
            for n in src.get('paths'):
                nm = str(n or '').strip()
                if not nm:
                    continue
                full = (cwd.rstrip('/') + '/' + nm) if (src_target == 'remote') else os.path.join(cwd or '', nm)
                sources.append({'path': full, 'name': os.path.basename(nm.rstrip('/')) or nm, 'is_dir': nm.endswith('/')})
        else:
            spath = str(src.get('path') or '').strip()
            if not spath:
                raise RuntimeError('path_required')
            sources.append({'path': spath, 'name': os.path.basename(spath.rstrip('/')) or spath, 'is_dir': spath.endswith('/')})

        if not sources:
            raise RuntimeError('no_sources')

        # Enrich is_dir where possible
        if src_target == 'local':
            for ent in sources:
                rp = _ensure_local_path_allowed(ent['path'])
                ent['path'] = rp
                try:
                    ent['is_dir'] = os.path.isdir(rp)
                except Exception:
                    pass
        else:
            ss = mgr.get(src['sid'])
            if not ss:
                raise RuntimeError('session_not_found')
            for ent in sources:
                rpath = ent['path']
                is_dir = _remote_is_dir(ss, rpath)
                if is_dir is True:
                    ent['is_dir'] = True
                elif is_dir is False:
                    ent['is_dir'] = False

        spec['src'] = src
        spec['sources'] = sources



    @bp.post('/api/fileops/ws-token')
    def api_fileops_ws_token() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        ttl = 60
        try:
            data = request.get_json(silent=True) or {}
            if isinstance(data, dict) and data.get('ttl'):
                ttl = max(10, min(300, int(data.get('ttl'))))
        except Exception:
            ttl = 60
        token = issue_fileops_ws_token(ttl_seconds=ttl)
        return jsonify({'ok': True, 'token': token, 'ttl': ttl})


    @bp.route('/ws/fileops')
    def ws_fileops() -> Any:
        """WebSocket progress stream for fileops jobs.

        query: token=<one-time token>, job_id=<job_id>

        Server messages:
          {type:'init', job:{...}}
          {type:'update', job:{...}}
          {type:'done', job:{...}}
          {type:'error', message:'...'}
        """
        if (resp := _require_enabled()) is not None:
            return resp

        ws = request.environ.get('wsgi.websocket')
        if ws is None:
            return 'Expected WebSocket', 400

        token = (request.args.get('token') or '').strip()
        job_id = (request.args.get('job_id') or '').strip()
        if not token or not job_id:
            try:
                ws.send(json.dumps({'type': 'error', 'message': 'token and job_id are required'}, ensure_ascii=False))
            except Exception:
                pass
            try:
                ws.close()
            except Exception:
                pass
            return ''

        if not validate_fileops_ws_token(token):
            try:
                ws.send(json.dumps({'type': 'error', 'message': 'bad_token'}, ensure_ascii=False))
            except Exception:
                pass
            try:
                ws.close()
            except Exception:
                pass
            return ''

        last_rev = -1
        try:
            while True:
                job = jobmgr.get(job_id)
                if job is None:
                    try:
                        ws.send(json.dumps({'type': 'error', 'message': 'job_not_found'}, ensure_ascii=False))
                    except Exception:
                        pass
                    break

                rev = int(getattr(job, 'rev', 0) or 0)
                if last_rev < 0:
                    last_rev = rev
                    ws.send(json.dumps({'type': 'init', 'job': job.to_dict()}, ensure_ascii=False))
                elif rev != last_rev:
                    last_rev = rev
                    ws.send(json.dumps({'type': 'update', 'job': job.to_dict()}, ensure_ascii=False))

                if job.state in ('done', 'error', 'canceled'):
                    ws.send(json.dumps({'type': 'done', 'job': job.to_dict()}, ensure_ascii=False))
                    break

                _ws_sleep(0.2)
        except Exception:
            # client likely disconnected
            pass
        finally:
            try:
                ws.close()
            except Exception:
                pass
        return ''
    @bp.post('/api/fileops/jobs')
    def api_fileops_create_job() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        data = request.get_json(silent=True) or {}
        op = str(data.get('op') or 'copy').strip().lower()
        if op not in ('copy', 'move', 'delete'):
            return error_response('unsupported_op', 400, ok=False)
        try:
            if op == 'delete':
                _normalize_delete(data)
            else:
                _normalize_sources(data)
        except RuntimeError as e:
            return error_response(str(e), 400, ok=False)
        except Exception:
            return error_response('bad_request', 400, ok=False)

        # Optional dry-run / conflict planning for copy/move
        if op in ('copy', 'move'):
            opts = (data.get('options') or {}) if isinstance(data.get('options'), dict) else {}
            overwrite = str(opts.get('overwrite', 'replace') or 'replace').strip().lower()
            dry_run = bool(opts.get('dry_run'))
            decisions = opts.get('decisions') if isinstance(opts.get('decisions'), dict) else {}
            default_action = str(opts.get('default_action') or opts.get('overwrite_default') or '').strip().lower() or None
            if default_action not in (None, 'replace', 'skip'):
                default_action = None

            conflicts = _compute_copy_move_conflicts(data)
            if dry_run:
                return jsonify({
                    'ok': True,
                    'dry_run': True,
                    'op': op,
                    'src': data.get('src') or {},
                    'dst': data.get('dst') or {},
                    'sources': data.get('sources') or [],
                    'bytes_total': data.get('bytes_total') or 0,
                    'conflicts': conflicts,
                })

            if overwrite == 'ask' and not decisions and not default_action and conflicts:
                return jsonify({'ok': False, 'error': 'conflicts', 'conflicts': conflicts}), 409

        job = jobmgr.create(op)
        # store normalized spec in closure
        if op == 'delete':
            spec = {'src': data['src'], 'sources': data['sources'], 'options': data.get('options') or {}}
            _progress_set(job, files_total=len(spec['sources']))
            jobmgr.submit(job, _run_job_delete, spec)
        else:
            spec = {'src': data['src'], 'dst': data['dst'], 'sources': data['sources'], 'options': data.get('options') or {}, 'bytes_total': data.get('bytes_total') or 0}
            _progress_set(job, bytes_total=spec['bytes_total'], files_total=len(spec['sources']))
            jobmgr.submit(job, _run_job_copy_move, spec)
        try:
            src = data.get('src') or {}
            dst = data.get('dst') or {}
            _core_log(
                "info",
                "fileops.job_create",
                job_id=job.job_id,
                op=op,
                sources=int(len(data.get('sources') or [])),
                bytes_total=int(data.get('bytes_total') or 0),
                src_target=str(src.get('target') or ''),
                src_sid=str(src.get('sid') or ''),
                src_path=str(src.get('path') or ''),
                dst_target=str(dst.get('target') or ''),
                dst_sid=str(dst.get('sid') or ''),
                dst_path=str(dst.get('path') or ''),
            )
        except Exception:
            pass

        return jsonify({'ok': True, 'job_id': job.job_id, 'job': job.to_dict()})


    @bp.get('/api/fileops/jobs')
    def api_fileops_list_jobs() -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        try:
            limit = int(request.args.get('limit', '20') or '20')
        except Exception:
            limit = 20
        limit = max(1, min(100, limit))
        try:
            with jobmgr._lock:
                jobs = list(jobmgr._jobs.values())
        except Exception:
            jobs = []
        jobs.sort(key=lambda j: float(getattr(j, 'created_ts', 0) or 0), reverse=True)
        return jsonify({'ok': True, 'jobs': [j.to_dict() for j in jobs[:limit]]})


    @bp.get('/api/fileops/jobs/<job_id>')
    def api_fileops_get_job(job_id: str) -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        job = jobmgr.get(job_id)
        if not job:
            return error_response('job_not_found', 404, ok=False)
        return jsonify({'ok': True, 'job': job.to_dict()})


    @bp.post('/api/fileops/jobs/clear')
    def api_fileops_clear_jobs() -> Any:
        """Clear finished jobs from the in-memory history.

        This endpoint is optional for the UI: the client can fall back to local hiding
        if it doesn't exist.

        Body: {"scope": "history"|"finished"|"errors"|"all"}
          - history (default): done + error + canceled
          - finished: done + canceled
          - errors: error
          - all: all non-active jobs (done/error/canceled)
        """
        if (resp := _require_enabled()) is not None:
            return resp

        try:
            data = request.get_json(silent=True) or {}
        except Exception:
            data = {}
        scope = str((data or {}).get('scope') or 'history').strip().lower()
        if scope not in ('history', 'finished', 'errors', 'all'):
            scope = 'history'

        def _should_delete(state: str) -> bool:
            st = (state or '').strip().lower()
            if st in ('running', 'queued'):
                return False
            if scope == 'errors':
                return st == 'error'
            if scope == 'finished':
                return st in ('done', 'canceled')
            # history / all
            return st in ('done', 'error', 'canceled')

        deleted = 0
        try:
            with jobmgr._lock:
                to_del = [jid for jid, j in jobmgr._jobs.items() if _should_delete(getattr(j, 'state', '') or '')]
                for jid in to_del:
                    jobmgr._jobs.pop(jid, None)
                    deleted += 1
        except Exception:
            # If something goes wrong, be safe and do nothing.
            deleted = 0
        _core_log("info", "fileops.jobs_clear", deleted=int(deleted), scope=str(scope))
        return jsonify({'ok': True, 'deleted': deleted})


    @bp.post('/api/fileops/jobs/<job_id>/cancel')
    def api_fileops_cancel_job(job_id: str) -> Any:
        if (resp := _require_enabled()) is not None:
            return resp
        ok = jobmgr.cancel(job_id)
        if not ok:
            return error_response('job_not_found', 404, ok=False)
        _core_log("info", "fileops.job_cancel", job_id=job_id)
        return jsonify({'ok': True, 'canceled': True})

    return bp
