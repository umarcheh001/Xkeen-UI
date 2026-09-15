"""The Happ decryptor engine (tools/happ-decryptor) must be tested and released.

The installer downloads ``happ-decrypt-universal-linux-<arch>`` from the GitHub
release and checks it against the published sha256, so a binary that is built
but missing from the checksums or from the release upload is as good as absent.
The engine also needs a newer Go than xk-geodat: its toolchain comes from its
own go.mod, installed after xk-geodat is already built with its version.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
ENGINE_DIR = "tools/happ-decryptor"
ENGINE_GO_MOD = f"{ENGINE_DIR}/go.mod"
ARCHES = ("arm64", "mips", "mipsle")
BINARIES = tuple(f"happ-decrypt-universal-linux-{arch}" for arch in ARCHES)


def _steps(workflow: str, job: str) -> list[dict]:
    data = yaml.safe_load((WORKFLOWS / workflow).read_text(encoding="utf-8"))
    return data["jobs"][job]["steps"]


def _index(steps: list[dict], predicate) -> int:
    matches = [i for i, step in enumerate(steps) if predicate(step)]
    assert matches, "step not found"
    return matches[0]


def _engine_go_setup(step: dict) -> bool:
    return str(step.get("uses", "")).startswith("actions/setup-go@") and (
        (step.get("with") or {}).get("go-version-file") == ENGINE_GO_MOD
    )


def _engine_run(step: dict, needle: str) -> bool:
    return step.get("working-directory") == ENGINE_DIR and needle in str(step.get("run", ""))


def _mentions(text: str, binary: str) -> int:
    # "…-mips" must not count "…-mipsle", and the binary must not count its ".sha256".
    return len(re.findall(re.escape(f"dist/{binary}") + r"(?![\w.-])", text))


def test_release_sets_up_engine_go_after_xk_geodat_build():
    steps = _steps("build-user-archive.yml", "build-release")
    geodat = _index(steps, lambda s: s.get("working-directory") == "tools/xk-geodat")
    setup = _index(steps, _engine_go_setup)
    tests = _index(steps, lambda s: _engine_run(s, "go test ./..."))
    build = _index(steps, lambda s: _engine_run(s, "build.sh"))
    assert geodat < setup < tests < build


def test_release_builds_engine_for_every_router_arch():
    steps = _steps("build-user-archive.yml", "build-release")
    run = steps[_index(steps, lambda s: _engine_run(s, "build.sh"))]["run"]
    for arch, binary in zip(ARCHES, BINARIES):
        line = next((l for l in run.splitlines() if f"OUT=../../dist/{binary} " in l), "")
        assert f"GOARCH={arch} " in line, f"no build line for {binary}"
        assert "GOOS=linux" in line
        if arch.startswith("mips"):
            assert "GOMIPS=softfloat" in line, f"{binary} must use softfloat"
    assert "VERSION" in run, "release binaries must carry a version for -version"


def test_release_publishes_engine_binaries_with_checksums():
    steps = _steps("build-user-archive.yml", "build-release")
    checksums = steps[_index(steps, lambda s: s.get("name") == "Create checksums")]["run"]
    sums_command = checksums[checksums.index("sha256sum \\") :]
    artifact = steps[_index(steps, lambda s: str(s.get("uses", "")).startswith("actions/upload-artifact@"))]
    artifact_paths = artifact["with"]["path"]
    release = steps[_index(steps, lambda s: s.get("name") == "Create or update GitHub Release")]["run"]

    for binary in BINARIES:
        assert f"sha256sum dist/{binary} > dist/{binary}.sha256" in checksums
        assert _mentions(sums_command, binary) == 1, f"{binary} missing from SHA256SUMS"
        assert _mentions(artifact_paths, binary) == 1
        assert f"dist/{binary}.sha256" in artifact_paths
        # Once for "gh release upload", once for "gh release create".
        assert _mentions(release, binary) == 2, f"{binary} not attached to the release"
        assert release.count(f"dist/{binary}.sha256") == 2


def test_ci_vets_tests_and_cross_builds_engine():
    steps = _steps("ci.yml", "test-and-build")
    _index(steps, _engine_go_setup)
    run = steps[_index(steps, lambda s: _engine_run(s, "go test ./..."))]["run"]
    assert "go vet ./..." in run
    assert "./cmd/happ-decrypt-universal" in run
    for arch in ARCHES:
        assert arch in run, f"CI does not cross-build for {arch}"


def test_engine_go_mod_declares_go_version():
    text = (ROOT / ENGINE_GO_MOD).read_text(encoding="utf-8")
    assert re.search(r"^go \d+\.\d+", text, re.M), "setup-go reads the Go version from this line"
