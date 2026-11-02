"""Фактическая принадлежность файлов модуля после его отдельного обновления.

Модуль, поставленный из записи каталога обновлений, состоит из тех файлов,
которые назвала запись. Панель хранит этот список в
``module-ownership-overrides.json``, и каждая операция — модуля, профиля,
обновления панели, переустановки — должна работать по нему, а не по карте
выпуска.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

from services import panel_service_data
from services.module_profile_plan import STATE_FILENAMES, user_owned
from services.module_transactions import plan as planner
from services.module_transactions.executor import run_operation
from services.module_transactions.install_state import state_file_updates
from services.module_transactions.journal import Journal
from services.module_transactions.ownership_overrides import (
    OVERRIDES_FILENAME,
    effective_ownership,
    read_overrides,
)
from services.module_transactions.plan import (
    build_panel_rollback_plan,
    build_panel_update_plan,
    build_plan,
    build_profile_transition_plan,
    installed_panel_listing,
)
from services.module_transactions.state import ModuleTransactionError
from services.panel_package_contract import validate_panel_archive
from tests.support.module_tx import (
    ARCHITECTURE,
    FRONTEND,
    MODULE_ORDER,
    OWNERSHIP,
    file_bytes,
    make_panel,
    make_release,
    publish_module_updates,
)


ROOT = Path(__file__).resolve().parents[1]
EXTRA = "services/xray_routing_helpers.py"
MIHOMO_EXTRA = "services/mihomo_helpers.py"
UPDATED = "1.0.1"
NEW = "2.11.0"


@pytest.fixture
def tree(tmp_path: Path):
    return make_panel(tmp_path, installed=("core", "tool.editor", "engine.xray", "engine.mihomo"))


def _installer():
    spec = importlib.util.spec_from_file_location(
        "module_profile_install", ROOT / "xkeen-ui" / "scripts" / "module_profile_install.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _json(payload: bytes):
    return json.loads(payload.decode("utf-8"))


def _update_module(panel, module_id: str, files: tuple[str, ...]) -> None:
    """The module the way an update entry leaves it: its files, the record, the managed list."""

    for relative in files:
        target = panel.path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(file_bytes(relative, UPDATED))
    overrides = {}
    if panel.path(OVERRIDES_FILENAME).is_file():
        overrides = panel.read_json(OVERRIDES_FILENAME)["modules"]
    overrides[module_id] = sorted(files)
    _write_json(panel.path(OVERRIDES_FILENAME), {"schema_version": 1, "modules": overrides})
    installed = panel.read_json("module-installed.json")
    installed.setdefault("versions", {})[module_id] = UPDATED
    _write_json(panel.path("module-installed.json"), installed)
    managed = panel.read_json("install-managed.json")
    managed["paths"] = sorted(set(managed["paths"]) | set(files))
    _write_json(panel.path("install-managed.json"), managed)


def _run(panel, plan, client) -> str:
    journal = Journal.create(panel.root, plan, f"op-{plan.operation}-{plan.module_id or 'all'}", extra={})
    return run_operation(
        journal,
        state_dir=panel.state,
        client=client,
        architecture=ARCHITECTURE,
        restart=lambda: None,
        wait_healthy=lambda phase: True,
    )


def _repair_to_update(panel, module_id: str, files: tuple[str, ...]) -> None:
    """The module updated the way the panel does it: a repair that lays a signed update entry."""

    release = make_release(panel.version)
    publish_module_updates(release, {module_id: UPDATED}, ownership={module_id: files})
    client = release.client(panel.state)
    catalog = dict(client.get_effective_catalog(panel.version).catalog)
    plan = build_plan("repair", module_id, **{**panel.kwargs, "catalog": catalog})
    assert _run(panel, plan, client) == "committed"


def _set_desired(panel, profile: str, selected: set[str], variant: str = "light") -> None:
    state = panel.read_json("modules.json")
    state["profile"] = profile
    state["editor"] = {"variant": variant}
    state["modules"] = {module_id: {"enabled": module_id in selected} for module_id in MODULE_ORDER}
    state["physical_request"] = {
        "profile": profile,
        "module_ids": [module_id for module_id in MODULE_ORDER if module_id in selected],
        "editor_variant": variant,
    }
    _write_json(panel.path("modules.json"), state)


def _release_tree(tmp_path: Path, version: str) -> Path:
    root = tmp_path / f"target-{version}" / "xkeen-ui"
    for paths in OWNERSHIP.values():
        for relative in paths:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(file_bytes(relative, version))
    _write_json(
        root / "module-ownership.json",
        {"schema_version": 1, "modules": {module_id: list(paths) for module_id, paths in OWNERSHIP.items()}, "frontend": FRONTEND},
    )
    return root


def _code(call) -> str:
    with pytest.raises(ModuleTransactionError) as raised:
        call()
    return raised.value.code


def test_override_replaces_module_files(tree):
    files = (*OWNERSHIP["engine.xray"], EXTRA)
    _update_module(tree, "engine.xray", files)

    effective = effective_ownership(tree.root, tree.state)

    assert read_overrides(tree.state) == {"engine.xray": tuple(sorted(files))}
    assert effective.modules["engine.xray"] == tuple(sorted(files))
    assert effective.modules["engine.mihomo"] == tuple(OWNERSHIP["engine.mihomo"])
    assert effective.frontend == {"bridge": FRONTEND["bridge"], "build": FRONTEND["build"]}
    listing = installed_panel_listing(tree.root, tree.state)
    assert listing["ownership"]["modules"]["engine.xray"] == sorted(files)
    assert EXTRA in listing["payload_sizes"]
    # Без каталога состояния листинг остаётся картой выпуска.
    assert EXTRA not in installed_panel_listing(tree.root)["payload_sizes"]


def test_missing_override_file_reads_empty(tree):
    assert read_overrides(tree.state) == {}
    assert effective_ownership(tree.root, tree.state).modules["engine.xray"] == tuple(OWNERSHIP["engine.xray"])


def test_override_claiming_core_file_is_a_conflict(tree):
    _update_module(tree, "engine.xray", (*OWNERSHIP["engine.xray"], "app.py"))

    assert _code(lambda: effective_ownership(tree.root, tree.state)) == "module_ownership_conflict"
    assert _code(lambda: build_plan("remove", "engine.mihomo", **tree.kwargs)) == "module_ownership_conflict"


def test_override_claiming_user_file_is_a_conflict(tree):
    _write_json(
        tree.path(OVERRIDES_FILENAME),
        {"schema_version": 1, "modules": {"engine.xray": [*OWNERSHIP["engine.xray"], "secret.key"]}},
    )

    assert _code(lambda: effective_ownership(tree.root, tree.state)) == "module_ownership_conflict"


@pytest.mark.parametrize("body", ["{", "[]", '{"schema_version": 2, "modules": {}}', '{"schema_version": 1, "modules": {"engine.xray": "a"}}'])
def test_broken_override_file_is_refused(tree, body):
    tree.path(OVERRIDES_FILENAME).write_text(body, encoding="utf-8")

    assert _code(lambda: read_overrides(tree.state)) == "module_ownership_unavailable"
    assert _code(lambda: build_plan("repair", "engine.xray", **tree.kwargs)) == "module_ownership_unavailable"
    assert _code(lambda: installed_panel_listing(tree.root, tree.state)) == "module_ownership_unavailable"


def test_remove_takes_the_files_of_the_updated_module(tree):
    files = (*OWNERSHIP["engine.mihomo"], MIHOMO_EXTRA)
    _update_module(tree, "engine.mihomo", files)

    plan = build_plan("remove", "engine.mihomo", **tree.kwargs)

    assert plan.files_remove == tuple(sorted(files))
    updates = state_file_updates(tree.root, plan)
    assert _json(updates[OVERRIDES_FILENAME]) == {"schema_version": 1, "modules": {}}
    # Версии пишет задача обновления модулей; здесь их не трогают.
    assert _json(updates["module-installed.json"])["versions"] == {"engine.mihomo": UPDATED}


def test_install_of_update_entry_records_its_files(tmp_path: Path):
    panel = make_panel(tmp_path)
    files = (*OWNERSHIP["tool.terminal"], "static/js/terminal/extra.js")
    release = make_release(panel.version)
    publish_module_updates(release, {"tool.terminal": UPDATED}, ownership={"tool.terminal": files})
    catalog = dict(release.client(panel.state).get_effective_catalog(panel.version).catalog)

    plan = build_plan("install", "tool.terminal", **{**panel.kwargs, "catalog": catalog})
    updates = state_file_updates(panel.root, plan)

    assert _json(updates[OVERRIDES_FILENAME]) == {"schema_version": 1, "modules": {"tool.terminal": sorted(files)}}


def test_release_entry_repair_drops_the_record(tree):
    _update_module(tree, "engine.xray", (*OWNERSHIP["engine.xray"], EXTRA))
    installed = tree.read_json("module-installed.json")
    installed.pop("versions")
    _write_json(tree.path("module-installed.json"), installed)

    plan = build_plan("repair", "engine.xray", **tree.kwargs)

    # Запись выпуска кладёт файлы карты панели, а не прежний список обновления.
    assert plan.files_add == tuple(sorted(OWNERSHIP["engine.xray"]))
    # Файл, который принесло обновление, а выпуск не знает, уходит вместе с записью.
    assert plan.files_remove == (EXTRA,)
    updates = state_file_updates(tree.root, plan)
    assert _json(updates[OVERRIDES_FILENAME]) == {"schema_version": 1, "modules": {}}
    assert EXTRA not in _json(updates["install-managed.json"])["paths"]


def test_repair_to_entry_without_a_file_removes_it(tree):
    _update_module(tree, "engine.xray", (*OWNERSHIP["engine.xray"], EXTRA))
    catalog_release = make_release(tree.version)
    publish_module_updates(catalog_release, {"engine.xray": "1.0.2"})
    catalog = dict(catalog_release.client(tree.state).get_effective_catalog(tree.version).catalog)

    plan = build_plan("repair", "engine.xray", **{**tree.kwargs, "catalog": catalog})

    assert plan.files_add == tuple(sorted(OWNERSHIP["engine.xray"]))
    assert plan.files_remove == (EXTRA,)
    assert _json(state_file_updates(tree.root, plan)[OVERRIDES_FILENAME])["modules"] == {
        "engine.xray": sorted(OWNERSHIP["engine.xray"])
    }


def test_profile_transition_keeps_updated_module(tree, tmp_path: Path):
    files = (*OWNERSHIP["engine.xray"], EXTRA)
    _update_module(tree, "engine.xray", files)
    _set_desired(tree, "custom", {"core", "tool.editor", "engine.xray", "engine.mihomo", "tool.files"})
    release = make_release(tree.version)
    common = dict(
        panel_root=tree.root, state_dir=tree.state, catalog=release.catalog, architecture=ARCHITECTURE, free_bytes=1 << 40
    )

    for target in (
        {"target_archive": installed_panel_listing(tree.root, tree.state)},
        {"target_panel_root": _release_tree(tmp_path, tree.version)},
    ):
        plan = build_profile_transition_plan(**common, **target)

        assert plan.files_add == tuple(sorted(OWNERSHIP["tool.files"]))
        assert plan.files_remove == ()
        assert not set(files) & (set(plan.files_add) | set(plan.files_remove))
        updates = state_file_updates(tree.root, plan)
        assert _json(updates[OVERRIDES_FILENAME])["modules"] == {"engine.xray": sorted(files)}
        assert set(files) <= set(_json(updates["install-managed.json"])["paths"])


def test_repair_with_update_entry_records_its_new_files_as_managed(tree):
    files = (*OWNERSHIP["engine.xray"], EXTRA)
    release = make_release(tree.version)
    publish_module_updates(release, {"engine.xray": UPDATED}, ownership={"engine.xray": files})
    catalog = dict(release.client(tree.state).get_effective_catalog(tree.version).catalog)

    plan = build_plan("repair", "engine.xray", **{**tree.kwargs, "catalog": catalog})

    assert plan.files_remove == ()
    updates = state_file_updates(tree.root, plan)
    assert EXTRA in _json(updates["install-managed.json"])["paths"]
    assert _json(updates[OVERRIDES_FILENAME])["modules"] == {"engine.xray": sorted(files)}

    _repair_to_update(tree, "engine.xray", files)

    assert tree.path(EXTRA).read_bytes() == file_bytes(EXTRA, UPDATED)
    assert EXTRA in tree.read_json("install-managed.json")["paths"]
    assert tree.read_json(OVERRIDES_FILENAME)["modules"] == {"engine.xray": sorted(files)}


def test_profile_transition_dropping_module_clears_its_override(tree):
    _repair_to_update(tree, "engine.xray", (*OWNERSHIP["engine.xray"], EXTRA))
    mihomo_files = (*OWNERSHIP["engine.mihomo"], MIHOMO_EXTRA)
    _repair_to_update(tree, "engine.mihomo", mihomo_files)
    _set_desired(tree, "xray-minimal", {"core", "tool.editor", "engine.xray"})
    release = make_release(tree.version)
    plan = build_profile_transition_plan(
        panel_root=tree.root,
        state_dir=tree.state,
        catalog=release.catalog,
        target_archive=installed_panel_listing(tree.root, tree.state),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )
    assert plan.files_remove == tuple(sorted(mihomo_files))

    journal = Journal.create(tree.root, plan, "full-scope-operation", extra={})
    result = run_operation(
        journal,
        state_dir=tree.state,
        client=release.client(tree.state),
        architecture=ARCHITECTURE,
        restart=lambda: None,
        wait_healthy=lambda phase: True,
    )

    assert result == "committed"
    assert not tree.path(MIHOMO_EXTRA).exists()
    assert tree.path(EXTRA).read_bytes() == file_bytes(EXTRA, UPDATED)
    assert tree.read_json(OVERRIDES_FILENAME) == {
        "schema_version": 1,
        "modules": {"engine.xray": sorted((*OWNERSHIP["engine.xray"], EXTRA))},
    }


def test_panel_update_clears_overrides_and_versions(tree, tmp_path: Path):
    files = (*OWNERSHIP["engine.xray"], EXTRA)
    _repair_to_update(tree, "engine.xray", files)
    # Версии запишет задача обновления модулей; здесь запись кладётся рукой.
    installed = tree.read_json("module-installed.json")
    installed["versions"] = {"engine.xray": UPDATED}
    _write_json(tree.path("module-installed.json"), installed)
    overrides_before = tree.path(OVERRIDES_FILENAME).read_bytes()
    installed_before = tree.path("module-installed.json").read_bytes()
    release = make_release(version=NEW)
    archive = tmp_path / "checked" / "panel.tar.gz"
    archive.parent.mkdir(parents=True)
    archive.write_bytes(release.panel)
    plan = build_panel_update_plan(
        panel_root=tree.root,
        state_dir=tree.state,
        catalog=release.catalog,
        target_archive=validate_panel_archive(archive, release.catalog["panel"], platform_architecture=ARCHITECTURE),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )
    assert EXTRA in plan.files_remove

    assert _run(tree, plan, release.client(tree.state, core_version=plan.source_version)) == "committed"

    assert not tree.path(EXTRA).exists()
    assert tree.read_json(OVERRIDES_FILENAME) == {"schema_version": 1, "modules": {}}
    assert "versions" not in tree.read_json("module-installed.json")
    assert EXTRA not in tree.read_json("install-managed.json")["paths"]

    # Возврат на прежнюю версию кладёт запись о файлах вместе с записью модулей:
    # обе переписало обновление, обе лежат в его копии.
    back = build_panel_rollback_plan(panel_root=tree.root, state_dir=tree.state, free_bytes=1 << 40)
    assert {OVERRIDES_FILENAME, "module-installed.json"} <= set(back.files_add)
    assert _run(tree, back, None) == "committed"

    assert tree.path(OVERRIDES_FILENAME).read_bytes() == overrides_before
    assert tree.path("module-installed.json").read_bytes() == installed_before
    assert tree.path(EXTRA).read_bytes() == file_bytes(EXTRA, UPDATED)


def test_installer_clears_overrides_and_versions(tree, tmp_path: Path):
    _update_module(tree, "engine.xray", (*OWNERSHIP["engine.xray"], EXTRA))
    source = tmp_path / "release" / "xkeen-ui"
    for paths in OWNERSHIP.values():
        for relative in paths:
            if relative.startswith("static/frontend-build/") or relative == "module-ownership.json":
                continue
            target = source.joinpath(*relative.split("/"))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"# release file\n")

    _installer().apply_profile(
        source, tree.root, "xray-minimal", transaction_root=tmp_path / "profile-tx"
    )

    assert tree.read_json(OVERRIDES_FILENAME) == {"schema_version": 1, "modules": {}}
    assert "versions" not in tree.read_json("module-installed.json")
    assert read_overrides(tree.state) == {}


def test_overrides_file_is_never_user_owned_or_payload(tree):
    installer = _installer()

    assert OVERRIDES_FILENAME in planner.STATE_FILES
    assert OVERRIDES_FILENAME in installer.STATE_FILES
    assert OVERRIDES_FILENAME in STATE_FILENAMES
    assert OVERRIDES_FILENAME not in planner.USER_FILES
    assert OVERRIDES_FILENAME not in installer.USER_FILES
    # Ни один модуль не может назвать этот файл своим.
    assert user_owned(OVERRIDES_FILENAME)
    _write_json(
        tree.path(OVERRIDES_FILENAME),
        {"schema_version": 1, "modules": {"engine.xray": [*OWNERSHIP["engine.xray"], OVERRIDES_FILENAME]}},
    )
    assert _code(lambda: effective_ownership(tree.root, tree.state)) == "module_ownership_conflict"
    protected = {Path(path).name for path, _ in panel_service_data.protected_panel_paths(str(tree.state))}
    assert OVERRIDES_FILENAME in protected
