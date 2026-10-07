# Stage 8.4: Lifecycle API

**Status:** approved design, pending implementation  
**Date:** 2026-10-06  
**Scope:** core-owned HTTP API for official module lifecycle operations

## Context

Stage 8.3 provides the trusted module transaction engine for `install`,
`repair`, and `remove`. It already owns planning, free-space checks, detached
execution, status journaling, restart health checks, rollback, and recovery of
an interrupted operation. Stage 8.4 exposes that engine through a stable API
without moving transaction work into the Flask request process.

The installed panel release remains the compatibility boundary. A module
package must come from the same immutable release as the panel. Consequently,
Stage 8.4 does not introduce a separate `update` operation: an installed
module can be repaired, and `update_available` is always false until panel
updates are implemented in Stage 8.5.

## Goals

- List actually installed modules and their configured/runtime state.
- List modules available from the signed catalog of the installed panel
  release.
- Produce a read-only plan with file, dependency, disk-space, and restart
  information.
- Apply only the exact plan that the client reviewed.
- Expose operation status and its journal.
- Cancel an active detached operation without signalling an unrelated process.
- Recover an abandoned operation and report whether an explicit restart is
  still required.
- Provide an explicit restart action guarded against concurrent mutation.
- Preserve all existing module registry, enable/disable, editor, and profile
  API contracts.

## Non-goals

- Module version updates independent of the panel release.
- Panel archive updates or profile transitions.
- Automatic installation of dependencies or removal of dependants.
- UI, notifications, background catalog polling, or arbitrary repositories.
- Multiple concurrent lifecycle operations.

## Architecture

Add `services.module_lifecycle.ModuleLifecycleService` as the orchestration
boundary between HTTP routes and the existing domain services. It owns no
second transaction implementation. It composes:

- `ModuleRegistry` for configured and effective activation state;
- `ModuleCatalogClient` for the verified catalog of the installed release;
- `services.module_transactions.plan` for authoritative plans;
- `services.module_transactions.launcher` for detached execution and status;
- `services.module_transactions.executor.recover` for abandoned operations;
- a narrow process-control adapter for cancellation;
- the existing panel restart callback and active-engine detector.

`routes/modules.py` remains the single core-owned modules blueprint. Its new
handlers validate HTTP input, call the lifecycle service, and map domain
errors to stable responses. Production dependencies are assembled in
`routes/__init__.py`; tests inject a service or its narrow dependencies.

The service imports no Flask objects. The detached runner remains the only
component that downloads, unpacks, changes module files, restarts the panel,
performs health checks, or rolls back.

## API

All successful responses include `ok: true` and use `Cache-Control: no-store`.
All request bodies must be JSON objects and retain the existing 8 KiB module
API request limit.

### `GET /api/modules/installed`

Returns the registry snapshot restricted to the actual installed state, while
preserving configured/effective/runtime fields needed by the maintenance UI.
The response includes:

- `modules`: module descriptors with `installed`, `enabled`,
  `effective_enabled`, status, version, size, dependencies, conflicts, and
  restart metadata;
- `installed_module_ids`;
- `profile`, editor state, and top-level `restart_required`;
- lifecycle availability information when the install manifest or release
  metadata cannot support module transactions.

The list does not fetch the network catalog.

### `GET /api/modules/available`

Reads the immutable catalog for the installed panel version with
`ModuleCatalogClient.get_release_catalog(panel_version)`. It must not use the
latest-release discovery path. Each normalized catalog module is enriched
with installed state and `lifecycle_actions` derived from the Stage 8.3
planner contract:

- `install` when an ordinary removable module is absent;
- `repair` and `remove` when an ordinary removable module is installed;
- `repair` only for the installed repair-only `tool.editor` module;
- no lifecycle action for absent `tool.editor` or for `core`.

Each entry reports `update_available: false`. The response also exposes the
catalog release, source URL, fetch timestamp, and freshness metadata. An
already verified exact-release cache remains usable offline according to the
catalog client's existing rules.

### `POST /api/modules/operations/plan`

Request:

```json
{"operation":"install","module_id":"tool.terminal"}
```

Allowed operations are exactly `install`, `repair`, and `remove`. Planning is
read-only. The response contains:

- `operation`, `module_id`, and installed panel version;
- `affected_module_ids`, always exactly the selected module;
- `files_add` and `files_remove`;
- `required_free_bytes` and `restart_required`;
- `installed_after`;
- `dependency_diff` with `requires`, `missing`, `conflicts`, and
  `required_by`;
- `blockers`, `applicable`, and `plan_id`.

Dependency or conflict failures are plan results, not opaque server errors:
the endpoint returns `200` with `applicable: false`, populated blockers, and
`plan_id: null`. No dependency is automatically installed and no dependant is
automatically removed. Other invalid requests use the normal error contract.

For an applicable plan, `plan_id` is the lowercase SHA-256 digest of canonical
JSON containing the complete authoritative transaction plan and dependency
diff. It is a stale-plan guard, not an authentication credential.

### `POST /api/modules/operations/apply`

Request:

```json
{
  "operation":"install",
  "module_id":"tool.terminal",
  "plan_id":"<sha256>"
}
```

The server reloads the exact-release signed catalog and rebuilds the complete
plan from current disk, registry, running-engine, and free-space state. It
rejects a blocked plan or a changed digest. It never accepts file lists,
dependency lists, archive URLs, sizes, or checksums from the client.

On success it starts the existing detached runner and returns `202` with the
new `operation_id` and initial status. Only the chosen module appears in the
transaction plan.

### `GET /api/modules/operations/status`

Returns the current or last operation through `observe_status`, including its
operation id, operation, module id, step, result, timestamps, error code,
error message, recovery/restart flags, and ordered log entries. A killed
runner is settled through the existing recovery behavior rather than being
reported as running forever.

### `POST /api/modules/operations/<operation_id>/cancel`

Cancellation is best-effort and returns `202` only after validating all of the
following:

- the requested id is the current operation id;
- status is `running`;
- the journal reports a live runner;
- on Linux, `/proc/<pid>/cmdline` identifies `module_transaction.py run` and
  contains the same operation id.

Only then may the service send `SIGTERM`. A missing or mismatched process is
never signalled. The runner's existing cancellation behavior determines the
outcome: before mutation it finishes as `interrupted`; after mutation it rolls
back; once the runner has raised its cancellation shield it may finish the
commit. Clients poll the status endpoint for the final result.

### `POST /api/modules/recovery`

Refuses while a runner is live. Otherwise it invokes `recover(panel_root,
state_dir, panel_running=True)`, returns the resulting status, and preserves a
`restart_required` flag when the restored files require the running panel to
be restarted. Recovery never triggers that restart implicitly.

### `POST /api/modules/restart`

Refuses while a module operation or panel update owns the tree, and refuses a
mixed state marked `rollback_failed`. Otherwise it invokes the existing
restart boundary with source `module-lifecycle` and returns the result. It
does not alter registry state or start a lifecycle transaction.

## Dependency Diff And Isolation

The dependency diff is derived from the verified catalog and the actual
installed manifest. For install it reports declared requirements missing from
the installed set and installed conflicts. For remove it reports installed
modules that directly require the selected module. Repair has no dependency
side effects but still reports the selected module's declared requirements.

`affected_module_ids` is always a one-element list. Apply uses the Stage 8.3
ownership map and plan unchanged, so the transaction can change only the
selected module's owned paths plus shared install/profile/frontend manifest
state already controlled by Stage 8.3.

## Errors

Lifecycle errors retain stable machine-readable `code` values and safe user
messages. Responses never include tracebacks, secrets, archive temporary
paths, transaction backup paths, or raw exception representations.

| HTTP | Meaning |
| --- | --- |
| `400` | malformed JSON, unsupported fields, invalid operation or id |
| `404` | unknown module or operation id |
| `409` | blockers, stale plan, active operation/update, unsafe cancel/recovery/restart |
| `503` | trusted catalog unavailable or restart dispatch failed |
| `500` | unexpected internal failure |

Catalog trust and transaction errors keep their existing domain codes where
possible. Unexpected exceptions are logged server-side and mapped to a
generic lifecycle failure.

## Testing

Implementation follows red-green-refactor. Service tests cover:

- installed state without a catalog fetch;
- available modules from the installed release, never latest discovery;
- install/repair actions and `update_available: false`;
- dependency, conflict, dependant, running-engine, and disk-space blockers;
- deterministic plan digests and rejection after any relevant state change;
- apply launching the exact rebuilt single-module plan;
- busy-operation and panel-update exclusion;
- status/log passthrough and dead-runner settlement;
- cancellation id/process-identity checks and `SIGTERM` dispatch;
- recovery of untouched, mutated, and rollback-failed operations;
- restart guards and restart failure mapping.

Route tests cover payload size/type/field validation, response status and
error codes, `no-store`, and dependency injection. Existing registry route
tests remain unchanged and must continue to pass.

An integration test uses the real Stage 8.3 planner/launcher boundary to prove
that apply hands off only the server-rebuilt plan for the selected module. The
existing module transaction tests remain the authority for byte-level file
isolation, restart health checks, and rollback behavior.

Verification includes the targeted lifecycle, transaction, registry, and
catalog suites, followed by the complete Python test suite and the modular
panel contract/inventory checks.

## Documentation And Closure

Implementation adds `docs/modular-panel-stage8-lifecycle-api.md` with the
endpoint and payload contract, stable errors, cancellation semantics, and a
manual recovery runbook. After verification, the roadmap and Stage 8 overview
will mark Stages 8.3 and 8.4 closed and identify Stage 8.5 as next.
