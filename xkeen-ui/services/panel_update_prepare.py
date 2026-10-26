"""Preparing a panel update in the background, so its window can show the way.

The plan of a panel update downloads the whole release archive and checks it:
half a minute on a router, and nothing to see for the owner while it lasts.
Here that work runs apart from the request. The window starts it, asks how it
goes and takes the plan when it is ready. One preparation at a time: a second
start while one runs joins it, so a closed window or another tab finds the
same download instead of beginning one more.
"""

from __future__ import annotations

import secrets
import threading
import time
from typing import Any, Callable

from services.module_lifecycle import ModuleLifecycleError


_FAILED = {"code": "panel_prepare_failed", "message": "panel update could not be prepared"}


class PanelPrepareCancelled(Exception):
    """Raised from the progress of a preparation the owner cancelled."""


def _spawn_thread(target: Callable[[], None]) -> None:
    threading.Thread(target=target, daemon=True, name="panel-update-prepare").start()


class PanelUpdatePreparer:
    def __init__(
        self,
        service: Any,
        *,
        clock: Callable[[], float] = time.time,
        spawn: Callable[[Callable[[], None]], None] | None = None,
    ) -> None:
        self._service = service
        self._clock = clock
        self._spawn = spawn or _spawn_thread
        self._guard = threading.Lock()
        self._job: dict[str, Any] | None = None
        self._cancel_requested = False

    def current_id(self) -> str | None:
        with self._guard:
            return None if self._job is None else self._job["prepare_id"]

    def start(self) -> dict[str, Any]:
        with self._guard:
            if self._job is not None and self._job["state"] == "running":
                # Asked for again after «Отмена»: the owner wants it after all.
                self._cancel_requested = False
                return dict(self._job)
            job = {
                "prepare_id": secrets.token_urlsafe(12),
                "state": "running",
                "phase": "catalog",
                "downloaded_bytes": 0,
                "total_bytes": 0,
                "cached": False,
                "started_at": self._clock(),
                "finished_at": None,
                "plan": None,
                "error": None,
            }
            self._job = job
            self._cancel_requested = False
            prepare_id = job["prepare_id"]
            started = dict(job)
        try:
            self._spawn(lambda: self._run(prepare_id))
        except BaseException:
            # A job nobody runs must not be joined by every next start.
            self._finish(prepare_id, state="failed", error=_FAILED)
            raise
        with self._guard:
            # A quick runner may be done already; a newer job is not this answer.
            if self._job is not None and self._job["prepare_id"] == prepare_id:
                return dict(self._job)
        return started

    def status(self, prepare_id: str) -> dict[str, Any]:
        with self._guard:
            return dict(self._own(prepare_id))

    def cancel(self, prepare_id: str) -> dict[str, Any]:
        with self._guard:
            job = self._own(prepare_id)
            if job["state"] == "running":
                self._cancel_requested = True
            return dict(job)

    def _own(self, prepare_id: str) -> dict[str, Any]:
        if self._job is None or self._job["prepare_id"] != str(prepare_id):
            raise ModuleLifecycleError(
                "panel_prepare_unknown",
                "panel update preparation is not known",
                status=404,
            )
        return self._job

    def _heard(self, prepare_id: str, phase: str, done: int, total: int) -> None:
        with self._guard:
            job = self._job
            if job is None or job["prepare_id"] != prepare_id:
                return
            if self._cancel_requested:
                raise PanelPrepareCancelled()
            job["phase"] = "downloading" if phase == "cached" else phase
            if phase == "cached":
                job["cached"] = True
            elif phase == "downloading":
                # A kept copy that failed its check is downloaded again.
                job["cached"] = False
            if total:
                job["total_bytes"] = int(total)
                job["downloaded_bytes"] = int(done)

    def _finish(self, prepare_id: str, **fields: Any) -> None:
        with self._guard:
            job = self._job
            if job is None or job["prepare_id"] != prepare_id or job["state"] != "running":
                return
            job.update(fields, finished_at=self._clock())

    def _run(self, prepare_id: str) -> None:
        try:
            self._prepare(prepare_id)
        finally:
            # A runner killed on the way (GreenletExit and the like) still
            # ends its job: a job left running would be joined forever.
            self._finish(prepare_id, state="failed", error=_FAILED)

    def _prepare(self, prepare_id: str) -> None:
        def heard(phase: str, done: int, total: int) -> None:
            self._heard(prepare_id, phase, done, total)

        try:
            plan = self._service.plan("panel-update", None, progress=heard)
        except PanelPrepareCancelled:
            with self._guard:
                job = self._job or {}
                downloading = job.get("phase") == "downloading" and not job.get("cached")
            # What was half downloaded is gone with the incoming folder, and the
            # cache holds nothing of this release then. A whole archive, kept or
            # just downloaded, stays for the next time.
            if downloading:
                self._service._drop_archive_cache()
            self._finish(prepare_id, state="cancelled")
        except ModuleLifecycleError as error:
            self._finish(prepare_id, state="failed", error={**error.details, "code": error.code, "message": str(error)})
        except Exception:  # noqa: BLE001 - the window must hear an end in any case
            try:
                from services.logging_setup import core_logger

                core_logger().exception("panel update preparation failed")
            except Exception:  # noqa: BLE001 - logging must not hide the result
                pass
            self._finish(prepare_id, state="failed", error=_FAILED)
        else:
            with self._guard:
                cancelled = self._cancel_requested
            # Cancelled while the archive was checked: the check is not stopped
            # halfway, but its plan is not offered either.
            if cancelled:
                self._finish(prepare_id, state="cancelled")
            else:
                self._finish(prepare_id, state="ready", plan=plan)
