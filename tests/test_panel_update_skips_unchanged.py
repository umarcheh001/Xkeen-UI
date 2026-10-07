"""Обновление панели не трогает файлы, которые в новом релизе не изменились.

Между соседними релизами меняется малая часть дерева. План сверяет каждый файл
на накопителе с тем, что лежит в архиве, по сумме и биту исполнения, и кладёт
только отличающиеся: места нужно меньше, а запись на накопитель короче.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import tarfile
import time
from pathlib import Path

import pytest

from services import panel_package_contract
from services.module_transactions import plan as plan_module
from services.module_transactions.executor import run_operation
from services.module_transactions.journal import Journal
from services.module_transactions.plan import build_panel_update_plan
from services.panel_package_contract import validate_panel_archive
from tests.support.module_lifecycle import make_service
from tests.support.module_tx import ARCHITECTURE, OWNERSHIP, file_bytes, make_panel, make_release


OLD, NEW = "2.10.0", "2.11.0"
ALL_PATHS = {path for paths in OWNERSHIP.values() for path in paths}


def _listing(tmp_path: Path, release) -> dict:
    archive = tmp_path / "checked" / "panel.tar.gz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(release.panel)
    return validate_panel_archive(archive, release.catalog["panel"], platform_architecture=ARCHITECTURE)


def _plan(tmp_path: Path, panel, release, listing: dict | None = None):
    return build_panel_update_plan(
        panel_root=panel.root,
        state_dir=panel.state,
        catalog=release.catalog,
        target_archive=listing or _listing(tmp_path, release),
        architecture=ARCHITECTURE,
        free_bytes=1 << 40,
    )


def _already_new(panel, *paths: str) -> None:
    """Файл на накопителе уже такой, каким его несёт новый релиз."""

    for relative in paths:
        panel.path(relative).write_bytes(file_bytes(relative, NEW))


def _run(panel, plan, release) -> str:
    journal = Journal.create(panel.root, plan, "skip-unchanged", extra={})
    return run_operation(
        journal,
        state_dir=panel.state,
        client=release.client(panel.state),
        architecture=ARCHITECTURE,
        restart=lambda: None,
        wait_healthy=lambda _phase: True,
    )


# --- оглавление архива ---------------------------------------------------------------


def test_archive_check_reports_the_digest_of_every_payload_file(tmp_path):
    release = make_release(version=NEW)

    checked = _listing(tmp_path, release)

    assert set(checked["payload_digests"]) == set(checked["payload_files"])
    assert checked["payload_digests"]["app.py"] == hashlib.sha256(file_bytes("app.py", NEW)).hexdigest()
    assert checked["payload_executable"] == []


def test_archive_check_names_the_executable_files(tmp_path):
    release = make_release(version=NEW)
    repacked = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(release.panel), mode="r:gz") as source, gzip.GzipFile(
        fileobj=repacked, mode="wb", mtime=0
    ) as packed, tarfile.open(fileobj=packed, mode="w") as target:
        for member in source:
            if member.name == "xkeen-ui/app.py":
                member.mode = 0o755
            target.addfile(member, source.extractfile(member))
    body = repacked.getvalue()
    archive = tmp_path / "panel.tar.gz"
    archive.write_bytes(body)
    descriptor = {**release.catalog["panel"], "size": len(body), "sha256": hashlib.sha256(body).hexdigest()}

    checked = validate_panel_archive(archive, descriptor, platform_architecture=ARCHITECTURE)

    assert checked["payload_executable"] == ["app.py"]


# --- план ----------------------------------------------------------------------------


def test_update_lays_only_the_files_the_release_changed(tmp_path):
    panel = make_panel(tmp_path, version=OLD, installed=tuple(OWNERSHIP))
    _already_new(panel, "static/js/core.js", "routes/mihomo.py")

    plan = _plan(tmp_path, panel, make_release(version=NEW))

    # Карта владения в тестовом релизе от версии не зависит — она тоже на месте.
    unchanged = {"static/js/core.js", "routes/mihomo.py", "module-ownership.json"}
    assert set(plan.files_add) == ALL_PATHS - unchanged
    assert plan.files_remove == ()


def test_an_identical_file_the_panel_does_not_manage_is_still_laid(tmp_path):
    panel = make_panel(tmp_path, version=OLD, installed=tuple(OWNERSHIP))
    _already_new(panel, "static/js/core.js")
    managed = panel.read_json("install-managed.json")
    managed["paths"].remove("static/js/core.js")
    panel.path("install-managed.json").write_text(json.dumps(managed), encoding="utf-8")

    plan = _plan(tmp_path, panel, make_release(version=NEW))

    # Иначе список управляемых файлов разошёлся бы с тем, что лежит в панели.
    assert "static/js/core.js" in plan.files_add


@pytest.mark.skipif(os.name == "nt", reason="бит исполнения есть только на POSIX")
def test_a_file_that_lost_its_executable_bit_is_laid_again(tmp_path):
    panel = make_panel(tmp_path, version=OLD, installed=tuple(OWNERSHIP))
    _already_new(panel, "static/js/core.js")
    os.chmod(panel.path("static/js/core.js"), 0o644)
    release = make_release(version=NEW)
    listing = _listing(tmp_path, release)
    listing["payload_executable"] = ["static/js/core.js"]

    plan = _plan(tmp_path, panel, release, listing)

    assert "static/js/core.js" in plan.files_add


def test_a_listing_without_digests_lays_everything(tmp_path):
    panel = make_panel(tmp_path, version=OLD, installed=tuple(OWNERSHIP))
    _already_new(panel, "static/js/core.js")
    release = make_release(version=NEW)
    listing = _listing(tmp_path, release)
    del listing["payload_digests"]

    plan = _plan(tmp_path, panel, release, listing)

    assert set(plan.files_add) == ALL_PATHS


def test_room_is_asked_only_for_the_files_that_are_laid(tmp_path, monkeypatch):
    panel = make_panel(tmp_path, version=OLD, installed=tuple(OWNERSHIP))
    release = make_release(version=NEW)
    listing = _listing(tmp_path, release)
    monkeypatch.setattr(plan_module, "hard_links_supported", lambda _root: False)
    everything = _plan(tmp_path, panel, release, listing).required_free_bytes
    skipped = ("static/js/core.js", "routes/mihomo.py")
    _already_new(panel, *skipped)

    plan = _plan(tmp_path, panel, release, listing)

    # И распакованная копия, и копия прежнего файла для отката — обе не нужны.
    saved = sum(listing["payload_sizes"][path] + len(file_bytes(path, OLD)) for path in skipped)
    assert abs((everything - plan.required_free_bytes) - saved * 6 // 5) <= 1


def test_a_file_changed_without_changing_its_size_is_noticed(tmp_path):
    panel = make_panel(tmp_path, version=OLD, installed=tuple(OWNERSHIP))
    release = make_release(version=NEW)
    listing = _listing(tmp_path, release)
    target = panel.path("static/js/core.js")
    _already_new(panel, "static/js/core.js")
    assert "static/js/core.js" not in _plan(tmp_path, panel, release, listing).files_add
    body = target.read_bytes()
    stamp = target.stat().st_mtime_ns + 5_000_000_000
    target.write_bytes(body.replace(b"@", b"#"))
    os.utime(target, ns=(stamp, stamp))

    plan = _plan(tmp_path, panel, release, listing)

    assert "static/js/core.js" in plan.files_add


def test_an_untouched_file_is_not_read_again_for_the_next_plan(tmp_path, monkeypatch):
    panel = make_panel(tmp_path, version=OLD, installed=tuple(OWNERSHIP))
    release = make_release(version=NEW)
    listing = _listing(tmp_path, release)
    _plan(tmp_path, panel, release, listing)
    read: list[Path] = []
    real = plan_module._hash_file

    def counting(path):
        read.append(Path(path))
        return real(path)

    monkeypatch.setattr(plan_module, "_hash_file", counting)

    # План строится до трёх раз на одно обновление: показ, сверка, запуск.
    _plan(tmp_path, panel, release, listing)

    assert read == []


# --- исполнитель ---------------------------------------------------------------------


def test_update_leaves_an_unchanged_file_exactly_as_it_was(tmp_path):
    panel = make_panel(tmp_path, version=OLD, installed=tuple(OWNERSHIP))
    kept = panel.path("static/js/core.js")
    _already_new(panel, "static/js/core.js")
    os.utime(kept, (1_600_000_000, 1_600_000_000))
    before = kept.stat()
    release = make_release(version=NEW)
    plan = _plan(tmp_path, panel, release)

    assert _run(panel, plan, release) == "committed"

    after = kept.stat()
    assert (after.st_ino, after.st_mtime_ns) == (before.st_ino, before.st_mtime_ns)
    assert kept.read_bytes() == file_bytes("static/js/core.js", NEW)
    assert panel.path("app.py").read_bytes() == file_bytes("app.py", NEW)
    assert panel.read_json("BUILD.json")["version"] == NEW
    # Нетронутый файл остаётся управляемым.
    assert set(panel.read_json("install-managed.json")["paths"]) == ALL_PATHS


def test_a_lone_new_precompressed_copy_is_not_older_than_its_source(tmp_path):
    panel = make_panel(tmp_path, version=OLD, installed=tuple(OWNERSHIP))
    source = panel.path("static/js/core.js")
    packed = panel.path("static/js/core.js.gz")
    _already_new(panel, "static/js/core.js")
    # Часы роутера до синхронизации отстают: исходник «из будущего».
    ahead = time.time() + 86_400
    os.utime(source, (ahead, ahead))
    stamp = source.stat().st_mtime_ns
    release = make_release(version=NEW)
    plan = _plan(tmp_path, panel, release)
    assert "static/js/core.js.gz" in plan.files_add and "static/js/core.js" not in plan.files_add

    assert _run(panel, plan, release) == "committed"

    # Панель отдаёт сжатую копию, только если та не старше исходника.
    assert source.stat().st_mtime_ns == stamp
    assert packed.stat().st_mtime_ns >= stamp


# --- сервис --------------------------------------------------------------------------


def test_the_archive_is_read_once_for_all_plans_of_one_update(tmp_path, monkeypatch):
    panel = make_panel(tmp_path, version=OLD, installed=("core", "tool.files"))
    service, _ = make_service(panel, make_release(version=NEW))
    calls: list[str] = []
    real = panel_package_contract.validate_panel_archive

    def counting(archive, *args, **kwargs):
        calls.append(os.fspath(archive))
        return real(archive, *args, **kwargs)

    monkeypatch.setattr(panel_package_contract, "validate_panel_archive", counting)

    first = service.plan("panel-update", None)
    second = service.plan("panel-update", None)

    assert first["applicable"] is True
    assert second["plan_id"] == first["plan_id"]
    assert len(calls) == 1
