"""Сторож тегов выпуска: формат и строгий порядок бет (RELEASING.md)."""

from __future__ import annotations

import pytest

from scripts.check_release_tag import check_tag, parse_tag, suggest_next

# The repository as of 23.10.2026, including old letter tags the guard must ignore.
HISTORY = [
    "v.2.8.8", "v2.9.2a", "v2.10.0-beta.5",
    "v3.0.0", "v3.0.1",
    "v3.0.2-beta.1", "v3.0.2-beta.2", "v3.0.2-beta.3", "v3.0.2-beta.4", "v3.0.2-beta.5",
    "v3.0.2",
]


@pytest.mark.parametrize("tag", ["v3.0.3-beta.1", "v3.1.0-beta.1", "v4.0.0-beta.1", "v3.0.3"])
def test_next_steps_after_a_stable_release_are_allowed(tag):
    assert check_tag(tag, HISTORY, on_main=True) == []


@pytest.mark.parametrize("tag", ["v3.0.3a", "v.3.0.3", "3.0.3", "v3.0.3-beta", "v3.0.3-beta.0", "v3.0.3-rc.1", "v3.0.03"])
def test_wrong_format_is_rejected(tag):
    errors = check_tag(tag, HISTORY)
    assert len(errors) == 1 and "формату" in errors[0]


def test_beta_numbers_go_strictly_in_order():
    history = HISTORY + ["v3.0.3-beta.1", "v3.0.3-beta.2"]
    assert check_tag("v3.0.3-beta.3", history) == []
    assert "beta.3" in check_tag("v3.0.3-beta.4", history)[0]
    # In CI the tag being built is already in the list; it is not a conflict.
    assert check_tag("v3.0.3-beta.2", history) == []
    assert "первая должна быть v3.0.4-beta.1" in check_tag("v3.0.4-beta.2", HISTORY)[-1]


def test_versions_at_or_below_the_latest_stable_are_rejected():
    assert "не выше" in check_tag("v3.0.2-beta.6", HISTORY)[0]
    assert "не выше" in check_tag("v3.0.1-beta.1", HISTORY)[0]


def test_skipping_numbers_is_rejected():
    assert "перескакивает" in check_tag("v3.0.5-beta.1", HISTORY)[0]
    assert "перескакивает" in check_tag("v3.2.0", HISTORY, on_main=True)[0]


def test_no_going_below_an_open_beta_line():
    history = HISTORY + ["v3.1.0-beta.1"]
    errors = check_tag("v3.0.3-beta.1", history)
    assert any("Уже идут беты v3.1.0" in e and "v3.1.0-beta.2" in e for e in errors)


def test_stable_tag_must_be_on_main():
    assert "main" in check_tag("v3.0.3", HISTORY, on_main=False)[0]
    assert check_tag("v3.0.3", HISTORY, on_main=None) == []


def test_next_tag_suggestion_follows_the_open_line():
    assert suggest_next(HISTORY) == ["v3.0.3-beta.1", "v3.1.0-beta.1"]
    assert suggest_next(HISTORY + ["v3.0.3-beta.1"]) == ["v3.0.3-beta.2", "v3.0.3"]


def test_parse_tag_reads_base_and_beta():
    assert parse_tag("v3.0.3-beta.12").base == (3, 0, 3)
    assert parse_tag("v3.0.3-beta.12").beta == 12
    assert parse_tag("v3.0.3").beta == 0


def test_both_tag_workflows_run_the_guard_before_building():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    command = 'python3 scripts/check_release_tag.py --tag "${GITHUB_REF#refs/tags/}"'
    for name in ("build-user-archive.yml", "publish-android-beta.yml"):
        text = (root / ".github/workflows" / name).read_text(encoding="utf-8")
        assert command in text, name
        guard = text.index(command)
        # The guard runs right after checkout, before any build or publish step.
        assert text.index("actions/checkout") < guard
        assert guard < text.index("- name:", text.index("Check release tag order") + 1)
        assert "fetch-depth: 0" in text[:guard]
