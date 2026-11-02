from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

from services.module_transactions import plan as planner
from services.module_transactions.plan import (
    Plan,
    build_plan,
    load_ownership_map,
    plan_from_json,
    plan_to_json,
    read_installed_modules,
    read_panel_version,
)
from services.module_transactions.state import ModuleTransactionError
from tests.support.module_tx import (
    OWNERSHIP,
    VERSION,
    catalog_document,
    make_panel,
    make_release,
    publish_module_updates,
    snapshot,
)


ROOT = Path(__file__).resolve().parents[1]


def _code(operation: str, module_id: str, panel, **overrides) -> str:
    with pytest.raises(ModuleTransactionError) as raised:
        build_plan(operation, module_id, **{**panel.kwargs, **overrides})
    return raised.value.code


def test_install_plan_lists_exactly_the_module_files(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)

    plan = build_plan("install", "tool.terminal", **panel.kwargs)

    assert isinstance(plan, Plan)
    assert plan.operation == "install" and plan.module_id == "tool.terminal" and plan.version == VERSION
    assert plan.files_add == tuple(sorted(OWNERSHIP["tool.terminal"]))
    assert plan.files_remove == ()
    assert plan.archive is not None
    assert plan.archive.archive == f"xkeen-module-tool.terminal-{VERSION}.tar.gz"
    entry = next(item for item in panel.kwargs["catalog"]["modules"] if item["id"] == "tool.terminal")
    assert (plan.archive.size, plan.archive.sha256) == (entry["size"], entry["sha256"])
    assert plan.restart_required is True
    assert plan.installed_after == ("core", "engine.xray", "tool.editor", "tool.terminal")


def test_repair_plan_reinstalls_the_files_of_an_installed_module(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)

    plan = build_plan("repair", "engine.xray", **panel.kwargs)

    assert plan.files_add == tuple(sorted(OWNERSHIP["engine.xray"]))
    assert plan.files_remove == ()
    assert plan.installed_after == ("core", "engine.xray", "tool.editor")


def test_remove_plan_lists_only_files_present_on_disk(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    panel.path("static/js/terminal/_core.js").unlink()

    plan = build_plan("remove", "tool.terminal", **panel.kwargs)

    assert plan.files_add == ()
    assert plan.files_remove == (
        "services/ws_pty.py",
        "static/js/pages/terminal.lazy.entry.js",
        "static/js/pages/terminal.lazy.entry.js.gz",
    )
    assert plan.archive is None
    assert plan.installed_after == ("core", "engine.xray", "tool.editor")


def test_build_plan_writes_nothing(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    before = snapshot(tmp_path)

    build_plan("install", "tool.terminal", **panel.kwargs)

    assert snapshot(tmp_path) == before


def test_plan_json_round_trip(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    for operation, module_id in (("repair", "tool.terminal"), ("remove", "tool.terminal"), ("install", "tool.files")):
        plan = build_plan(operation, module_id, **panel.kwargs)

        encoded = json.loads(json.dumps(plan_to_json(plan)))

        assert plan_from_json(encoded) == plan


def test_plan_from_stage_8_3_json_defaults_to_module_scope() -> None:
    old = {
        "operation": "install",
        "module_id": "tool.files",
        "version": "2.10.0",
        "files_add": ["static/js/pages/file_manager.lazy.entry.js"],
        "files_remove": [],
        "archive": {"archive": "module.tar.gz", "size": 10, "sha256": "a" * 64},
        "required_free_bytes": 100,
        "restart_required": True,
        "installed_after": ["core", "tool.files"],
    }

    plan = plan_from_json(old)

    assert plan.scope == "module"
    assert plan.source_version == plan.target_version == plan.version == "2.10.0"
    assert plan.target_profile is None


@pytest.mark.parametrize(
    ("operation", "module_id"),
    [("upgrade", "tool.terminal"), ("update", "core"), ("install", "core"), ("remove", "core"), ("repair", "core"),
     ("install", "tool.editor"), ("remove", "tool.editor"), ("install", "tool.unknown")],
)
def test_forbidden_operations(tmp_path: Path, operation: str, module_id: str) -> None:
    assert _code(operation, module_id, make_panel(tmp_path)) == "module_operation_forbidden"


def test_editor_can_be_repaired(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)

    assert build_plan("repair", "tool.editor", **panel.kwargs).files_add == OWNERSHIP["tool.editor"]


def test_catalog_of_another_release_is_refused(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)

    assert _code("install", "tool.terminal", panel, catalog=catalog_document("2.10.1")) == "module_version_mismatch"


def test_module_entry_of_another_version_is_refused(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    catalog = catalog_document(VERSION)
    next(item for item in catalog["modules"] if item["id"] == "tool.terminal")["version"] = "2.10.1"

    assert _code("install", "tool.terminal", panel, catalog=catalog) == "module_version_mismatch"


def test_module_missing_from_the_catalog_is_refused(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    catalog = catalog_document(VERSION)
    catalog["modules"] = [item for item in catalog["modules"] if item["id"] != "tool.terminal"]

    assert _code("install", "tool.terminal", panel, catalog=catalog) == "catalog_module_unknown"


def test_unsupported_architecture_is_refused(tmp_path: Path) -> None:
    assert _code("install", "tool.terminal", make_panel(tmp_path), architecture="armv7") == "catalog_architecture_unsupported"


def test_install_of_an_installed_module_is_refused(tmp_path: Path) -> None:
    assert _code("install", "engine.xray", make_panel(tmp_path)) == "module_already_installed"


@pytest.mark.parametrize("operation", ["repair", "remove", "update"])
def test_repair_and_remove_need_an_installed_module(tmp_path: Path, operation: str) -> None:
    assert _code(operation, "tool.terminal", make_panel(tmp_path)) == "module_not_installed"


def test_install_needs_its_dependencies(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core",))

    with pytest.raises(ModuleTransactionError) as raised:
        build_plan("install", "engine.mihomo", **panel.kwargs)

    assert raised.value.code == "module_dependency_missing"
    assert raised.value.details["module_ids"] == ["tool.editor"]


def test_install_refuses_a_conflicting_installed_module(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    catalog = catalog_document(VERSION)
    next(item for item in catalog["modules"] if item["id"] == "tool.terminal")["conflicts"] = ["engine.xray"]

    assert _code("install", "tool.terminal", panel, catalog=catalog) == "module_conflict"


def test_remove_refuses_a_module_others_depend_on(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    catalog = catalog_document(VERSION)
    next(item for item in catalog["modules"] if item["id"] == "engine.xray")["requires"] = ["core", "tool.editor", "tool.terminal"]
    installed = json.loads(panel.path("module-installed.json").read_text(encoding="utf-8"))
    installed["modules"]["tool.terminal"] = True
    panel.path("module-installed.json").write_text(json.dumps(installed), encoding="utf-8")

    with pytest.raises(ModuleTransactionError) as raised:
        build_plan("remove", "tool.terminal", **{**panel.kwargs, "catalog": catalog})

    assert raised.value.code == "module_required_by"
    assert raised.value.details["module_ids"] == ["engine.xray"]


def test_remove_refuses_a_running_engine(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "engine.mihomo"))

    assert _code("remove", "engine.xray", panel, active_engines=frozenset({"engine.xray"})) == "module_engine_active"
    assert build_plan("remove", "engine.mihomo", **panel.kwargs, active_engines=frozenset({"engine.xray"}))


def test_remove_refuses_the_only_engine(tmp_path: Path) -> None:
    # Without an engine the panel has nothing to manage: the last one stays.
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray"))
    assert _code("remove", "engine.xray", panel) == "module_last_engine"

    mirror = make_panel(tmp_path / "mihomo", installed=("core", "tool.editor", "engine.mihomo"))
    assert _code("remove", "engine.mihomo", mirror) == "module_last_engine"


def test_user_owned_path_in_the_map_is_refused(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    data = json.loads(panel.path("module-ownership.json").read_text(encoding="utf-8"))
    data["modules"]["tool.terminal"].append("secret.key")
    panel.path("module-ownership.json").write_text(json.dumps(data), encoding="utf-8")

    with pytest.raises(ModuleTransactionError) as raised:
        build_plan("install", "tool.terminal", **panel.kwargs)

    assert raised.value.code == "module_ownership_conflict"
    assert raised.value.details["path"] == "secret.key"


@pytest.mark.parametrize("unsafe", ["../outside.py", "/etc/passwd", "static/../../x", "static\\x.js", ""])
def test_unsafe_path_in_the_map_is_refused(tmp_path: Path, unsafe: str) -> None:
    panel = make_panel(tmp_path)
    data = json.loads(panel.path("module-ownership.json").read_text(encoding="utf-8"))
    data["modules"]["tool.terminal"].append(unsafe)
    panel.path("module-ownership.json").write_text(json.dumps(data), encoding="utf-8")

    assert _code("install", "tool.terminal", panel) == "module_ownership_conflict"


def test_path_listed_for_two_modules_is_refused(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    data = json.loads(panel.path("module-ownership.json").read_text(encoding="utf-8"))
    data["modules"]["tool.terminal"].append("app.py")
    panel.path("module-ownership.json").write_text(json.dumps(data), encoding="utf-8")

    assert _code("install", "tool.terminal", panel) == "module_ownership_conflict"


def test_not_enough_free_space_is_refused(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    plan = build_plan("install", "tool.terminal", **panel.kwargs)

    assert plan.required_free_bytes > plan.archive.size
    with pytest.raises(ModuleTransactionError) as raised:
        build_plan("install", "tool.terminal", **{**panel.kwargs, "free_bytes": plan.required_free_bytes - 1})
    assert raised.value.code == "module_free_space"
    assert raised.value.details == {"required": plan.required_free_bytes, "free": plan.required_free_bytes - 1}
    assert build_plan("install", "tool.terminal", **{**panel.kwargs, "free_bytes": plan.required_free_bytes})


def test_free_space_is_measured_on_the_panel_filesystem_by_default(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    kwargs = dict(panel.kwargs)
    kwargs.pop("free_bytes")

    assert build_plan("install", "tool.terminal", **kwargs).required_free_bytes > 0


def test_panel_without_an_ownership_map_supports_no_operation(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    panel.path("module-ownership.json").unlink()

    for operation, module_id in (("install", "tool.terminal"), ("repair", "engine.xray"), ("remove", "engine.xray")):
        assert _code(operation, module_id, panel) == "module_ownership_unavailable"


@pytest.mark.parametrize("body", ["{broken", "[]", '{"schema_version": 2, "modules": {}, "frontend": {}}', '{"schema_version": 1}'])
def test_unreadable_ownership_map_is_unavailable(tmp_path: Path, body: str) -> None:
    panel = make_panel(tmp_path)
    panel.path("module-ownership.json").write_text(body, encoding="utf-8")

    with pytest.raises(ModuleTransactionError) as raised:
        load_ownership_map(panel.root)

    assert raised.value.code == "module_ownership_unavailable"


@pytest.mark.parametrize("version", ["a1b2c3d", "a1b2c3d-dirty", "2.9.2a", "", None, 7])
def test_panel_build_without_a_release_version_is_unsupported(tmp_path: Path, version) -> None:
    panel = make_panel(tmp_path)
    panel.path("BUILD.json").write_text(json.dumps({"version": version}), encoding="utf-8")

    with pytest.raises(ModuleTransactionError) as raised:
        read_panel_version(panel.root)

    assert raised.value.code == "panel_version_unsupported"


def test_panel_version_accepts_a_leading_v_of_a_release_tag(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    panel.path("BUILD.json").write_text(json.dumps({"version": "v2.10.0"}), encoding="utf-8")

    assert read_panel_version(panel.root) == "2.10.0"


def test_panel_without_build_json_is_unsupported(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    panel.path("BUILD.json").unlink()

    assert _code("install", "tool.terminal", panel) == "panel_version_unsupported"


def test_installed_modules_come_from_the_install_manifest(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)

    assert read_installed_modules(panel.state) == frozenset({"core", "tool.editor", "engine.xray"})

    panel.path("module-installed.json").write_text("{broken", encoding="utf-8")

    with pytest.raises(ModuleTransactionError) as raised:
        read_installed_modules(panel.state)
    assert raised.value.code == "module_state_unavailable"


def test_user_owned_rules_match_the_profile_installer() -> None:
    spec = importlib.util.spec_from_file_location(
        "module_profile_install", ROOT / "xkeen-ui" / "scripts" / "module_profile_install.py"
    )
    installer = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = installer
    spec.loader.exec_module(installer)

    assert planner.STATE_FILES == installer.STATE_FILES
    assert planner.USER_TOP_LEVEL == installer.USER_TOP_LEVEL
    assert planner.USER_FILES == installer.USER_FILES
    assert planner.USER_PREFIXES == installer.USER_PREFIXES
    for path in ("secret.key", "bin/tool", "var/log/x", "opt/etc/mihomo/config.yaml", "install.sh",
                 "opt/etc/mihomo/profiles/a.yaml", "modules.json", "routes/mihomo.py", "static/js/core.js"):
        assert planner.user_owned(path) == installer._user_owned(path), path


# --- Новейшая запись каталога: обновления модулей ---------------------------


def _effective_catalog(panel, versions: dict[str, str], **kwargs) -> dict:
    """The catalog the panel acts on: the release with the signed update entries merged in."""

    release = make_release(panel.version)
    publish_module_updates(release, versions, **kwargs)
    return dict(release.client(panel.state).get_effective_catalog(panel.version).catalog)


def _record_installed_versions(panel, versions: dict[str, str]) -> None:
    record = panel.read_json("module-installed.json")
    record["versions"] = versions
    panel.path("module-installed.json").write_text(json.dumps(record), encoding="utf-8")


def test_update_entry_is_accepted_though_version_differs_from_panel(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    catalog = _effective_catalog(panel, {"tool.terminal": "1.0.1"})

    plan = build_plan("install", "tool.terminal", **{**panel.kwargs, "catalog": catalog})

    assert plan.version == VERSION
    assert plan.module_version == "1.0.1"
    assert plan.archive is not None and plan.archive.archive == "xkeen-module-tool.terminal-1.0.1.tar.gz"
    assert plan.module_files == tuple(sorted(OWNERSHIP["tool.terminal"]))
    assert plan.files_add == plan.module_files


@pytest.mark.parametrize("marker", [None, False, "true", 1])
def test_release_entry_with_foreign_version_is_still_refused(tmp_path: Path, marker) -> None:
    panel = make_panel(tmp_path)
    catalog = catalog_document(VERSION)
    entry = next(item for item in catalog["modules"] if item["id"] == "tool.terminal")
    entry["version"] = "1.0.1"
    if marker is not None:
        entry["update_entry"] = marker

    assert _code("install", "tool.terminal", panel, catalog=catalog) == "module_version_mismatch"


def test_release_entry_plan_takes_the_module_version_of_the_panel_build(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    panel.path("module-versions.json").write_text('{"engine.xray": "1.2.0"}', encoding="utf-8")

    plan = build_plan("repair", "engine.xray", **panel.kwargs)

    assert plan.module_version == "1.2.0"
    assert plan.module_files is None
    assert plan.files_add == tuple(sorted(OWNERSHIP["engine.xray"]))


def test_repair_lays_newest_entry_and_records_version(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    files = (*OWNERSHIP["engine.xray"], "services/xray_routing_helpers.py")
    catalog = _effective_catalog(panel, {"engine.xray": "1.0.1"}, ownership={"engine.xray": files})

    plan = build_plan("repair", "engine.xray", **{**panel.kwargs, "catalog": catalog})

    assert plan.module_version == "1.0.1"
    assert plan.module_files == tuple(sorted(files))
    assert plan.files_add == tuple(sorted(files))
    assert plan.archive is not None and plan.archive.archive == "xkeen-module-engine.xray-1.0.1.tar.gz"
    assert plan_from_json(json.loads(json.dumps(plan_to_json(plan)))) == plan


def test_update_entry_claiming_a_file_of_another_module_is_refused(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    files = (*OWNERSHIP["engine.xray"], "routes/mihomo.py")
    catalog = _effective_catalog(panel, {"engine.xray": "1.0.1"}, ownership={"engine.xray": files})

    assert _code("repair", "engine.xray", panel, catalog=catalog) == "module_ownership_conflict"


def test_repair_refuses_when_installed_is_newer_than_entry(tmp_path: Path) -> None:
    # установлено 1.0.3, каталог обновлений недоступен
    panel = make_panel(tmp_path)
    _record_installed_versions(panel, {"engine.xray": "1.0.3"})

    with pytest.raises(ModuleTransactionError) as caught:
        build_plan("repair", "engine.xray", **panel.kwargs)
    assert caught.value.code == "module_update_catalog_unavailable"

    older = _effective_catalog(make_panel(tmp_path / "older"), {"engine.xray": "1.0.2"})
    assert _code("repair", "engine.xray", panel, catalog=older) == "module_update_catalog_unavailable"

    same = _effective_catalog(make_panel(tmp_path / "same"), {"engine.xray": "1.0.3"})
    assert build_plan("repair", "engine.xray", **{**panel.kwargs, "catalog": same}).module_version == "1.0.3"


def test_install_after_remove_takes_newest_entry(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "tool.terminal"))
    catalog = _effective_catalog(panel, {"tool.terminal": "1.0.1"})
    removal = build_plan("remove", "tool.terminal", **{**panel.kwargs, "catalog": catalog})
    assert removal.module_version is None and removal.module_files is None

    removed = make_panel(tmp_path / "removed")
    plan = build_plan("install", "tool.terminal", **{**removed.kwargs, "catalog": catalog})

    assert plan.module_version == "1.0.1"
    assert plan.archive is not None and plan.archive.archive == "xkeen-module-tool.terminal-1.0.1.tar.gz"


def test_plan_from_old_journal_has_no_module_version() -> None:
    old = {
        "scope": "module",
        "operation": "repair",
        "module_id": "tool.files",
        "version": "2.10.0",
        "source_version": "2.10.0",
        "target_version": "2.10.0",
        "target_profile": None,
        "files_add": ["static/js/pages/file_manager.lazy.entry.js"],
        "files_remove": [],
        "archive": {"archive": "module.tar.gz", "size": 10, "sha256": "a" * 64},
        "required_free_bytes": 100,
        "restart_required": True,
        "installed_after": ["core", "tool.files"],
    }

    plan = plan_from_json(old)

    assert plan.module_version is None
    assert plan.module_files is None


# --- Операция update ----------------------------------------------------------

DIAGNOSTICS = "tool.advanced-diagnostics"
INSTALLED_WITH_DIAGNOSTICS = ("core", "tool.editor", "engine.xray", DIAGNOSTICS)


def test_update_plan_removes_old_files_and_adds_new(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=INSTALLED_WITH_DIAGNOSTICS)
    old_files = set(OWNERSHIP[DIAGNOSTICS])
    new_files = {"routes/system_resources.py", "static/js/features/resource_history.js"}
    catalog = _effective_catalog(panel, {DIAGNOSTICS: "1.0.1"}, ownership={DIAGNOSTICS: tuple(new_files)})

    plan = build_plan("update", DIAGNOSTICS, **{**panel.kwargs, "catalog": catalog})

    assert plan.operation == "update" and plan.module_id == DIAGNOSTICS
    assert plan.files_add == tuple(sorted(new_files))
    assert plan.files_remove == tuple(sorted(old_files - new_files))
    assert plan.module_version == "1.0.1"
    assert plan.module_files == tuple(sorted(new_files))
    assert plan.archive is not None and plan.archive.archive == f"xkeen-module-{DIAGNOSTICS}-1.0.1.tar.gz"
    assert plan.installed_after == tuple(sorted(INSTALLED_WITH_DIAGNOSTICS))
    assert plan_from_json(json.loads(json.dumps(plan_to_json(plan)))) == plan


def test_update_space_is_counted_like_a_repair(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=INSTALLED_WITH_DIAGNOSTICS)
    catalog = _effective_catalog(panel, {DIAGNOSTICS: "1.0.1"})

    update = build_plan("update", DIAGNOSTICS, **{**panel.kwargs, "catalog": catalog})
    repair = build_plan("repair", DIAGNOSTICS, **{**panel.kwargs, "catalog": catalog})

    assert update.required_free_bytes == repair.required_free_bytes > 0
    required = update.required_free_bytes
    assert _code("update", DIAGNOSTICS, panel, catalog=catalog, free_bytes=required - 1) == "module_free_space"


def test_update_without_newer_entry_is_blocked(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=INSTALLED_WITH_DIAGNOSTICS)

    # Только каталог выпуска: обновлять нечем.
    assert _code("update", DIAGNOSTICS, panel) == "module_update_not_available"

    # Запись той же версии, что установлена, — тоже не обновление.
    _record_installed_versions(panel, {DIAGNOSTICS: "1.0.1"})
    same = _effective_catalog(make_panel(tmp_path / "same"), {DIAGNOSTICS: "1.0.1"})
    assert _code("update", DIAGNOSTICS, panel, catalog=same) == "module_update_not_available"


def test_update_of_not_installed_module_is_refused(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    catalog = _effective_catalog(panel, {DIAGNOSTICS: "1.0.1"})

    assert _code("update", DIAGNOSTICS, panel, catalog=catalog) == "module_not_installed"


def test_editor_module_can_be_updated(tmp_path: Path) -> None:
    panel = make_panel(tmp_path)
    catalog = _effective_catalog(panel, {"tool.editor": "1.0.1"})

    plan = build_plan("update", "tool.editor", **{**panel.kwargs, "catalog": catalog})

    assert plan.module_version == "1.0.1"
    assert plan.files_add == tuple(sorted(OWNERSHIP["tool.editor"]))


def test_entry_claiming_foreign_file_is_a_conflict(tmp_path: Path) -> None:
    panel = make_panel(tmp_path, installed=INSTALLED_WITH_DIAGNOSTICS)
    files = (*OWNERSHIP[DIAGNOSTICS], "routes/routing/__init__.py")
    catalog = _effective_catalog(panel, {DIAGNOSTICS: "1.0.1"}, ownership={DIAGNOSTICS: files})

    assert _code("update", DIAGNOSTICS, panel, catalog=catalog) == "module_ownership_conflict"
