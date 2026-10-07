"""Обновление панели не качает и не распаковывает архив без нужды.

Проверка «есть ли обновление» обходится подписанным каталогом, план строится
по оглавлению архива, а сам архив за всё обновление скачивается один раз:
панель кладёт проверенную копию рядом, исполнитель забирает её оттуда.
"""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from flask import Flask

from routes.devtools import create_devtools_blueprint
from services.module_lifecycle import ModuleLifecycleError
from services.module_registry import ModuleRegistry
from services.module_transactions import extract as extract_module
from services.module_transactions.executor import run_operation
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_panel_update_plan, build_profile_transition_plan
from services.panel_package_contract import validate_panel_archive
from tests.support.module_lifecycle import LaunchRecorder, make_service
from tests.support.module_tx import ARCHITECTURE, VERSION, make_panel, make_release


def _panel_downloads(release) -> int:
    return release.transport.calls.count(release.panel_url)


def _checked_archive(tmp_path: Path, release) -> dict:
    archive = tmp_path / "checked" / "panel.tar.gz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(release.panel)
    return validate_panel_archive(archive, release.catalog["panel"], platform_architecture=ARCHITECTURE)


def _unpacked_archive(tmp_path: Path, release) -> Path:
    """То же дерево, что описывает оглавление: архив, распакованный целиком."""

    checked = _checked_archive(tmp_path, release)
    root = tmp_path / "unpacked" / "xkeen-ui"
    extract_module.extract_panel_payload(tmp_path / "checked" / "panel.tar.gz", root, checked["payload_files"])
    return root


@pytest.fixture
def no_extraction(monkeypatch):
    """Панель не имеет права распаковывать архив ради плана."""

    def forbidden(*_args, **_kwargs):
        raise AssertionError("the panel process must not unpack the panel archive")

    monkeypatch.setattr(extract_module, "extract_panel_payload", forbidden)


# --- план по оглавлению архива ---------------------------------------------------


def test_archive_check_reports_the_size_of_every_payload_file(tmp_path):
    release = make_release(version="2.11.0")

    checked = _checked_archive(tmp_path, release)

    assert set(checked["payload_sizes"]) == set(checked["payload_files"])
    assert checked["payload_sizes"]["app.py"] > 0


def test_panel_update_plan_from_archive_listing_equals_plan_from_unpacked_tree(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    release = make_release(version="2.11.0")
    common = {
        "panel_root": panel.root,
        "state_dir": panel.state,
        "catalog": release.catalog,
        "architecture": ARCHITECTURE,
        "free_bytes": 1 << 40,
    }

    unpacked = build_panel_update_plan(target_panel_root=_unpacked_archive(tmp_path, release), **common)
    listed = build_panel_update_plan(target_archive=_checked_archive(tmp_path, release), **common)

    assert listed == unpacked


def test_profile_transition_plan_from_archive_listing_equals_plan_from_unpacked_tree(tmp_path):
    panel = make_panel(tmp_path)
    ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool").set_profile("mihomo-minimal")
    release = make_release()
    common = {
        "panel_root": panel.root,
        "state_dir": panel.state,
        "catalog": release.catalog,
        "architecture": ARCHITECTURE,
        "free_bytes": 1 << 40,
    }

    unpacked = build_profile_transition_plan(target_panel_root=_unpacked_archive(tmp_path, release), **common)
    listed = build_profile_transition_plan(target_archive=_checked_archive(tmp_path, release), **common)

    assert listed == unpacked


def test_a_full_scope_plan_needs_a_target_description(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0")
    release = make_release(version="2.11.0")

    with pytest.raises(TypeError):
        build_panel_update_plan(
            panel_root=panel.root, state_dir=panel.state, catalog=release.catalog, architecture=ARCHITECTURE
        )


# --- лёгкая проверка обновления ---------------------------------------------------


def test_update_check_reads_only_the_signed_catalog_when_an_update_exists(tmp_path, no_extraction):
    panel = make_panel(tmp_path, version="2.10.0")
    release = make_release(version="2.11.0")
    service, catalog = make_service(panel, release)

    result = service.panel_update_check()

    assert result == {
        "ok": True,
        "source_version": "2.10.0",
        "target_version": "2.11.0",
        "update_available": True,
    }
    assert _panel_downloads(release) == 0
    assert catalog.latest_requests == 1


def test_update_check_reads_only_the_signed_catalog_when_the_panel_is_current(tmp_path, no_extraction):
    panel = make_panel(tmp_path)
    release = make_release()
    service, _ = make_service(panel, release)

    result = service.panel_update_check()

    assert result["update_available"] is False
    assert result["source_version"] == result["target_version"] == VERSION
    assert _panel_downloads(release) == 0


def test_update_check_keeps_the_pending_profile_refusal(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0")
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    registry.set_profile("mihomo-minimal")
    service, _ = make_service(panel, make_release(version="2.11.0"), registry=registry)

    with pytest.raises(ModuleLifecycleError) as raised:
        service.panel_update_check()

    assert raised.value.code == "profile_transition_required"


def test_update_check_maps_an_unreachable_catalog_to_the_public_code(tmp_path):
    from services.module_catalog_client import CatalogClientError

    class Unreachable:
        def get_catalog(self, **_kwargs):
            raise CatalogClientError("catalog_release_not_found", "no release")

    service, _ = make_service(
        make_panel(tmp_path), make_release(), catalog_factory=lambda _version, _architecture: Unreachable()
    )

    with pytest.raises(ModuleLifecycleError) as raised:
        service.panel_update_check()

    assert raised.value.code == "panel_update_unavailable"
    assert raised.value.status == 503


def test_update_check_asks_for_a_fresh_catalog_only_on_request(tmp_path):
    seen: list[bool] = []
    release = make_release(version="2.11.0")
    snapshot = SimpleNamespace(catalog=release.catalog, release_version="2.11.0")

    class Catalog:
        def get_catalog(self, *, force_refresh=False):
            seen.append(force_refresh)
            return snapshot

    service, _ = make_service(
        make_panel(tmp_path, version="2.10.0"), release, catalog_factory=lambda _version, _architecture: Catalog()
    )

    service.panel_update_check()
    service.panel_update_check(force_refresh=True)

    assert seen == [False, True]


# --- план и применение: один архив, без распаковки ------------------------------------


def test_plan_for_a_current_panel_downloads_no_archive(tmp_path, no_extraction):
    panel = make_panel(tmp_path)
    release = make_release()
    service, _ = make_service(panel, release)

    payload = service.plan("panel-update", None)

    assert payload["applicable"] is False
    assert payload["blockers"][0]["code"] == "panel_version_current"
    assert payload["blockers"][0]["current_version"] == VERSION
    assert _panel_downloads(release) == 0


def test_plan_and_apply_download_the_archive_once_and_never_unpack_it(tmp_path, no_extraction):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    release = make_release(version="2.11.0")
    launcher = LaunchRecorder()

    def launch(plan, **kwargs):
        # Как настоящий запуск: план пересобирается под блокировкой.
        rebuilt = kwargs["prepare_plan"]()
        return launcher(rebuilt, **kwargs)

    service, _ = make_service(panel, release, launch_operation=launch)

    reviewed = service.plan("panel-update", None)
    service.apply("panel-update", None, reviewed["plan_id"])

    assert reviewed["applicable"] is True
    assert _panel_downloads(release) == 1
    assert launcher.plans[-1].target_version == "2.11.0"


def test_apply_hands_the_archive_cache_to_the_runner_for_full_scope_only(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    launcher = LaunchRecorder()
    service, _ = make_service(panel, make_release(version="2.11.0"), launch_operation=launcher)

    reviewed = service.plan("panel-update", None)
    service.apply("panel-update", None, reviewed["plan_id"])

    cache = service.archive_cache_dir
    assert launcher.kwargs[-1]["extra_args"] == ("--archive-cache", str(cache))
    assert [path.suffixes[-2:] for path in cache.iterdir() if path.is_file()] == [[".tar", ".gz"]]


def test_a_damaged_cached_archive_is_replaced_by_a_fresh_download(tmp_path, no_extraction):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    release = make_release(version="2.11.0")
    service, _ = make_service(panel, release)
    first = service.plan("panel-update", None)
    cached = next(path for path in service.archive_cache_dir.iterdir() if path.is_file())
    body = bytearray(cached.read_bytes())
    body[len(body) // 2] ^= 0xFF
    cached.write_bytes(bytes(body))

    second = service.plan("panel-update", None)

    assert second["plan_id"] == first["plan_id"]
    assert _panel_downloads(release) == 2
    assert cached.read_bytes() == release.panel


def test_a_blocked_plan_does_not_leave_the_archive_behind(tmp_path, monkeypatch):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    service, _ = make_service(panel, make_release(version="2.11.0"))
    monkeypatch.setattr(
        "services.module_transactions.plan.shutil.disk_usage", lambda _path: SimpleNamespace(free=0)
    )

    payload = service.plan("panel-update", None)

    assert payload["blockers"][0]["code"] == "operation_free_space"
    assert not any(service.archive_cache_dir.glob("*"))


def test_a_refused_apply_does_not_leave_the_archive_behind(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    service, _ = make_service(panel, make_release(version="2.11.0"), launch_operation=LaunchRecorder())
    service.plan("panel-update", None)

    with pytest.raises(ModuleLifecycleError):
        service.apply("panel-update", None, "f" * 64)

    assert not any(service.archive_cache_dir.glob("*"))


def test_update_check_clears_an_archive_nobody_came_for(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    service, _ = make_service(panel, make_release(version="2.11.0"))
    service.plan("panel-update", None)
    assert any(service.archive_cache_dir.glob("*"))

    service.panel_update_check()

    assert not any(service.archive_cache_dir.glob("*"))


# --- исполнитель забирает архив у панели -------------------------------------------


def _update_plan(tmp_path: Path, panel, release):
    return build_panel_update_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_archive=_checked_archive(tmp_path, release),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )


def _run(panel, plan, release, cache: Path | None):
    journal = Journal.create(panel.root, plan, "light-path-operation", extra={})
    return run_operation(
        journal,
        state_dir=panel.state,
        client=release.client(panel.state),
        architecture=ARCHITECTURE,
        restart=lambda: None,
        wait_healthy=lambda _phase: True,
        panel_archive_cache=cache,
    )


def test_runner_takes_the_archive_the_panel_already_verified(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    release = make_release(version="2.11.0")
    plan = _update_plan(tmp_path, panel, release)
    cache = tmp_path / "cache"
    cache.mkdir()
    cached = cache / f"{plan.archive.sha256}.tar.gz"
    cached.write_bytes(release.panel)

    assert _run(panel, plan, release, cache) == "committed"

    assert _panel_downloads(release) == 0
    assert panel.read_json("BUILD.json")["version"] == "2.11.0"
    # Копия у панели больше не нужна: исполнитель унёс её к себе.
    assert not cached.exists()


def test_runner_downloads_when_the_panel_left_nothing(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    release = make_release(version="2.11.0")
    plan = _update_plan(tmp_path, panel, release)

    assert _run(panel, plan, release, tmp_path / "missing-cache") == "committed"

    assert _panel_downloads(release) == 1


def test_runner_does_not_trust_a_damaged_cached_archive(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    release = make_release(version="2.11.0")
    plan = _update_plan(tmp_path, panel, release)
    cache = tmp_path / "cache"
    cache.mkdir()
    body = bytearray(release.panel)
    body[len(body) // 2] ^= 0xFF
    (cache / f"{plan.archive.sha256}.tar.gz").write_bytes(bytes(body))

    assert _run(panel, plan, release, cache) == "committed"

    assert _panel_downloads(release) == 1
    assert panel.read_json("BUILD.json")["version"] == "2.11.0"


def test_runner_cli_accepts_the_archive_cache(tmp_path):
    import importlib.util

    script = Path(__file__).resolve().parents[1] / "xkeen-ui" / "scripts" / "module_transaction.py"
    spec = importlib.util.spec_from_file_location("module_transaction_cli_light", script)
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)
    panel = make_panel(tmp_path, version="2.10.0", installed=("core", "tool.files"))
    release = make_release(version="2.11.0")
    plan = _update_plan(tmp_path, panel, release)
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / f"{plan.archive.sha256}.tar.gz").write_bytes(release.panel)
    operation_id = "20261007T120000Z-abcdef"
    Journal.create(
        panel.root, plan, operation_id,
        extra={"health_url": "http://127.0.0.1:1/login", "restart_cmd": ["restart-panel"]},
    )

    with patch.object(cli.subprocess, "run", lambda *_args, **_kwargs: None), patch.object(
        cli, "wait_for_panel", lambda *_args, **_kwargs: True
    ), patch.dict(os.environ, {"XKEEN_UI_UPDATE_DIR": str(tmp_path / "update")}):
        code = cli.main(
            [
                "run", "--panel-root", str(panel.root), "--state-dir", str(panel.state),
                "--operation", operation_id, "--archive-cache", str(cache),
            ],
            client_factory=lambda state_dir, _architecture, _version: release.client(state_dir),
            architecture=ARCHITECTURE,
        )

    assert code == 0
    assert _panel_downloads(release) == 0
    assert panel.read_json("BUILD.json")["version"] == "2.11.0"


# --- DevTools ----------------------------------------------------------------------


class _Lifecycle:
    def __init__(self, available: bool) -> None:
        self.available = available
        self.calls: list[tuple] = []

    def panel_update_check(self, *, force_refresh=False):
        self.calls.append(("check", force_refresh))
        return {
            "ok": True,
            "source_version": "1.0.0",
            "target_version": "1.1.0" if self.available else "1.0.0",
            "update_available": self.available,
        }

    def plan(self, *_args, **_kwargs):
        raise AssertionError("an update check must not build a plan")


def _devtools(tmp_path, lifecycle):
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(create_devtools_blueprint(str(tmp_path), lifecycle_service=lifecycle))
    return app.test_client()


@pytest.mark.parametrize("available", [True, False])
def test_devtools_check_uses_the_light_check_and_names_the_release(tmp_path, available):
    lifecycle = _Lifecycle(available)
    with patch.dict(os.environ, {"XKEEN_UI_UPDATE_CHANNEL": "stable"}, clear=False):
        response = _devtools(tmp_path, lifecycle).post("/api/devtools/update/check", json={"force_refresh": True})

    payload = response.get_json()
    assert response.status_code == 200
    assert payload["update_available"] is available
    assert payload["current"]["version"] == "1.0.0"
    assert payload["latest"]["version"] == ("1.1.0" if available else "1.0.0")
    # Плашка обновления подписывает релиз его тегом.
    assert payload["latest"]["tag"] == ("v1.1.0" if available else "v1.0.0")
    assert payload["security"]["will_block_run"] is (not available)
    assert lifecycle.calls == [("check", True)]
