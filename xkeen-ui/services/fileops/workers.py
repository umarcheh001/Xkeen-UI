"""Worker loop for FileOps.

Kept separate so we can unit-test job state transitions without Flask.
"""

from __future__ import annotations

from typing import Any


def worker_loop(jobmgr: Any, task_queue: Any) -> None:
    """Consume (job_id, runner, spec) tasks forever."""
    while True:
        jid, runner, spec = task_queue.get()
        job = jobmgr.get(jid)
        if not job:
            try:
                task_queue.task_done()
            except Exception:
                pass
            continue

        # If job was canceled while queued, complete it quickly.
        try:
            cancel_flag = getattr(job, 'cancel_flag', None)
            if cancel_flag is not None and cancel_flag.is_set():
                job.state = 'canceled'
                job.error = None
                job.finished_ts = jobmgr._now()
                jobmgr.bump(job)
                try:
                    task_queue.task_done()
                except Exception:
                    pass
                continue
        except Exception:
            pass

        try:
            runner(job, spec)
        except Exception:
            try:
                if job.state not in ('done', 'error', 'canceled'):
                    job.state = 'error'
                    job.error = 'worker_error'
                    job.finished_ts = jobmgr._now()
                    jobmgr.bump(job)
            except Exception:
                pass
        finally:
            try:
                task_queue.task_done()
            except Exception:
                pass


__all__ = ['worker_loop']
