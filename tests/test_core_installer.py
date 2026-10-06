from __future__ import annotations

import hashlib
import importlib
import io
import json
import time
import zipfile

import pytest


profiles = importlib.import_module("services.core_profiles")
installer_module = importlib.import_module("services.core_installer")
state_module = importlib.import_module("services.core_profile_state")


def _xray_archive(payload: bytes) -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("xray", payload)
    return stream.getvalue()


def _release_for(payload: bytes, *, checksum: str | None = None) -> dict:
    archive = _xray_archive(payload)
    return {
        "stable": {"tag": "v26.3.27", "url": "https://example.test/release", "published_at": "2026-09-30T00:00:00Z"},
        "asset": {"name": "Xray-linux-64.zip", "url": "https://example.test/xray.zip"},
        "checksum": {"sha256": checksum or hashlib.sha256(archive).hexdigest(), "name": "Xray-linux-64.zip.dgst"},
        "binary_name": "xray",
        "platform": {"machine": "x86_64", "opkg_arch": "x86_64", "endianness": "le"},
        "installable": True,
        "reason": "",
        "stale": False,
        "fetched_at": time.time(),
    }


def _wait_for_terminal(installer, operation_id: str) -> dict:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        operation = installer.status("xray", operation_id)
        if operation["status"] in {"succeeded", "failed", "rolled_back"}:
            return operation
        time.sleep(0.01)
    raise AssertionError("installation operation did not finish")


def _installer(
    tmp_path,
    *,
    payload: bytes = b"new-xray",
    release: dict | None = None,
    preflight=(0, "ok"),
    running="xray",
    running_after_restart: str | None = None,
):
    target = tmp_path / "xray"
    target.write_bytes(b"old-xray")
    archive = _xray_archive(payload)
    store = state_module.CoreProfileStateStore(str(tmp_path / "state"))
    active = {"core": running}

    def restart(*_args, **_kwargs):
        if running_after_restart is not None:
            active["core"] = running_after_restart
        return True

    install = installer_module.CoreInstaller(
        state_store=store,
        binary_paths={"xray": str(target), "mihomo": str(tmp_path / "mihomo")},
        xray_configs_dir=str(tmp_path / "xray-configs"),
        mihomo_config_file=str(tmp_path / "mihomo.yaml"),
        restart=restart,
        running_core=lambda: active["core"],
        release_resolver=lambda *_args, **_kwargs: release or _release_for(payload),
        downloader=lambda *_args, **_kwargs: archive,
        run_command=lambda *_args, **_kwargs: preflight,
        health_timeout_s=0.1,
        latest_tag_resolver=lambda *_args, **_kwargs: None,
    )
    return install, store, target


def test_selected_profile_and_installed_profile_are_persisted_separately(tmp_path):
    store = state_module.CoreProfileStateStore(str(tmp_path / "state"))
    store.set_selected("mihomo", "mihomo-enhanced")
    store.set_installed("mihomo", profile_id="official", release_tag="v1.19.0", asset_name="mihomo-linux-amd64.gz")

    value = state_module.CoreProfileStateStore(str(tmp_path / "state")).get("mihomo")
    assert value["selected_profile_id"] == "mihomo-enhanced"
    assert value["installed_profile_id"] == "official"
    assert value["installed_release_tag"] == "v1.19.0"


def test_legacy_runtime_state_backfills_progress_contract(tmp_path):
    state_dir = tmp_path / "state"
    state_dir.mkdir(parents=True)
    state_path = state_dir / "core-profiles" / "state.json"
    state_path.parent.mkdir()
    state_path.write_text(
        json.dumps({"version": 1, "xray": {}, "mihomo": {"last_status": "succeeded", "last_phase": "complete"}}),
        encoding="utf-8",
    )

    value = state_module.CoreProfileStateStore(str(state_dir)).get("mihomo")

    assert value["last_progress"] == 100
    assert value["last_phase_label"] == "Установка завершена"


def test_apply_replaces_verified_binary_and_marks_installed(tmp_path):
    install, store, target = _installer(tmp_path)
    prepared = install.prepare("xray")
    accepted = install.apply("xray", prepared["confirmation_id"])
    operation = _wait_for_terminal(install, accepted["operation_id"])

    assert operation["status"] == "succeeded"
    assert operation["progress"] == 100
    assert operation["phase_label"] == "Установка завершена"
    assert target.read_bytes() == b"new-xray"
    assert store.get("xray")["selected_profile_id"] == "official"
    assert store.get("xray")["installed_profile_id"] == "official"
    assert store.get("xray")["installed_release_tag"] == "v26.3.27"
    persisted = store.get("xray")
    assert persisted["last_operation_id"] == accepted["operation_id"]
    assert persisted["last_progress"] == 100
    assert persisted["last_phase_label"] == "Установка завершена"


def test_confirmation_is_single_use_and_profile_status_reads_binary_version(tmp_path):
    install, _store, _target = _installer(tmp_path)
    install.run_command = lambda command, **_kwargs: (0, "Xray 26.3.27") if "-version" in command else (0, "ok")
    prepared = install.prepare("xray")
    install.apply("xray", prepared["confirmation_id"])

    with pytest.raises(installer_module.CoreInstallError) as exc_info:
        install.apply("xray", prepared["confirmation_id"])

    assert exc_info.value.code == "confirmation_expired"
    assert install.profiles("xray")["state"]["detected_version"] == "26.3.27"


def test_resolved_release_metadata_is_cached_per_profile_and_architecture(tmp_path):
    calls = []
    release = _release_for(b"new-xray")
    install, _store, _target = _installer(tmp_path, release=release)
    install.release_resolver = lambda *args, **kwargs: calls.append(args[0].profile_id) or release

    install.profiles("xray")
    install.profiles("xray")

    assert calls == ["official", "uwuray", "gfw-knocker", "jolymmiles", "patterniha"]


def test_github_outage_uses_expired_verified_release_cache(tmp_path):
    release = _release_for(b"new-xray")
    install, store, _target = _installer(tmp_path, release=release)
    cache_key = f"xray:official:{install.platform.machine}:{install.platform.opkg_arch}:{install.platform.endianness}"
    store.set_release_cache(cache_key, release)
    cache_path = tmp_path / "state" / "core-profiles" / "release-cache.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    cache[cache_key]["fetched_at"] = time.time() - 24 * 3600
    cache_path.write_text(json.dumps(cache), encoding="utf-8")
    install.release_resolver = lambda *_args, **_kwargs: {
        "installable": False,
        "reason": "github_unavailable",
        "stable": None,
        "asset": None,
        "checksum": None,
    }

    value = install.profiles("xray")
    official = next(item for item in value["profiles"] if item["profile_id"] == "official")

    assert official["release"]["installable"] is True
    assert official["release"]["stale"] is True
    prepared = install.prepare("xray")
    assert prepared["release"]["installable"] is True
    assert prepared["release"]["stale"] is True


def test_expired_release_cache_refreshes_when_github_is_available(tmp_path):
    cached_release = _release_for(b"cached-xray")
    fresh_release = {**_release_for(b"new-xray"), "stable": {**cached_release["stable"], "tag": "v26.3.28"}}
    install, store, _target = _installer(tmp_path, release=cached_release)
    cache_key = f"xray:official:{install.platform.machine}:{install.platform.opkg_arch}:{install.platform.endianness}"
    store.set_release_cache(cache_key, cached_release)
    cache_path = tmp_path / "state" / "core-profiles" / "release-cache.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    cache[cache_key]["fetched_at"] = time.time() - 24 * 3600
    cache_path.write_text(json.dumps(cache), encoding="utf-8")
    install.release_resolver = lambda *_args, **_kwargs: fresh_release

    value = install.profiles("xray")
    official = next(item for item in value["profiles"] if item["profile_id"] == "official")

    assert official["release"]["stable"]["tag"] == "v26.3.28"
    assert official["release"]["stale"] is False


def test_bad_checksum_never_replaces_binary_or_creates_rollback_state(tmp_path):
    install, store, target = _installer(tmp_path, release=_release_for(b"new-xray", checksum="0" * 64))
    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])

    assert operation["status"] == "failed"
    assert operation["phase"] == "verify"
    assert operation["progress"] == 28
    assert operation["phase_label"] == "Проверка контрольной суммы"
    assert target.read_bytes() == b"old-xray"
    assert store.get("xray")["installed_profile_id"] is None


def test_failed_preflight_restores_binary_and_prior_state(tmp_path):
    install, store, target = _installer(tmp_path, preflight=(1, "invalid config"))
    store.set_installed("xray", profile_id="official", release_tag="v26.3.26", asset_name="Xray-linux-64.zip")
    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])

    assert operation["status"] == "rolled_back"
    assert operation["phase"] == "rolled_back"
    assert target.read_bytes() == b"old-xray"
    assert store.get("xray")["installed_release_tag"] == "v26.3.26"
    assert (tmp_path / "state" / "core-profiles" / "backups" / operation["operation_id"] / "state.json").is_file()
    assert "invalid config" not in operation["error"]


def test_failed_healthcheck_restores_binary_and_prior_state(tmp_path):
    install, store, target = _installer(tmp_path, running_after_restart="mihomo")
    store.set_installed("xray", profile_id="official", release_tag="v26.3.26", asset_name="Xray-linux-64.zip")
    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])

    assert operation["status"] == "rolled_back"
    assert target.read_bytes() == b"old-xray"
    assert store.get("xray")["installed_release_tag"] == "v26.3.26"


def test_active_core_change_before_replacement_leaves_binary_untouched(tmp_path):
    install, _store, target = _installer(tmp_path)
    active = {"core": "xray"}
    archive = _xray_archive(b"new-xray")
    install.running_core = lambda: active["core"]

    def switch_core_while_downloading(*_args, **_kwargs):
        active["core"] = "mihomo"
        return archive

    install.downloader = switch_core_while_downloading
    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])

    assert operation["status"] == "failed"
    assert target.read_bytes() == b"old-xray"


def test_healthcheck_observes_the_restarted_core_for_the_full_window(tmp_path):
    install, _store, target = _installer(tmp_path)
    state = {"restarted": False, "checks_after_restart": 0}

    def running_core():
        if not state["restarted"]:
            return "xray"
        state["checks_after_restart"] += 1
        return "xray" if state["checks_after_restart"] == 1 else None

    def restart(*_args, **_kwargs):
        state["restarted"] = True
        return True

    install.running_core = running_core
    install.restart = restart
    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])

    assert operation["status"] == "rolled_back"
    assert target.read_bytes() == b"old-xray"


def test_healthcheck_tolerates_a_transient_process_gap_after_restart(tmp_path):
    install, _store, target = _installer(tmp_path)
    state = {"restarted": False, "checks_after_restart": 0}

    def running_core():
        if not state["restarted"]:
            return "xray"
        state["checks_after_restart"] += 1
        return "xray" if state["checks_after_restart"] >= 3 else None

    def restart(*_args, **_kwargs):
        state["restarted"] = True
        return True

    install.running_core = running_core
    install.restart = restart
    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])

    assert operation["status"] == "succeeded"
    assert target.read_bytes() == b"new-xray"


def test_rollback_preserves_source_selection_for_other_engine(tmp_path):
    install, store, _target = _installer(tmp_path, preflight=(1, "invalid config"))

    def fail_preflight(*_args, **_kwargs):
        store.set_selected("mihomo", "mihomo-enhanced")
        return 1, "invalid config"

    install.run_command = fail_preflight
    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])

    assert operation["status"] == "rolled_back"
    assert store.get("mihomo")["selected_profile_id"] == "mihomo-enhanced"


def test_status_rejects_unknown_operation_id(tmp_path):
    install, _store, _target = _installer(tmp_path)

    with pytest.raises(installer_module.CoreInstallError) as exc_info:
        install.status("xray", "not-an-operation")

    assert exc_info.value.code == "operation_not_found"


def test_prepare_rejects_inactive_core(tmp_path):
    install, _store, _target = _installer(tmp_path, running="mihomo")

    with pytest.raises(installer_module.CoreInstallError) as exc_info:
        install.prepare("xray")

    assert exc_info.value.code == "inactive_core"


def _age_release_cache(tmp_path, seconds: float) -> None:
    cache_path = tmp_path / "state" / "core-profiles" / "release-cache.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    for entry in cache.values():
        entry["fetched_at"] = time.time() - seconds
    cache_path.write_text(json.dumps(cache), encoding="utf-8")


def test_release_metadata_an_hour_old_is_served_without_asking_github(tmp_path):
    calls = []
    release = _release_for(b"new-xray")
    install, _store, _target = _installer(tmp_path, release=release)
    install.release_resolver = lambda *args, **kwargs: calls.append(args[0].profile_id) or release
    install.profiles("xray")
    _age_release_cache(tmp_path, 3600)
    calls.clear()

    install.profiles("xray")

    assert calls == []


def test_release_that_cannot_be_installed_is_not_requested_again_on_every_page_load(tmp_path):
    calls = []
    missing = {"installable": False, "reason": "asset_missing", "stable": None, "asset": None, "checksum": None}
    install, _store, _target = _installer(tmp_path)
    install.release_resolver = lambda *args, **kwargs: calls.append(args[0].profile_id) or dict(missing)

    install.profiles("xray")
    first = install.profiles("xray")

    assert len(calls) == 5
    assert first["profiles"][0]["release"]["reason"] == "asset_missing"


def test_release_that_cannot_be_installed_is_checked_again_after_a_short_while(tmp_path):
    calls = []
    missing = {"installable": False, "reason": "asset_missing", "stable": None, "asset": None, "checksum": None}
    install, _store, _target = _installer(tmp_path)
    install.release_resolver = lambda *args, **kwargs: calls.append(args[0].profile_id) or dict(missing)
    install.profiles("xray")
    _age_release_cache(tmp_path, 3600)
    calls.clear()

    install.profiles("xray")

    assert len(calls) == 5


def test_github_outage_result_is_never_stored(tmp_path):
    calls = []
    outage = {"installable": False, "reason": "github_unavailable", "stable": None, "asset": None, "checksum": None}
    install, _store, _target = _installer(tmp_path)
    install.release_resolver = lambda *args, **kwargs: calls.append(args[0].profile_id) or dict(outage)

    install.profiles("xray")
    install.profiles("xray")

    assert len(calls) == 10


def test_expired_stable_release_is_confirmed_by_tag_without_the_api(tmp_path):
    calls = []
    tag_checks = []
    release = _release_for(b"new-xray")
    install, _store, _target = _installer(tmp_path, release=release)
    install.release_resolver = lambda *args, **kwargs: calls.append(args[0].profile_id) or release
    install.latest_tag_resolver = lambda repo, **_kwargs: tag_checks.append(repo) or "v26.3.27"
    install.profiles("xray")
    _age_release_cache(tmp_path, 24 * 3600)
    calls.clear()

    value = install.profiles("xray")
    install.profiles("xray")

    assert calls == []
    assert tag_checks == [
        "XTLS/Xray-core",
        "MakostaDev/UwuRay",
        "GFW-knocker/Xray-core",
        "Jolymmiles/Xray-core",
        "patterniha/Xray-core",
    ]
    assert value["profiles"][0]["release"]["stale"] is False


def test_expired_stable_release_is_fetched_again_when_the_tag_has_moved(tmp_path):
    calls = []
    release = _release_for(b"new-xray")
    install, _store, _target = _installer(tmp_path, release=release)
    install.release_resolver = lambda *args, **kwargs: calls.append(args[0].profile_id) or release
    install.latest_tag_resolver = lambda repo, **_kwargs: "v26.4.0" if repo == "XTLS/Xray-core" else "v26.3.27"
    install.profiles("xray")
    _age_release_cache(tmp_path, 24 * 3600)
    calls.clear()

    install.profiles("xray")

    assert calls == ["official"]


def test_prerelease_sources_are_not_confirmed_by_the_stable_tag(tmp_path):
    calls = []
    tag_checks = []
    release = {**_release_for(b"new-mihomo"), "binary_name": "mihomo"}
    install, _store, _target = _installer(tmp_path, release=release)
    install.release_resolver = lambda *args, **kwargs: calls.append(args[0].profile_id) or release
    install.latest_tag_resolver = lambda repo, **_kwargs: tag_checks.append(repo) or "v26.3.27"
    install.profiles("mihomo")
    _age_release_cache(tmp_path, 24 * 3600)
    calls.clear()

    install.profiles("mihomo")

    prerelease_ids = [item.profile_id for item in profiles.list_profiles("mihomo") if item.release_policy == "prerelease_allowed"]
    prerelease_repos = [item.repo for item in profiles.list_profiles("mihomo") if item.release_policy == "prerelease_allowed"]
    assert prerelease_ids and calls == prerelease_ids
    assert not set(tag_checks) & set(prerelease_repos)
