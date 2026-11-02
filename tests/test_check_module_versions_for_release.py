"""Проверки версий модулей при выпуске панели (scripts/check_module_versions_for_release.py)."""

from __future__ import annotations

import subprocess

from scripts import check_module_versions_for_release as checker
from scripts.check_module_versions_for_release import (
    merge_ownership,
    missing_merges,
    nearest_ancestor_panel_tag,
    unbumped_modules,
)

OWNERSHIP = {
    "core": ["app.py", "module-ownership.json", "module-sizes.json"],
    "tool.files": ["routes/files.py", "static/js/pages/files.js", "static/js/pages/files.js.gz"],
    "tool.backups": ["routes/backups.py"],
}
OLD = {"tool.files": "1.0.0", "tool.backups": "1.0.0"}


def test_version_below_issued_tag_is_forgotten_merge():
    versions = {"tool.files": "1.0.0", "tool.backups": "1.0.0"}
    problems = missing_merges(versions, ["module-tool.files-1.0.1", "module-tool.backups-1.0.0"])
    assert len(problems) == 1
    assert "tool.files" in problems[0] and "1.0.1" in problems[0]


def test_version_equal_or_higher_than_issued_passes():
    versions = {"tool.files": "1.0.2", "tool.backups": "1.0.0"}
    assert missing_merges(versions, ["module-tool.files-1.0.1", "module-tool.backups-1.0.0"]) == []


def test_panel_without_module_tags_passes():
    assert missing_merges({"tool.files": "1.0.0"}, []) == []
    assert missing_merges({"tool.files": "1.0.0"}, ["v3.0.2", "module-bad"]) == []


def test_changed_sources_without_bump_are_listed():
    changed = ["xkeen-ui/routes/files.py", "xkeen-ui/routes/backups.py"]
    assert unbumped_modules(changed, OWNERSHIP, OLD, {"tool.files": "1.0.1", "tool.backups": "1.0.0"}) == [
        "tool.backups"
    ]
    assert unbumped_modules(changed, OWNERSHIP, OLD, {"tool.files": "1.0.1", "tool.backups": "1.0.1"}) == []


def test_only_generated_files_do_not_count():
    changed = [
        "xkeen-ui/module-sizes.json",
        "xkeen-ui/static/js/pages/files.js.gz",
        "xkeen-ui/static/frontend-build/x.js",
        "xkeen-ui/module-versions.json",
        "module-versions.json",
        "tests/test_x.py",
    ]
    assert unbumped_modules(changed, OWNERSHIP, OLD, OLD) == []


def test_core_changes_are_not_a_module_and_new_module_passes():
    assert unbumped_modules(["xkeen-ui/app.py"], OWNERSHIP, OLD, OLD) == []
    changed = ["xkeen-ui/routes/files.py"]
    assert unbumped_modules(changed, OWNERSHIP, {}, OLD) == []


def test_base_is_nearest_ancestor_of_either_channel():
    # tags go from the nearest ancestor; a stable after betas compares with the last beta
    ordered = ["module-tool.files-1.0.1", "v3.0.3-beta.2", "v3.0.3-beta.1", "v3.0.2"]
    assert nearest_ancestor_panel_tag("v3.0.3", ordered) == "v3.0.3-beta.2"
    # a beta right after a stable compares with that stable
    assert nearest_ancestor_panel_tag("v3.0.4-beta.1", ["v3.0.3", "v3.0.3-beta.2"]) == "v3.0.3"
    # the tag itself and legacy tags are skipped; no predecessor gives None
    assert nearest_ancestor_panel_tag("v3.0.3", ["v3.0.3", "v.2.8.8", "v2.9.2a"]) is None


def test_non_ancestor_higher_tag_is_ignored():
    # v3.1.0 is a hotfix elsewhere and is not in the ancestor list of v3.0.3
    assert nearest_ancestor_panel_tag("v3.0.3", ["v3.0.2"]) == "v3.0.2"


def test_edit_after_bump_in_beta_is_reported_against_beta_base():
    # base = the beta where files was already bumped to 1.0.1; edited again, not bumped
    changed = ["xkeen-ui/routes/files.py"]
    assert unbumped_modules(changed, OWNERSHIP, {"tool.files": "1.0.1"}, {"tool.files": "1.0.1"}) == ["tool.files"]


def test_deleted_module_file_counts_through_previous_ownership():
    previous = {"tool.files": ["routes/files.py", "routes/old_files_helper.py"]}
    current = {"core": ["app.py"], "tool.files": ["routes/files.py"]}
    ownership = merge_ownership(previous, current)
    assert unbumped_modules(["xkeen-ui/routes/old_files_helper.py"], current, OLD, OLD) == []
    assert unbumped_modules(["xkeen-ui/routes/old_files_helper.py"], ownership, OLD, OLD) == ["tool.files"]


def test_file_moved_from_module_to_core_counts_for_the_module():
    previous = {"tool.files": ["utils/shared.py"]}
    current = {"core": ["utils/shared.py"], "tool.files": []}
    ownership = merge_ownership(previous, current)
    assert unbumped_modules(["xkeen-ui/utils/shared.py"], ownership, OLD, OLD) == ["tool.files"]


def _git_repo(tmp_path, with_versions):
    def run(*args):
        subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)

    run("init", "-q")
    (tmp_path / "x.txt").write_text("x", encoding="utf-8")
    if with_versions:
        (tmp_path / "module-versions.json").write_text('{"tool.files": "1.0.0"}', encoding="utf-8")
    run("add", ".")
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c")
    run("tag", "v1.0.0")
    return tmp_path


def test_versions_at_tag_without_file_is_none(tmp_path):
    assert checker._versions_at(_git_repo(tmp_path, False), "v1.0.0") is None


def test_versions_at_tag_with_file(tmp_path):
    assert checker._versions_at(_git_repo(tmp_path, True), "v1.0.0") == {"tool.files": "1.0.0"}


def test_main_skips_unbump_check_with_note_when_old_versions_missing(monkeypatch, capsys, tmp_path):
    (tmp_path / "module-versions.json").write_text('{"tool.files": "1.0.0"}', encoding="utf-8")
    monkeypatch.setattr(checker, "_git", lambda root, *args: [])
    monkeypatch.setattr(checker, "_ancestor_panel_tags", lambda root, tag: ["v3.0.2"])
    monkeypatch.setattr(checker, "_versions_at", lambda root, ref: None)
    assert checker.main(["--tag", "v3.0.3", "--root", str(tmp_path)]) == 0
    assert "пропущена" in capsys.readouterr().out
