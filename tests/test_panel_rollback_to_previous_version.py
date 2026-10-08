"""После обновления из панели можно вернуться на прежнюю версию.

Обновление и так хранит всё, что заменяет: этим оно отменяет себя, если новый
релиз не запустился. После успеха копии выбрасывались, и вернуться было нечем —
только установщиком прежнего релиза. Теперь каталог операции остаётся рядом с
панелью как «предыдущая версия», а возврат — обычная операция под журналом:
без сети, с проверкой запуска и со своей отменой.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest
from flask import Flask

from routes.devtools import create_devtools_blueprint
from routes.modules import create_modules_blueprint
from services.module_registry import ModuleRegistry
from services.module_transactions.executor import recover, run_operation
from services.module_transactions.journal import Journal
from services.module_transactions.plan import (
    build_panel_rollback_plan,
    build_panel_update_plan,
    build_plan,
)
from services.module_transactions.previous_version import (
    describe_previous_version,
    previous_version_root,
)
from services.module_transactions.state import ModuleTransactionError, read_status
from services.panel_package_contract import validate_panel_archive
from tests.support.module_lifecycle import LaunchRecorder, make_service
from tests.support.module_tx import ARCHITECTURE, changed_paths, make_panel, make_release, snapshot


OLD, NEW, NEWER = "2.10.0", "2.11.0", "2.12.0"
# Запись о ходе операции и кэш каталога — не файлы панели.
SERVICE_FOLDERS = ("module-operations/", "module-catalog/")


def _tree(panel) -> dict[str, bytes]:
    return {path: body for path, body in snapshot(panel.root).items() if not path.startswith(SERVICE_FOLDERS)}


def _update_plan(tmp_path: Path, panel, release):
    archive = tmp_path / f"checked-{release.version}" / "panel.tar.gz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(release.panel)
    return build_panel_update_plan(
        panel_root=panel.root, state_dir=panel.state, catalog=release.catalog,
        target_archive=validate_panel_archive(archive, release.catalog["panel"], platform_architecture=ARCHITECTURE),
        architecture=ARCHITECTURE, free_bytes=1 << 40,
    )


def _run(panel, plan, release=None, *, healthy=lambda _phase: True, name="operation", provision=None) -> str:
    journal = Journal.create(panel.root, plan, name, extra={})
    return run_operation(
        journal,
        state_dir=panel.state,
        client=None if release is None else release.client(panel.state, core_version=plan.source_version),
        architecture=ARCHITECTURE,
        restart=lambda: None,
        wait_healthy=healthy,
        provision=provision,
    )


def _updated(tmp_path: Path, version: str = NEW):
    """Панель, только что обновлённая с ``OLD``; и её дерево до обновления."""

    panel = make_panel(tmp_path, version=OLD, installed=("core", "tool.files"))
    (panel.root / "uninstall.sh").write_bytes(b"#!/bin/sh\necho previous\n")
    before = _tree(panel)
    release = make_release(version=version)
    assert _run(panel, _update_plan(tmp_path, panel, release), release, name="update") == "committed"
    return panel, before


def _go_back(panel, **kwargs) -> str:
    plan = build_panel_rollback_plan(panel_root=panel.root, state_dir=panel.state, free_bytes=1 << 40)
    return _run(panel, plan, name="go-back", **kwargs)


def _reason(panel) -> str:
    with pytest.raises(ModuleTransactionError) as raised:
        build_panel_rollback_plan(panel_root=panel.root, state_dir=panel.state, free_bytes=1 << 40)
    assert raised.value.code == "panel_rollback_unavailable"
    return raised.value.details["reason"]


# --- копия прежней версии ------------------------------------------------------------------


def test_a_confirmed_update_leaves_the_previous_version_next_to_the_panel(tmp_path):
    panel, _before = _updated(tmp_path)

    described = describe_previous_version(panel.root)

    assert (described["available"], described["version"]) == (True, OLD)
    assert described["size"] > 0
    assert previous_version_root(panel.root).is_dir()
    # Незавершённой операции при этом нет: копия лежит отдельно.
    assert Journal.find(panel.root) is None


def test_a_panel_that_was_never_updated_has_nowhere_to_go_back(tmp_path):
    panel = make_panel(tmp_path, version=OLD, installed=("core", "tool.files"))

    assert describe_previous_version(panel.root)["available"] is False
    assert _reason(panel) == "no_previous_version"


def test_the_copy_is_one_step_back(tmp_path):
    panel, _before = _updated(tmp_path)
    middle = _tree(panel)
    release = make_release(version=NEWER)
    assert _run(panel, _update_plan(tmp_path, panel, release), release, name="second-update") == "committed"

    assert describe_previous_version(panel.root)["version"] == NEW
    assert _go_back(panel) == "committed"
    assert changed_paths(middle, _tree(panel)) == set()


def test_an_update_that_did_not_start_leaves_the_earlier_copy_usable(tmp_path):
    panel, before = _updated(tmp_path)
    release = make_release(version=NEWER)

    failed = _run(
        panel, _update_plan(tmp_path, panel, release), release,
        name="failed-update", healthy=lambda phase: phase == "rollback",
    )

    assert failed == "rolled_back"
    assert describe_previous_version(panel.root)["version"] == OLD
    assert _go_back(panel) == "committed"
    assert changed_paths(before, _tree(panel)) == set()


# --- возврат ---------------------------------------------------------------------------------


def test_going_back_puts_the_tree_exactly_as_it_was(tmp_path):
    panel, before = _updated(tmp_path)
    assert panel.read_json("BUILD.json")["version"] == NEW

    assert _go_back(panel) == "committed"

    assert changed_paths(before, _tree(panel)) == set()
    assert panel.read_json("BUILD.json")["version"] == OLD
    status = read_status(panel.state)
    assert (status["operation"], status["scope"], status["result"]) == ("panel-rollback", "panel", "committed")


def test_going_back_needs_no_network(tmp_path):
    panel, _before = _updated(tmp_path)

    # Клиента каталога у операции нет вовсе.
    assert _go_back(panel) == "committed"


def test_after_going_back_the_copy_is_gone(tmp_path):
    panel, _before = _updated(tmp_path)
    _go_back(panel)

    assert not previous_version_root(panel.root).exists()
    assert _reason(panel) == "no_previous_version"


def test_a_previous_version_that_does_not_start_is_undone(tmp_path):
    panel, _before = _updated(tmp_path)
    updated = _tree(panel)

    result = _go_back(panel, healthy=lambda phase: phase == "rollback")

    assert result == "rolled_back"
    assert changed_paths(updated, _tree(panel)) == set()
    # Копия цела: попытку можно повторить.
    assert describe_previous_version(panel.root)["available"] is True


def test_going_back_cut_short_is_finished_by_the_next_start(tmp_path):
    panel, _before = _updated(tmp_path)
    updated = _tree(panel)
    plan = build_panel_rollback_plan(panel_root=panel.root, state_dir=panel.state, free_bytes=1 << 40)
    journal = Journal.create(panel.root, plan, "cut-short", extra={})
    journal.set_step("applying")
    # Половина файлов прежней версии уже на месте, когда пропадает питание.
    for relative in plan.files_add[: len(plan.files_add) // 2]:
        journal.apply_file(relative, previous_version_root(panel.root) / "backup" / "files" / relative)

    assert recover(panel.root, panel.state) == "rolled_back"

    assert changed_paths(updated, _tree(panel)) == set()
    assert describe_previous_version(panel.root)["available"] is True


def test_going_back_restores_the_environment_of_the_previous_release(tmp_path):
    panel, _before = _updated(tmp_path)
    calls: list[tuple[str, str]] = []

    def provision(phase: str, script: Path):
        calls.append((phase, panel.read_json("BUILD.json")["version"]))
        return []

    assert _go_back(panel, provision=provision) == "committed"

    # Общий скрипт зовётся один раз и уже на возвращённых файлах; библиотеки не трогаются.
    assert calls == [("apply", OLD)]


# --- устаревшая копия --------------------------------------------------------------------------


def test_a_module_operation_after_the_update_makes_the_copy_stale(tmp_path):
    panel, _before = _updated(tmp_path)
    release = make_release(version=NEW)
    plan = build_plan(
        "install", "tool.terminal",
        panel_root=panel.root, state_dir=panel.state, catalog=release.catalog,
        architecture=ARCHITECTURE, free_bytes=1 << 40,
    )

    assert _run(panel, plan, release, name="module") == "committed"

    assert not previous_version_root(panel.root).exists()
    assert _reason(panel) == "no_previous_version"


def test_a_tree_changed_behind_the_panels_back_is_not_laid_over(tmp_path):
    panel, _before = _updated(tmp_path)
    managed = panel.read_json("install-managed.json")
    managed["paths"].append("services/added_by_hand.py")
    (panel.root / "install-managed.json").write_text(json.dumps(managed), encoding="utf-8")

    assert _reason(panel) == "panel_changed_since_update"


def test_a_copy_of_another_release_is_not_used(tmp_path):
    panel, _before = _updated(tmp_path)
    build = panel.read_json("BUILD.json")
    build["version"] = NEWER
    (panel.root / "BUILD.json").write_text(json.dumps(build), encoding="utf-8")

    assert _reason(panel) == "panel_version_changed"


def test_a_copy_with_a_missing_file_is_not_used(tmp_path):
    panel, _before = _updated(tmp_path)
    copies = sorted(path for path in (previous_version_root(panel.root) / "backup" / "files").rglob("*") if path.is_file())
    copies[0].unlink()

    assert _reason(panel) == "previous_version_incomplete"


def test_the_copy_changed_between_the_plan_and_the_run_stops_the_operation(tmp_path):
    panel, _before = _updated(tmp_path)
    updated = _tree(panel)
    plan = build_panel_rollback_plan(panel_root=panel.root, state_dir=panel.state, free_bytes=1 << 40)
    build = panel.read_json("BUILD.json")
    build["version"] = NEWER
    (panel.root / "BUILD.json").write_text(json.dumps(build), encoding="utf-8")
    after_change = _tree(panel)

    assert _run(panel, plan, name="stale") == "interrupted"

    assert changed_paths(after_change, _tree(panel)) == set()
    assert updated != after_change


# --- API ----------------------------------------------------------------------------------------


def test_the_panel_offers_and_launches_the_way_back(tmp_path):
    panel, _before = _updated(tmp_path)
    launcher = LaunchRecorder()
    release = make_release(version=NEW)
    service, _ = make_service(panel, release, launch_operation=launcher)

    assert service.installed()["previous_version"]["version"] == OLD
    reviewed = service.plan("panel-rollback", None)
    service.apply("panel-rollback", None, reviewed["plan_id"])

    assert (reviewed["applicable"], reviewed["scope"]) == (True, "panel")
    assert (reviewed["source_version"], reviewed["target_version"]) == (NEW, OLD)
    assert launcher.plans[-1].operation == "panel-rollback"
    assert "extra_args" not in launcher.kwargs[-1]
    # Ни каталог, ни архив для возврата не нужны.
    assert release.transport.calls == []


def test_a_plan_without_a_copy_says_why(tmp_path):
    panel = make_panel(tmp_path, version=OLD, installed=("core", "tool.files"))
    service, _ = make_service(panel, make_release(version=OLD))

    reviewed = service.plan("panel-rollback", None)

    assert reviewed["applicable"] is False
    assert reviewed["blockers"][0]["code"] == "panel_rollback_unavailable"
    assert reviewed["blockers"][0]["reason"] == "no_previous_version"


def test_the_route_takes_the_operation_without_a_module(tmp_path):
    panel, _before = _updated(tmp_path)
    service, _ = make_service(panel, make_release(version=NEW), launch_operation=LaunchRecorder())
    app = Flask(__name__)
    app.config["TESTING"] = True
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    app.register_blueprint(create_modules_blueprint(registry, lifecycle_service=service))
    client = app.test_client()

    planned = client.post("/api/modules/operations/plan", json={"operation": "panel-rollback"})
    refused = client.post("/api/modules/operations/plan", json={"operation": "panel-rollback", "module_id": "core"})
    applied = client.post(
        "/api/modules/operations/apply",
        json={"operation": "panel-rollback", "plan_id": planned.get_json()["plan_id"]},
    )

    assert planned.status_code == 200 and planned.get_json()["applicable"] is True
    assert refused.status_code == 400
    assert applied.status_code == 202


def test_devtools_shows_the_button_and_goes_back_through_the_engine(tmp_path):
    panel, _before = _updated(tmp_path)
    launcher = LaunchRecorder()
    service, _ = make_service(panel, make_release(version=NEW), launch_operation=launcher)
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(create_devtools_blueprint(str(tmp_path), lifecycle_service=service))
    client = app.test_client()

    with patch.dict(os.environ, {"XKEEN_UI_UPDATE_CHANNEL": "stable"}, clear=False):
        status = client.get("/api/devtools/update/status").get_json()
        started = client.post("/api/devtools/update/rollback", json={})

    assert status["has_backup"] is True
    assert status["previous_version"]["version"] == OLD
    assert started.status_code == 202 and started.get_json()["started"] is True
    assert launcher.plans[-1].operation == "panel-rollback"


def test_devtools_hides_the_button_when_there_is_nothing_to_go_back_to(tmp_path):
    panel = make_panel(tmp_path, version=OLD, installed=("core", "tool.files"))
    service, _ = make_service(panel, make_release(version=OLD), launch_operation=LaunchRecorder())
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(create_devtools_blueprint(str(tmp_path), lifecycle_service=service))
    client = app.test_client()

    with patch.dict(os.environ, {"XKEEN_UI_UPDATE_CHANNEL": "stable"}, clear=False):
        status = client.get("/api/devtools/update/status").get_json()
        refused = client.post("/api/devtools/update/rollback", json={}).get_json()

    assert status["has_backup"] is False
    assert (refused["ok"], refused["error"]) == (False, "no_backup")
