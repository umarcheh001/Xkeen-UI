from __future__ import annotations

import json
from pathlib import Path

from services.module_update_channel import write_channel
from services.notification_center import NotificationCenter


class FakeLifecycle:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def notification_catalog(self, *, force_refresh=False):
        self.calls.append(bool(force_refresh))
        return dict(self.payload)


def _payload(channel="stable"):
    return {
        "ok": True,
        "channel": channel,
        "source_version": "2.10.0",
        "target_version": "2.11.0",
        "update_available": True,
        "requires_installer": False,
        "min_updater": None,
        "freshness": "fresh",
        "stale_reason": None,
        "fetched_at": 1_000.0,
        "installed_module_ids": ["core", "engine.xray"],
        "current_modules": [
            {
                "id": "engine.xray",
                "version": "2.10.0",
                "requires": ["core"],
                "conflicts": [],
            }
        ],
        "target_modules": [
            {
                "id": "engine.xray",
                "version": "2.11.0",
                "size": 1234,
                "requires": ["core", "tool.editor"],
                "conflicts": [],
                "requires_restart": True,
            },
            {
                "id": "tool.terminal",
                "version": "2.11.0",
                "size": 5678,
                "requires": ["core"],
                "conflicts": [],
                "requires_restart": True,
            },
        ],
        "target_panel": {"size": 9999},
        "baseline_error": None,
    }


def test_notification_center_deduplicates_and_persists_local_state(tmp_path: Path):
    lifecycle = FakeLifecycle(_payload())
    center = NotificationCenter(lifecycle, state_dir=tmp_path, now=lambda: 2_000.0)

    first = center.check(force_refresh=True)
    assert lifecycle.calls == [True]
    assert first["unread_count"] == 3
    kinds = {record["kind"] for record in first["records"]}
    assert kinds == {"panel-update", "module-update", "module-new"}

    record_id = next(record["id"] for record in first["records"] if record["kind"] == "module-update")
    center.set_record_state(record_id, "dismiss")
    second = center.check(force_refresh=False)
    assert lifecycle.calls == [True, False]
    assert second["unread_count"] == 2
    assert record_id not in {record["id"] for record in second["records"]}

    raw = json.loads((tmp_path / "module-notifications.json").read_text(encoding="utf-8"))
    assert raw["schema_version"] == 1
    assert raw["records"][record_id]["dismissed_at"] == 2_000.0


def test_notification_center_keeps_stale_catalog_and_exposes_retry(tmp_path: Path):
    payload = _payload()
    lifecycle = FakeLifecycle(payload)
    now = [2_000.0]
    center = NotificationCenter(lifecycle, state_dir=tmp_path, now=lambda: now[0])
    center.check()

    def unavailable(*, force_refresh=False):
        error = ValueError("offline")
        error.code = "catalog_unavailable"
        raise error

    lifecycle.notification_catalog = unavailable
    now[0] = 3_000.0
    result = center.check(force_refresh=True)
    assert result["status"]["error_code"] == "catalog_unavailable"
    assert any(record["kind"] == "catalog-error" for record in result["records"])
    assert any(record["kind"] == "panel-update" for record in result["records"])


def test_notification_center_channel_state_isolated(tmp_path: Path):
    lifecycle = FakeLifecycle(_payload())
    center = NotificationCenter(lifecycle, state_dir=tmp_path, now=lambda: 2_000.0)
    center.check()
    write_channel(tmp_path, "prerelease")
    lifecycle.payload = _payload("prerelease")

    result = center.snapshot()
    assert result["channel"] == "prerelease"
    assert result["records"] == []
    assert result["unread_count"] == 0

    result = center.check()
    assert result["channel"] == "prerelease"
    assert result["unread_count"] == 3


def test_records_of_an_older_panel_vanish_and_poll_right_after_update(tmp_path: Path):
    version = ["2.10.0"]
    lifecycle = FakeLifecycle(_payload())
    center = NotificationCenter(lifecycle, state_dir=tmp_path, now=lambda: 2_000.0, panel_version=lambda: version[0])
    assert center.check(background=True)["unread_count"] == 3

    # The panel was updated to the advertised release and restarted ten
    # minutes later, long before the daily background gate opens again.
    version[0] = "2.11.0"
    lifecycle.payload = {
        **_payload(),
        "source_version": "2.11.0",
        "update_available": False,
        "current_modules": [],
        "target_modules": [],
    }
    restarted = NotificationCenter(
        lifecycle, state_dir=tmp_path, now=lambda: 2_600.0, panel_version=lambda: version[0]
    )
    before_poll = restarted.snapshot()
    assert before_poll["records"] == []
    assert before_poll["unread_count"] == 0

    after_poll = restarted.check(background=True)
    assert lifecycle.calls == [False, False]
    assert after_poll["records"] == []


def test_unchanged_panel_version_keeps_the_daily_gate(tmp_path: Path):
    lifecycle = FakeLifecycle(_payload())
    center = NotificationCenter(lifecycle, state_dir=tmp_path, now=lambda: 2_000.0, panel_version=lambda: "2.10.0")
    center.check(background=True)
    result = center.check(background=True)
    assert lifecycle.calls == [False]
    assert result["unread_count"] == 3


def test_baseline_failure_does_not_announce_modules_as_new(tmp_path: Path):
    payload = {**_payload(), "current_modules": [], "baseline_error": "catalog_unavailable"}
    center = NotificationCenter(FakeLifecycle(payload), state_dir=tmp_path, now=lambda: 2_000.0)

    result = center.check()
    kinds = sorted(record["kind"] for record in result["records"])
    assert kinds == ["catalog-baseline", "panel-update"]


def test_installed_module_is_never_announced_as_new(tmp_path: Path):
    payload = _payload()
    payload["installed_module_ids"] = ["core", "engine.xray", "tool.terminal"]
    center = NotificationCenter(FakeLifecycle(payload), state_dir=tmp_path, now=lambda: 2_000.0)

    result = center.check()
    assert not any(
        record["kind"] == "module-new" and record.get("module_id") == "tool.terminal"
        for record in result["records"]
    )


def test_offline_after_update_falls_back_to_the_daily_gate(tmp_path: Path):
    version = ["2.10.0"]
    now = [2_000.0]
    lifecycle = FakeLifecycle(_payload())
    center = NotificationCenter(lifecycle, state_dir=tmp_path, now=lambda: now[0], panel_version=lambda: version[0])
    center.check(background=True)

    def unavailable(*, force_refresh=False):
        lifecycle.calls.append(bool(force_refresh))
        error = ValueError("offline")
        error.code = "catalog_unavailable"
        raise error

    version[0] = "2.11.0"
    lifecycle.notification_catalog = unavailable
    now[0] = 2_600.0
    center.check(background=True)  # right after the update
    for minutes in (10, 16, 60, 77, 120, 300, 600):
        now[0] = 2_600.0 + minutes * 60
        center.check(background=True)
    # Two short retries (15 min, then an hour), then the failure waits a day:
    # never an hourly retry for the rest of the day.
    assert lifecycle.calls == [False, False, False, False]


def _offline(lifecycle, code="catalog_unavailable"):
    def unavailable(*, force_refresh=False):
        lifecycle.calls.append(bool(force_refresh))
        error = ValueError("offline")
        error.code = code
        raise error

    return unavailable


def test_a_dismissed_outage_is_forgotten_once_the_catalog_answers(tmp_path: Path):
    now = [2_000.0]
    lifecycle = FakeLifecycle(_payload())
    center = NotificationCenter(lifecycle, state_dir=tmp_path, now=lambda: now[0])
    healthy = lifecycle.notification_catalog

    lifecycle.notification_catalog = _offline(lifecycle)
    error_id = next(r["id"] for r in center.check()["records"] if r["kind"] == "catalog-error")
    center.set_record_state(error_id, "dismiss")
    # Still the same outage: the dismissal holds.
    assert not any(r["kind"] == "catalog-error" for r in center.check()["records"])

    lifecycle.notification_catalog = healthy
    center.check()
    now[0] += 30 * 24 * 60 * 60
    lifecycle.notification_catalog = _offline(lifecycle)
    assert any(r["kind"] == "catalog-error" for r in center.check()["records"])


def test_a_dismissed_baseline_note_stays_dismissed_while_it_lasts(tmp_path: Path):
    payload = {**_payload(), "current_modules": [], "baseline_error": "catalog_unavailable"}
    center = NotificationCenter(FakeLifecycle(payload), state_dir=tmp_path, now=lambda: 2_000.0)
    note = next(r["id"] for r in center.check()["records"] if r["kind"] == "catalog-baseline")
    center.set_record_state(note, "dismiss")
    assert note not in {r["id"] for r in center.check()["records"]}


def test_dismissals_of_another_channel_survive_retention(tmp_path: Path):
    now = [2_000.0]
    lifecycle = FakeLifecycle(_payload("prerelease"))
    write_channel(tmp_path, "prerelease")
    center = NotificationCenter(lifecycle, state_dir=tmp_path, now=lambda: now[0])
    panel = next(r["id"] for r in center.check()["records"] if r["kind"] == "panel-update")
    center.set_record_state(panel, "dismiss")

    write_channel(tmp_path, "stable")
    lifecycle.payload = _payload("stable")
    now[0] += 91 * 24 * 60 * 60
    center.check()

    write_channel(tmp_path, "prerelease")
    lifecycle.payload = _payload("prerelease")
    assert panel not in {r["id"] for r in center.check()["records"]}


def test_manual_check_during_a_background_poll_returns_its_result(tmp_path: Path):
    import threading

    started = threading.Event()
    release = threading.Event()
    lifecycle = FakeLifecycle(_payload())
    healthy = lifecycle.notification_catalog

    def slow(*, force_refresh=False):
        started.set()
        release.wait(5)
        return healthy(force_refresh=force_refresh)

    lifecycle.notification_catalog = slow
    center = NotificationCenter(lifecycle, state_dir=tmp_path, now=lambda: 2_000.0)
    worker = threading.Thread(target=lambda: center.check(background=True))
    worker.start()
    assert started.wait(5)
    threading.Timer(0.2, release.set).start()

    result = center.check(force_refresh=True)
    worker.join(5)
    # The manual check waited for the running poll instead of showing the
    # state from before it, and did not ask the catalog a second time.
    assert result["unread_count"] == 3
    assert lifecycle.calls == [False]


def test_unsettled_profile_is_not_called_a_network_failure(tmp_path: Path):
    lifecycle = FakeLifecycle(_payload())
    lifecycle.notification_catalog = _offline(lifecycle, "profile_transition_required")
    center = NotificationCenter(lifecycle, state_dir=tmp_path, now=lambda: 2_000.0)
    record = next(r for r in center.check()["records"] if r["kind"] == "catalog-error")
    assert "набор модулей" in record["message"]
    assert "связаться" not in record["message"]


def test_failed_background_polls_retry_soon_then_back_off_from_a_day_to_a_week(tmp_path: Path):
    now = [2_000.0]
    lifecycle = FakeLifecycle(_payload())
    lifecycle.notification_catalog = _offline(lifecycle)
    center = NotificationCenter(lifecycle, state_dir=tmp_path, now=lambda: now[0])
    day = 24 * 60 * 60
    delays = []
    for _ in range(7):
        status = center.check(background=True)["status"]
        delays.append(status["next_poll_at"] - now[0])
        now[0] = status["next_poll_at"] - 1
        center.check(background=True)  # not due yet: no request
        now[0] += 1
    # A router that has just booted meets the network a few minutes later.
    assert delays == [15 * 60, 60 * 60, day, 2 * day, 4 * day, 7 * day, 7 * day]
    assert len(lifecycle.calls) == 7


def test_a_snoozed_note_comes_back_unread_and_the_page_knows_when(tmp_path: Path):
    now = [2_000.0]
    center = NotificationCenter(FakeLifecycle(_payload()), state_dir=tmp_path, now=lambda: now[0])
    snapshot = center.check(force_refresh=True)
    record_id = snapshot["records"][0]["id"]
    center.mark_seen()
    assert center.snapshot()["unread_count"] == 0

    snapshot = center.set_record_state(record_id, "snooze", snooze_seconds=24 * 60 * 60)
    assert record_id not in {record["id"] for record in snapshot["records"]}
    assert snapshot["status"]["snooze_wake_in_s"] == 24 * 60 * 60

    now[0] += 24 * 60 * 60 + 1
    snapshot = center.snapshot()
    back = next(record for record in snapshot["records"] if record["id"] == record_id)
    assert back["seen"] is False
    assert snapshot["unread_count"] == 1
    assert snapshot["status"]["snooze_wake_in_s"] is None


def test_notification_state_is_kept_by_the_installer():
    from services.module_profile_plan import user_owned

    assert user_owned("module-notifications.json")


# --- Обновление модуля внутри установленного выпуска --------------------------


def _module_update_payload(channel="stable"):
    payload = _payload(channel)
    payload.update(
        target_version="2.10.0",
        update_available=False,
        current_modules=[],
        target_modules=[],
        module_updates=[{"module_id": "engine.xray", "version": "1.1.0", "installed_version": "1.0.0"}],
    )
    return payload


def test_module_update_available_is_one_record_with_module_and_version(tmp_path: Path):
    lifecycle = FakeLifecycle(_module_update_payload())
    versions = {"engine.xray": "1.0.0"}
    center = NotificationCenter(
        lifecycle, state_dir=tmp_path, now=lambda: 2_000.0, module_versions=lambda: dict(versions)
    )

    first = center.check(force_refresh=True)
    second = center.check(force_refresh=True)

    records = [record for record in second["records"] if record["kind"] == "module_update_available"]
    assert len(records) == 1
    assert (records[0]["module_id"], records[0]["version"]) == ("engine.xray", "1.1.0")
    assert records[0]["id"] == next(r["id"] for r in first["records"] if r["kind"] == "module_update_available")
    assert "Happ" not in json.dumps(records[0], ensure_ascii=False)
    center.mark_seen()
    assert center.check(force_refresh=True)["unread_count"] == 0


def test_module_update_record_is_the_same_on_either_channel(tmp_path: Path):
    lifecycle = FakeLifecycle(_module_update_payload())
    center = NotificationCenter(lifecycle, state_dir=tmp_path, now=lambda: 2_000.0, module_versions=lambda: {"engine.xray": "1.0.0"})
    stable = center.check()
    center.mark_seen()
    write_channel(tmp_path, "prerelease")
    lifecycle.payload = _module_update_payload("prerelease")

    prerelease = center.check()

    assert [r["id"] for r in prerelease["records"]] == [r["id"] for r in stable["records"]]
    # Seen once is seen: the bell does not count it again on the other channel.
    assert prerelease["unread_count"] == 0


def test_module_update_record_goes_away_once_the_module_is_updated(tmp_path: Path):
    lifecycle = FakeLifecycle(_module_update_payload())
    versions = {"engine.xray": "1.0.0"}
    center = NotificationCenter(
        lifecycle, state_dir=tmp_path, now=lambda: 2_000.0, module_versions=lambda: dict(versions)
    )
    assert center.check()["unread_count"] == 1

    versions["engine.xray"] = "1.1.0"

    # Before the next check of the catalog the record no longer applies.
    snapshot = center.snapshot()
    assert snapshot["records"] == []
    assert snapshot["unread_count"] == 0


def test_module_update_record_follows_what_the_router_has_installed(tmp_path: Path):
    from tests.support.module_lifecycle import make_service
    from tests.support.module_tx import make_panel, make_release, publish_module_updates

    panel = make_panel(tmp_path)
    release = make_release()
    publish_module_updates(release, {"engine.xray": "1.1.0"})
    service, _catalog = make_service(panel, release)
    center = NotificationCenter(service, state_dir=panel.state, now=lambda: 2_000.0)

    checked = center.check(force_refresh=True)
    assert [(r["kind"], r["module_id"], r["version"]) for r in checked["records"]] == [
        ("module_update_available", "engine.xray", "1.1.0"),
    ]

    # The update is laid: the runner records the module's new version.
    record = json.loads(panel.path("module-installed.json").read_text(encoding="utf-8"))
    record["versions"] = {"engine.xray": "1.1.0"}
    panel.path("module-installed.json").write_text(json.dumps(record), encoding="utf-8")

    assert center.snapshot()["records"] == []
