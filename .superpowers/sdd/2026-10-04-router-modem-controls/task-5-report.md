# Task 5 report: LTE modem controls documentation and verification

Date: 2026-10-05

## Scope

Task 5 documented the completed scoped LTE modem control feature, regenerated
the requested contract and size artifacts, and ran the local verification set.
No live router operation or modem reset was executed. The first hardware run
remains limited to read-only probe and an explicitly confirmed `T2_STATIC`
reset; Beeline was not touched.

## Files produced or regenerated

Created:

- `docs/router-modem-controls.md` — operator procedure, probe/reset semantics,
  QMI preference, IMEI matching for TTY fallback, safe failure states, exact
  `T2_STATIC` first-run procedure, Beeline prohibition, and the absence of a
  `:8080` service.

Regenerated with the repository generators:

- `docs/modular-panel-stage0-inventory.json`
- `docs/modular-panel-stage0-inventory.md`
- `xkeen-ui/module-sizes.json`

The following requested generators produced byte-identical output, so their
tracked files have no diff:

- `docs/modular-panel-stage4.1-contract.json`
- `docs/modular-panel-stage4.1-contract.md`
- `docs/panel-operator-stage0-inventory.json`

The stage 0 and module size diffs contain only the expected modem service,
route, frontend feature, tests, endpoint locators, and computed size/count
changes from Tasks 1–4. No unrelated generated churn was accepted.

## Commands and results

All commands were run from the repository root `G:\repo\Xkeen-UI`.

| Command | Result |
| --- | --- |
| `python scripts/generate_modular_panel_inventory.py --root .` | passed |
| `python scripts/generate_modular_panel_stage4_1_contract.py --root .` | passed; no diff |
| `python scripts/generate_panel_operator_inventory.py --root .` | passed; no diff |
| `python scripts/sync_module_sizes.py --root .` | passed |
| `git diff --check` | passed |
| `python -m pytest -q tests/test_router_modem_control.py tests/test_system_resources.py tests/test_router_diagnostics.py tests/test_resource_monitor_frontend.py tests/test_modular_panel_stage0_inventory.py tests/test_modular_panel_stage4_1_contract.py tests/test_panel_operator_stage0_contract.py tests/test_module_registry.py` | **131 passed** |
| `node --check xkeen-ui/static/js/features/resource_monitor.js` | passed |
| `python -m py_compile xkeen-ui/services/router_modem_control.py xkeen-ui/routes/system_resources.py` | passed |
| `npx playwright test e2e/router_modem_controls.spec.mjs e2e/mihomo_clash_diagnostics.spec.mjs --reporter=line` | **10 passed** |
| `python -m pytest -q` | **2963 passed, 38 skipped, 11 failed** |

The Playwright web server logged the expected optional `gevent` absence and
used its lite development server; all selected browser scenarios still passed.

## Full pytest concerns

The 11 full-suite failures are outside this task's files and feature:

- 9 installer progress/terminal tests invoke `sh` directly. The Windows
  runner has no POSIX `sh`, so `subprocess.Popen` raises `FileNotFoundError`.
- `tests/test_installer_bytecode_warmup.py::test_warmup_compiles_the_panel_into_the_cache`
  did not produce `.pyc` files in the current Windows environment.
- `tests/test_operator_icons.py::test_operator_icon_manifest_and_machine_readable_inventory_are_reproducible`
  reports stale line locators in the existing operator icon inventory after
  unrelated panel template changes. The requested panel operator inventory
  generator itself reproduced successfully.

No production fix was made for these environment or pre-existing contract
issues. No live router reset was run.
