"""Сколько места операция занимает на накопителе на самом деле.

Новый релиз не должен лежать на накопителе дважды: файлы из рабочей папки
переносятся в дерево панели, а не копируются, архив убирается сразу после
распаковки. Прежние файлы на время операции держатся жёсткими ссылками и места
не стоят — оценка в плане считает их копию, только когда ссылки недоступны.
"""

from __future__ import annotations

import errno
import os
from pathlib import Path

import pytest

from services.module_transactions import journal as journal_module
from services.module_transactions import plan as plan_module
from services.module_transactions.executor import run_operation
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_panel_update_plan, build_plan, hard_links_supported
from services.panel_package_contract import validate_panel_archive
from tests.support.module_tx import ARCHITECTURE, OWNERSHIP, file_bytes, make_panel, make_release


def _listing(tmp_path: Path, release) -> dict:
    archive = tmp_path / "checked" / "panel.tar.gz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(release.panel)
    return validate_panel_archive(archive, release.catalog["panel"], platform_architecture=ARCHITECTURE)


def _update_plan(tmp_path: Path, panel, release, **extra):
    return build_panel_update_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_archive=_listing(tmp_path, release),
        architecture=ARCHITECTURE,
        **extra,
    )


def _staged(tmp_path: Path, relative: str, body: bytes) -> Path:
    path = tmp_path / "staged" / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return path


# --- журнал: перенос вместо копии ---------------------------------------------------


def test_a_consumed_source_is_moved_into_place_and_can_be_undone(tmp_path):
    panel = make_panel(tmp_path)
    plan = build_plan("repair", "engine.xray", **panel.kwargs)
    relative = "services/xray_subscriptions.py"
    before = panel.path(relative).read_bytes()
    source = _staged(tmp_path, relative, b"next release\n")
    journal = Journal.create(panel.root, plan, "storage-cost", extra={})

    journal.apply_file(relative, source, consume=True)

    assert panel.path(relative).read_bytes() == b"next release\n"
    # Файл перенесён: второго экземпляра в рабочей папке не осталось.
    assert not source.exists()

    journal.rollback()

    assert panel.path(relative).read_bytes() == before


def test_a_source_that_cannot_be_renamed_is_copied_and_then_removed(tmp_path, monkeypatch):
    panel = make_panel(tmp_path)
    plan = build_plan("repair", "engine.xray", **panel.kwargs)
    relative = "services/xray_subscriptions.py"
    source = _staged(tmp_path, relative, b"from another storage\n")
    journal = Journal.create(panel.root, plan, "storage-cost", extra={})
    real_replace = os.replace

    def other_device(src, dst):
        if Path(src) == source:
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        return real_replace(src, dst)

    monkeypatch.setattr(journal_module.os, "replace", other_device)

    journal.apply_file(relative, source, consume=True)

    assert panel.path(relative).read_bytes() == b"from another storage\n"
    assert not source.exists()


def test_a_source_is_left_alone_unless_it_is_given_away(tmp_path):
    panel = make_panel(tmp_path)
    plan = build_plan("repair", "engine.xray", **panel.kwargs)
    relative = "services/xray_subscriptions.py"
    source = _staged(tmp_path, relative, b"shared source\n")
    journal = Journal.create(panel.root, plan, "storage-cost", extra={})

    journal.apply_file(relative, source)

    assert source.read_bytes() == b"shared source\n"


# --- исполнитель: релиз не лежит на накопителе дважды --------------------------------


def test_update_keeps_neither_the_archive_nor_a_second_copy_of_the_payload(tmp_path):
    panel = make_panel(tmp_path, version="2.10.0")
    release = make_release(version="2.11.0")
    plan = _update_plan(tmp_path, panel, release, free_bytes=1 << 40)
    journal = Journal.create(panel.root, plan, "storage-cost", extra={})
    seen: dict[str, list[str]] = {}

    def look(step: str) -> None:
        staging = journal.staging
        seen[step] = sorted(
            path.relative_to(staging).as_posix() for path in staging.rglob("*") if path.is_file()
        ) if staging.exists() else []

    result = run_operation(
        journal,
        state_dir=panel.state,
        client=release.client(panel.state),
        architecture=ARCHITECTURE,
        restart=lambda: None,
        wait_healthy=lambda _phase: True,
        on_step=look,
    )

    assert result == "committed"
    # К началу укладки архив уже убран, а к записи состояния рабочая папка пуста.
    assert not any(name.endswith(".tar.gz") for name in seen["applying"])
    assert seen["applying"], "the payload is unpacked before it is laid"
    assert seen["state"] == []
    assert panel.path("app.py").read_bytes() == file_bytes("app.py", "2.11.0")


def test_module_install_drops_its_archive_before_laying_files(tmp_path):
    panel = make_panel(tmp_path)
    release = make_release()
    plan = build_plan("install", "tool.terminal", **{**panel.kwargs, "catalog": release.catalog})
    journal = Journal.create(panel.root, plan, "storage-cost", extra={})
    seen: dict[str, list[str]] = {}

    def look(step: str) -> None:
        staging = journal.staging
        seen[step] = sorted(path.name for path in staging.rglob("*") if path.is_file()) if staging.exists() else []

    result = run_operation(
        journal,
        state_dir=panel.state,
        client=release.client(panel.state),
        architecture=ARCHITECTURE,
        restart=lambda: None,
        wait_healthy=lambda _phase: True,
        on_step=look,
    )

    assert result == "committed"
    assert not any(name.endswith(".tar.gz") for name in seen["applying"])
    assert seen["state"] == []
    assert all(panel.path(path).is_file() for path in OWNERSHIP["tool.terminal"])


# --- оценка места в плане ------------------------------------------------------------


def test_hard_links_are_detected_without_leaving_anything_behind(tmp_path):
    panel = make_panel(tmp_path)
    before = sorted(path.name for path in tmp_path.iterdir()) + sorted(path.name for path in panel.root.iterdir())

    assert hard_links_supported(panel.root) is True

    after = sorted(path.name for path in tmp_path.iterdir()) + sorted(path.name for path in panel.root.iterdir())
    assert after == before


def test_a_storage_without_hard_links_is_reported_as_such(tmp_path, monkeypatch):
    panel = make_panel(tmp_path)

    def refuse(_source, _target):
        raise OSError(errno.EPERM, "Operation not permitted")

    monkeypatch.setattr(plan_module.os, "link", refuse)
    plan_module._LINK_SUPPORT.clear()

    assert hard_links_supported(panel.root) is False
    assert sorted(path.name for path in tmp_path.iterdir()) == ["xkeen-ui"]


def _update_numbers(tmp_path: Path, panel, release, plan) -> tuple[int, int, int]:
    # Считается только то, что план кладёт: совпавшие с релизом файлы не трогаются.
    listing = _listing(tmp_path, release)
    archive = int(release.catalog["panel"]["size"])
    expanded = sum(listing["payload_sizes"][path] for path in plan.files_add)
    replaced = sum(panel.path(path).stat().st_size for path in plan.files_add if panel.path(path).is_file())
    return archive, expanded, replaced


def test_update_needs_room_for_the_archive_and_one_copy_of_the_release(tmp_path, monkeypatch):
    panel = make_panel(tmp_path, version="2.10.0", installed=tuple(OWNERSHIP))
    release = make_release(version="2.11.0")
    monkeypatch.setattr(plan_module, "hard_links_supported", lambda _root: True)
    plan = _update_plan(tmp_path, panel, release, free_bytes=1 << 40)
    archive, expanded, _replaced = _update_numbers(tmp_path, panel, release, plan)

    assert plan.required_free_bytes == (archive + expanded) * 6 // 5


def test_update_counts_the_copy_of_old_files_only_without_hard_links(tmp_path, monkeypatch):
    panel = make_panel(tmp_path, version="2.10.0", installed=tuple(OWNERSHIP))
    release = make_release(version="2.11.0")
    monkeypatch.setattr(plan_module, "hard_links_supported", lambda _root: False)
    plan = _update_plan(tmp_path, panel, release, free_bytes=1 << 40)
    archive, expanded, replaced = _update_numbers(tmp_path, panel, release, plan)

    assert replaced > 0
    assert plan.required_free_bytes == (archive + expanded + replaced) * 6 // 5


def test_module_install_does_not_count_a_copy_that_is_a_link(tmp_path, monkeypatch):
    panel = make_panel(tmp_path)
    kwargs = {**panel.kwargs, "free_bytes": 1 << 40}
    monkeypatch.setattr(plan_module, "hard_links_supported", lambda _root: True)
    linked = build_plan("repair", "engine.xray", **kwargs).required_free_bytes
    monkeypatch.setattr(plan_module, "hard_links_supported", lambda _root: False)
    copied = build_plan("repair", "engine.xray", **kwargs).required_free_bytes

    replaced = sum(panel.path(path).stat().st_size for path in OWNERSHIP["engine.xray"])
    assert copied - linked == replaced * 6 // 5 or copied - linked in (replaced * 6 // 5 - 1, replaced * 6 // 5 + 1)
    assert linked > 0
