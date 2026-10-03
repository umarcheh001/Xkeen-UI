from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "build-user-archive.yml"


def test_release_workflow_builds_modular_assets_on_push_and_tags() -> None:
    source = WORKFLOW.read_text(encoding="utf-8")

    assert "push:" in source
    assert "tags:" in source
    assert "python scripts/build_modular_panel_release.py" in source
    assert "dist/modular-panel" in source
    assert "release-metadata.json" in source
    assert "validate_module_archive" in source or "module_package_contract" in source
    assert "actions/upload-artifact" in source
    assert "gh release create" in source
    assert "startsWith(github.ref, 'refs/tags/v')" in source


def test_release_workflow_does_not_create_github_release_on_branch_pushes() -> None:
    source = WORKFLOW.read_text(encoding="utf-8")
    release_step = source.index("      - name: Create or update GitHub Release")
    release_source = source[release_step:]
    assert "if: startsWith(github.ref, 'refs/tags/v')" in release_source
    assert "gh release create" in release_source
