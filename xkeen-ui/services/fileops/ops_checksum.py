from __future__ import annotations

import hashlib
import os
from typing import Any, Dict, Tuple

from services.fileops.job_models import FileOpJob
from services.fileops.runtime import FileOpsRuntime


CHUNK_BYTES = 256 * 1024


def normalize_checksum(spec: Dict[str, Any], rt: FileOpsRuntime) -> Dict[str, Any]:
    """Validate + normalize checksum request.

    Accepts either:
      {op:'checksum', src:{target, path, sid?}}
    or legacy-style:
      {op:'checksum', target, path, sid?}

    Returns runner spec:
      {src:{target, path, sid?}, size_total:int|0}
    """

    src = spec.get('src') if isinstance(spec.get('src'), dict) else {}
    target = str((src.get('target') if src else None) or spec.get('target') or '').strip().lower()
    path = str((src.get('path') if src else None) or spec.get('path') or '').strip()
    sid = str((src.get('sid') if src else None) or spec.get('sid') or '').strip()

    if target not in ('local', 'remote'):
        raise RuntimeError('bad_target')
    if not path:
        raise RuntimeError('path_required')

    size_total = 0

    if target == 'local':
        ensure_follow = rt.ensure_local_follow
        if not callable(ensure_follow):
            raise RuntimeError('local_helpers_missing')
        try:
            rp = ensure_follow(path)
        except PermissionError as e:
            raise RuntimeError(str(e))
        if os.path.isdir(rp):
            raise RuntimeError('not_a_file')
        if not os.path.isfile(rp):
            raise RuntimeError('not_found')
        try:
            size_total = int(os.path.getsize(rp))
        except Exception:
            size_total = 0
        return {
            'src': {'target': 'local', 'path': rp},
            'size_total': size_total,
        }

    # remote
    if not sid:
        raise RuntimeError('sid_required')
    ds = None
    try:
        ds = rt.mgr.get(sid)
    except Exception:
        ds = None
    if not ds:
        raise RuntimeError('session_not_found')

    try:
        sz = rt.remote_stat_size(ds, path)
        if sz is not None:
            size_total = int(sz)
    except Exception:
        size_total = 0

    return {
        'src': {'target': 'remote', 'sid': sid, 'path': path},
        'size_total': size_total,
    }


def _hash_stream(job: FileOpJob, fp: Any, *, rt: FileOpsRuntime, size_total: int = 0) -> Tuple[str, str, int]:
    md5 = hashlib.md5()
    sha = hashlib.sha256()
    done = 0
    last_report = 0

    while True:
        if job.cancel_flag is not None and job.cancel_flag.is_set():
            raise RuntimeError('canceled')
        chunk = fp.read(CHUNK_BYTES)
        if not chunk:
            break
        md5.update(chunk)
        sha.update(chunk)
        done += len(chunk)
        # Throttle progress updates
        if done - last_report >= 512 * 1024:
            last_report = done
            rt.progress_set(job, bytes_done=done, bytes_total=int(size_total or 0))

    return md5.hexdigest(), sha.hexdigest(), done


def run_job_checksum(job: FileOpJob, spec: Dict[str, Any], rt: FileOpsRuntime) -> None:
    rt.job_set_state(job, 'running')
    job.started_ts = rt.now_fn()

    src = spec.get('src') or {}
    target = str(src.get('target') or '').strip().lower()
    path = str(src.get('path') or '').strip()
    sid = str(src.get('sid') or '').strip()
    size_total = 0
    try:
        size_total = int(spec.get('size_total') or 0)
    except Exception:
        size_total = 0

    try:
        rt.progress_set(
            job,
            files_total=1,
            files_done=0,
            bytes_total=int(size_total or 0),
            bytes_done=0,
            current={'path': path, 'name': os.path.basename(path.rstrip('/')) or path, 'phase': 'checksum', 'is_dir': False},
        )

        if target == 'local':
            with open(path, 'rb') as fp:
                md5_hex, sha_hex, done = _hash_stream(job, fp, rt=rt, size_total=size_total)
            rt.progress_set(
                job,
                files_done=1,
                bytes_done=int(done),
                bytes_total=int(size_total or done),
                result={'target': 'local', 'path': path, 'size': int(size_total or done), 'md5': md5_hex, 'sha256': sha_hex},
            )
            rt.job_set_state(job, 'done')
            job.finished_ts = rt.now_fn()
            return

        # remote checksum via lftp cat
        ds = rt.mgr.get(sid)
        if not ds:
            raise RuntimeError('session_not_found')

        proc = None
        md5_hex = ''
        sha_hex = ''
        done = 0
        try:
            # Prefer remotefs manager API to keep protocol details consistent.
            proc = rt.mgr._popen_lftp(ds, [f"cat {rt.lftp_quote(path)}"])  # type: ignore[attr-defined]
            job._proc = proc
            if proc.stdout is None:
                raise RuntimeError('no_stdout')
            md5_hex, sha_hex, done = _hash_stream(job, proc.stdout, rt=rt, size_total=size_total)
            try:
                rc = proc.wait(timeout=5)
            except Exception:
                rc = None
            if rc is not None and int(rc) != 0:
                raise RuntimeError('read_failed')
        finally:
            try:
                if proc and proc.stdout:
                    proc.stdout.close()
            except Exception:
                pass
            try:
                if proc and proc.stderr:
                    proc.stderr.close()
            except Exception:
                pass
            job._proc = None

        rt.progress_set(
            job,
            files_done=1,
            bytes_done=int(done),
            bytes_total=int(size_total or done),
            result={'target': 'remote', 'sid': sid, 'path': path, 'size': int(size_total or done), 'md5': md5_hex, 'sha256': sha_hex},
        )
        rt.job_set_state(job, 'done')
        job.finished_ts = rt.now_fn()
    except RuntimeError as e:
        if str(e) == 'canceled' or (job.cancel_flag is not None and job.cancel_flag.is_set()):
            rt.job_set_state(job, 'canceled', error=None)
        else:
            rt.job_set_state(job, 'error', error=str(e))
        job.finished_ts = rt.now_fn()
        try:
            if job._proc is not None:
                job._proc.terminate()
        except Exception:
            pass
        job._proc = None
    except Exception:
        rt.job_set_state(job, 'error', error='unexpected_error')
        job.finished_ts = rt.now_fn()
        try:
            if job._proc is not None:
                job._proc.terminate()
        except Exception:
            pass
        job._proc = None
