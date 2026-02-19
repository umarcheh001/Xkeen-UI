"""FileOps in-memory manager.

Public API stays compatible with the original monolithic implementation:
- create(op) -> FileOpJob
- get(job_id) -> FileOpJob|None
- submit(job, runner, spec) -> None
- cancel(job_id) -> bool

Internals are split into queue/workers helpers.
"""

from __future__ import annotations

import queue as _queue
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Tuple

from .job_models import FileOpJob
from .queue import cleanup_dead_jobs, oldest_finished_first
from .workers import worker_loop


def _now() -> float:
    return time.time()


def _gen_id(prefix: str = 'job') -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class FileOpJobManager:
    """In-memory job registry + worker queue."""

    def __init__(
        self,
        *,
        max_jobs: int = 100,
        ttl_seconds: int = 3600,
        workers: int = 1,
        now_fn: Callable[[], float] | None = None,
        gen_id_fn: Callable[[str], str] | None = None,
    ) -> None:
        self.max_jobs = int(max_jobs or 100)
        self.ttl_seconds = int(ttl_seconds or 3600)
        self.workers = max(1, min(4, int(workers or 1)))

        self._now = now_fn or _now
        self._gen_id = gen_id_fn or _gen_id

        self._lock = threading.Lock()
        self._jobs: Dict[str, FileOpJob] = {}

        self._queue: '_queue.Queue[Tuple[str, Any, Any]]' = _queue.Queue()
        self._workers_started = False
        self._workers: List[threading.Thread] = []

    @staticmethod
    def bump(job: FileOpJob) -> None:
        try:
            job.rev = int(getattr(job, 'rev', 0) or 0) + 1
        except Exception:
            pass

    def cleanup(self) -> None:
        now = self._now()
        with self._lock:
            for jid in cleanup_dead_jobs(self._jobs, ttl_seconds=self.ttl_seconds, now=now):
                self._jobs.pop(jid, None)

    def create(self, op: str) -> FileOpJob:
        self.cleanup()
        with self._lock:
            if len(self._jobs) >= self.max_jobs:
                # Drop oldest finished jobs first.
                finished = oldest_finished_first(self._jobs)
                for jid, _ in finished[: max(1, len(self._jobs) - self.max_jobs + 1)]:
                    self._jobs.pop(jid, None)

            jid = self._gen_id('job')
            job = FileOpJob(
                job_id=jid,
                op=op,
                created_ts=self._now(),
                progress={
                    'files_done': 0,
                    'files_total': 0,
                    'bytes_done': 0,
                    'bytes_total': 0,
                    'current': None,
                },
                cancel_flag=threading.Event(),
            )
            self._jobs[jid] = job
            self.bump(job)
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
                t = threading.Thread(
                    target=worker_loop,
                    args=(self, self._queue),
                    name=f'fileops-worker-{i}',
                    daemon=True,
                )
                t.start()
                self._workers.append(t)

    def submit(self, job: FileOpJob, runner: Any, spec: Any) -> None:
        self._start_workers()
        try:
            job.state = 'queued'
            self.bump(job)
        except Exception:
            pass
        self._queue.put((job.job_id, runner, spec))

    def cancel(self, jid: str) -> bool:
        job = self.get(jid)
        if not job:
            return False

        try:
            if job.cancel_flag is not None:
                job.cancel_flag.set()
        except Exception:
            pass

        # If queued, mark immediately
        if job.state == 'queued':
            job.error = None
            job.state = 'canceled'
            job.finished_ts = self._now()
            self.bump(job)
            return True

        try:
            if job._proc is not None and job.state == 'running':
                job._proc.terminate()
        except Exception:
            pass

        self.bump(job)
        return True


__all__ = ['FileOpJobManager']
