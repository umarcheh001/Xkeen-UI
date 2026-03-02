from __future__ import annotations

import os
import time
from typing import Any, Dict, Tuple

from services.fileops.job_models import FileOpJob
from services.fileops.runtime import FileOpsRuntime


def normalize_dirsize(spec: Dict[str, Any], rt: FileOpsRuntime) -> Dict[str, Any]:
    """Normalize deep-size request.

    Accepts either:
      {op:'dirsize', src:{target:'local', path:'...'}}
    or:
      {op:'dirsize', target:'local', path:'...'}

    Returns runner spec:
      {path_abs:str, is_dir:bool}
    """

    src = spec.get('src') if isinstance(spec.get('src'), dict) else {}
    target = str((src.get('target') if src else None) or spec.get('target') or 'local').strip().lower()
    path = str((src.get('path') if src else None) or spec.get('path') or '').strip()

    if target != 'local':
        raise RuntimeError('only_local_supported')
    if not path:
        raise RuntimeError('path_required')

    ensure_follow = rt.ensure_local_follow
    if not callable(ensure_follow):
        raise RuntimeError('local_helpers_missing')
    try:
        rp = ensure_follow(path)
    except PermissionError as e:
        raise RuntimeError(str(e))

    if not os.path.exists(rp):
        raise RuntimeError('not_found')

    return {
        'path_abs': rp,
        'is_dir': bool(os.path.isdir(rp)),
    }


def _scan_dir_size(job: FileOpJob, root: str, *, rt: FileOpsRuntime, max_items: int = 3_000_000) -> Tuple[int, int, bool]:
    """Return (bytes, items_count, truncated) without following symlinks.

    Reports progress as it walks.
    """

    total = 0
    items = 0
    truncated = False
    stack = [root]

    last_report = time.monotonic()

    while stack:
        if job.cancel_flag is not None and job.cancel_flag.is_set():
            raise RuntimeError('canceled')

        d = stack.pop()
        try:
            with os.scandir(d) as it:
                for ent in it:
                    if job.cancel_flag is not None and job.cancel_flag.is_set():
                        raise RuntimeError('canceled')
                    items += 1
                    if items > int(max_items or 0):
                        truncated = True
                        stack.clear()
                        break
                    try:
                        st = ent.stat(follow_symlinks=False)
                    except Exception:
                        continue
                    try:
                        if ent.is_dir(follow_symlinks=False):
                            stack.append(os.path.join(d, ent.name))
                        else:
                            total += int(getattr(st, 'st_size', 0) or 0)
                    except Exception:
                        continue

                    # Throttle UI updates
                    now = time.monotonic()
                    if (now - last_report) >= 0.25:
                        last_report = now
                        rt.progress_set(
                            job,
                            files_done=int(items),
                            bytes_done=int(total),
                            current={'path': os.path.join(d, ent.name), 'name': ent.name, 'phase': 'dirsize', 'is_dir': bool(ent.is_dir(follow_symlinks=False))},
                        )
        except Exception:
            # best-effort: treat inaccessible subtree as truncated
            truncated = True
            continue

    return int(total), int(items), bool(truncated)


def run_job_dirsize(job: FileOpJob, spec: Dict[str, Any], rt: FileOpsRuntime) -> None:
    rt.job_set_state(job, 'running')
    job.started_ts = rt.now_fn()

    path_abs = str(spec.get('path_abs') or '').strip()
    is_dir = bool(spec.get('is_dir'))

    try:
        rt.progress_set(
            job,
            files_total=0,  # unknown upfront
            files_done=0,
            bytes_total=0,
            bytes_done=0,
            current={'path': path_abs, 'name': os.path.basename(path_abs.rstrip('/')) or path_abs, 'phase': 'dirsize', 'is_dir': bool(is_dir)},
        )

        if not os.path.exists(path_abs):
            raise RuntimeError('not_found')

        if not is_dir:
            try:
                sz = int(os.path.getsize(path_abs))
            except Exception:
                sz = 0
            rt.progress_set(
                job,
                files_done=1,
                bytes_done=sz,
                result={'path': path_abs, 'bytes': sz, 'items': 1, 'truncated': False},
            )
            rt.job_set_state(job, 'done')
            job.finished_ts = rt.now_fn()
            return

        bytes_total, items, truncated = _scan_dir_size(job, path_abs, rt=rt)
        rt.progress_set(
            job,
            bytes_done=int(bytes_total),
            files_done=int(items),
            result={'path': path_abs, 'bytes': int(bytes_total), 'items': int(items), 'truncated': bool(truncated)},
        )
        rt.job_set_state(job, 'done')
        job.finished_ts = rt.now_fn()
    except RuntimeError as e:
        if str(e) == 'canceled' or (job.cancel_flag is not None and job.cancel_flag.is_set()):
            rt.job_set_state(job, 'canceled', error=None)
        else:
            rt.job_set_state(job, 'error', error=str(e))
        job.finished_ts = rt.now_fn()
    except Exception:
        rt.job_set_state(job, 'error', error='unexpected_error')
        job.finished_ts = rt.now_fn()
