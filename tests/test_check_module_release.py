"""Проверки выпуска модуля отдельно от панели (scripts/check_module_release.py)."""

from __future__ import annotations

import io
import json
import tarfile
from pathlib import Path

import pytest

from scripts.check_module_release import (
    check_changed_paths,
    check_latest_in_channel,
    check_module_releasable,
    check_tag_version,
    compare_with_panel_archive,
    find_panel_tag,
    parse_module_tag,
)

MODULE = "tool.files"
VERSIONS = {"tool.files": "1.0.1", "tool.backups": "1.0.0"}


def test_tag_must_match_versions_file():
    assert parse_module_tag("module-tool.files-1.0.1") == ("tool.files", "1.0.1")
    assert check_tag_version("module-tool.files-1.0.1", VERSIONS, []) == []
    assert check_tag_version("module-tool.files-1.0.2", VERSIONS, [])
    assert check_tag_version("module-tool.terminal-1.0.0", VERSIONS, [])
    with pytest.raises(ValueError):
        parse_module_tag("v3.0.3")


def test_version_must_exceed_issued():
    issued = ["module-tool.files-1.0.0", "module-tool.backups-9.0.0"]
    assert check_tag_version("module-tool.files-1.0.1", VERSIONS, issued) == []
    # сам выпускаемый тег уже есть в списке и не считается
    assert check_tag_version("module-tool.files-1.0.1", VERSIONS, ["module-tool.files-1.0.1"] + issued) == []
    assert check_tag_version("module-tool.files-1.0.1", VERSIONS, ["module-tool.files-1.0.2"])


def test_beta_panel_is_latest_only_among_betas():
    published = ["v3.0.2", "v3.0.3-beta.1", "v3.0.3-beta.2", "v3.1.0"]
    assert check_latest_in_channel("v3.0.3-beta.2", published) == []
    assert check_latest_in_channel("v3.1.0", published) == []
    assert check_latest_in_channel("v3.0.3-beta.1", published)


def test_older_panel_is_refused():
    published = ["v3.0.1", "v3.0.2", "v3.0.3"]
    assert check_latest_in_channel("v3.0.2", published)
    assert check_latest_in_channel("v3.0.3", published) == []
    assert check_latest_in_channel("v3.0.3", ["v3.0.2"])  # у метки нет выпуска


def test_find_panel_tag_takes_nearest():
    assert find_panel_tag(["module-tool.files-1.0.0", "v3.0.3-beta.2", "v3.0.2"]) == "v3.0.3-beta.2"
    with pytest.raises(ValueError):
        find_panel_tag(["module-tool.files-1.0.0", "v.2.8.8"])


def test_core_change_is_refused_and_tests_are_allowed():
    files = {"static/js/files.js", "routes/files.py"}
    assert check_changed_paths(["xkeen-ui/static/js/files.js", "tests/test_x.py", "e2e/a.spec.mjs", "docs/a.md"], files) == []
    errors = check_changed_paths(["xkeen-ui/services/core.py"], files)
    assert errors and "правка требует выпуска панели" in errors[0]
    assert check_changed_paths(["package.json"], files)


def test_module_versions_file_is_allowed_outside_module():
    assert check_changed_paths(["module-versions.json"], {"a.py"}) == []
    assert check_changed_paths(["xkeen-ui/module-versions.json"], {"a.py"})


def test_editor_release_requires_panel_release():
    assert check_module_releasable("tool.files") == []
    errors = check_module_releasable("tool.editor")
    assert errors and "правка требует выпуска панели" in errors[0]


# ---- сравнение с архивом панели ------------------------------------------

def _ownership(mods: dict, extra: dict | None = None) -> bytes:
    data = {"schema_version": 1, "modules": mods, "frontend": {}}
    data.update(extra or {})
    return json.dumps(data, sort_keys=True).encode()


def _sizes(mods: dict) -> bytes:
    return json.dumps({"schema_version": 1, "modules": mods}).encode()


def _base_files() -> dict[str, bytes]:
    return {
        "app.py": b"core",
        "static/files.js": b"files-v1",
        "static/backups.js": b"backups",
        "module-ownership.json": _ownership({"core": ["app.py"], MODULE: ["static/files.js"], "tool.backups": ["static/backups.js"]}),
        "module-sizes.json": _sizes({"core": 10, MODULE: 5, "tool.backups": 7}),
        "BUILD.json": b"{}",
    }


def _setup(tmp_path: Path, build_changes: dict[str, bytes | None]) -> tuple[Path, Path]:
    base = _base_files()
    tmp_path.mkdir(parents=True, exist_ok=True)
    archive = tmp_path / "panel.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        for name, data in base.items():
            info = tarfile.TarInfo(f"xkeen-ui/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    build = tmp_path / "build"
    merged = dict(base)
    for name, data in build_changes.items():
        if data is None:
            merged.pop(name, None)
        else:
            merged[name] = data
    for name, data in merged.items():
        target = build / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return build, archive


def test_module_only_change_passes(tmp_path):
    build, archive = _setup(tmp_path, {"static/files.js": b"files-v2"})
    assert compare_with_panel_archive(build, archive, MODULE) == []


def test_byte_difference_in_core_is_reported(tmp_path):
    build, archive = _setup(tmp_path, {"app.py": b"changed"})
    errors = compare_with_panel_archive(build, archive, MODULE)
    assert errors and "app.py" in errors[0] and "правка требует выпуска панели" in errors[0]


def test_neighbour_module_difference_is_reported(tmp_path):
    build, archive = _setup(tmp_path, {"static/backups.js": b"changed"})
    assert any("static/backups.js" in e for e in compare_with_panel_archive(build, archive, MODULE))


def test_ownership_may_differ_only_in_released_module(tmp_path):
    own = {"core": ["app.py"], MODULE: ["static/files.js", "static/new.js"], "tool.backups": ["static/backups.js"]}
    build, archive = _setup(tmp_path, {"module-ownership.json": _ownership(own), "static/new.js": b"n"})
    assert compare_with_panel_archive(build, archive, MODULE) == []
    own["tool.backups"] = ["static/backups.js", "static/x.js"]
    build, archive = _setup(tmp_path / "b", {"module-ownership.json": _ownership(own), "static/new.js": b"n"})
    assert any("module-ownership.json" in e for e in compare_with_panel_archive(build, archive, MODULE))


def test_sizes_may_differ_only_in_released_module(tmp_path):
    build, archive = _setup(tmp_path, {"module-sizes.json": _sizes({"core": 10, MODULE: 99, "tool.backups": 7})})
    assert compare_with_panel_archive(build, archive, MODULE) == []
    build, archive = _setup(tmp_path / "b", {"module-sizes.json": _sizes({"core": 11, MODULE: 5, "tool.backups": 7})})
    assert any("module-sizes.json" in e for e in compare_with_panel_archive(build, archive, MODULE))


def test_ignored_files_are_not_compared(tmp_path):
    base_changes = {
        "BUILD.json": b'{"x":1}',
        "module-versions.json": b"{}",
        "retired-files.json": b"[1]",
        "scripts/entware_mirrors.txt": b"mirror",
    }
    build, archive = _setup(tmp_path, base_changes)
    assert compare_with_panel_archive(build, archive, MODULE) == []


def test_unknown_new_file_stops_release(tmp_path):
    build, archive = _setup(tmp_path, {"services/new_core.py": b"x"})
    errors = compare_with_panel_archive(build, archive, MODULE)
    assert any("services/new_core.py" in e for e in errors)
