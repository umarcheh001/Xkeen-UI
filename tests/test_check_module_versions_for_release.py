"""Проверки версий модулей при выпуске панели (scripts/check_module_versions_for_release.py)."""

from __future__ import annotations

from scripts.check_module_versions_for_release import (
    missing_merges,
    previous_panel_tag,
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


def test_previous_tag_is_taken_from_own_channel():
    tags = ["v3.0.1", "v3.0.2", "v3.0.3-beta.2", "v3.0.3-beta.10", "v3.0.3-beta.9", "v.2.8.8", "v2.9.2a"]
    assert previous_panel_tag("v3.0.3", tags) == "v3.0.2"
    assert previous_panel_tag("v3.0.3-beta.10", tags) == "v3.0.3-beta.9"
    assert previous_panel_tag("v3.0.3-beta.2", tags) is None
    assert previous_panel_tag("v3.0.1", ["v3.0.1", "v.2.8.8"]) is None
