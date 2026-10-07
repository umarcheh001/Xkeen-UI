"""Переход профиля трогает только разницу: чего не хватает и что лишнее.

Релиз при переходе тот же, поэтому файлы, которые уже лежат на месте, не
перекладываются и не копируются про запас. Убрать модуль — значит удалить его
файлы: для этого не нужны ни архив панели, ни сеть.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from services.module_lifecycle import ModuleLifecycleError
from services.module_registry import ModuleRegistry
from services.module_transactions.executor import recover, run_operation
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_profile_transition_plan, installed_panel_listing
from services.module_transactions.state import ModuleTransactionError
from services.panel_package_contract import validate_panel_archive
from tests.support.module_lifecycle import make_service
from tests.support.module_tx import (
    ARCHITECTURE,
    MODULE_ORDER,
    OWNERSHIP,
    file_bytes,
    make_panel,
    make_release,
    snapshot,
)


FULL = tuple(MODULE_ORDER)
TERMINAL = set(OWNERSHIP["tool.terminal"])
BOOKKEEPING = ("module-catalog/", "module-operations/")


def _desire(panel, modules: set[str], *, profile: str = "custom", variant: str = "light") -> None:
    import json

    state = panel.read_json("modules.json")
    state["profile"] = profile
    state["editor"] = {"variant": variant}
    state["modules"] = {module_id: {"enabled": module_id in modules} for module_id in MODULE_ORDER}
    # Переход исполняет явный запрос профиля, а не положение переключателей.
    state["physical_request"] = {
        "profile": profile,
        "module_ids": [module_id for module_id in MODULE_ORDER if module_id in modules],
        "editor_variant": variant,
    }
    panel.path("modules.json").write_text(json.dumps(state), encoding="utf-8")


def _archive_listing(tmp_path: Path, release) -> dict:
    archive = tmp_path / "checked" / "panel.tar.gz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(release.panel)
    return validate_panel_archive(archive, release.catalog["panel"], platform_architecture=ARCHITECTURE)


def _plan(panel, release, listing, **extra):
    return build_profile_transition_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_archive=listing,
        architecture=ARCHITECTURE,
        **{"free_bytes": 1 << 40, **extra},
    )


class _NoNetwork:
    """Клиент каталога, к которому никто не должен обратиться."""

    def __getattr__(self, name):
        raise AssertionError(f"the operation must not reach the network ({name})")


def _run(panel, plan, client, *, healthy: bool = True, on_step=None) -> str:
    journal = Journal.create(panel.root, plan, "profile-diff-operation", extra={})
    return run_operation(
        journal,
        state_dir=panel.state,
        client=client,
        architecture=ARCHITECTURE,
        restart=lambda: None,
        wait_healthy=lambda _phase: healthy,
        on_step=on_step,
    )


def _payload(panel) -> dict[str, bytes]:
    return {path: body for path, body in snapshot(panel.root).items() if not path.startswith(BOOKKEEPING)}


# --- план ---------------------------------------------------------------------------


def test_removing_a_module_plans_only_its_files_and_no_archive(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    _desire(panel, set(FULL) - {"tool.terminal"})

    plan = _plan(panel, make_release(), installed_panel_listing(panel.root))

    assert plan.files_add == ()
    assert set(plan.files_remove) == TERMINAL
    assert plan.archive is None
    assert "tool.terminal" not in plan.installed_after


def test_removal_needs_room_only_for_the_copy_of_what_it_removes(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    _desire(panel, set(FULL) - {"tool.terminal"})
    removed_bytes = sum(len(file_bytes(path)) for path in TERMINAL)

    plan = _plan(panel, make_release(), installed_panel_listing(panel.root))

    assert plan.required_free_bytes == removed_bytes * 6 // 5

    with pytest.raises(ModuleTransactionError) as raised:
        _plan(panel, make_release(), installed_panel_listing(panel.root), free_bytes=removed_bytes)
    assert raised.value.code == "module_free_space"


def test_adding_a_module_plans_only_the_files_that_are_not_there(tmp_path):
    panel = make_panel(tmp_path)
    installed = {"core", "tool.editor", "engine.xray"}
    _desire(panel, installed | {"tool.terminal"})
    release = make_release()

    plan = _plan(panel, release, _archive_listing(tmp_path, release))

    assert set(plan.files_add) == TERMINAL
    assert plan.files_remove == ()
    assert plan.archive is not None
    assert plan.archive.sha256 == release.catalog["panel"]["sha256"]


def test_swapping_engines_adds_one_and_removes_the_other(tmp_path):
    panel = make_panel(tmp_path)
    _desire(panel, {"core", "tool.editor", "engine.mihomo"}, profile="mihomo-minimal")
    release = make_release()

    plan = _plan(panel, release, _archive_listing(tmp_path, release))

    assert set(plan.files_add) == set(OWNERSHIP["engine.mihomo"])
    assert set(plan.files_remove) == set(OWNERSHIP["engine.xray"])


def test_a_kept_file_that_went_missing_is_laid_again(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    _desire(panel, set(FULL) - {"tool.terminal"})
    panel.path("static/js/core.js").unlink()
    release = make_release()

    plan = _plan(panel, release, _archive_listing(tmp_path, release))

    assert plan.files_add == ("static/js/core.js",)
    assert plan.archive is not None


# --- исполнение ---------------------------------------------------------------------


def test_removal_commits_without_the_network_and_leaves_other_files_alone(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    _desire(panel, set(FULL) - {"tool.terminal"})
    plan = _plan(panel, make_release(), installed_panel_listing(panel.root))
    kept = {path: panel.path(path).stat().st_mtime_ns for path in OWNERSHIP["engine.xray"] + OWNERSHIP["tool.files"]}

    assert _run(panel, plan, _NoNetwork()) == "committed"

    assert not any(panel.path(path).exists() for path in TERMINAL)
    # Остальные файлы не переписывались вовсе.
    assert {path: panel.path(path).stat().st_mtime_ns for path in kept} == kept
    assert panel.read_json("module-installed.json")["modules"]["tool.terminal"] is False
    assert "tool.terminal" not in panel.read_json("install-profile.json")["module_ids"]
    managed = set(panel.read_json("install-managed.json")["paths"])
    assert not managed & TERMINAL
    assert set(OWNERSHIP["engine.xray"]) <= managed
    assert panel.path("secret.key").read_bytes() == b"user secret\n"


def test_addition_lays_only_the_new_files(tmp_path):
    panel = make_panel(tmp_path)
    _desire(panel, {"core", "tool.editor", "engine.xray", "tool.terminal"})
    release = make_release()
    plan = _plan(panel, release, _archive_listing(tmp_path, release))
    kept = {path: panel.path(path).stat().st_mtime_ns for path in OWNERSHIP["engine.xray"]}

    assert _run(panel, plan, release.client(panel.state)) == "committed"

    assert all(panel.path(path).read_bytes() == file_bytes(path) for path in TERMINAL)
    assert {path: panel.path(path).stat().st_mtime_ns for path in kept} == kept
    managed = set(panel.read_json("install-managed.json")["paths"])
    assert TERMINAL <= managed and set(OWNERSHIP["engine.xray"]) <= managed
    assert panel.read_json("module-installed.json")["modules"]["tool.terminal"] is True


def test_removal_that_fails_the_health_check_puts_the_files_back(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    before = _payload(panel)
    _desire(panel, set(FULL) - {"tool.terminal"})
    desired = _payload(panel)
    plan = _plan(panel, make_release(), installed_panel_listing(panel.root))

    assert _run(panel, plan, _NoNetwork(), healthy=False) == "rolled_back"

    assert _payload(panel) == desired
    assert all(panel.path(path).read_bytes() == before[path] for path in TERMINAL)


def test_removal_interrupted_before_the_restart_is_undone_at_the_next_start(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    _desire(panel, set(FULL) - {"tool.terminal"})
    desired = _payload(panel)
    plan = _plan(panel, make_release(), installed_panel_listing(panel.root))

    class PowerCut(BaseException):
        pass

    def cut(step: str) -> None:
        if step == "restarting":
            raise PowerCut()

    with pytest.raises(PowerCut):
        _run(panel, plan, _NoNetwork(), on_step=cut)
    assert not panel.path("services/ws_pty.py").exists()

    assert recover(panel.root, panel.state) == "rolled_back"
    assert _payload(panel) == desired


# --- сервис --------------------------------------------------------------------------


def _panel_downloads(release) -> int:
    return release.transport.calls.count(release.panel_url)


def test_service_plans_a_removal_without_downloading_the_archive(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    registry.set_profile("custom", module_ids=[module for module in FULL if module != "tool.terminal"])
    release = make_release()
    service, _ = make_service(panel, release, registry=registry)

    payload = service.plan("profile-transition", None)

    assert payload["applicable"] is True
    assert payload["files_add"] == []
    assert set(payload["files_remove"]) == TERMINAL
    assert _panel_downloads(release) == 0
    assert not service.archive_cache_dir.exists() or not any(service.archive_cache_dir.iterdir())


def test_service_downloads_the_archive_only_when_files_have_to_be_added(tmp_path):
    panel = make_panel(tmp_path)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    registry.set_profile("mihomo-minimal")
    release = make_release()
    service, _ = make_service(panel, release, registry=registry)

    payload = service.plan("profile-transition", None)

    assert set(payload["files_add"]) == set(OWNERSHIP["engine.mihomo"])
    assert set(payload["files_remove"]) == set(OWNERSHIP["engine.xray"])
    assert _panel_downloads(release) == 1


def test_service_reports_no_room_for_a_removal_as_a_blocker(tmp_path, monkeypatch):
    panel = make_panel(tmp_path, installed=FULL)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    registry.set_profile("custom", module_ids=[module for module in FULL if module != "tool.terminal"])
    service, _ = make_service(panel, make_release(), registry=registry)
    monkeypatch.setattr("services.module_transactions.plan.shutil.disk_usage", lambda _path: SimpleNamespace(free=0))

    payload = service.plan("profile-transition", None)

    assert payload["blockers"][0]["code"] == "operation_free_space"


def test_service_refuses_a_panel_without_its_ownership_map(tmp_path):
    panel = make_panel(tmp_path, installed=FULL)
    registry = ModuleRegistry(str(panel.state), which=lambda _name: "/bin/tool")
    registry.set_profile("custom", module_ids=[module for module in FULL if module != "tool.terminal"])
    service, _ = make_service(panel, make_release(), registry=registry)
    panel.path("module-ownership.json").unlink()

    with pytest.raises(ModuleLifecycleError) as raised:
        service.plan("profile-transition", None)

    assert raised.value.code == "module_ownership_unavailable"
