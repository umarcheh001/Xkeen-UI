"""Панель принимает релиз, в котором состав модулей уже не тот, что у неё.

Установленная панель сверяла новый релиз со своим списком модулей: стоило в
следующем релизе добавить модуль, убрать модуль или поменять зависимость — и она
отказывалась его принять, причём уже на проверке обновлений. Починить это
«потом» нечем: исправление должно стоять в той панели, которая на роутере.

Теперь строгая сверка с собственным списком остаётся только для каталога своей
версии. Чужому релизу доверие даёт подпись; от него требуется только быть
согласованным внутри себя. Профиль после обновления считается по новому релизу.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from services.module_catalog_client import CatalogClientError
from services.module_transactions.executor import run_operation
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_panel_update_plan
from services.module_transactions.state import ModuleTransactionError
from services.panel_package_contract import validate_panel_archive
from tests.support.module_tx import ARCHITECTURE, OWNERSHIP, file_bytes, make_panel, make_release


OLD, NEW = "2.10.0", "2.11.0"

# Модуль, которого установленная панель не знает.
NEW_MODULE = "tool.traffic-map"
NEW_FILES = ("routes/traffic_map.py", "static/js/pages/traffic_map.entry.js")
WITH_NEW_MODULE = {**OWNERSHIP, NEW_MODULE: NEW_FILES}
NEW_DEFINITION = {NEW_MODULE: {"requires": ["core"], "conflicts": [], "requires_restart": True}}

ALL_KNOWN = tuple(OWNERSHIP)


def _catalog(panel, release):
    """Каталог нового релиза таким, каким его видит установленная панель."""

    return release.client(panel.state, core_version=panel.version).get_release_catalog(release.version).catalog


def _plan(tmp_path: Path, panel, release):
    archive = tmp_path / "checked" / "panel.tar.gz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(release.panel)
    catalog = _catalog(panel, release)
    listing = validate_panel_archive(archive, catalog["panel"], platform_architecture=ARCHITECTURE)
    return build_panel_update_plan(
        panel_root=panel.root, state_dir=panel.state, catalog=catalog,
        target_archive=listing, architecture=ARCHITECTURE, free_bytes=1 << 40,
    )


def _apply(panel, plan, release) -> str:
    journal = Journal.create(panel.root, plan, "foreign-release", extra={})
    return run_operation(
        journal,
        state_dir=panel.state,
        client=release.client(panel.state, core_version=panel.version),
        architecture=ARCHITECTURE,
        restart=lambda: None,
        wait_healthy=lambda _phase: True,
    )


def _full_panel(tmp_path: Path):
    panel = make_panel(tmp_path, version=OLD, installed=ALL_KNOWN)
    for name in ("modules.json", "install-profile.json"):
        document = panel.read_json(name)
        document["profile"] = "full"
        if name == "install-profile.json":
            document["editor_variant"] = "full"
        else:
            document["editor"] = {"variant": "full"}
        panel.path(name).write_text(__import__("json").dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return panel


# --- каталог ---------------------------------------------------------------------------


def test_a_newer_release_with_a_module_the_panel_does_not_know_is_accepted(tmp_path):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(NEW, WITH_NEW_MODULE, definitions=NEW_DEFINITION)

    catalog = _catalog(panel, release)

    assert NEW_MODULE in [entry["id"] for entry in catalog["modules"]]


def test_the_panels_own_release_is_still_checked_against_its_own_list(tmp_path):
    # Каталог своей версии описывает саму эту панель: незнакомый модуль в нём —
    # признак подмены или сбоя сборки, а не будущего.
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(OLD, WITH_NEW_MODULE, definitions=NEW_DEFINITION)

    with pytest.raises(CatalogClientError) as raised:
        _catalog(panel, release)

    assert raised.value.code == "catalog_module_unknown"


def test_a_changed_dependency_in_a_newer_release_is_accepted(tmp_path):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(
        NEW, OWNERSHIP, definitions={"tool.backups": {"requires": ["core", "tool.files"], "conflicts": [], "requires_restart": True}}
    )

    entries = {entry["id"]: entry for entry in _catalog(panel, release)["modules"]}

    assert entries["tool.backups"]["requires"] == ["core", "tool.files"]


def test_a_newer_release_must_still_agree_with_itself(tmp_path):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(
        NEW, WITH_NEW_MODULE, definitions={NEW_MODULE: {"requires": ["core", "tool.nowhere"], "conflicts": [], "requires_restart": True}}
    )

    with pytest.raises(CatalogClientError) as raised:
        _catalog(panel, release)

    assert raised.value.code == "catalog_dependency_unknown"


@pytest.mark.parametrize("bad_id", ["Tool.Caps", "tool..empty", "9tool", "tool.", " tool.pad", "tool_under", "tool.-dash"])
def test_a_module_name_of_a_newer_release_must_look_like_a_module_name(tmp_path, bad_id):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(
        NEW, {**OWNERSHIP, bad_id: ("routes/x.py",)},
        definitions={bad_id: {"requires": ["core"], "conflicts": [], "requires_restart": True}},
    )

    with pytest.raises(CatalogClientError) as raised:
        _catalog(panel, release)

    assert raised.value.code == "catalog_module_invalid"


def test_a_module_that_needs_a_newer_panel_does_not_spoil_the_whole_catalog(tmp_path):
    # Что модулю нужна панель новее, важно в ту минуту, когда ставят его самого.
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(NEW, WITH_NEW_MODULE, definitions=NEW_DEFINITION, min_core={NEW_MODULE: NEW})

    catalog = _catalog(panel, release)

    assert {entry["id"]: entry["min_core"] for entry in catalog["modules"]}[NEW_MODULE] == NEW


def test_fields_a_newer_release_added_are_passed_over(tmp_path):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(NEW, OWNERSHIP, panel_fields={"release_notes_url": "https://example.invalid/notes"})

    catalog = _catalog(panel, release)

    assert catalog["panel"]["version"] == NEW
    assert "release_notes_url" not in catalog["panel"]


def test_an_unknown_field_in_the_panels_own_release_is_still_refused(tmp_path):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(OLD, OWNERSHIP, panel_fields={"release_notes_url": "https://example.invalid/notes"})

    with pytest.raises(CatalogClientError) as raised:
        _catalog(panel, release)

    assert raised.value.code == "catalog_panel_field_unknown"


# --- профиль после обновления -------------------------------------------------------------


def test_the_full_profile_gets_the_module_the_release_added(tmp_path):
    panel = _full_panel(tmp_path)
    release = make_release(NEW, WITH_NEW_MODULE, definitions=NEW_DEFINITION)

    plan = _plan(tmp_path, panel, release)

    assert NEW_MODULE in plan.target_profile["module_ids"]
    assert set(NEW_FILES) <= set(plan.files_add)
    assert _apply(panel, plan, release) == "committed"
    # «Полный» профиль значит «всё, что есть в релизе»: модуль лежит на месте,
    # числится установленным и включён.
    for relative in NEW_FILES:
        assert panel.path(relative).read_bytes() == file_bytes(relative, NEW)
    assert NEW_MODULE in panel.read_json("install-profile.json")["module_ids"]
    assert panel.read_json("install-profile.json")["profile"] == "full"
    assert panel.read_json("module-installed.json")["modules"][NEW_MODULE] is True
    assert panel.read_json("modules.json")["modules"][NEW_MODULE]["enabled"] is True
    assert set(NEW_FILES) <= set(panel.read_json("install-managed.json")["paths"])


def test_a_chosen_set_of_modules_does_not_grow_by_itself(tmp_path):
    panel = make_panel(tmp_path, version=OLD, installed=("core", "tool.editor", "engine.xray"))
    release = make_release(NEW, WITH_NEW_MODULE, definitions=NEW_DEFINITION)

    plan = _plan(tmp_path, panel, release)

    assert NEW_MODULE not in plan.target_profile["module_ids"]
    assert not set(NEW_FILES) & set(plan.files_add)
    assert _apply(panel, plan, release) == "committed"
    assert not panel.path(NEW_FILES[0]).exists()
    assert sorted(panel.read_json("install-profile.json")["module_ids"]) == ["core", "engine.xray", "tool.editor"]


def test_a_chosen_set_gets_what_its_modules_now_require(tmp_path):
    panel = make_panel(tmp_path, version=OLD, installed=("core", "tool.editor", "engine.xray"))
    # В новом релизе Xray опирается на модуль, которого раньше не было.
    release = make_release(
        NEW,
        WITH_NEW_MODULE,
        definitions={
            **NEW_DEFINITION,
            "engine.xray": {"requires": ["core", NEW_MODULE], "conflicts": [], "requires_restart": True},
        },
    )

    plan = _plan(tmp_path, panel, release)

    assert NEW_MODULE in plan.target_profile["module_ids"]
    assert _apply(panel, plan, release) == "committed"
    assert panel.path(NEW_FILES[0]).is_file()
    assert NEW_MODULE in panel.read_json("install-profile.json")["module_ids"]


def test_a_module_the_release_dropped_is_removed(tmp_path):
    panel = _full_panel(tmp_path)
    without_backups = {module: paths for module, paths in OWNERSHIP.items() if module != "tool.backups"}
    release = make_release(NEW, without_backups)

    plan = _plan(tmp_path, panel, release)

    assert "tool.backups" not in plan.target_profile["module_ids"]
    assert "templates/backups.html" in plan.files_remove
    assert _apply(panel, plan, release) == "committed"
    assert not panel.path("templates/backups.html").exists()
    assert "tool.backups" not in panel.read_json("install-profile.json")["module_ids"]
    assert panel.read_json("modules.json")["modules"]["tool.backups"]["enabled"] is False


# --- ограничитель «с какой версии можно обновляться» ---------------------------------------


def test_a_release_can_refuse_panels_that_are_too_old_to_update_themselves(tmp_path):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(NEW, OWNERSHIP, panel_fields={"min_updater": "2.10.5"})

    with pytest.raises(ModuleTransactionError) as raised:
        _plan(tmp_path, panel, release)

    # Не «каталог негоден», а понятная причина: такую панель обновляет установщик.
    assert raised.value.code == "panel_update_requires_installer"
    assert raised.value.details.get("min_updater") == "2.10.5"
    assert raised.value.details.get("current_version") == OLD


def test_a_panel_new_enough_for_the_release_updates_itself(tmp_path):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(NEW, OWNERSHIP, panel_fields={"min_updater": OLD})

    plan = _plan(tmp_path, panel, release)

    assert plan.target_version == NEW
    assert _apply(panel, plan, release) == "committed"


@pytest.mark.parametrize("value", ["", "soon", 3, None])
def test_a_limit_that_is_not_a_version_is_refused(tmp_path, value):
    panel = make_panel(tmp_path, version=OLD)
    release = make_release(NEW, OWNERSHIP, panel_fields={"min_updater": value})

    with pytest.raises(CatalogClientError) as raised:
        _catalog(panel, release)

    assert raised.value.code == "catalog_panel_min_updater_invalid"


def test_the_update_check_says_when_the_installer_is_needed(tmp_path):
    from tests.support.module_lifecycle import make_service

    panel = make_panel(tmp_path, version=OLD)
    release = make_release(NEW, OWNERSHIP, panel_fields={"min_updater": "2.10.5"})
    service, _ = make_service(panel, release)

    result = service.panel_update_check()

    # Владелец узнаёт об этом до того, как нажмёт «обновить».
    assert result["update_available"] is True
    assert result["requires_installer"] is True
    assert result["min_updater"] == "2.10.5"


def test_the_release_builder_can_name_the_oldest_panel_that_updates_itself(tmp_path):
    import importlib.util
    import sys

    path = Path(__file__).resolve().parents[1] / "scripts" / "build_modular_panel_release.py"
    spec = importlib.util.spec_from_file_location("build_modular_panel_release_min_updater", path)
    builder = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = builder
    spec.loader.exec_module(builder)
    asset = builder.BuiltAsset(path=tmp_path / "xkeen-ui-panel-2.11.0.tar.gz", sha256="a" * 64, size=10)

    def entry(min_updater):
        inputs = builder.ReleaseInputs(
            root=tmp_path, output_dir=tmp_path, version=NEW, source_date_epoch=1, source_commit="c" * 40,
            min_updater=min_updater,
        )
        return builder._panel_catalog_entry(asset, inputs)

    assert entry("2.10.0")["min_updater"] == "2.10.0"
    # Без ограничителя поля нет вовсе: обновиться может любая панель.
    assert "min_updater" not in entry(None)
    with pytest.raises(builder.ReleaseBuildError):
        entry("soon")
