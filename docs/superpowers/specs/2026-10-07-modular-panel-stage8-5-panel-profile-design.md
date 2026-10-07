# Stage 8.5: Panel Update And Profile Transition

**Status:** approved design, pending implementation  
**Date:** 2026-10-07  
**Scope:** signed whole-panel updates and physical profile transitions through the Stage 8 lifecycle engine

## Context

Stage 8.4 exposes reviewed module-only plans through a detached transaction
runner. Stage 7 already has an installer-side profile transaction, while the
older DevTools self-updater downloads a legacy archive and invokes
`install.sh`. Those paths do not yet share a plan, journal, trust policy, or
rollback model.

Stage 8.5 makes a signed panel archive the source for two new full-scope
operations:

- a panel update changes the release while preserving the saved profile and
  user-owned state;
- a profile transition changes the physically installed module set while
  keeping the installed release unchanged.

Module-only operations remain isolated to one module. Panel updates and
profile transitions are separate transactions and never decompose into a
series of module-only changes.

## Goals

- Publish the panel archive descriptor inside the signed catalog.
- Validate, download, and extract the panel archive without executing code
  from it.
- Add reviewed `panel-update` and `profile-transition` lifecycle plans.
- Preserve profile, Custom module selection, editor variant, enabled state,
  and user configuration across a panel update.
- Apply the desired profile atomically to the physical payload.
- Use one lock, status surface, detached runner, journal, cancellation model,
  and recovery path for module, panel, and profile operations.
- Keep module-only rollback distinct from full managed-tree rollback.
- Move Stage 7 profile selection onto the same ownership map used by module
  packages.
- Make the signed lifecycle path the production stable updater while keeping
  the DevTools API compatible.

## Non-goals

- Combining a version update and an explicit profile change in one request.
- Updating modules independently to a release different from the panel.
- Delta updates, arbitrary repositories, user-provided URLs, or extra
  channels.
- Executing `install.sh`, package hooks, or other archive code.
- Replacing the development-only `main` updater.
- UI work, notifications, or background polling from Stages 8.6 and 8.7.

## Accepted Product Decisions

### Profile API remains configuration-only

`POST /api/modules/profile` keeps its Stage 7 behavior: it atomically stores
the desired profile and returns its restart diff. It does not download or
change payload files. It additionally reports whether a physical profile
transition is required.

The physical transition is a reviewed lifecycle operation. The client first
stores the desired profile, then requests and applies a
`profile-transition` plan. A guarded restart is refused while the desired
profile differs from the installed payload.

### Stable self-update moves to lifecycle

The signed panel update is the only production stable update path. Existing
`/api/devtools/update/*` routes remain a compatibility facade and delegate
stable operations to the lifecycle service. The `main` channel stays an
explicit development-only legacy path. Both paths use the same update lock,
so they cannot mutate the panel concurrently.

### Each operation has one purpose

A profile transition downloads the panel archive for the currently installed
release. A panel update downloads the target release archive and reapplies the
saved profile. A user cannot request both changes in one plan. After one
operation commits, the client builds a fresh plan for the other.

## Signed Catalog And Panel Archive

`catalog.json` gains a required top-level `panel` descriptor covered by the
existing Ed25519 signature. It contains:

- `archive`, `size`, and `sha256`;
- `version`, equal to `release_version`;
- `signing_key_id`;
- supported `architectures`.

The release builder derives this descriptor from the deterministic panel
archive it already produces. Catalog schema version remains `1`: the project
has not shipped a production catalog consumer that accepts panel updates, and
the field becomes required atomically with this implementation.

`ModuleCatalogClient` gains a bounded streaming panel download. It accepts
only the official immutable release asset URL, verifies size and SHA-256, and
returns the archive only from an already signature-verified catalog snapshot.
Neither an archive URL nor its digest is accepted from an HTTP client.

The panel archive validator requires:

- exactly one `xkeen-ui/` root;
- directories and regular files only;
- normalized relative paths with no traversal, absolute paths, drive
  prefixes, duplicate members, links, devices, or hooks;
- the expected maximum compressed and expanded sizes;
- a valid `module-ownership.json` matching the packaged managed files;
- no mutable runtime state or user-owned configuration in the archive.

`install.sh` may remain an archived bootstrap artifact, but the lifecycle
runner never executes it.

## Shared Profile Planner

The Stage 7 selection logic becomes a pure shared service. Given an ownership
map, profile id, optional Custom module ids, and editor variant, it returns:

- validated selected module ids with dependency closure;
- the exact managed payload paths for that selection;
- the four resulting state documents;
- frontend manifest output;
- a stable diff against the actually installed manifest.

The profile installer, release builder, and lifecycle transaction planner all
consume this component. The installed panel no longer maintains a second
path-owner classifier that can disagree with `module-ownership.json`.

User-owned paths and state files remain outside the payload selection. The
planner preserves the Stage 7 presets `full`, `xray-minimal`,
`mihomo-minimal`, and `custom`, including editor variant behavior.

## Plans And API

`POST /api/modules/operations/plan` accepts the existing module operations
plus two new operation names.

### Panel update

Request:

```json
{"operation":"panel-update"}
```

The server fetches the latest verified stable catalog, refuses a non-newer
release, reads the saved installed profile, and builds the target file and
state diff from the target panel archive metadata. The response reports the
current and target versions, preserved profile, changed path counts, required
free space, restart requirement, blockers, and `plan_id`.

### Profile transition

Request:

```json
{"operation":"profile-transition"}
```

The server reads the desired registry profile and the actual
`module-installed.json`, then uses the exact-release catalog. It refuses when
the physical payload already matches the desired profile. The response
reports the profile/module diff, editor variant, changed path counts, required
free space, restart requirement, blockers, and `plan_id`.

The request does not repeat profile fields. This prevents a reviewed plan
from differing from the state saved through `POST /api/modules/profile`.

### Apply and stale-plan protection

`POST /api/modules/operations/apply` keeps the existing shape and receives
the operation plus `plan_id`; module operations still include `module_id`.
The server rebuilds the complete plan from catalog, installed state, desired
profile, filesystem, and free-space state. Any difference invalidates the
digest. Existing module scopes keep `module_plan_stale`; panel and profile
scopes return `operation_plan_stale`.

Plan JSON becomes a discriminated union with `scope`:

- `module` for existing install, repair, and remove;
- `panel` for a release update;
- `profile` for a same-release profile transition.

Old Stage 8.3 journal plans without `scope` deserialize as `module`.

## Pending Transition And Restart Guard

`POST /api/modules/profile` compares desired module ids and editor variant
with the physical install manifest. Its existing response fields remain, and
it adds `transition_required` plus the desired target summary.

`POST /api/modules/restart` returns `409 profile_transition_required` while
the desired and installed profiles differ. This avoids deliberately starting
a reduced or expanded runtime over the wrong physical payload. The frozen
runtime continues serving until the transition runner owns the restart.

The guard applies to the lifecycle and stable DevTools restart boundaries.
It cannot prevent an administrator from invoking the init script manually;
boot recovery therefore continues to validate and repair unfinished
transactions before starting the panel.

## Transaction Model

All operation types use the existing detached runner, shared self-update
lock, transaction root, status file, cancellation identity checks, and
recovery entry point. There is never more than one writer of the panel tree.

For panel and profile scopes the runner performs:

1. Download the panel archive into transaction staging.
2. Verify its signed catalog descriptor and archive contract.
3. Extract only validated regular files into staging.
4. Compute the target managed set from the shared profile planner.
5. Recheck that archive metadata, desired state, and plan digest still match.
6. Journal every added, replaced, and removed managed path.
7. Atomically write the four install/profile state files and frontend
   manifests.
8. Flush the filesystem, restart the service, and wait for HTTP health.
9. Verify that every target active module has no startup error.
10. Commit, or restore the full prior managed tree and state and restart the
    previous panel.

The old managed set comes from `install-managed.json` and the installed
ownership map. Unknown legacy managed files are handled by the existing Stage
7 compatibility rule; user-owned paths are never inferred as managed.

Free-space preflight includes the compressed archive, expanded target
payload, the worst-case rollback copy of every replaced/removed path, and the
existing safety margin.

## Rollback And Recovery

Module-scope rollback continues to touch only the selected module ownership
set and shared state files. Panel/profile rollback restores every managed
path changed by the full-scope plan and all four state files. The scope is
persisted in `operation.json`; recovery never guesses it from the current
filesystem.

Cancellation before `applying` removes staging and finishes as
`interrupted`. Cancellation after mutation begins raises the shield and runs
full rollback. Commit and rollback are non-interruptible.

Recovery behavior remains step-based:

- `prepared`, `downloading`, `verifying`: discard staging, no tree changes;
- `applying`, `state`, `restarting`, `health`: restore the journaled scope;
- `rolling_back`: continue the idempotent rollback;
- confirmed commit with a leftover directory: finish cleanup only.

Failure to restore files remains `rollback_failed` and preserves the only
backup. A successful file restore with an unhealthy old panel remains
`rolled_back` with `panel_unresponsive: true`.

No nested `xkeen-ui.profile-transaction-*` is created by lifecycle
operations. Files removed from a profile remain in the transaction backup
until health succeeds, then are deleted with the committed journal.

## DevTools Compatibility

For stable channel calls:

- `check` reads the verified lifecycle catalog and panel descriptor;
- `run` builds and immediately applies a server-side `panel-update` plan,
  preserving the old one-click behavior while accepting no client URL or
  checksum authority;
- `status` projects the shared lifecycle status into the existing response;
- legacy rollback remains available only for backups created by the old
  updater.

The `main` channel continues to use the legacy shell runner and is labelled
development-only in its response. The shared lock prevents it from running
beside any lifecycle transaction.

## Errors

New stable domain codes include:

| Code | Meaning |
| --- | --- |
| `panel_update_unavailable` | no trusted compatible target release exists |
| `panel_version_current` | latest stable release is not newer |
| `panel_archive_invalid` | panel archive or ownership contract failed validation |
| `profile_transition_required` | restart is unsafe before applying desired profile |
| `profile_transition_not_required` | physical payload already matches desired profile |
| `profile_payload_unavailable` | exact-release panel archive cannot be obtained |
| `profile_target_invalid` | desired profile cannot form a valid physical payload |
| `operation_free_space` | full-scope backup/staging space is insufficient |

Existing catalog, trust, concurrency, health, cancellation, and rollback
codes remain unchanged. Responses do not reveal temporary paths, backup
paths, raw exceptions, catalog bytes, or signatures.

## Testing

Implementation follows red-green-refactor.

Catalog and package tests cover the required panel descriptor, deterministic
metadata, bounded download, digest/size mismatch, unsupported architecture,
traversal, duplicate members, links, user-state entries, and inconsistent
ownership.

Planner tests cover newer-version selection, current-version refusal,
preservation of saved Full/minimal/Custom state, pending-transition detection,
profile dependency validation, exact managed diffs, free-space blockers, and
deterministic plan digests.

Transaction tests cover:

- Full to both minimal profiles and back;
- Custom transitions and editor variants;
- panel update over Full, minimal, and Custom installations;
- byte-for-byte preservation of user configuration;
- add/replace/remove behavior across versions;
- cancel before and after mutation;
- health failure and full rollback;
- crash/recovery at every journal step;
- isolation between module-only and full-scope rollback;
- old journal deserialization and recovery.

Route and compatibility tests cover strict request validation, stale apply,
restart refusal while a transition is pending, additive profile response
fields, stable DevTools delegation, development-only `main`, shared locking,
safe status projection, and error mapping.

Real-tree tests build a panel archive, install both minimal profiles, perform
same-version profile transitions and a cross-version panel update, then import
the resulting application without dangling backend or frontend dependencies.

Verification runs targeted catalog, package, profile, transaction, lifecycle,
route, self-update, generator, and contract suites, followed by the complete
Python suite and GitHub CI.

## Documentation And Closure

Implementation adds a Stage 8.5 operator/recovery document describing the
two full-scope operations, pending-profile behavior, rollback boundaries, and
the stable DevTools migration. The Stage 8 generated contract gains the panel
descriptor and operation details. The roadmap marks 8.5 closed only after
targeted tests, full-suite verification, independent review, and CI pass.
