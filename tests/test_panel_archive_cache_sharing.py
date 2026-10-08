"""Проверка обновлений не мешает тому, кто уже качает или держит архив панели.

Проверку зовёт каждая страница панели при загрузке и по таймеру. Раньше она
первым делом стирала каталог с архивом: скачивание, идущее в соседнем запросе,
теряло свой файл, а архив уже показанного плана приходилось качать заново.
"""

from __future__ import annotations

import os
import threading
import time

from services.module_lifecycle import ARCHIVE_CACHE_KEEP_S
from tests.support.module_lifecycle import LaunchRecorder, make_service
from tests.support.module_tx import make_panel, make_release


def _panel_downloads(release) -> int:
    return release.transport.calls.count(release.panel_url)


def _files(service) -> list[str]:
    cache = service.archive_cache_dir
    return sorted(path.name for path in cache.iterdir()) if cache.is_dir() else []


def _stand(tmp_path, **overrides):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    release = make_release(version="2.11.0")
    service, _ = make_service(panel, release, **overrides)
    return service, release


def test_a_check_keeps_the_archive_of_a_plan_that_was_just_shown(tmp_path):
    service, release = _stand(tmp_path, launch_operation=LaunchRecorder())
    reviewed = service.plan("panel-update", None)

    service.panel_update_check()
    service.apply("panel-update", None, reviewed["plan_id"])

    assert _panel_downloads(release) == 1


def test_a_check_clears_an_archive_nobody_came_for(tmp_path):
    service, _release = _stand(tmp_path)
    service.plan("panel-update", None)
    (kept,) = [service.archive_cache_dir / name for name in _files(service)]
    old = time.time() - ARCHIVE_CACHE_KEEP_S - 60
    os.utime(kept, (old, old))

    service.panel_update_check()

    assert _files(service) == []


def test_a_check_clears_the_archive_of_another_release(tmp_path):
    service, _release = _stand(tmp_path)
    cache = service.archive_cache_dir
    cache.mkdir(parents=True)
    (cache / ("0" * 64 + ".tar.gz")).write_bytes(b"previous release")
    (cache / "incoming-1-deadbeef").mkdir()
    old = time.time() - ARCHIVE_CACHE_KEEP_S - 60
    os.utime(cache / "incoming-1-deadbeef", (old, old))

    service.panel_update_check()

    assert _files(service) == []


def test_a_check_during_a_download_does_not_take_the_file_away(tmp_path):
    service, release = _stand(tmp_path)
    started, proceed = threading.Event(), threading.Event()
    stream = release.transport.stream_to

    def slow(url, output, **kwargs):
        if url == release.panel_url:
            started.set()
            assert proceed.wait(10)
        return stream(url, output, **kwargs)

    release.transport.stream_to = slow
    outcome: dict = {}

    def plan() -> None:
        try:
            outcome["plan"] = service.plan("panel-update", None)
        except Exception as error:  # noqa: BLE001 - показать причину в тесте
            outcome["error"] = error

    worker = threading.Thread(target=plan)
    worker.start()
    assert started.wait(10)
    in_flight = _files(service)

    service.panel_update_check()

    assert _files(service) == in_flight != []
    proceed.set()
    worker.join(10)
    assert outcome.get("error") is None
    assert outcome["plan"]["applicable"] is True


def test_two_plans_at_once_download_the_archive_once(tmp_path):
    service, release = _stand(tmp_path)
    started, proceed = threading.Event(), threading.Event()
    stream = release.transport.stream_to

    def slow(url, output, **kwargs):
        if url == release.panel_url:
            started.set()
            assert proceed.wait(10)
        return stream(url, output, **kwargs)

    release.transport.stream_to = slow
    plans: list = []
    first = threading.Thread(target=lambda: plans.append(service.plan("panel-update", None)))
    first.start()
    assert started.wait(10)
    second = threading.Thread(target=lambda: plans.append(service.plan("panel-update", None)))
    second.start()
    time.sleep(0.2)
    proceed.set()
    first.join(10)
    second.join(10)

    assert [plan["applicable"] for plan in plans] == [True, True]
    assert plans[0]["plan_id"] == plans[1]["plan_id"]
    assert _panel_downloads(release) == 1


def test_a_refused_plan_does_not_take_the_archive_from_a_plan_in_flight(tmp_path):
    service, release = _stand(tmp_path)
    started, proceed = threading.Event(), threading.Event()
    stream = release.transport.stream_to

    def slow(url, output, **kwargs):
        if url == release.panel_url:
            started.set()
            assert proceed.wait(10)
        return stream(url, output, **kwargs)

    release.transport.stream_to = slow
    outcome: dict = {}
    worker = threading.Thread(target=lambda: outcome.update(plan=service.plan("panel-update", None)))
    worker.start()
    assert started.wait(10)

    # То, что делает любой отклонённый план или apply в соседнем запросе.
    service._drop_archive_cache()

    proceed.set()
    worker.join(10)
    assert outcome["plan"]["applicable"] is True
    assert _panel_downloads(release) == 1
