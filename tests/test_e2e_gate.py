"""Отметка о полном e2e и проверка тегов перед пушем (scripts/e2e_gate.py)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from scripts.e2e_gate import marker_path, run_gate, tags_missing_e2e

ROOT = Path(__file__).resolve().parents[1]
ZERO = "0" * 40


def git(cwd, *args):
    done = subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)
    return done.stdout.strip()


@pytest.fixture
def repo(tmp_path):
    git(tmp_path, "init", "-q")
    git(tmp_path, "config", "user.name", "t")
    git(tmp_path, "config", "user.email", "t@example.test")
    (tmp_path / "file.txt").write_text("one\n", encoding="utf-8")
    git(tmp_path, "add", "file.txt")
    git(tmp_path, "commit", "-q", "-m", "one")
    return tmp_path


def push_line(repo, ref, sha):
    return f"{ref} {sha} {ref} {ZERO}"


def mark(repo, sha):
    path = marker_path(sha, repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}", encoding="utf-8")


def test_branch_push_needs_no_marker(repo):
    head = git(repo, "rev-parse", "HEAD")
    assert tags_missing_e2e([push_line(repo, "refs/heads/pre-release", head)], repo) == []


def test_tag_without_marker_is_reported(repo):
    head = git(repo, "rev-parse", "HEAD")
    assert tags_missing_e2e([push_line(repo, "refs/tags/v1.2.3", head)], repo) == ["refs/tags/v1.2.3"]


def test_annotated_tag_is_checked_by_its_commit(repo):
    git(repo, "tag", "-a", "v1.2.3-beta.1", "-m", "beta")
    tag_object = git(repo, "rev-parse", "v1.2.3-beta.1")
    head = git(repo, "rev-parse", "HEAD")
    assert tag_object != head
    line = push_line(repo, "refs/tags/v1.2.3-beta.1", tag_object)
    assert tags_missing_e2e([line], repo) == ["refs/tags/v1.2.3-beta.1"]
    mark(repo, head)
    assert tags_missing_e2e([line], repo) == []


def test_tag_deletion_and_foreign_tags_are_ignored(repo):
    head = git(repo, "rev-parse", "HEAD")
    deletion = f"(delete) {ZERO} refs/tags/v1.2.3 {head}"
    assert tags_missing_e2e([deletion, push_line(repo, "refs/tags/note", head)], repo) == []


def test_run_refuses_a_dirty_tree_before_spending_time(repo):
    (repo / "file.txt").write_text("two\n", encoding="utf-8")
    calls = []
    assert run_gate(lambda command: calls.append(command) or 0, repo) == 1
    assert calls == []


def test_run_marks_the_commit_after_a_green_pass(repo):
    calls = []
    assert run_gate(lambda command: calls.append(command) or 0, repo) == 0
    assert calls == ["npm run frontend:build", "npx playwright test"]
    data = json.loads(marker_path(git(repo, "rev-parse", "HEAD"), repo).read_text(encoding="utf-8"))
    assert data["retried_failed"] is False


def test_run_retries_only_the_failed_tests_once(repo):
    answers = {"npm run frontend:build": 0, "npx playwright test": 1, "npx playwright test --last-failed": 0}
    calls = []
    assert run_gate(lambda command: calls.append(command) or answers[command], repo) == 0
    assert calls[-1] == "npx playwright test --last-failed"
    data = json.loads(marker_path(git(repo, "rev-parse", "HEAD"), repo).read_text(encoding="utf-8"))
    assert data["retried_failed"] is True


def test_run_leaves_no_marker_when_the_retry_fails_too(repo):
    answers = {"npm run frontend:build": 0, "npx playwright test": 1, "npx playwright test --last-failed": 1}
    assert run_gate(lambda command: answers[command], repo) == 1
    assert not marker_path(git(repo, "rev-parse", "HEAD"), repo).exists()


def test_run_leaves_no_marker_when_the_tree_changed_during_the_run(repo):
    def runner(command):
        (repo / "file.txt").write_text("two\n", encoding="utf-8")
        return 0

    assert run_gate(runner, repo) == 1
    assert not marker_path(git(repo, "rev-parse", "HEAD"), repo).exists()


def test_failed_build_stops_the_run(repo):
    calls = []
    assert run_gate(lambda command: calls.append(command) or 1, repo) == 1
    assert calls == ["npm run frontend:build"]


def test_pre_push_hook_runs_the_check_and_npm_exposes_the_gate():
    hook = (ROOT / ".githooks/pre-push").read_text(encoding="utf-8")
    assert 'exec "$py" "$script" check-push' in hook
    assert 'script="$hooks_dir/../scripts/e2e_gate.py"' in hook
    assert "XKEEN_SKIP_E2E_GATE" in hook
    scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    assert scripts["e2e:gate"] == "node scripts/run_python.mjs scripts/e2e_gate.py run"
