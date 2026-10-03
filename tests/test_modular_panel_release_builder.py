from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER_PATH = ROOT / "scripts" / "build_modular_panel_release.py"


def _load_builder():
    assert BUILDER_PATH.is_file()
    spec = importlib.util.spec_from_file_location("build_modular_panel_release", BUILDER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_release_builder_exposes_stable_input_and_asset_contract() -> None:
    builder = _load_builder()

    inputs = builder.ReleaseInputs(
        root=ROOT,
        output_dir=ROOT / "dist",
        version="1.2.3",
        source_date_epoch=1_700_000_000,
        source_commit="a" * 40,
    )

    assert inputs.version == "1.2.3"
    assert inputs.source_date_epoch == 1_700_000_000
    assert inputs.source_commit == "a" * 40
    assert inputs.architecture == "aarch64"
    assert inputs.min_core == "1.0.0"

    for name in ("ArchiveSpec", "BuiltAsset", "ReleaseBundle"):
        assert hasattr(builder, name)

    assert callable(builder.build_release)
    assert callable(builder.write_release_bundle)
