# Task 4 Report: Recovery, Restart, Offline, And Responsive States

## RED

Added browser coverage for interrupted recovery, rollback failure lockout, guarded restart, profile transition, safe catalog/status errors, retained installed cards, error-code mapping, focus return, and 390x844 layout. The first recovery run failed because no recovery action was rendered for an interrupted operation. The mobile run then exposed header overflow at 390px.

## GREEN

Implemented explicit recovery and restart controls in the module manager. Recovery only calls `POST /api/modules/recovery` for `interrupted`; it never restarts implicitly. Restart is shown only for a terminal status with `restart_required`, and is suppressed for active, recovery, rollback failure, or profile transition guards. `rollback_failed` disables lifecycle actions and gives a manual recovery boundary without retry advice.

Added `describeLifecycleFailure()` with concise Russian guidance and public codes. Remote exception text and private paths are not rendered. Installed snapshots are retained when a later catalog or status request fails. Operation updates remain polite live content; the dedicated error region is assertive. Logs render in a bounded scrollable code block.

Added one-column responsive rules, wrapping metadata, stable control heights, a 760px plan dialog cap, and mobile header constraints. The browser test captures `test-results/modules-operation-desktop.png` at 1440x960 and `test-results/modules-operation-mobile.png` at 390x844, asserting no horizontal overflow and readable dialog bounds.

## Changed Files

- `xkeen-ui/static/js/features/module_manager/controller.js`
- `xkeen-ui/static/js/features/module_manager/render.js`
- `xkeen-ui/templates/modules.html`
- `xkeen-ui/static/modules-manager.css`
- `e2e/modules_manager.spec.mjs`
- `tests/test_module_manager_ui.py`

## Verification

- `XKEEN_UI_FRONTEND_SOURCE_FALLBACK=1 npx playwright test e2e/modules_manager.spec.mjs --project=chromium`: **21 passed**.
- `python -m pytest tests/test_module_manager_ui.py -q`: **4 passed**.
- `git diff --check`: passed.

The broad Python suite was not used as a gate; the brief records its unrelated missing-`sh` environment failure.

## Self-review

No automatic restart path remains. A rollback failure cannot expose recovery, restart, plan, toggle, or lifecycle action controls. All dynamic operation and catalog text uses `textContent`/text nodes. Known installed cards remain available after independent request failures. The remaining external dependency is the normal server environment used by the Playwright fixture.
