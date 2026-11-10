from __future__ import annotations

import hashlib
import gzip
import importlib
import io
import json
import time
import threading
import zipfile

import pytest


profiles = importlib.import_module("services.core_profiles")
installer_module = importlib.import_module("services.core_installer")
state_module = importlib.import_module("services.core_profile_state")


@pytest.mark.parametrize("header,total", [("8", 8), (None, 0), ("invalid", 0)])
def test_core_download_reports_chunks_and_optional_total(monkeypatch, header, total):
    class Response:
        headers = {} if header is None else {"Content-Length": header}
        def __enter__(self): return self
        def __exit__(self, *_args): pass
        def read(self, size):
            assert size > 0
            return chunks.pop(0)

    chunks = [b"abc", b"defgh", b""]
    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: Response())
    seen = []
    result = installer_module.CoreInstaller._download("https://example.test/core", timeout_s=2, on_progress=lambda done, size: seen.append((done, size)))
    assert result == b"abcdefgh"
    assert seen == [(3, total), (8, total)]


def test_core_install_status_exposes_live_download_bytes(tmp_path, monkeypatch):
    install, _store, _target = _installer(tmp_path)
    payload = _xray_archive(b"new-xray")
    first_read = threading.Event()
    continue_download = threading.Event()

    class Response:
        headers = {"Content-Length": str(len(payload))}
        def __enter__(self): return self
        def __exit__(self, *_args): pass
        def read(self, _size):
            if not first_read.is_set():
                first_read.set()
                return payload[:10]
            assert continue_download.wait(3)
            result = payload[10:]
            self.read = lambda _size: b""
            return result

    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: Response())
    install.downloader = install._download
    prepared = install.prepare("xray")
    operation_id = install.apply("xray", prepared["confirmation_id"])["operation_id"]
    try:
        assert first_read.wait(3)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            operation = install.status("xray", operation_id)
            if operation.get("downloaded_bytes") == 10:
                break
            time.sleep(0.01)
        assert operation["downloaded_bytes"] == 10
        assert operation["total_bytes"] == len(payload)
        assert 8 <= operation["progress"] < 28
    finally:
        continue_download.set()
    assert _wait_for_terminal(install, operation_id)["status"] == "succeeded"


def test_core_download_propagates_stream_errors(monkeypatch):
    class Response:
        headers = {"Content-Length": "8"}
        def __enter__(self): return self
        def __exit__(self, *_args): pass
        def read(self, _size): raise OSError("connection lost")

    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: Response())
    with pytest.raises(OSError, match="connection lost"):
        installer_module.CoreInstaller._download("https://example.test/core", timeout_s=2, on_progress=lambda *_args: None)


def _xray_archive(payload: bytes) -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        # Дата закреплена: архив и его контрольную сумму тесты строят двумя
        # отдельными вызовами, а zip вписывает текущее время с шагом в две
        # секунды — на границе шага сумма переставала совпадать.
        archive.writestr(zipfile.ZipInfo("xray", date_time=(2026, 1, 1, 0, 0, 0)), payload)
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


def test_successful_install_removes_its_temporary_backup(tmp_path):
    install, store, _target = _installer(tmp_path)
    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])
    assert operation["status"] == "succeeded"
    assert not (tmp_path / "state" / "core-profiles" / "backups" / operation["operation_id"]).exists()


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

    assert calls == ["official", "official-prerelease", "uwuray", "gfw-knocker", "jolymmiles", "patterniha"]


def test_prepare_reuses_verified_release_metadata_already_shown_to_the_user(tmp_path):
    calls = []
    release = _release_for(b"new-xray")
    install, _store, _target = _installer(tmp_path, release=release)
    install.release_resolver = lambda *args, **kwargs: calls.append(args[0].profile_id) or release

    install.profiles("xray")
    calls.clear()
    prepared = install.prepare("xray")

    assert calls == []
    assert prepared["release"]["checksum"]["sha256"] == release["checksum"]["sha256"]


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


def test_reinstall_inactive_core_keeps_running_core_untouched(tmp_path):
    install, store, target = _installer(tmp_path, running="mihomo")
    restarts = []
    commands = []
    install.restart = lambda *_args, **_kwargs: restarts.append(True)
    install.run_command = lambda command, **_kwargs: (commands.append(command) or (0, "Xray 26.3.27"))

    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])

    assert operation["status"] == "succeeded"
    assert target.read_bytes() == b"new-xray"
    assert store.get("xray")["installed_release_tag"] == "v26.3.27"
    assert restarts == []
    assert any("version" in command for command in commands)


def test_inactive_reinstall_rejects_invalid_binary_without_replacing_it(tmp_path):
    install, _store, target = _installer(tmp_path, running="mihomo", preflight=(1, "invalid"))
    restarts = []
    install.restart = lambda *_args, **_kwargs: restarts.append(True)
    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])

    assert operation["status"] == "failed"
    assert target.read_bytes() == b"old-xray"
    assert restarts == []


def test_inactive_reinstall_refuses_switch_during_validation(tmp_path):
    install, _store, target = _installer(tmp_path, running="mihomo")
    active = {"core": "mihomo"}
    install.running_core = lambda: active["core"]
    restarts = []
    install.restart = lambda *_args, **_kwargs: restarts.append(True)
    def validate(_command, **_kwargs):
        active["core"] = "xray"
        return 0, "Xray 26.3.27"
    prepared = install.prepare("xray")
    install.run_command = validate
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])

    assert operation["status"] == "failed"
    assert target.read_bytes() == b"old-xray"
    assert restarts == []


def test_first_install_keeps_other_core_running_without_restart(tmp_path):
    install, store, target = _installer(tmp_path, running="mihomo")
    target.unlink()
    restarts = []
    install.restart = lambda *_args, **_kwargs: restarts.append(True)

    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])

    assert operation["status"] == "succeeded"
    assert target.read_bytes() == b"new-xray"
    assert store.get("xray")["installed_release_tag"] == "v26.3.27"
    assert restarts == []


@pytest.mark.parametrize("engine", ["xray", "mihomo"])
def test_first_install_validates_temporary_file_before_publication(tmp_path, engine):
    install, _store, xray_target = _installer(tmp_path, running="mihomo" if engine == "xray" else "xray")
    if engine == "xray":
        xray_target.unlink()
        target = xray_target
    else:
        target = tmp_path / "mihomo"
        payload = gzip.compress(b"new-mihomo", mtime=0)
        release = _release_for(b"unused")
        release["asset"] = {"name": "mihomo-linux-amd64.gz", "url": "https://example.test/mihomo.gz"}
        release["checksum"]["sha256"] = hashlib.sha256(payload).hexdigest()
        install.release_resolver = lambda *_args, **_kwargs: release
        install.downloader = lambda *_args, **_kwargs: payload
    observed = []
    def validate(command, **_kwargs):
        observed.append((target.exists(), command[0] != str(target)))
        return 1, "bad binary"
    install.run_command = validate
    prepared = install.prepare(engine)
    operation_id = install.apply(engine, prepared["confirmation_id"])["operation_id"]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        operation = install.status(engine, operation_id)
        if operation["status"] in {"succeeded", "failed", "rolled_back"}:
            break
        time.sleep(.01)
    assert observed == [(False, True)]
    assert operation["status"] == "failed"
    assert not target.exists()


@pytest.mark.parametrize("engine", ["xray", "mihomo"])
def test_first_install_keeps_published_file_if_saving_state_fails(tmp_path, monkeypatch, engine):
    install, store, target = _installer(tmp_path, running="mihomo" if engine == "xray" else "xray")
    if engine == "xray":
        target.unlink()
        expected = b"new-xray"
    else:
        target = tmp_path / "mihomo"
        expected = b"new-mihomo"
        payload = gzip.compress(expected, mtime=0)
        release = _release_for(b"unused")
        release["asset"] = {"name": "mihomo-linux-amd64.gz", "url": "https://example.test/mihomo.gz"}
        release["checksum"]["sha256"] = hashlib.sha256(payload).hexdigest()
        install.release_resolver = lambda *_args, **_kwargs: release
        install.downloader = lambda *_args, **_kwargs: payload
    monkeypatch.setattr(store, "set_installed", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("disk error")))
    prepared = install.prepare(engine)
    operation_id = install.apply(engine, prepared["confirmation_id"])["operation_id"]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        operation = install.status(engine, operation_id)
        if operation["status"] in {"succeeded", "failed", "rolled_back"}:
            break
        time.sleep(.01)
    assert operation["status"] == "failed"
    assert target.read_bytes() == expected


def test_first_install_never_deletes_file_replaced_after_publication(tmp_path, monkeypatch):
    install, store, target = _installer(tmp_path, running="mihomo")
    target.unlink()
    def replace_and_fail(*_args, **_kwargs):
        replacement = tmp_path / "external"
        replacement.write_bytes(b"external")
        replacement.replace(target)
        raise OSError("disk error")
    monkeypatch.setattr(store, "set_installed", replace_and_fail)
    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])
    assert operation["status"] == "failed"
    assert target.read_bytes() == b"external"


def test_first_install_mihomo_keeps_xray_running(tmp_path):
    install, store, _target = _installer(tmp_path, running="xray")
    payload = gzip.compress(b"new-mihomo", mtime=0)
    release = _release_for(b"unused")
    release["asset"] = {"name": "mihomo-linux-amd64.gz", "url": "https://example.test/mihomo.gz"}
    release["checksum"]["sha256"] = hashlib.sha256(payload).hexdigest()
    release["binary_name"] = "mihomo"
    install.release_resolver = lambda *_args, **_kwargs: release
    install.downloader = lambda *_args, **_kwargs: payload
    restarts = []
    install.restart = lambda *_args, **_kwargs: restarts.append(True)
    prepared = install.prepare("mihomo")
    operation_id = install.apply("mihomo", prepared["confirmation_id"])["operation_id"]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        operation = install.status("mihomo", operation_id)
        if operation["status"] in {"succeeded", "failed", "rolled_back"}:
            break
        time.sleep(.01)
    assert operation["status"] == "succeeded"
    assert (tmp_path / "mihomo").read_bytes() == b"new-mihomo"
    assert store.get("mihomo")["installed_profile_id"] == "official"
    assert restarts == []


def test_reinstall_inactive_mihomo_keeps_xray_running(tmp_path):
    install, store, _target = _installer(tmp_path, running="xray")
    target = tmp_path / "mihomo"
    target.write_bytes(b"old-mihomo")
    payload = gzip.compress(b"new-mihomo", mtime=0)
    release = _release_for(b"unused")
    release["asset"] = {"name": "mihomo-linux-amd64.gz", "url": "https://example.test/mihomo.gz"}
    release["checksum"]["sha256"] = hashlib.sha256(payload).hexdigest()
    release["binary_name"] = "mihomo"
    install.release_resolver = lambda *_args, **_kwargs: release
    install.downloader = lambda *_args, **_kwargs: payload
    restarts = []
    install.restart = lambda *_args, **_kwargs: restarts.append(True)
    prepared = install.prepare("mihomo")
    operation_id = install.apply("mihomo", prepared["confirmation_id"])["operation_id"]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        operation = install.status("mihomo", operation_id)
        if operation["status"] in {"succeeded", "failed", "rolled_back"}:
            break
        time.sleep(.01)
    assert operation["status"] == "succeeded"
    assert target.read_bytes() == b"new-mihomo"
    assert store.get("mihomo")["installed_profile_id"] == "official"
    assert restarts == []


def test_failed_first_install_never_restarts_stopped_service(tmp_path):
    install, _store, target = _installer(tmp_path, running=None, preflight=(1, "bad binary"))
    target.unlink()
    restarts = []
    install.restart = lambda *_args, **_kwargs: restarts.append(True)
    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])
    assert operation["status"] == "failed"
    assert not target.exists()
    assert restarts == []


def test_first_install_refuses_file_created_after_confirmation(tmp_path):
    install, _store, target = _installer(tmp_path, running="mihomo")
    target.unlink()
    prepared = install.prepare("xray")
    target.write_bytes(b"external")
    with pytest.raises(installer_module.CoreInstallError) as exc:
        install.apply("xray", prepared["confirmation_id"])
    assert exc.value.code == "core_already_installed"
    assert target.read_bytes() == b"external"


def test_first_install_rollback_does_not_remove_concurrent_replacement(tmp_path):
    install, _store, target = _installer(tmp_path, running="mihomo")
    target.unlink()
    def replace_during_validation(*_args, **_kwargs):
        replacement = tmp_path / "replacement"
        replacement.write_bytes(b"external")
        replacement.replace(target)
        return 1, "failed"
    install.run_command = replace_during_validation
    prepared = install.prepare("xray")
    _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])
    assert target.read_bytes() == b"external"


def test_first_install_does_not_mark_concurrent_replacement_as_verified(tmp_path):
    install, store, target = _installer(tmp_path, running="mihomo")
    target.unlink()
    def replace_during_validation(*_args, **_kwargs):
        replacement = tmp_path / "replacement"
        replacement.write_bytes(b"external")
        replacement.replace(target)
        return 0, "ok"
    install.run_command = replace_during_validation
    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])
    assert operation["status"] == "failed"
    assert target.read_bytes() == b"external"
    assert not store.get("xray")["installed_profile_id"]


def test_first_install_does_not_publish_if_validation_fails_during_core_switch(tmp_path):
    install, _store, target = _installer(tmp_path, running="mihomo")
    target.unlink()
    active = {"core": "mihomo"}
    install.running_core = lambda: active["core"]
    def switch_during_validation(*_args, **_kwargs):
        active["core"] = "xray"
        return 1, "failed"
    install.run_command = switch_during_validation
    prepared = install.prepare("xray")
    _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])
    assert not target.exists()


def test_first_install_stops_when_module_disabled_during_download(tmp_path):
    install, _store, target = _installer(tmp_path, running="mihomo")
    target.unlink()
    allowed = {"value": True}
    original_downloader = install.downloader
    install.allow_first_install = lambda _engine: allowed["value"]
    def download(*args, **kwargs):
        payload = original_downloader(*args, **kwargs)
        allowed["value"] = False
        return payload
    install.downloader = download
    prepared = install.prepare("xray")
    operation = _wait_for_terminal(install, install.apply("xray", prepared["confirmation_id"])["operation_id"])
    assert operation["status"] == "failed"
    assert not target.exists()


def test_prepare_during_a_core_hand_off_waits_for_the_owner(tmp_path):
    """Both engines up: the settled owner decides, and no owner is its own refusal."""
    from services.cores import CoreRuntime

    install, _store, _target = _installer(tmp_path, running=None)
    both = CoreRuntime(("xray", "mihomo"))

    install.settled_core = lambda: (both, None)
    with pytest.raises(installer_module.CoreInstallError) as exc_info:
        install.prepare("xray")
    assert exc_info.value.code == "core_switching"

    install.settled_core = lambda: (both, "mihomo")
    with pytest.raises(installer_module.CoreInstallError) as exc_info:
        install.prepare("xray")
    assert exc_info.value.code == "core_switching"

    install.settled_core = lambda: (CoreRuntime(("xray",)), "xray")
    assert install.prepare("xray")["engine_id"] == "xray"


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

    assert len(calls) == 6
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

    assert len(calls) == 6


def test_github_outage_result_is_never_stored(tmp_path):
    calls = []
    outage = {"installable": False, "reason": "github_unavailable", "stable": None, "asset": None, "checksum": None}
    install, _store, _target = _installer(tmp_path)
    install.release_resolver = lambda *args, **kwargs: calls.append(args[0].profile_id) or dict(outage)

    install.profiles("xray")
    install.profiles("xray")

    assert len(calls) == 12


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

    # The pre-release channel follows the newest build, which the cheap tag
    # check (it sees stable releases only) cannot confirm.
    assert calls == ["official-prerelease"]
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

    # The pre-release channel is fetched as well: no tag check confirms it.
    assert calls == ["official", "official-prerelease"]


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
    stable_repos = [item.repo for item in profiles.list_profiles("mihomo") if item.release_policy == "stable_only"]
    assert prerelease_ids and calls == prerelease_ids
    # Only stable sources are confirmed by the tag; the official pre-release
    # channel shares the repository with the stable one, hence the list.
    assert tag_checks == stable_repos


def _channel_installer(tmp_path, *, running_version: str):
    install, store, _target = _installer(tmp_path)
    stable = _release_for(b"new-xray")
    newest = {**stable, "stable": {**stable["stable"], "tag": "v26.10.17", "prerelease": True}}
    install.release_resolver = lambda profile, *_args, **_kwargs: newest if profile.profile_id == "official-prerelease" else stable
    install._read_binary_version = lambda _engine: running_version
    return install, store


def test_a_core_newer_than_the_stable_channel_selects_the_prerelease_channel(tmp_path):
    # XKeen installed 26.9.9 while the last stable Xray is v26.3.27.
    install, _store = _channel_installer(tmp_path, running_version="26.9.9")
    value = install.profiles("xray")
    assert value["state"]["selected_profile_id"] == "official-prerelease"
    assert install.prepare("xray")["profile"]["profile_id"] == "official-prerelease"


def test_a_core_on_the_stable_line_keeps_the_stable_channel(tmp_path):
    install, _store = _channel_installer(tmp_path, running_version="26.3.27")
    assert install.profiles("xray")["state"]["selected_profile_id"] == "official"


def test_an_explicit_choice_and_a_recorded_install_outrank_the_version_guess(tmp_path):
    install, store = _channel_installer(tmp_path, running_version="26.9.9")
    store.set_installed("xray", profile_id="official", release_tag="v26.3.27", asset_name="Xray-linux-64.zip")
    assert install.profiles("xray")["state"]["selected_profile_id"] == "official"
    install.select("xray", "uwuray")
    assert install.profiles("xray")["state"]["selected_profile_id"] == "uwuray"
    install.select("xray", "official")
    assert install.profiles("xray")["state"]["selected_profile_id"] == "official"


def test_a_mihomo_alpha_build_selects_the_mihomo_prerelease_channel(tmp_path):
    install, _store, _target = _installer(tmp_path)
    install.release_resolver = lambda *_args, **_kwargs: {**_release_for(b"new-mihomo"), "binary_name": "mihomo"}
    install._read_binary_version = lambda _engine: "alpha-94b13ae"
    assert install.profiles("mihomo")["state"]["selected_profile_id"] == "official-prerelease"


def test_the_version_of_a_mihomo_alpha_build_is_its_commit(tmp_path):
    install, _store, _target = _installer(tmp_path)
    (tmp_path / "mihomo").write_bytes(b"binary")
    install.run_command = lambda *_args, **_kwargs: (0, "Mihomo Meta alpha-94b13ae linux arm64 with go1.25.1 Mon Oct 13 2026")
    assert install._read_binary_version("mihomo") == "alpha-94b13ae"
    install.run_command = lambda *_args, **_kwargs: (0, "Mihomo Meta v1.19.32 linux arm64 with go1.25.1")
    assert install._read_binary_version("mihomo") == "v1.19.32"


def test_mihomo_preflight_uses_router_validation_template(monkeypatch, tmp_path):
    install, _store, _target = _installer(tmp_path)
    monkeypatch.setenv(
        "MIHOMO_VALIDATE_CMD",
        "/opt/sbin/mihomo -t -d {root} -f {config}",
    )

    assert install._preflight_command("mihomo", "/tmp/new-mihomo") == [
        "/tmp/new-mihomo",
        "-t",
        "-d",
        str(tmp_path),
        "-f",
        str(tmp_path / "mihomo.yaml"),
    ]
