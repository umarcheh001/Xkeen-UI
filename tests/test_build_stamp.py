"""BUILD.json must describe the code that is actually packed.

The release workflow builds the archive *before* the commit that ships it, so a
plain `git rev-parse HEAD` always names the previous commit.  Stamping that hash
as the build version made BUILD.json assert something untrue: on the router it
read `3974660f` while the installed code was `a1076989`.  These tests pin the
honest stamp instead — a base commit, a dirty flag, and a content hash of the
packed tree.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "build_user_archive.py"


def _load_builder():
    name = "build_user_archive_under_test"
    spec = importlib.util.spec_from_file_location(name, SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    # dataclasses resolves string annotations through sys.modules, and the
    # script uses `from __future__ import annotations`.
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=str(repo),
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout.strip()


def _init_repo(repo: Path) -> None:
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.invalid")
    _git(repo, "config", "user.name", "Test")
    (repo / "seed.txt").write_text("seed\n", encoding="utf-8")
    _git(repo, "add", "seed.txt")
    _git(repo, "commit", "-qm", "seed")


@pytest.fixture(scope="module")
def builder():
    return _load_builder()


def test_tree_hash_is_deterministic_and_content_sensitive(builder, tmp_path):
    first = tmp_path / "a"
    second = tmp_path / "b"
    for root in (first, second):
        (root / "nested").mkdir(parents=True)
        (root / "top.txt").write_text("same\n", encoding="utf-8")
        (root / "nested" / "inner.txt").write_text("same too\n", encoding="utf-8")

    assert builder.compute_tree_sha256(first) == builder.compute_tree_sha256(second)

    (second / "nested" / "inner.txt").write_text("changed\n", encoding="utf-8")
    assert builder.compute_tree_sha256(first) != builder.compute_tree_sha256(second)


def test_tree_hash_covers_paths_not_only_contents(builder, tmp_path):
    first = tmp_path / "a"
    second = tmp_path / "b"
    first.mkdir()
    second.mkdir()
    (first / "one.txt").write_text("payload\n", encoding="utf-8")
    (second / "two.txt").write_text("payload\n", encoding="utf-8")

    assert builder.compute_tree_sha256(first) != builder.compute_tree_sha256(second)


def test_build_stamp_reports_clean_tree(builder, tmp_path):
    repo = tmp_path / "clean"
    _init_repo(repo)

    stamp = builder.git_build_stamp(repo)

    assert stamp.dirty is False
    assert stamp.base_commit == _git(repo, "rev-parse", "--short", "HEAD")
    assert stamp.commit == _git(repo, "rev-parse", "HEAD")
    assert stamp.version == stamp.base_commit


def test_build_stamp_marks_uncommitted_work(builder, tmp_path):
    repo = tmp_path / "dirty"
    _init_repo(repo)
    (repo / "seed.txt").write_text("edited after the commit\n", encoding="utf-8")

    stamp = builder.git_build_stamp(repo)

    assert stamp.dirty is True
    assert stamp.version == f"{stamp.base_commit}-dirty"
    # The commit no longer describes the packed code, so it must not be claimed.
    assert stamp.commit is None


def test_build_stamp_notices_untracked_files(builder, tmp_path):
    repo = tmp_path / "untracked"
    _init_repo(repo)
    (repo / "brand_new.txt").write_text("not committed yet\n", encoding="utf-8")

    assert builder.git_build_stamp(repo).dirty is True


def test_build_stamp_survives_a_non_repository(builder, tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()

    stamp = builder.git_build_stamp(plain)

    assert stamp.base_commit == "local"
    assert stamp.commit is None
    assert stamp.dirty is True


def test_written_build_json_carries_the_full_stamp(builder, tmp_path):
    package_root = tmp_path / "pkg"
    package_root.mkdir()
    (package_root / "app.py").write_text("print('hi')\n", encoding="utf-8")
    stamp = builder.BuildStamp(version="deadbeef-dirty", base_commit="deadbeef", commit=None, dirty=True)

    builder.write_build_json(package_root, stamp=stamp, update_url="https://example.invalid/u")

    payload = json.loads((package_root / "BUILD.json").read_text(encoding="utf-8"))
    assert payload["version"] == "deadbeef-dirty"
    assert payload["base_commit"] == "deadbeef"
    assert payload["commit"] is None
    assert payload["dirty"] is True
    assert payload["update_url"] == "https://example.invalid/u"
    assert payload["release_date"].endswith("Z")
    # The hash identifies the packed code even when no commit can.
    assert len(payload["tree_sha256"]) == 64
    assert payload["tree_sha256"] == builder.compute_tree_sha256(package_root, exclude={"BUILD.json"})


def test_build_json_hash_ignores_itself(builder, tmp_path):
    package_root = tmp_path / "pkg"
    package_root.mkdir()
    (package_root / "app.py").write_text("print('hi')\n", encoding="utf-8")
    stamp = builder.BuildStamp(version="v1", base_commit="v1", commit=None, dirty=True)

    builder.write_build_json(package_root, stamp=stamp, update_url="")
    first = json.loads((package_root / "BUILD.json").read_text(encoding="utf-8"))["tree_sha256"]

    # Re-stamping with different metadata must not move the content hash.
    builder.write_build_json(package_root, stamp=builder.BuildStamp("v2", "v2", None, True), update_url="")
    second = json.loads((package_root / "BUILD.json").read_text(encoding="utf-8"))["tree_sha256"]

    assert first == second


def test_installer_preserves_the_stamp_fields():
    installer = (ROOT / "xkeen-ui" / "install.sh").read_text(encoding="utf-8")

    # install.sh rewrites BUILD.json from scratch; the archive's stamp must survive it.
    for field in ("base_commit", "dirty", "tree_sha256"):
        assert field in installer, f"install.sh drops the {field!r} field"


def test_ci_workflow_uses_the_shared_stamp_writer():
    workflow = (ROOT / ".github" / "workflows" / "build-user-archive.yml").read_text(encoding="utf-8")

    # A second hand-rolled payload here is how the two builds drifted apart before.
    assert "scripts/build_user_archive.py" in workflow
    assert "builder.write_build_json(" in workflow
    assert "builder.BuildStamp(" in workflow
    assert '"release_date": os.environ["RELEASE_DATE"]' not in workflow


def test_build_info_service_exposes_the_stamp_fields():
    sys.path.insert(0, str(ROOT / "xkeen-ui"))
    from services.build_info import read_build_info

    info = read_build_info("/nonexistent-state-dir")

    for field in ("base_commit", "dirty", "tree_sha256"):
        assert field in info, f"read_build_info hides the {field!r} field"
