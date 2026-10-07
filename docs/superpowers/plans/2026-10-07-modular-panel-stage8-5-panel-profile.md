# Stage 8.5 Panel Update And Profile Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add signed whole-panel updates and atomic physical profile transitions to the existing reviewed lifecycle transaction API.

**Architecture:** Extend the signed catalog with a panel descriptor, extract Stage 7 profile selection into one pure ownership-based planner, and add `panel`/`profile` scopes to the existing detached journal runner. Keep module-only plans backward-compatible, preserve the configuration-only profile route, and route stable DevTools updates through lifecycle plan/apply.

**Tech Stack:** Python 3.11+, Flask, dataclasses, `tarfile`, Ed25519-verified catalog snapshots, pytest, existing atomic JSON and module transaction helpers.

**Spec:** `docs/superpowers/specs/2026-10-07-modular-panel-stage8-5-panel-profile-design.md`

## Global Constraints

- Stable assets come only from the signed official GitHub Release catalog; callers cannot supply URLs, checksums, paths, or file lists.
- `profile-transition` uses the exact installed release; `panel-update` uses a strictly newer stable release.
- `POST /api/modules/profile` remains configuration-only and additive-compatible.
- Panel update and profile transition are separate reviewed operations and never expand into module-only operations.
- User files, runtime state, engine configuration, `secret.key`, `var/`, `bin/`, and declared Mihomo paths are never managed payload.
- No archive script or hook is executed.
- One shared lock excludes module, panel, profile, legacy update, and restart mutations.
- Existing Stage 8.3 plans without `scope` remain readable as module plans.
- Every production behavior is introduced through a failing test first.
- Work stays on `codex/modular-panel-testing`; do not create a second worktree or branch.

---

### Task 1: Signed Panel Descriptor And Verified Download

**Files:**
- Modify: `scripts/build_modular_panel_release.py`
- Modify: `xkeen-ui/services/module_package_contract.py`
- Modify: `xkeen-ui/services/module_catalog_client.py`
- Create: `xkeen-ui/services/panel_package_contract.py`
- Modify: `tests/test_modular_panel_release_builder.py`
- Modify: `tests/test_module_package_contract.py`
- Modify: `tests/test_module_catalog_client.py`
- Create: `tests/test_panel_package_contract.py`

**Interfaces:**
- Produces: catalog field `panel: {archive, size, sha256, version, signing_key_id, architectures}`.
- Produces: `validate_panel_archive(path: Path, descriptor: Mapping[str, Any], *, platform_architecture: str) -> dict[str, Any]`.
- Produces: `ModuleCatalogClient.download_verified_panel_archive(snapshot: CatalogSnapshot, output_dir: Path) -> Path`.
- Consumes: existing `CatalogSnapshot`, official release URL policy, streaming limits, semver, and safe-path helpers.

- [ ] **Step 1: Add failing release/catalog tests**

Add assertions that a built catalog contains a panel descriptor whose size and SHA-256 equal the generated `xkeen-ui-panel-<version>.tar.gz`, and that catalog validation rejects missing/extra/invalid panel fields.

```python
panel = bundle.catalog["panel"]
assert panel == {
    "archive": "xkeen-ui-panel-1.2.3.tar.gz",
    "size": bundle.panel.path.stat().st_size,
    "sha256": hashlib.sha256(bundle.panel.path.read_bytes()).hexdigest(),
    "version": "1.2.3",
    "signing_key_id": "release-2026",
    "architectures": ["aarch64", "mips", "mipsel"],
}
```

- [ ] **Step 2: Run the new catalog tests and confirm RED**

Run: `python -m pytest -q tests/test_modular_panel_release_builder.py tests/test_module_package_contract.py -k "panel or catalog"`

Expected: failures because `catalog.json` has no `panel` field and the validator does not require it.

- [ ] **Step 3: Publish and normalize the panel descriptor**

Add `_panel_catalog_entry(panel, inputs)` to the builder and extend `validate_catalog_document` to return a normalized panel mapping. Require exact release version, known signing key string, supported architectures, basename-only archive name, positive bounded size, and lowercase SHA-256.

- [ ] **Step 4: Add failing panel archive safety tests**

Build controlled tarballs and assert rejection of traversal, absolute paths, duplicate members, symlink/hardlink/device entries, multiple roots, mutable state files, and ownership entries that disagree with packaged managed files. Assert a real deterministic panel archive validates and returns normalized `payload_files` and ownership.

```python
checked = validate_panel_archive(archive, descriptor, platform_architecture="aarch64")
assert checked["root"] == "xkeen-ui"
assert "services/module_lifecycle.py" in checked["payload_files"]
assert checked["ownership"]["core"]
```

- [ ] **Step 5: Run panel validator tests and confirm RED**

Run: `python -m pytest -q tests/test_panel_package_contract.py`

Expected: import failure because `services.panel_package_contract` does not exist.

- [ ] **Step 6: Implement the declarative panel archive validator**

Reuse normalized POSIX path rules but do not import or execute the staged installer. Stream tar headers, cap expanded bytes, allow only directory/regular-file members under `xkeen-ui/`, parse `module-ownership.json`, and reject state/user paths using the existing ownership policy.

- [ ] **Step 7: Add RED tests for verified panel download**

Cover official URL construction, bounded streaming, size mismatch, checksum mismatch, descriptor change, architecture rejection, and cleanup of partial files.

```python
path = client.download_verified_panel_archive(snapshot, tmp_path)
assert path.name == snapshot.catalog["panel"]["archive"]
assert path.read_bytes() == panel_bytes
```

- [ ] **Step 8: Implement verified panel download and run GREEN suites**

Run: `python -m pytest -q tests/test_modular_panel_release_builder.py tests/test_module_package_contract.py tests/test_panel_package_contract.py tests/test_module_catalog_client.py`

Expected: all pass, excluding only any pre-existing platform-specific Windows mode assertion when running on Windows.

- [ ] **Step 9: Commit Task 1**

```bash
git add scripts/build_modular_panel_release.py xkeen-ui/services/module_package_contract.py xkeen-ui/services/module_catalog_client.py xkeen-ui/services/panel_package_contract.py tests/test_modular_panel_release_builder.py tests/test_module_package_contract.py tests/test_module_catalog_client.py tests/test_panel_package_contract.py
git commit -m "feat(modules): publish verified panel archives"
```

### Task 2: One Ownership-Based Profile Planner

**Files:**
- Create: `xkeen-ui/services/module_profile_plan.py`
- Modify: `xkeen-ui/scripts/module_profile_install.py`
- Modify: `scripts/build_modular_panel_release.py`
- Modify: `xkeen-ui/services/module_transactions/plan.py`
- Create: `tests/test_module_profile_plan.py`
- Modify: `tests/test_installer_profiles.py`
- Modify: `tests/test_module_transactions_guardrails.py`
- Modify: `tests/test_module_packages_over_installer_profiles.py`

**Interfaces:**
- Produces: `ProfileTarget` dataclass with `profile`, `module_ids`, `editor_variant`, `payload_files`, `state_files`, and `frontend`.
- Produces: `build_profile_target(panel_source: Path, *, profile: str, module_ids: Sequence[str] | None, editor_variant: str | None) -> ProfileTarget`.
- Produces: `profile_transition_diff(installed_state: Mapping[str, Any], target: ProfileTarget) -> dict[str, Any]`.
- Consumes: `module-ownership.json`, canonical presets/dependencies, and the Stage 7 user-owned path contract.

- [ ] **Step 1: Add RED pure-planner tests**

Cover all canonical presets, valid/invalid Custom sets, dependency closure, editor variants, exact owned payload, state JSON, frontend manifests, and deterministic transition diff.

```python
target = build_profile_target(panel, profile="xray-minimal", module_ids=None, editor_variant=None)
assert target.module_ids == ("core", "engine.xray", "tool.editor")
assert target.editor_variant == "light"
assert not any(path.startswith("routes/mihomo") for path in target.payload_files)
```

- [ ] **Step 2: Run planner tests and confirm RED**

Run: `python -m pytest -q tests/test_module_profile_plan.py`

Expected: import failure because the pure planner does not exist.

- [ ] **Step 3: Implement the pure planner**

Move canonical profile/module validation and target-state generation out of the installer. Make ownership data, not filename classification, authoritative for payload selection. Keep frontend closure metadata from `module-ownership.json` and editor variant filtering explicit.

- [ ] **Step 4: Switch installer and release builder to the shared planner**

Keep `module_profile_install.apply_profile(...)` and its CLI stable. Replace its internal selection/classification calls with `build_profile_target`; make the release builder use the same ownership output when cutting module and panel assets.

- [ ] **Step 5: Prove Stage 7 behavior remains GREEN**

Run: `python -m pytest -q tests/test_module_profile_plan.py tests/test_installer_profiles.py tests/test_module_packages_over_installer_profiles.py tests/test_installer_profile_frontend_closure.py tests/test_module_transactions_guardrails.py`

- [ ] **Step 6: Commit Task 2**

```bash
git add xkeen-ui/services/module_profile_plan.py xkeen-ui/scripts/module_profile_install.py scripts/build_modular_panel_release.py xkeen-ui/services/module_transactions/plan.py tests/test_module_profile_plan.py tests/test_installer_profiles.py tests/test_module_packages_over_installer_profiles.py tests/test_module_transactions_guardrails.py
git commit -m "refactor(modules): share profile ownership planning"
```

### Task 3: Full-Scope Plans And Backward-Compatible Journals

**Files:**
- Modify: `xkeen-ui/services/module_transactions/plan.py`
- Modify: `xkeen-ui/services/module_transactions/journal.py`
- Modify: `xkeen-ui/services/module_transactions/install_state.py`
- Modify: `xkeen-ui/services/module_transactions/state.py`
- Modify: `tests/test_module_transactions_plan.py`
- Modify: `tests/test_module_transactions_journal.py`
- Modify: `tests/test_module_transactions_install_state.py`
- Create: `tests/test_panel_profile_transaction_plan.py`

**Interfaces:**
- Produces: discriminated `Plan.scope` values `module`, `panel`, and `profile`.
- Produces: `build_panel_update_plan(...) -> Plan` and `build_profile_transition_plan(...) -> Plan`.
- Produces: `Plan` fields `source_version`, `target_version`, `target_profile`, `files_add`, `files_remove`, `archive`, `required_free_bytes`, and `installed_after`.
- Consumes: verified normalized catalog, saved profile, physical install manifest, current/target ownership, active engines, and free disk bytes.

- [ ] **Step 1: Add RED planning tests**

Assert panel update chooses a strictly newer release and preserves saved profile/Custom/editor state. Assert profile transition stays on the current version, reads desired registry state, calculates full add/remove sets, refuses an already matching payload, and never emits user-owned paths.

```python
plan = build_profile_transition_plan(panel_root=panel, state_dir=panel, catalog=catalog, architecture="aarch64")
assert plan.scope == "profile"
assert plan.source_version == plan.target_version == "1.2.3"
assert plan.target_profile["profile"] == "xray-minimal"
assert "routes/mihomo.py" in plan.files_remove
```

- [ ] **Step 2: Run planning tests and confirm RED**

Run: `python -m pytest -q tests/test_panel_profile_transaction_plan.py`

Expected: missing full-scope plan builders.

- [ ] **Step 3: Generalize plan serialization minimally**

Add scope/version/profile fields without changing existing module plan behavior. `plan_from_json` defaults a missing scope to `module` and accepts the exact old JSON shape. Keep `module_id` mandatory only for module scope.

- [ ] **Step 4: Implement full-scope builders and free-space accounting**

Compute old managed files from installed manifests/ownership, target files from the panel descriptor and profile planner, archive plus expanded payload plus worst-case backups plus 20 percent, and stable blockers/codes from the design.

- [ ] **Step 5: Add RED journal compatibility/scope tests**

Open a fixture written in the old Stage 8.3 plan format, then create panel/profile journals and assert rollback is constrained to each serialized `files_add/files_remove/state` set.

- [ ] **Step 6: Update journal/install-state helpers and run GREEN suites**

Run: `python -m pytest -q tests/test_module_transactions_plan.py tests/test_panel_profile_transaction_plan.py tests/test_module_transactions_journal.py tests/test_module_transactions_install_state.py`

- [ ] **Step 7: Commit Task 3**

```bash
git add xkeen-ui/services/module_transactions/plan.py xkeen-ui/services/module_transactions/journal.py xkeen-ui/services/module_transactions/install_state.py xkeen-ui/services/module_transactions/state.py tests/test_module_transactions_plan.py tests/test_panel_profile_transaction_plan.py tests/test_module_transactions_journal.py tests/test_module_transactions_install_state.py
git commit -m "feat(modules): plan panel and profile transactions"
```

### Task 4: Full-Scope Detached Execution And Recovery

**Files:**
- Modify: `xkeen-ui/services/module_transactions/executor.py`
- Modify: `xkeen-ui/services/module_transactions/extract.py`
- Modify: `xkeen-ui/services/module_transactions/launcher.py`
- Modify: `xkeen-ui/scripts/module_transaction.py`
- Modify: `tests/test_module_transactions_executor.py`
- Modify: `tests/test_module_transactions_cli.py`
- Modify: `tests/test_module_transactions_launcher.py`
- Create: `tests/test_panel_profile_transactions.py`

**Interfaces:**
- Produces: detached execution of all three plan scopes through the existing `launch` and CLI entry point.
- Produces: full-scope archive verification/extraction, active-module health validation, cancel semantics, and idempotent recovery.
- Consumes: `download_verified_panel_archive`, `validate_panel_archive`, `ProfileTarget`, generalized `Plan`, and existing `Journal`.

- [ ] **Step 1: Add RED successful-operation integration tests**

Use a fake catalog transport and real temporary panel trees. Assert Full to Xray/Mihomo Minimal and back, Custom transitions, and a cross-version panel update commit with exact target managed bytes while user files remain byte-for-byte unchanged.

- [ ] **Step 2: Run success cases and confirm RED**

Run: `python -m pytest -q tests/test_panel_profile_transactions.py -k "commits or preserves"`

Expected: executor supports only module archives.

- [ ] **Step 3: Implement scope dispatch in the runner**

Keep shared status step names. Module scope follows the existing path; panel/profile scopes download the panel archive, validate it, extract selected paths, journal full add/remove/state changes, flush, restart, and validate HTTP plus target active modules.

- [ ] **Step 4: Add RED failure, cancellation, and recovery tests**

Cover corrupt archive before mutation, cancellation before applying, cancellation after one replacement, health failure, rollback restart failure, crash at every step, repeat recovery, and a module journal beside full-scope fixtures to prove rollback boundaries never widen.

- [ ] **Step 5: Implement full rollback and recovery dispatch**

Persist `scope` before mutation, raise the existing cancellation shield during rollback/commit, keep `rollback_failed` backups, and settle pre-mutation crashes as `interrupted` without restarting.

- [ ] **Step 6: Run transaction suites GREEN**

Run: `python -m pytest -q tests/test_panel_profile_transactions.py tests/test_module_transactions_executor.py tests/test_module_transactions_cli.py tests/test_module_transactions_launcher.py tests/test_module_transactions_journal.py`

- [ ] **Step 7: Commit Task 4**

```bash
git add xkeen-ui/services/module_transactions/executor.py xkeen-ui/services/module_transactions/extract.py xkeen-ui/services/module_transactions/launcher.py xkeen-ui/scripts/module_transaction.py tests/test_panel_profile_transactions.py tests/test_module_transactions_executor.py tests/test_module_transactions_cli.py tests/test_module_transactions_launcher.py
git commit -m "feat(modules): execute full panel transactions"
```

### Task 5: Lifecycle Planning, Apply, And Restart Guard

**Files:**
- Modify: `xkeen-ui/services/module_lifecycle.py`
- Modify: `xkeen-ui/routes/modules.py`
- Modify: `xkeen-ui/routes/__init__.py`
- Modify: `tests/test_module_lifecycle.py`
- Modify: `tests/test_module_lifecycle_routes.py`
- Modify: `tests/test_module_registry.py`

**Interfaces:**
- Produces: lifecycle operations `panel-update` and `profile-transition` through existing `plan` and `apply` methods.
- Produces: additive profile response fields `transition_required` and `transition_target`.
- Produces: restart failure `profile_transition_required` when desired and installed physical states differ.
- Consumes: full-scope plan builders and the existing canonical plan digest/launcher.

- [ ] **Step 1: Add RED lifecycle service tests**

Assert read-only panel/profile plans, blocker responses, deterministic digests, stale apply after catalog/profile/install/free-space change, no client authority fields, and exact rebuilt plans handed to launcher.

- [ ] **Step 2: Add RED profile/restart route tests**

Assert the old profile response fields remain, the new pending fields are correct, unknown request fields remain rejected, and restart returns `409 profile_transition_required` until installed state matches desired state.

- [ ] **Step 3: Run lifecycle tests and confirm RED**

Run: `python -m pytest -q tests/test_module_lifecycle.py tests/test_module_lifecycle_routes.py tests/test_module_registry.py -k "panel or profile or restart or transition"`

- [ ] **Step 4: Extend lifecycle orchestration and route validation**

Dispatch by operation, map `operation_plan_stale` only for full scopes, omit `module_id` for full scopes, preserve 8 KiB/no-store rules, and keep all file/archive/network work outside Flask.

- [ ] **Step 5: Implement pending-profile response and guarded restart**

Compare desired `modules.json` profile/module ids/editor variant with physical `install-profile.json` and `module-installed.json`. Do not mutate physical manifests in the profile route.

- [ ] **Step 6: Run lifecycle/registry suites GREEN**

Run: `python -m pytest -q tests/test_module_lifecycle.py tests/test_module_lifecycle_routes.py tests/test_module_registry.py tests/test_request_size_limits.py`

- [ ] **Step 7: Commit Task 5**

```bash
git add xkeen-ui/services/module_lifecycle.py xkeen-ui/routes/modules.py xkeen-ui/routes/__init__.py tests/test_module_lifecycle.py tests/test_module_lifecycle_routes.py tests/test_module_registry.py
git commit -m "feat(modules): expose panel and profile lifecycle plans"
```

### Task 6: Stable DevTools Compatibility Facade

**Files:**
- Modify: `xkeen-ui/routes/devtools.py`
- Modify: `xkeen-ui/services/self_update/__init__.py`
- Modify: `xkeen-ui/services/self_update/state.py`
- Modify: `tests/test_devtools_update_smoke.py`
- Modify: `tests/test_self_update_status_recovery.py`
- Create: `tests/test_self_update_lifecycle_delegation.py`

**Interfaces:**
- Produces: stable `check/run/status` projection over `ModuleLifecycleService`.
- Preserves: development-only `main` shell updater and old-backup rollback.
- Consumes: shared lifecycle service factory, lock/status serializer, and `panel-update` plan/apply.

- [ ] **Step 1: Add RED stable delegation tests**

Assert stable check uses the signed panel descriptor, stable run internally builds/applies a server plan without accepting `resolved` URL/checksum authority, status projects lifecycle state, and busy lifecycle operations refuse legacy main runs.

- [ ] **Step 2: Run delegation tests and confirm RED**

Run: `python -m pytest -q tests/test_self_update_lifecycle_delegation.py`

Expected: stable routes still launch `update_xkeen_ui.sh`.

- [ ] **Step 3: Implement channel dispatch and response compatibility**

Inject the lifecycle service into DevTools production wiring. For stable, translate lifecycle catalog/plan/status fields into existing response keys; for `main`, retain the shell runner and add `development_only: true`. Ignore client `resolved` authority on stable.

- [ ] **Step 4: Preserve legacy rollback and shared locking**

Keep `/api/devtools/update/rollback` for old backup archives only. Confirm both stable lifecycle and main legacy paths use the same self-update lock and never overwrite each other's status.

- [ ] **Step 5: Run self-update and lifecycle suites GREEN**

Run: `python -m pytest -q tests/test_self_update_lifecycle_delegation.py tests/test_devtools_update_smoke.py tests/test_self_update_status_recovery.py tests/test_module_lifecycle.py tests/test_module_lifecycle_routes.py`

- [ ] **Step 6: Commit Task 6**

```bash
git add xkeen-ui/routes/devtools.py xkeen-ui/services/self_update/__init__.py xkeen-ui/services/self_update/state.py tests/test_self_update_lifecycle_delegation.py tests/test_devtools_update_smoke.py tests/test_self_update_status_recovery.py
git commit -m "feat(updater): delegate stable updates to lifecycle"
```

### Task 7: Real-Tree Acceptance And Recovery Matrix

**Files:**
- Modify: `tests/test_module_transactions_real_tree.py`
- Modify: `tests/test_module_packages_over_installer_profiles.py`
- Create: `tests/test_panel_update_real_tree.py`
- Modify: `tests/support/module_tx.py`

**Interfaces:**
- Produces: end-to-end proof that release assets, profile planning, full-scope transaction, state manifests, and application import agree.
- Consumes: the real release builder and all production validators/planners/executors from Tasks 1-6.

- [ ] **Step 1: Add real-tree profile transition cases**

Build one release, install Full, transition to each minimal profile and back, import the application after every commit, and assert no dangling Python/static dependency and no user-file change.

- [ ] **Step 2: Add real-tree cross-version update cases**

Build two deterministic releases with one controlled managed-file change. Install Full, Xray Minimal, Mihomo Minimal, and Custom from the first; update each to the second; assert version/state/profile preservation and target bytes.

- [ ] **Step 3: Add the full recovery matrix**

Parameterize crashes at `prepared`, `downloading`, `verifying`, `applying`, `state`, `restarting`, `health`, and `rolling_back`. Assert exact old/new tree outcomes and retry behavior from the design.

- [ ] **Step 4: Run real-tree suites GREEN**

Run: `python -m pytest -q tests/test_panel_update_real_tree.py tests/test_module_transactions_real_tree.py tests/test_module_packages_over_installer_profiles.py`

- [ ] **Step 5: Commit Task 7**

```bash
git add tests/test_panel_update_real_tree.py tests/test_module_transactions_real_tree.py tests/test_module_packages_over_installer_profiles.py tests/support/module_tx.py
git commit -m "test(modules): cover panel transition recovery"
```

### Task 8: Contracts, Documentation, Review, And Delivery

**Files:**
- Create: `docs/modular-panel-stage8-panel-profile.md`
- Modify: `README-modular-panel-plan.md`
- Modify: `docs/modular-panel-stage8-official-module-manager.md`
- Modify: `scripts/generate_modular_panel_stage8_contract.py`
- Regenerate: `docs/modular-panel-stage8-contract.json`
- Regenerate: `docs/modular-panel-stage8-contract.md`
- Regenerate: `docs/modular-panel-stage0-inventory.json`
- Regenerate: `docs/modular-panel-stage0-inventory.md`
- Regenerate: `xkeen-ui/module-sizes.json`
- Modify: `tests/test_modular_panel_stage8_contract.py`
- Modify: `tests/test_modular_panel_stage0_inventory.py`

**Interfaces:**
- Produces: the operator contract, recovery runbook, generated Stage 8 machine contract, closed roadmap status, stable inventories, and final delivery evidence.
- Consumes: all implemented APIs, codes, scopes, archive fields, and test counts from Tasks 1-7.

- [ ] **Step 1: Add RED generated-contract assertions**

Assert Stage 8.5 closed metadata, required panel descriptor fields, full-scope operation sequences, profile pending/restart policy, stable DevTools delegation, and rollback-scope separation.

- [ ] **Step 2: Run contract tests and confirm RED**

Run: `python -m pytest -q tests/test_modular_panel_stage8_contract.py`

- [ ] **Step 3: Write operator/recovery documentation and close roadmap 8.5**

Document plan/apply payloads, pending-profile flow, panel/profile status, all new error codes, cancel semantics, boot recovery, `rollback_failed`, stable/main DevTools split, and manual recovery steps. Mark 8.5 closed and 8.6 next.

- [ ] **Step 4: Update generator and regenerate all affected artifacts**

Run:

```bash
python scripts/generate_modular_panel_inventory.py --root .
python scripts/sync_module_sizes.py --root .
python scripts/generate_modular_panel_inventory.py --root .
python scripts/generate_modular_panel_stage4_1_contract.py --root .
python scripts/generate_modular_panel_stage4_6_compatibility.py --root .
python scripts/generate_panel_operator_inventory.py --root .
python scripts/generate_operator_icon_inventory.py
python scripts/generate_modular_panel_stage8_contract.py --root .
```

Repeat inventory/size/inventory and confirm hashes are unchanged.

- [ ] **Step 5: Run generated and targeted suites**

Run:

```bash
python -m pytest -q tests/test_modular_panel_stage0_inventory.py tests/test_modular_panel_stage4_1_contract.py tests/test_modular_panel_stage4_6_compatibility.py tests/test_modular_panel_stage8_contract.py tests/test_panel_operator_stage0_contract.py tests/test_operator_icons.py
python -m pytest -q tests/test_module_catalog_client.py tests/test_module_package_contract.py tests/test_panel_package_contract.py tests/test_module_profile_plan.py tests/test_panel_profile_transaction_plan.py tests/test_panel_profile_transactions.py tests/test_module_lifecycle.py tests/test_module_lifecycle_routes.py tests/test_self_update_lifecycle_delegation.py tests/test_panel_update_real_tree.py
python -m compileall -q xkeen-ui tests
git diff --check
```

- [ ] **Step 6: Commit docs and generated artifacts**

```bash
git add README-modular-panel-plan.md docs/modular-panel-stage8-panel-profile.md docs/modular-panel-stage8-official-module-manager.md scripts/generate_modular_panel_stage8_contract.py docs/modular-panel-stage8-contract.json docs/modular-panel-stage8-contract.md docs/modular-panel-stage0-inventory.json docs/modular-panel-stage0-inventory.md xkeen-ui/module-sizes.json tests/test_modular_panel_stage8_contract.py tests/test_modular_panel_stage0_inventory.py
git commit -m "docs(modules): close panel update stage"
```

- [ ] **Step 7: Request independent code review and fix all Critical/Important findings**

Review the complete range from the design commit through `HEAD`, with emphasis on archive trust, path safety, state preservation, scope isolation, cancellation, recovery, and compatibility. Any fix follows systematic debugging and TDD, receives its own commit, and regenerates inventories if source sizes change.

- [ ] **Step 8: Run fresh full verification**

Run: `python -m pytest -q`

On Windows, compare failures with the documented baseline platform-only set; no Stage 8.5, lifecycle, transaction, catalog, contract, or inventory failure is acceptable. Run targeted tests for any flaky result in isolation and repeatedly before classifying it.

- [ ] **Step 9: Push and wait for GitHub**

```bash
git status --short --branch
git push origin codex/modular-panel-testing
gh run list --branch codex/modular-panel-testing --limit 4 --json databaseId,name,status,conclusion,headSha,url
```

Watch both `CI` and `Build user archive` for the pushed SHA to terminal success. For any failure, inspect `gh run view <id> --log-failed`, reproduce, fix through TDD, commit, push, and wait again.
