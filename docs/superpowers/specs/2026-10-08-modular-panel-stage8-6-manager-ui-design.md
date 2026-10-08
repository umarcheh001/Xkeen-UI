# Stage 8.6: Module Manager UI

**Status:** approved design, pending implementation
**Date:** 2026-10-08
**Scope:** core-owned maintenance screen for official modules, panel updates,
profile transitions, restart, and lifecycle recovery

## Context

Stages 8.4 and 8.5 provide the authoritative Lifecycle API: installed state,
the signed exact-release catalog, server-built plans, detached apply, status,
cancel, recovery, restart, signed panel updates, profile transitions, and
rollback. They deliberately do not provide a user interface.

The existing DevTools updater is no longer an appropriate primary home for
stable updates. It is an optional diagnostics screen, while lifecycle
operations are core-owned and must stay available when optional diagnostics
are absent. Maintaining two full update experiences would also allow their
state and explanations to drift apart.

Stage 8.6 adds one core-owned "Modules and updates" manager. It is the only
production UI that plans, applies, observes, cancels, recovers, restarts, or
rolls back a signed lifecycle operation. DevTools retains its explicit
development-only `main` update path and a compact stable-channel link to the
manager; its API compatibility facade remains intact for older clients.

## Goals

- Give users a single maintenance destination for the panel and official
  modules.
- Show actual installed state without network access on initial screen entry.
- Fetch the signed catalog only after a user asks to check or opens the
  available-modules tab.
- Require a reviewed, server-built plan before every destructive lifecycle
  action.
- Make an in-progress operation, its ordered journal, cancellation, restart,
  and recovery visible from one persistent place.
- Explain safe error states without exposing transaction paths, raw errors,
  signatures, checksums, or implementation details.
- Keep the screen usable without `tool.advanced-diagnostics` or any DevTools
  frontend import.

## Non-goals

- A marketplace, third-party repositories, arbitrary package URLs, or
  independent module version channels.
- Automatic module installation/removal to satisfy dependencies.
- Background catalog polling, notification preferences, or seen/dismissed
  records; those belong to Stage 8.7.
- Concurrent lifecycle operations, client-generated file lists, or bypassing
  the plan/apply stale-plan guard.
- Replacing the existing registry/profile editor or development-only `main`
  updater in DevTools.

## Product Decisions

### One core-owned destination

`/modules` is a top-level, core-owned route called "Modules and updates". It
is included in the top-level navigation independently of DevTools and owns a
small update badge. The badge is only session state derived from an explicit
check in this screen; it does not start a catalog request by itself and is not
a substitute for the Stage 8.7 notification center.

The screen has two tabs:

- **Installed** is the default. Its first item is the panel release card,
  followed by installed modules and the saved installation/profile summary.
- **Available** contains official catalog modules and is loaded only when the
  user opens this tab or presses "Check for updates".

No advanced diagnostics panel, terminal, or DevTools component is embedded in
this screen. Links to diagnostics, where available, remain one-way links out
of the manager and are not required to understand or complete an operation.

### DevTools remains a pointer, not a second manager

For the stable channel, the DevTools update card becomes a compact status
notice with an "Open modules and updates" action. It no longer independently
checks, plans, starts, polls, cancels, restarts, or rolls back a stable
update. This avoids two competing progress views and leaves all signed
lifecycle actions in `/modules`.

The clearly labelled development-only `main` path remains in DevTools with
its existing behavior. The stable compatibility API remains available for
older callers, but the new UI must not use it for lifecycle operations.

## Screen Loading And Data Ownership

The top-level shell lazy-loads the manager frontend only when `/modules` is
opened. Entering the screen makes these two independent, no-store requests:

```text
GET /api/modules/installed
GET /api/modules/operations/status
```

`installed` supplies the panel version, installed modules, profile/editor
state, `previous_version`, lifecycle availability, and `restart_required`.
`status` supplies a current or last operation and its ordered journal. The
catalog is not fetched during initial load.

The screen keeps a small local view model rather than introducing a global
client store:

```text
installed snapshot + lifecycle status + optional catalog + selected plan
```

After an operation reaches a terminal result, the screen reloads installed
state and discards the previous catalog and plan. This prevents stale cards
from pretending that an already changed payload is still current.

If an operation was already running when the page is opened, the status area
attaches to that operation instead of offering a second apply action. Its
status is refreshed while it is active and stops polling after a terminal
result or an unrecoverable transport failure. Re-entering the route restores
the same view from `status`; the browser never invents an operation id.

## Installed Tab

### Panel release card

The first card names the installed panel release and shows its lifecycle
availability. It has a manual "Check for updates" action. That action asks
the server for a read-only `panel-update` plan; it is the one allowed path to
discover a newer signed panel release. A current release is displayed as a
normal no-update result, not as a frightening error.

When a newer release is available, the card receives an update badge and
shows the reviewed target version only inside the plan confirmation. It also
offers a panel rollback only when `previous_version.available` is true. The
rollback follows the same plan and confirmation sequence as every other
lifecycle mutation.

The manager shows a pending physical profile transition prominently when the
installed snapshot reports it. It leads to a `profile-transition` plan,
instead of presenting a normal restart that would be rejected by the API.

### Installed module rows

Each module row uses the installed snapshot only and presents the human name,
installed version, enabled/effective/runtime state, restart requirement,
known unavailable/failed reason, and declared dependency summary. Existing
registry enable/disable controls retain their established API and confirmation
behavior; lifecycle planning does not duplicate that state transition.

Lifecycle controls are limited to actions advertised by the backend:

- **Repair** for a repairable installed module.
- **Remove** for a removable installed module.
- **Install** is not shown in this tab for an absent module; it belongs to
  Available.

There is no misleading module "update" control. Under the release model,
module-only `update_available` is always false; a module version advances as
part of a reviewed panel update.

## Available Tab

Opening Available retrieves:

```text
GET /api/modules/available
```

The response is presented as a signed, exact-release catalog. The screen
shows freshness or stale-cache state, but never treats a stale catalog as an
unverified package source. Catalog entries show their installed state,
version, declared dependencies/conflicts, restart requirement, and only the
server-provided lifecycle actions. Install stays unavailable until the
catalog response is usable.

The user explicitly presses an available entry's Install action. Dependencies
are displayed in the subsequent plan; the UI never silently adds them.

The panel card's separate "Check for updates" action does not rely on this
exact-release catalog. It requests the read-only `panel-update` plan described
above, whose lifecycle contract performs trusted latest-release discovery.

## Plan, Confirmation, And Apply

Every lifecycle mutation uses the same two-step interaction:

1. The user chooses an action. The manager sends only its operation and,
   where required, module id to `POST /api/modules/operations/plan`.
2. The manager displays the server-built plan and only then exposes Apply.
   Apply posts the received `plan_id` to `POST /api/modules/operations/apply`.

The confirmation presents only the public plan data: action and scope,
selected/affected modules, current and target panel versions where relevant,
add/remove file counts, required free space, dependency diff, restart
requirement, and blockers. It does not show archive URLs, checksums,
transaction directories, or raw server diagnostics.

A blocked plan remains a readable result with its blockers and no Apply
button. A stale-plan response discards the local plan and offers to rebuild
it. An apply response yields the server operation id; it then becomes the
single source for the operation area.

## Persistent Operation Area

The manager contains one pinned operation area above the tab content whenever
`status` has an active, recoverable, or restart-required operation. It shows:

- action, scope, affected module or target panel/profile when present;
- current step, result, safe error code/message, timestamps, and ordered log;
- Cancel only while the server reports an active cancellable operation;
- Recover only when status/recovery semantics permit it;
- Restart only when `restart_required` is true and no profile-transition,
  rollback, or active-operation guard is present.

Cancellation is a request, not an immediate success claim. The UI sends the
operation id to the cancel endpoint, disables duplicate buttons, and continues
to observe status until the runner reaches a terminal state. Recovery similarly
never restarts the panel implicitly.

`rollback_failed` is an explicit stop state: the manager disables new
lifecycle actions and directs the operator to the safe manual recovery
guidance already defined by the Lifecycle API. It never suggests retrying an
install over an un-restored tree.

## Error And Offline States

The UI maps stable API codes to concise operational guidance while preserving
the code for support. It distinguishes:

| Condition | User-facing behavior |
| --- | --- |
| `catalog_unavailable` | Explain that the signed catalog cannot currently be checked; retain installed state and offer a later retry. |
| stale cached catalog | Show its freshness/staleness and allow only the server-authorized catalog actions. |
| signature/archive/trust failure | State that the release could not be trusted; do not expose an install/apply continuation. |
| blockers or insufficient disk | Keep the plan visible with the server reason and no Apply action. |
| `operation_in_progress` | Attach to the reported operation through status instead of asking the user to retry blindly. |
| stale plan | Discard it and require a fresh review. |
| `profile_transition_required` | Direct the user to a profile-transition plan, not Restart. |
| `rollback_failed` | Block further mutations and present the manual recovery boundary. |

Network/JSON errors are rendered as a retryable screen-local condition. The
manager must not clear known installed state merely because a later catalog or
status request failed. All errors remain safe messages from the API or local
transport text, never traceback output.

## Accessibility And Responsive Behavior

Tabs, action controls, confirmation, log details, and errors use semantic
buttons, headings, labels, focus management, and live status announcements.
The confirmation initially focuses its title and returns focus to its invoking
action when closed. Controls retain fixed, responsive dimensions so long
module names and log entries wrap rather than overflow.

On narrow screens the installed module metadata and plan summary stack into a
single readable column, while the operation controls remain available without
hiding the current step or recovery state. The operation log is progressively
disclosed; it is present for diagnosis but does not dominate normal maintenance
work.

## Frontend Boundary

The implementation adds a top-level route/screen registration, a core-owned
template root, a lazy manager bootstrap, and manager-specific styles and
tests. Its dependency direction is:

```text
top-level shell -> modules manager screen -> Lifecycle API + existing registry API
DevTools stable notice -> top-level navigation to /modules
DevTools development-main UI -> existing development updater
```

The manager does not import `features/devtools/*`, optional diagnostic
bundles, or module-owned screen roots. It may use existing core shell
utilities for top-level navigation, fetch/error handling, modal focus, toast,
and escaping if they do not pull an optional module into the bundle.

## Testing

Implementation follows red-green-refactor.

Frontend/unit coverage proves:

- `/modules` route registration, top-navigation activation, and lazy loading;
- initial entry requests only installed state and status, never the catalog;
- Available and explicit update check fetch the catalog only when requested;
- installed/available rendering from lifecycle snapshots, including stale
  catalog, no-update, previous-version rollback, and pending profile state;
- plan summary, blocked-plan behavior, stale-plan invalidation, and exact
  apply payload construction;
- operation resume/poll/terminal refresh, cancel, recovery, restart, and
  `rollback_failed` action lockout;
- no import of DevTools or advanced-diagnostics code from the manager;
- DevTools stable view navigates to `/modules`, while development `main`
  controls remain available.

Browser/E2E coverage proves a full user flow: enter with no network catalog
fetch, open Available, review and apply a plan, observe the result/restart
boundary, then reload the route and recover the server-owned operation state.
It also covers offline/trust failure, blockers, stale plans, profile-transition
guard, responsive layout, and keyboard navigation in confirmation/recovery
states.

Existing lifecycle route/service/transaction tests remain the authority for
trust verification, file changes, locking, restart health, rollback, and
recovery; manager tests mock only their public HTTP contracts.

## Acceptance Criteria

- A core-only installation can open `/modules` and manage lifecycle state
  without DevTools installed.
- Initial entry makes no catalog request and still shows installed state plus
  any existing operation.
- Every mutation is preceded by a server-built, explicitly confirmed plan.
- Only one visible operation can be followed, cancelled, recovered, or
  restarted, and it survives route reload through server status.
- Stable panel update and rollback have one UI home: `/modules`.
- DevTools has no duplicate stable plan/apply/progress/recovery experience;
  its `main` development route continues to work.
- The manager remains safe and comprehensible for offline, stale, blocked,
  trust-failed, interrupted, and rollback-failed states.
- No manager code imports advanced diagnostics or optional DevTools frontend
  code.

## Documentation And Closure

Implementation updates the Stage 8 operator document and generated contract
only where the established public behavior requires it. Stage 8.6 is closed
only after targeted frontend tests, lifecycle compatibility tests, the full
test suite, UI review at desktop and mobile widths, independent code review,
and GitHub CI succeed.
