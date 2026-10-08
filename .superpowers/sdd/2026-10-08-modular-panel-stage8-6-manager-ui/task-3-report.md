# Task 3 report: plan confirmation, apply, and operation monitoring

## Outcome

The manager now requests a public server plan for an allowed module or full-scope action, renders its scope and consequences in a modal, and applies only the returned `plan_id`. Blocked plans remain reviewable with no Apply control. Apply retains the returned operation ID and shows the pinned public status record. Running results poll the status endpoint; terminal results stop polling, discard the plan and catalog, and fetch installed plus status once. Cancel sends the operation-specific request and keeps monitoring until the server reports a terminal result.

## TDD evidence

- RED: `npx playwright test e2e/modules_manager.spec.mjs --project=chromium` initially failed before reaching the UI because `/modules` had no built frontend entry in this worktree (`missing_build_entry`). The test server supports `XKEEN_UI_FRONTEND_SOURCE_FALLBACK=1` for dev/test source execution.
- RED: `$env:XKEEN_UI_FRONTEND_SOURCE_FALLBACK='1'; npx playwright test e2e/modules_manager.spec.mjs --project=chromium --reporter=line` reached the new test and failed waiting for `getByRole('button', { name: 'Установить Терминал' })` because the existing action was disabled.
- GREEN: `$env:XKEEN_UI_FRONTEND_SOURCE_FALLBACK='1'; npx playwright test e2e/modules_manager.spec.mjs --project=chromium --grep 'Module lifecycle review' --workers=1 --reporter=dot` yielded `6 passed` after implementation.
- RED (follow-up regression): `$env:XKEEN_UI_FRONTEND_SOURCE_FALLBACK='1'; npx playwright test e2e/modules_manager.spec.mjs --project=chromium --grep 'monitors running operation' --reporter=line` failed `toBeEnabled()` because a previous cancel left the next operation's cancel button disabled.
- GREEN (follow-up regression): the same focused command yielded `1 passed` after resetting `cancelPending` on terminal status.
- Final: `$env:XKEEN_UI_FRONTEND_SOURCE_FALLBACK='1'; npx playwright test e2e/modules_manager.spec.mjs --project=chromium --reporter=dot` yielded `11 passed (18.4s)`.
- Final: `python -m pytest tests/test_module_manager_ui.py -q` yielded `4 passed in 0.47s`.
- Final: `git diff --check` exited 0.

## Files changed

- `e2e/modules_manager.spec.mjs`: plan/apply, blocked, stale, badge, status/cancel/terminal tests; existing catalog locators scoped to headings after action labels became visible.
- `xkeen-ui/static/js/features/module_manager/controller.js`: action-to-plan flow, dialog lifecycle, apply guard, operation monitoring and polling, cancel request, and terminal refresh.
- `xkeen-ui/static/js/features/module_manager/render.js`: allowlisted action buttons, safe plan summary and status DOM rendering.
- `xkeen-ui/templates/modules.html`: focusable confirmation heading and explicit Apply label.
- `xkeen-ui/static/modules-manager.css`: status, log, and confirmation sizing.

`api.js` and `tests/test_module_manager_ui.py` did not need changes: the existing public client methods and page contract already supported this flow.

## Self-review and concerns

- Requests use the existing public lifecycle client. No browser-derived file paths, checksums, or download URLs are sent to apply.
- Plan details and public error/log strings are inserted with `textContent`. Blockers cannot be applied. Stale apply errors close and discard the reviewed plan.
- Running status alone schedules polling; the timer and in-flight response generation are invalidated on deactivation and terminal status. Cancel is treated as a request, without inventing a terminal result.
- The renderer gates `profile-transition` on a server-provided `transition_required` field. `ModuleLifecycleService.installed()` does not currently include that field; explicit profile-transition UI gating remains for Task 4, as directed. The frontend keeps the guard ready without expanding backend scope here.
- Browser tests require `XKEEN_UI_FRONTEND_SOURCE_FALLBACK=1` in this worktree because no built `modules` entry exists. The local server also reports a missing optional `gevent` dependency and runs its development fallback; it did not affect the verified cases.
