# Stage 8.1 Release Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic panel and official module archives with generated manifests, catalog/checksums, and tag-gated GitHub Release assets while preserving the legacy bootstrap archive.

**Architecture:** A pure-stdlib Python builder owns release input normalization, deterministic tar creation, module ownership projection, manifest generation, catalog/checksum generation, and Stage 8.0 static preflight. The existing user archive builder remains the compatibility path; CI invokes the new builder for tag/push validation and publishes only validated assets on tags.

**Tech Stack:** Python 3 standard library (`tarfile`, `gzip`, `hashlib`, `json`, `pathlib`), existing Stage 0 inventory/Module Registry, GitHub Actions YAML, pytest.

**Spec:** `docs/superpowers/specs/2026-10-03-modular-panel-stage8-1-release-assets-design.md`

**Implementation status:** completed 4 October 2026. The checklist below records
the approved execution plan; the implementation is covered by the release
builder/workflow tests and the full Python suite.

## Global Constraints

- Module archives contain exactly `module-manifest.json` and `payload/<manifest ownership paths>`.
- Archives use POSIX-relative sorted paths, uid/gid 0, empty uname/gname, and explicit `SOURCE_DATE_EPOCH`.
- Only `directory` and `regular_file` tar entries are allowed; symlinks, hardlinks, absolute paths, `..`, hooks, and undeclared files are rejected.
- Catalog channel is `stable`; dependencies, conflicts, and `requires_restart` come from Module Registry.
- Stage 8.0 static preflight runs before an asset is exposed as a release artifact.
- No GitHub download client, Ed25519 verification, updater transaction, restart/rollback engine, or UI is implemented in 8.1.
- Existing `xkeen-ui-routing.tar.gz` remains the bootstrap compatibility artifact.

---

### Task 1: Define Release Builder Interfaces

**Files:**
- Create: `scripts/build_modular_panel_release.py`
- Test: `tests/test_modular_panel_release_builder.py`

**Interfaces:**
- Produces `ReleaseInputs`, `ArchiveSpec`, `BuiltAsset`, and `ReleaseBundle` dataclasses.
- Exposes `build_release(root: Path, output_dir: Path, *, version: str, source_date_epoch: int, source_commit: str) -> ReleaseBundle`.
- Exposes `write_release_bundle(bundle: ReleaseBundle) -> None` and a CLI with `--root`, `--output-dir`, `--version`, `--source-date-epoch`, and `--source-commit`.

- [ ] **Step 1: Write failing tests for CLI and bundle shape**

  Assert the builder module imports, `build_release` returns a bundle with one panel asset, one asset per `MODULE_IDS`, `catalog.json`, checksums, and `release-metadata.json`, and the CLI writes all declared files to an output directory.

- [ ] **Step 2: Run the focused tests and verify the expected missing-interface failure**

  Run: `python -m pytest -q tests/test_modular_panel_release_builder.py`

  Expected: collection or attribute failure because the new builder module and interfaces do not exist yet.

- [ ] **Step 3: Implement the minimal dataclasses, argument parser, and bundle writer**

  Keep the builder pure and filesystem-scoped. Normalize `version` to SemVer, require a non-negative integer epoch, write JSON as UTF-8 with sorted keys/indentation, and return paths/checksums through typed dataclasses rather than making CI parse console output.

- [ ] **Step 4: Run focused tests and confirm the interface is green**

  Run: `python -m pytest -q tests/test_modular_panel_release_builder.py`

- [ ] **Step 5: Commit the interface milestone**

  ```bash
  git add scripts/build_modular_panel_release.py tests/test_modular_panel_release_builder.py
  git commit -m "feat(release): add modular release builder interfaces"
  ```

### Task 2: Implement Deterministic Tar Creation

**Files:**
- Modify: `scripts/build_modular_panel_release.py`
- Test: `tests/test_modular_panel_release_builder.py`

**Interfaces:**
- Add `build_deterministic_tar(output_path: Path, files: Mapping[str, Path], *, epoch: int) -> str` returning the SHA-256 digest.
- Add `read_archive_members(path: Path) -> list[tarfile.TarInfo]` for test and preflight inspection.

- [ ] **Step 1: Write failing reproducibility and metadata tests**

  Build the same archive twice from a temporary source tree with reversed input insertion order and assert identical bytes, identical SHA-256, sorted member names, fixed metadata, and no host absolute path.

- [ ] **Step 2: Run the focused tests and verify they fail before implementation**

  Run: `python -m pytest -q tests/test_modular_panel_release_builder.py -k deterministic`

- [ ] **Step 3: Implement deterministic tar/gzip creation**

  Normalize every key with `PurePosixPath`, reject absolute/parent paths and symlink sources, add directories before their children when needed, set uid/gid/uname/gname/mtime/mode explicitly, sort members, and use a gzip header with the supplied epoch.

- [ ] **Step 4: Run the focused deterministic tests**

  Run: `python -m pytest -q tests/test_modular_panel_release_builder.py -k deterministic`

- [ ] **Step 5: Commit the deterministic archive milestone**

  ```bash
  git add scripts/build_modular_panel_release.py tests/test_modular_panel_release_builder.py
  git commit -m "feat(release): make panel archives reproducible"
  ```

### Task 3: Project Module Ownership and Generate Manifests

**Files:**
- Modify: `scripts/build_modular_panel_release.py`
- Test: `tests/test_modular_panel_release_builder.py`
- Reference: `docs/modular-panel-stage0-inventory.json`, `docs/modular-panel-stage7-installer-profiles.md`, `xkeen-ui/services/module_registry.py`

**Interfaces:**
- Add `build_module_ownership(root: Path) -> dict[str, list[str]]` returning normalized repository-relative paths by module id.
- Add `build_module_manifest(module_id: str, *, version: str, ownership: Sequence[str], registry: ModuleDefinition, architecture: str = "aarch64") -> dict[str, Any]`.
- Add `module_archive_spec(root: Path, module_id: str, ...) -> ArchiveSpec`.

- [ ] **Step 1: Write failing ownership tests**

  Assert every registry module has a deterministic ownership list, `core` owns shared runtime maps, removable module ownership excludes `modules.json`, `secret.key`, Mihomo profiles/backups, installer scripts, and unknown paths raise a build error instead of being silently assigned.

- [ ] **Step 2: Run the focused ownership tests and verify failure**

  Run: `python -m pytest -q tests/test_modular_panel_release_builder.py -k ownership`

- [ ] **Step 3: Implement ownership projection from Stage 0/7 boundaries**

  Load Stage 0 unit paths, use the registry definitions for dependencies/restart metadata, apply Stage 7 user/state exclusions, keep module payload paths under `payload/`, and fail on an unclassified managed path. Do not copy user data or legacy state into module archives.

- [ ] **Step 4: Add manifest fields and validate generated manifests**

  Emit Stage 8.0 required fields (`schema_version`, identity/API fields, channel, min core, architecture, requires/conflicts, `requires_restart`, `ownership`, `max_size`) and set catalog `archive`, `size`, `sha256`, and `signing_key_id` only after the archive exists.

- [ ] **Step 5: Run ownership and manifest tests**

  Run: `python -m pytest -q tests/test_modular_panel_release_builder.py -k "ownership or manifest"`

- [ ] **Step 6: Commit module ownership and manifest generation**

  ```bash
  git add scripts/build_modular_panel_release.py tests/test_modular_panel_release_builder.py
  git commit -m "feat(release): generate module ownership manifests"
  ```

### Task 4: Build Panel/Module Assets and Catalog

**Files:**
- Modify: `scripts/build_modular_panel_release.py`
- Test: `tests/test_modular_panel_release_builder.py`, `tests/test_module_package_contract.py`

**Interfaces:**
- Add `build_panel_archive(root: Path, output_dir: Path, *, version: str, epoch: int) -> BuiltAsset`.
- Add `build_module_archive(root: Path, output_dir: Path, module_id: str, *, version: str, epoch: int) -> BuiltAsset`.
- Add `build_catalog(bundle: ReleaseBundle) -> dict[str, Any]`.

- [ ] **Step 1: Write failing asset and catalog tests**

  Assert the panel filename is `xkeen-ui-panel-<version>.tar.gz`, module names are `xkeen-module-<id>-<version>.tar.gz`, all module archives pass `validate_module_archive` with architecture/core inputs, catalog sizes/digests equal actual files, and release metadata lists every asset exactly once.

- [ ] **Step 2: Run the focused tests and verify failure**

  Run: `python -m pytest -q tests/test_modular_panel_release_builder.py tests/test_module_package_contract.py -k "asset or catalog or release"`

- [ ] **Step 3: Implement panel and module archive assembly**

  Preserve the existing bootstrap source selection for the panel payload, map module files into `payload/`, add `module-manifest.json` as the only module metadata file, and reject any archive path that Stage 8.0 preflight does not accept.

- [ ] **Step 4: Implement catalog/checksum/release metadata generation**

  Write stable-only catalog entries from the registry, use trusted key id `release-2026` as the unsigned 8.1 placeholder, write `<asset>.sha256` with the standard `<digest>  <filename>` form, and include source commit/version/asset list in `release-metadata.json`.

- [ ] **Step 5: Run asset tests and static preflight**

  Run: `python -m pytest -q tests/test_modular_panel_release_builder.py tests/test_module_package_contract.py`

- [ ] **Step 6: Commit generated asset logic**

  ```bash
  git add scripts/build_modular_panel_release.py tests/test_modular_panel_release_builder.py tests/test_module_package_contract.py
  git commit -m "feat(release): build panel and module release assets"
  ```

### Task 5: Preserve Legacy Bootstrap Packaging

**Files:**
- Modify: `scripts/build_user_archive.py` only if required to share deterministic helpers without changing its output contract
- Test: `tests/test_user_archive_packaging.py`, `tests/test_build_stamp.py`, `tests/test_modular_panel_release_builder.py`

**Interfaces:**
- Keep `scripts/build_user_archive.py` CLI and output `xkeen-ui-routing.tar.gz` unchanged.
- Add a regression assertion that the new panel asset contains the same installer entrypoints and legacy bootstrap files required by `xkeen-ui/install.sh`.

- [ ] **Step 1: Write failing compatibility assertion**

  Build the panel asset and compare required paths (`xkeen-ui/install.sh`, `xkeen-ui/uninstall.sh`, frontend/runtime payload roots) against the legacy builder's package selection.

- [ ] **Step 2: Run the compatibility test and verify its failure if the panel source selection is incomplete**

  Run: `python -m pytest -q tests/test_modular_panel_release_builder.py -k compatibility`

- [ ] **Step 3: Implement only the shared source-selection adapter needed by both builders**

  Do not alter the legacy archive name or install layout. Keep any change to `build_user_archive.py` limited to a reusable function with identical current defaults and output members.

- [ ] **Step 4: Run legacy packaging tests plus compatibility tests**

  Run: `python -m pytest -q tests/test_user_archive_packaging.py tests/test_build_stamp.py tests/test_modular_panel_release_builder.py -k compatibility`

- [ ] **Step 5: Commit compatibility changes**

  ```bash
  git add scripts/build_user_archive.py tests/test_user_archive_packaging.py tests/test_build_stamp.py tests/test_modular_panel_release_builder.py
  git commit -m "test(release): preserve bootstrap archive compatibility"
  ```

### Task 6: Add CI Build and Release Publication

**Files:**
- Modify: `.github/workflows/build-user-archive.yml`
- Test: `tests/test_modular_panel_release_workflow.py`
- Modify: `docs/superpowers/specs/2026-10-03-modular-panel-stage8-1-release-assets-design.md` only if implementation changes an approved boundary

**Interfaces:**
- CI invokes `python scripts/build_modular_panel_release.py --root . --output-dir dist/modular-panel --version "$VERSION" --source-date-epoch "$SOURCE_DATE_EPOCH" --source-commit "$GITHUB_SHA"`.
- Tag builds publish the complete list returned by `release-metadata.json`; push builds upload validation artifacts without creating a Release.

- [ ] **Step 1: Write failing workflow contract tests**

  Parse the YAML and assert the workflow runs on pushes and tags, uses the modular builder, runs Stage 8.0 preflight/tests, uploads `dist/modular-panel/**`, and gates `gh release create/upload` behind a tag condition.

- [ ] **Step 2: Run workflow tests and verify failure**

  Run: `python -m pytest -q tests/test_modular_panel_release_workflow.py`

- [ ] **Step 3: Add CI steps in dependency order**

  Keep the existing user archive job intact; add modular release build/validation after frontend build, then upload artifact. Use `if: startsWith(github.ref, 'refs/tags/v')` for Release creation and pass only generated assets to `gh release create`.

- [ ] **Step 4: Run workflow contract and YAML parsing tests**

  Run: `python -m pytest -q tests/test_modular_panel_release_workflow.py tests/test_happ_decryptor_workflows.py tests/test_build_stamp.py`

- [ ] **Step 5: Commit CI changes**

  ```bash
  git add .github/workflows/build-user-archive.yml tests/test_modular_panel_release_workflow.py
  git commit -m "ci(release): publish modular panel assets on tags"
  ```

### Task 7: Update Stage 8.1 Documentation and Generated Baselines

**Files:**
- Modify: `README-modular-panel-plan.md`
- Modify: `docs/README.md`
- Modify: `docs/modular-panel-stage8-official-module-manager.md`
- Modify: `docs/modular-panel-stage8-contract.md`
- Modify: `docs/modular-panel-stage8-contract.json`
- Test: `tests/test_modular_panel_stage8_contract.py`

**Interfaces:**
- Stage 8 contract adds `release_assets`, `determinism`, and `ci_publication` sections generated by `scripts/generate_modular_panel_stage8_contract.py`.
- Documentation marks 8.1 closed only after builder and CI tests pass.

- [ ] **Step 1: Write failing contract/documentation assertions**

  Assert exact asset naming, deterministic metadata, catalog/checksum outputs, CI tag gating, and a closed 8.1 status are present in generated JSON/Markdown and roadmap docs.

- [ ] **Step 2: Run focused contract tests and verify failure**

  Run: `python -m pytest -q tests/test_modular_panel_stage8_contract.py -k "release or 8_1"`

- [ ] **Step 3: Extend the generator and regenerate snapshots**

  Add the approved sections, regenerate both Stage 8 contract files, update the roadmap/index and link the implementation plan/spec.

- [ ] **Step 4: Run all stage and release tests**

  Run: `python -m pytest -q tests/test_modular_panel_stage0_inventory.py tests/test_modular_panel_stage8_contract.py tests/test_modular_panel_release_builder.py tests/test_module_package_contract.py tests/test_modular_panel_release_workflow.py`

- [ ] **Step 5: Commit documentation and generated snapshots**

  ```bash
  git add README-modular-panel-plan.md docs/README.md docs/modular-panel-stage8-official-module-manager.md docs/modular-panel-stage8-contract.md docs/modular-panel-stage8-contract.json tests/test_modular_panel_stage8_contract.py
  git commit -m "docs(modules): close stage 8.1 release assets"
  ```

### Task 8: Full Verification and Handoff

**Files:**
- No source changes unless verification finds a defect.

- [ ] **Step 1: Build a local release bundle from a fixed epoch**

  Run: `python scripts/build_modular_panel_release.py --root . --output-dir dist/modular-panel --version 1.0.0 --source-date-epoch 1700000000 --source-commit test-commit`

- [ ] **Step 2: Rebuild into a second directory and compare bytes/catalog**

  Run the same command with a separate output directory and assert `fc /b` (or SHA-256) matches every archive, catalog, checksum, and metadata file.

- [ ] **Step 3: Run the complete Python suite**

  On Windows, prepend `C:\Program Files\Git\bin` to `PATH` so shell-based installer tests can locate `sh`, then run `python -m pytest -q`.

- [ ] **Step 4: Run `git diff --check` and inspect the release file list**

  Confirm no untracked generated artifact is accidentally committed and the repository working tree is clean except intentionally staged release outputs.

- [ ] **Step 5: Commit only if verification requires a correction, then push the test branch**

  ```bash
  git push origin HEAD:codex/modular-panel-testing
  ```

- [ ] **Step 6: Wait for the CI run for the pushed SHA and report its terminal result**

  Use the GitHub Actions run URL for the exact commit and report the final workflow conclusion, not merely that the push succeeded.
