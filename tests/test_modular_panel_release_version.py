"""The release version comes from the git tag and has to be semver."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "build_modular_panel_release.py"
WORKFLOW = ROOT / ".github" / "workflows" / "build-user-archive.yml"


def _builder():
    spec = importlib.util.spec_from_file_location("xkeen_release_builder_version", BUILDER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("version", ["2.9.2a", "2.9.1b", ".2.8.8", "2.9", "v2.9.3"])
def test_builder_stops_on_a_version_the_catalog_client_cannot_compare(tmp_path, version):
    # Tags with a letter suffix used to build fine and then fail the static
    # preflight one CI step later, with nothing telling which rule was broken.
    builder = _builder()

    with pytest.raises(builder.ReleaseBuildError, match="tag releases as vX.Y.Z"):
        builder.build_release(
            ROOT,
            tmp_path / "dist",
            version=version,
            source_date_epoch=1_700_000_000,
            source_commit="a" * 40,
        )
    assert not (tmp_path / "dist").exists() or not any((tmp_path / "dist").iterdir())


def test_builder_accepts_the_versions_ci_produces():
    builder = _builder()

    for version in ("2.9.3", "3.0.0", "0.0.0-dev.0123456789ab"):
        assert builder._SEMVER_RE.fullmatch(version), version


def test_builder_and_contract_agree_on_what_a_version_is():
    sys.path.insert(0, str(ROOT / "xkeen-ui"))
    from services import module_package_contract as contract

    assert _builder()._SEMVER_RE.pattern == contract._SEMVER_RE.pattern


def test_workflow_takes_the_release_version_from_the_tag():
    source = WORKFLOW.read_text(encoding="utf-8")

    assert 'VERSION="${TAG#v}"' in source
    assert source.index("python scripts/build_modular_panel_release.py") < source.index(
        "name: Validate modular panel release assets"
    )
