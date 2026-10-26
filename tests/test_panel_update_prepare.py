from __future__ import annotations

import pytest

from services.module_catalog_client import CatalogClientError
from services.module_lifecycle import ModuleLifecycleError
from services.panel_update_prepare import PanelUpdatePreparer
from tests.support.module_lifecycle import make_service
from tests.support.module_tx import make_panel, make_release


def _run_now(target):
    target()


def _updatable(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0")
    return make_service(panel, make_release(version="2.11.0"))


class PhaseLog:
    """Records the phases the service reports while the preparer listens."""

    def __init__(self, service):
        self.phases: list[str] = []
        original = service.plan

        def plan(operation, module_id=None, *, progress=None):
            def heard(phase, done, total):
                self.phases.append(phase)
                if progress is not None:
                    progress(phase, done, total)

            return original(operation, module_id, progress=heard)

        service.plan = plan


def test_prepare_reports_phases_and_returns_the_plan(tmp_path):
    service, _ = _updatable(tmp_path)
    log = PhaseLog(service)
    preparer = PanelUpdatePreparer(service, spawn=_run_now)

    snapshot = preparer.start()

    assert snapshot["state"] == "ready"
    assert snapshot["plan"]["target_version"] == "2.11.0"
    assert snapshot["plan"]["applicable"] is True
    assert log.phases[0] == "catalog"
    assert "downloading" in log.phases
    assert log.phases[-1] == "verifying"
    assert snapshot["downloaded_bytes"] == snapshot["total_bytes"] > 0
    assert snapshot["cached"] is False
    assert snapshot["error"] is None
    assert snapshot["finished_at"] >= snapshot["started_at"]


def test_prepare_with_cached_archive_skips_download(tmp_path):
    service, _ = _updatable(tmp_path)
    preparer = PanelUpdatePreparer(service, spawn=_run_now)
    preparer.start()
    log = PhaseLog(service)

    snapshot = preparer.start()

    assert snapshot["state"] == "ready"
    assert snapshot["cached"] is True
    assert "downloading" not in log.phases
    assert "cached" in log.phases


def test_cancel_during_download_drops_partial_archive(tmp_path):
    service, catalog = _updatable(tmp_path)
    preparer = PanelUpdatePreparer(service, spawn=_run_now)
    real_download = catalog.download_verified_panel_archive

    def download(snapshot, destination, **kwargs):
        progress = kwargs["progress"]

        def cancelling(written):
            preparer.cancel(preparer.current_id())
            progress(written)

        return real_download(snapshot, destination, progress=cancelling)

    catalog.download_verified_panel_archive = download

    snapshot = preparer.start()

    assert snapshot["state"] == "cancelled"
    assert snapshot["plan"] is None
    cache = service.archive_cache_dir
    assert not cache.exists() or list(cache.iterdir()) == []


def test_start_joins_running_job(tmp_path):
    service, _ = _updatable(tmp_path)
    spawned = []
    preparer = PanelUpdatePreparer(service, spawn=spawned.append)

    first = preparer.start()
    second = preparer.start()

    assert first["prepare_id"] == second["prepare_id"]
    assert second["state"] == "running"
    assert len(spawned) == 1


def test_start_after_cancel_takes_the_cancel_back(tmp_path):
    service, _ = _updatable(tmp_path)
    spawned = []
    preparer = PanelUpdatePreparer(service, spawn=spawned.append)
    first = preparer.start()
    preparer.cancel(first["prepare_id"])

    again = preparer.start()
    spawned[0]()

    assert again["prepare_id"] == first["prepare_id"]
    assert preparer.status(first["prepare_id"])["state"] == "ready"


def test_a_job_whose_runner_dies_does_not_stay_running(tmp_path):
    service, _ = _updatable(tmp_path)

    class Killed(BaseException):
        pass

    def killed(*_args, **_kwargs):
        raise Killed()

    service.plan = killed
    spawned = []
    preparer = PanelUpdatePreparer(service, spawn=spawned.append)
    first = preparer.start()

    with pytest.raises(Killed):
        spawned[0]()

    assert preparer.status(first["prepare_id"])["state"] == "failed"
    assert preparer.start()["prepare_id"] != first["prepare_id"]


def test_a_runner_that_does_not_start_leaves_no_running_job(tmp_path):
    service, _ = _updatable(tmp_path)

    def refused(_target):
        raise RuntimeError("no thread")

    preparer = PanelUpdatePreparer(service, spawn=refused)

    with pytest.raises(RuntimeError):
        preparer.start()

    assert preparer.status(preparer.current_id())["state"] == "failed"


def test_finished_job_is_followed_by_a_new_one(tmp_path):
    service, _ = _updatable(tmp_path)
    preparer = PanelUpdatePreparer(service, spawn=_run_now)

    first = preparer.start()
    second = preparer.start()

    assert first["prepare_id"] != second["prepare_id"]


def test_prepare_failure_keeps_lifecycle_error_code(tmp_path):
    service, catalog = _updatable(tmp_path)

    def broken(*_args, **_kwargs):
        raise CatalogClientError("catalog_archive_unavailable", "module archive could not be downloaded")

    catalog.download_verified_panel_archive = broken
    preparer = PanelUpdatePreparer(service, spawn=_run_now)

    snapshot = preparer.start()

    assert snapshot["state"] == "failed"
    assert snapshot["phase"] == "downloading"
    assert snapshot["error"]["code"] == "panel_update_unavailable"
    assert snapshot["plan"] is None


def test_unexpected_failure_has_a_generic_code(tmp_path):
    service, _ = _updatable(tmp_path)

    def broken(*_args, **_kwargs):
        raise RuntimeError("boom")

    service.plan = broken
    preparer = PanelUpdatePreparer(service, spawn=_run_now)

    snapshot = preparer.start()

    assert snapshot["state"] == "failed"
    assert snapshot["error"]["code"] == "panel_prepare_failed"


def test_status_of_unknown_prepare_is_404(tmp_path):
    service, _ = _updatable(tmp_path)
    preparer = PanelUpdatePreparer(service, spawn=_run_now)

    with pytest.raises(ModuleLifecycleError) as raised:
        preparer.status("nope")

    assert raised.value.status == 404
    assert raised.value.code == "panel_prepare_unknown"


def test_cancel_of_finished_job_changes_nothing(tmp_path):
    service, _ = _updatable(tmp_path)
    preparer = PanelUpdatePreparer(service, spawn=_run_now)
    done = preparer.start()

    snapshot = preparer.cancel(done["prepare_id"])

    assert snapshot["state"] == "ready"
    assert snapshot["plan"] == done["plan"]


def test_current_panel_is_ready_with_blocker_plan(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0")
    service, _ = make_service(panel, make_release(version="2.10.0"))
    preparer = PanelUpdatePreparer(service, spawn=_run_now)

    snapshot = preparer.start()

    assert snapshot["state"] == "ready"
    assert snapshot["plan"]["blockers"][0]["code"] == "panel_version_current"
