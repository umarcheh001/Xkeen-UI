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


def test_generated_sizes_file_is_left_to_the_comparison_by_meaning():
    # The pre-commit hook makes every change of a module refresh module-sizes.json;
    # the comparison with the panel archive checks that only the module's entry moved.
    assert check_changed_paths(["xkeen-ui/static/js/files.js", "xkeen-ui/module-sizes.json"], {"static/js/files.js"}) == []
    assert check_changed_paths(["module-sizes.json"], {"a.py"})


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


# ---- запасные случаи -------------------------------------------------------

def test_leading_dot_directories_are_not_stripped():
    assert check_changed_paths(["./docs/x.md"], set()) == []
    assert check_changed_paths([".docs/x"], set())
    assert check_changed_paths([".github/x"], set())


def test_beta_ten_is_newer_than_beta_nine():
    published = ["v3.0.3-beta.9", "v3.0.3-beta.10", "v3.0.2"]
    assert check_latest_in_channel("v3.0.3-beta.10", published) == []
    assert check_latest_in_channel("v3.0.3-beta.9", published)
    assert check_latest_in_channel("v3.0.2", published) == []


# ---- main: коды выхода и сквозной прогон на временном репозитории ---------

def test_main_exit_codes_separate_panel_outcome_from_failure(capsys):
    from scripts.check_module_release import main

    assert main(["--tag", "module-tool.editor-1.0.1", "--panel-archive", "x"]) == 2
    err = capsys.readouterr().err
    assert "ВЫПУСК ПАНЕЛИ" in err and "ОШИБКА" not in err
    assert main(["--tag", "v3.0.3", "--panel-archive", "x"]) == 1
    assert "ОШИБКА" in capsys.readouterr().err


def _git_run(root: Path, *args: str) -> None:
    import subprocess

    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
        cwd=root, check=True, capture_output=True,
    )


def _make_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    (repo / "xkeen-ui").mkdir(parents=True)
    (repo / "module-versions.json").write_text(json.dumps({MODULE: "1.0.0"}), encoding="utf-8")
    (repo / "xkeen-ui" / "app.py").write_bytes(b"core")
    (repo / "xkeen-ui" / "files.py").write_bytes(b"files-v1")
    _git_run(repo.parent, "init", "-q", str(repo))
    _git_run(repo, "add", ".")
    _git_run(repo, "commit", "-q", "-m", "base")
    _git_run(repo, "tag", "v3.0.3-beta.9")
    _git_run(repo, "tag", "v3.0.3-beta.10")
    (repo / "module-versions.json").write_text(json.dumps({MODULE: "1.0.1"}), encoding="utf-8")
    return repo


def _patch_builder(monkeypatch, repo: Path, files: dict[str, bytes]):
    import scripts.check_module_release as mod

    def build(root, panel_tag, work):
        tree = work / "tree"
        for name, data in files.items():
            (tree / name).parent.mkdir(parents=True, exist_ok=True)
            (tree / name).write_bytes(data)
        return tree

    monkeypatch.setattr(mod, "_build_package_tree", build)
    monkeypatch.setattr(mod, "_module_ownership", lambda root: {MODULE: ["files.py"]})


OWN = _ownership({"core": ["app.py"], MODULE: ["files.py"]})


def _base_archive(tmp_path: Path) -> Path:
    archive = tmp_path / "panel.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        for name, data in {"app.py": b"core", "files.py": b"files-v1", "module-ownership.json": OWN}.items():
            info = tarfile.TarInfo(f"xkeen-ui/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return archive


def test_main_end_to_end_on_a_temp_repo(tmp_path, monkeypatch, capsys):
    from scripts.check_module_release import main

    repo = _make_repo(tmp_path)
    (repo / "xkeen-ui" / "files.py").write_bytes(b"files-v2")
    _git_run(repo, "add", ".")
    _git_run(repo, "commit", "-q", "-m", "module change")
    archive = _base_archive(tmp_path)
    args = ["--root", str(repo), "--tag", "module-tool.files-1.0.1", "--panel-archive", str(archive)]

    _patch_builder(monkeypatch, repo, {"app.py": b"core", "files.py": b"files-v2", "module-ownership.json": OWN})
    assert main(args) == 0
    # тег не совпадает с module-versions.json: настоящий сбой
    assert main(["--root", str(repo), "--tag", "module-tool.files-1.0.2", "--panel-archive", str(archive)]) == 1
    capsys.readouterr()

    # правка ядра: штатный исход
    (repo / "xkeen-ui" / "app.py").write_bytes(b"core2")
    _git_run(repo, "add", ".")
    _git_run(repo, "commit", "-q", "-m", "core change")
    assert main(args) == 2
    assert "ВЫПУСК ПАНЕЛИ" in capsys.readouterr().err


# ---- стабильный выпуск и беты на одном коммите -----------------------------

def test_stable_ranks_above_its_own_betas():
    from scripts.check_module_release import _panel_key

    assert _panel_key("v3.1.0") > _panel_key("v3.1.0-beta.3")
    assert _panel_key("v3.1.0-beta.10") > _panel_key("v3.1.0-beta.9")
    assert _panel_key("v3.1.1-beta.1") > _panel_key("v3.1.0")


def test_stable_and_beta_on_one_commit_choose_stable_as_base(tmp_path):
    from scripts.check_module_release import _ancestor_tags

    repo = _make_repo(tmp_path)
    _git_run(repo, "tag", "v3.0.3")
    assert find_panel_tag(_ancestor_tags(repo)) == "v3.0.3"


# ---- второй выпуск модуля от той же панели ----------------------------------

def _release_commit(repo: Path, version: str, content: bytes, tag: str | None = None) -> None:
    (repo / "module-versions.json").write_text(json.dumps({MODULE: version}), encoding="utf-8")
    (repo / "xkeen-ui" / "files.py").write_bytes(content)
    _git_run(repo, "add", ".")
    _git_run(repo, "commit", "-q", "-m", f"module {version}")
    if tag:
        _git_run(repo, "tag", tag)


def test_second_release_on_one_panel_must_contain_the_first(tmp_path, monkeypatch, capsys):
    from scripts.check_module_release import main

    repo = _make_repo(tmp_path)
    archive = _base_archive(tmp_path)
    _patch_builder(monkeypatch, repo, {"app.py": b"core", "files.py": b"x", "module-ownership.json": OWN})
    _git_run(repo, "checkout", "-q", "-b", "module/tool.files-1.0.1")
    _release_commit(repo, "1.0.1", b"files-v2", "module-tool.files-1.0.1")

    # ветка 1.0.2 отрезана от тега панели и не содержит правку 1.0.1
    _git_run(repo, "checkout", "-q", "-b", "module/tool.files-1.0.2", "v3.0.3-beta.10")
    _release_commit(repo, "1.0.2", b"files-v3", "module-tool.files-1.0.2")
    args = ["--root", str(repo), "--tag", "module-tool.files-1.0.2", "--panel-archive", str(archive)]
    capsys.readouterr()
    assert main(args) == 1
    err = capsys.readouterr().err
    assert "ОШИБКА" in err and "module-tool.files-1.0.1" in err

    # ветка от тега 1.0.1 проходит
    _git_run(repo, "tag", "-d", "module-tool.files-1.0.2")
    _git_run(repo, "checkout", "-q", "-b", "module/tool.files-1.0.2-fixed", "module-tool.files-1.0.1")
    _release_commit(repo, "1.0.2", b"files-v3", "module-tool.files-1.0.2")
    assert main(args) == 0


def test_earlier_release_on_another_panel_is_not_required(tmp_path, monkeypatch, capsys):
    from scripts.check_module_release import main

    repo = _make_repo(tmp_path)
    archive = _base_archive(tmp_path)
    _patch_builder(monkeypatch, repo, {"app.py": b"core", "files.py": b"x", "module-ownership.json": OWN})
    # выпуск 1.0.1 от более старой панели v3.0.2 на отдельной линии
    _git_run(repo, "checkout", "-q", "--", "module-versions.json")
    _git_run(repo, "switch", "-q", "--orphan", "old-line")
    (repo / "old.txt").write_text("old", encoding="utf-8")
    _git_run(repo, "add", "old.txt")
    _git_run(repo, "commit", "-q", "-m", "old panel")
    _git_run(repo, "tag", "v3.0.2")
    _git_run(repo, "commit", "-q", "--allow-empty", "-m", "old module release")
    _git_run(repo, "tag", "module-tool.files-1.0.1")

    _git_run(repo, "checkout", "-q", "-f", "-b", "module/tool.files-1.0.2", "v3.0.3-beta.10")
    _release_commit(repo, "1.0.2", b"files-v3", "module-tool.files-1.0.2")
    args = ["--root", str(repo), "--tag", "module-tool.files-1.0.2", "--panel-archive", str(archive)]
    assert main(args) == 0, capsys.readouterr().err
