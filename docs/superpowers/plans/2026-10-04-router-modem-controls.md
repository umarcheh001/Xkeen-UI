# Управление LTE-модемами из диагностики: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в модалку диагностики безопасную проверку транспорта и управляемый reset выбранного LTE-модема, не создавая отдельный веб-сервис и не затрагивая другие модемы.

**Architecture:** Существующий RCI normalizer остаётся единственным источником LTE-карточек. Новый `services/router_modem_control.py` получает подтверждённый RCI `modem_id`, сопоставляет его IMEI с QMI/TTY устройством, запускает только фиксированный subprocess/TTY transport и хранит короткоживущий operation state. Flask routes expose probe/reset/status, а `resource_monitor.js` добавляет controls к конкретной карточке и опрашивает operation status.

**Tech Stack:** Python 3.11, Flask, `subprocess.run`, POSIX `os/termios` для TTY probe, существующий `normalize_lte()`/`sample_router_lte()`, vanilla ES modules, Playwright, pytest.

**Spec:** `docs/superpowers/specs/2026-10-04-router-modem-controls-design.md`

## Global Constraints

- Не устанавливать `qmi-utils`, `libqmi`, `uhttpd_kn`, не менять права на устройства и не запускать отдельный HTTP-сервер.
- Не принимать путь устройства, shell-команду, IMEI, модель или имя как источник истины от браузера.
- Входной `modem_id` — ASCII-идентификатор до 64 символов из `[A-Za-z0-9_.-]`.
- QMI имеет приоритет; TTY допускается только после `AT`/`AT+CGSN` и совпадения IMEI с RCI.
- Сырые stdout/stderr, IMEI, SIM-идентификаторы и произвольные команды не попадают в API operation state.
- На один `modem_id` допускается только одна активная операция; operation state хранится не более 15 минут.
- Reset нескольких модемов одной кнопкой, изменение APN/режима сети/band-lock/PIN и fallback по позиции `/dev/ttyUSB*` не реализуются.
- Роутерный destructive прогон выполняется только для `T2_STATIC` (`UsbQmi1`); Beeline-модем не сбрасывается.

---

### Task 1: Backend service contract and failing tests

**Files:**
- Create: `tests/test_router_modem_control.py`
- Modify: `tests/test_router_diagnostics.py`
- Modify: `tests/test_system_resources.py`

**Interfaces:**
- Consumes: existing `normalize_lte`, `sample_router_lte`, `RciUnavailable` and Flask blueprint factory.
- Produces: executable tests defining `validate_modem_id`, `ModemControlService.probe`, `ModemControlService.start_reset`, and `ModemControlService.status` behavior.

- [ ] **Step 1: Write failing pure-validation and matching tests.**

  Add tests that assert the service accepts `UsbQmi1`, rejects empty/overlong/unsafe ids, selects the RCI item by exact id, and never uses a browser-supplied IMEI or device path. Add a fixture with two RCI modems and two device candidates; only the candidate whose `AT+CGSN`/QMI id matches the selected modem may be returned.

  ```python
  def test_probe_matches_selected_modem_by_imei_and_prefers_qmi():
      service = ModemControlService(rci_fetcher=fixture_rci, device_enumerator=fixture_devices, runner=fixture_runner)
      result = service.probe("UsbQmi1")
      assert result["modem"]["id"] == "UsbQmi1"
      assert result["preferred_transport"] == "qmi"
      assert result["transports"] == [{"kind": "qmi", "available": True}]
  ```

- [ ] **Step 2: Write failing transport and lifecycle tests.**

  Add tests for QMI `--dms-get-ids`, TTY `AT`/`AT+CGSN`, QMI priority, missing tool, mismatched IMEI, confirmation mismatch, duplicate active reset, operation terminal states, timeout, and redaction. Test helpers must record argv and assert no shell string and no raw stderr in returned state.

  ```python
  def test_reset_requires_exact_confirmation_and_returns_202_contract(client, service):
      response = client.post("/api/system/router/lte/UsbQmi1/reset", json={"confirmation": "Beeline"})
      assert response.status_code == 400
      assert response.get_json()["code"] == "modem_confirmation_mismatch"
  ```

- [ ] **Step 3: Run the new tests and verify they fail for missing implementation.**

  Run `python -m pytest -q tests/test_router_modem_control.py tests/test_system_resources.py -k modem`.
  Expected: collection or assertion failures because the service module and routes do not exist yet; no test may pass merely because it exercises unrelated LTE telemetry.

- [ ] **Step 4: Commit the red tests.**

  ```bash
  git add tests/test_router_modem_control.py tests/test_router_diagnostics.py tests/test_system_resources.py
  git commit -m "test(router): define LTE modem control contract"
  ```

### Task 2: Implement safe transport adapter and operation lifecycle

**Files:**
- Create: `xkeen-ui/services/router_modem_control.py`
- Test: `tests/test_router_modem_control.py`

**Interfaces:**
- Consumes: `sample_router_lte` normalization and injected clock/sleep/runner/device enumerator.
- Produces: `ModemControlService`, `validate_modem_id`, `ModemControlError`, and JSON-safe probe/operation dictionaries used by routes.

- [ ] **Step 1: Add the immutable data contracts and bounded registry.**

  Define frozen dataclasses for `ModemControlProbe` and operation state, constants for probe/reset/recovery timeouts and 15-minute retention, a lock-protected dictionary keyed by opaque `operation_id`, and a per-modem active-operation index. Store only modem id, transport kind, safe code/message, timestamps, before/after snapshots, and public status.

  ```python
  MODEM_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
  TERMINAL_STATES = frozenset({"recovered", "failed", "timed_out"})
  ```

- [ ] **Step 2: Implement exact RCI selection and device enumeration.**

  Re-fetch the inventory through the existing `sample_router_lte` sampler, locate the exact selected id, require a non-empty IMEI, and produce a bounded snapshot that excludes IMEI/SIM from the public response. Enumerate only `/dev/cdc-wdm*` and `/dev/ttyUSB*` character devices from the service-owned filesystem; never accept a path argument from a route. The sampler, clock, runner, and enumerator are constructor dependencies so tests can use fixtures without changing the router normalizer.

- [ ] **Step 3: Implement QMI probe/reset with fixed argv.**

  For each candidate QMI device, run `qmicli -d <enumerated_path> --dms-get-ids` with `shell=False`, a short timeout, and parsed IMEI comparison. Use the matched path only internally. Reset with `qmicli -d <matched_path> --dms-set-operating-mode=reset`; map missing executable, timeout, nonzero result and IMEI mismatch to `qmi_tool_missing`, `qmi_probe_timeout`, `modem_reset_failed` and `transport_not_matched` without copying stderr.

- [ ] **Step 4: Implement TTY fallback with matching before reset.**

  Open only enumerated character devices with `os.open`, configure 115200 8N1 via `termios`, send `AT\r` and `AT+CGSN\r`, parse bounded responses for `OK` and matching IMEI, then close the descriptor in `finally`. Send `AT+RESET\r` only after the match. QMI results remain preferred even if a TTY candidate also matches.

- [ ] **Step 5: Implement worker recovery polling and redacted state.**

  `start_reset(modem_id, confirmation)` validates the id, re-fetches RCI, runs probe, reserves the per-modem slot, captures `before`, and starts a daemon worker. The worker sends the fixed reset command, waits for the selected id to disappear/reappear through the RCI fetcher, records `recovered` only when the exact id returns, records `timed_out` after the bounded deadline, and always releases the active slot. `status(operation_id)` returns a copy and prunes entries older than retention.

- [ ] **Step 6: Run backend tests and refactor only while green.**

  Run `python -m pytest -q tests/test_router_modem_control.py` and then `python -m pytest -q tests/test_router_diagnostics.py -k lte tests/test_system_resources.py -k router`.
  Expected: all new transport/lifecycle tests pass; existing LTE normalization behavior remains unchanged.

- [ ] **Step 7: Commit the service implementation.**

  ```bash
  git add xkeen-ui/services/router_modem_control.py xkeen-ui/services/router_diagnostics.py tests/test_router_modem_control.py
  git commit -m "feat(router): add scoped LTE modem control service"
  ```

### Task 3: Add authenticated Flask routes

**Files:**
- Modify: `xkeen-ui/routes/system_resources.py`
- Modify: `tests/test_system_resources.py`
- Test: `tests/test_router_modem_control.py`

**Interfaces:**
- Consumes: `ModemControlService.probe`, `.start_reset`, and `.status`.
- Produces: `POST /api/system/router/lte/<modem_id>/probe`, `POST /api/system/router/lte/<modem_id>/reset`, and `GET /api/system/router/lte/operations/<operation_id>` with stable safe error codes.

- [ ] **Step 1: Add route tests for success, validation and failure mapping.**

  Mount the blueprint with an injected service fixture. Assert probe returns `200` and `Cache-Control: no-store`, reset returns `202` with `operation_id`/`before`/`transport`, status returns only the requested operation, malformed ids return `400`, unknown modem returns `404 modem_not_found`, confirmation mismatch returns `400`, active duplicate returns `409`, and missing operation returns `404 operation_not_found`.

- [ ] **Step 2: Implement route handlers and error conversion.**

  Define one module-level `MODEM_CONTROL_SERVICE = ModemControlService()` used by the handlers; tests replace that object with a fixture service. Parse JSON as an object, pass only route `modem_id` and exact confirmation string to the service, return `jsonify` copies with `Cache-Control: no-store`, and convert `ModemControlError` to `error_response` without exposing exception text.

- [ ] **Step 3: Run route tests and existing resource tests.**

  Run `python -m pytest -q tests/test_system_resources.py tests/test_router_modem_control.py`.
  Expected: all route tests pass and existing `/api/system/router/lte` response tests remain green.

- [ ] **Step 4: Commit the routes.**

  ```bash
  git add xkeen-ui/routes/system_resources.py tests/test_system_resources.py tests/test_router_modem_control.py
  git commit -m "feat(router): expose scoped LTE modem operations"
  ```

### Task 4: Add per-card LTE controls and polling UI

**Files:**
- Modify: `xkeen-ui/static/js/features/resource_monitor.js`
- Modify: `xkeen-ui/static/panel-operator.css`
- Modify: `tests/test_resource_monitor_frontend.py`
- Create or modify: `e2e/router_modem_controls.spec.mjs`

**Interfaces:**
- Consumes: existing LTE payload plus the three modem-control routes and `XKeen.ui.confirm`.
- Produces: per-card probe button, reset confirmation, operation status area and isolated rendering for each modem.

- [ ] **Step 1: Add failing static-contract tests.**

  Assert the source contains the three endpoint templates, exact modem id is URL-encoded, `XKeen.ui.confirm` is used with `danger: true`, reset stays disabled before probe, polling stops on terminal states, and rendering never inserts response HTML with `innerHTML`.

- [ ] **Step 2: Add card controls in `renderLte`.**

  Give each card a `data-modem-id`, append a compact control row and status node, and keep the existing metrics unchanged. The probe action updates only its card; successful probe stores a safe transport kind and enables reset only when `available` is true. Offline/unidentified cards show the safe reason and keep reset disabled.

- [ ] **Step 3: Implement confirmation, reset request and polling.**

  Use `XKeen.ui.confirm({ title: "Перезапуск модема", message: ..., details: ..., okText: "Перезапустить", cancelText: "Отмена", danger: true })`. POST `{ confirmation: modemId }`, render `queued/running/waiting_for_modem`, poll `GET /operations/<operation_id>` at a bounded interval, stop on `recovered/failed/timed_out`, then call `loadLte()` once to refresh all cards. Do not allow a second reset for the same card while polling.

- [ ] **Step 4: Add scoped CSS states.**

  Add rules under `body.panel-page` for `.xk-lte-controls`, `.xk-lte-control-status`, `data-state="running"`, `data-state="error"`, and `data-state="success"`; preserve the existing responsive grid and avoid adding a second card inside the modem card.

- [ ] **Step 5: Add Playwright fixture coverage.**

  Mock two modems (`UsbQmi0`, `UsbQmi1`) and route probe/reset/status responses. Assert probing `UsbQmi1` does not change `UsbQmi0`, the confirmation text names `T2_STATIC`/`UsbQmi1`, reset sends only that id, the card shows recovery, and an error/timeout leaves the other card untouched. Run both desktop and mobile project configurations used by the existing diagnostics specs.

- [ ] **Step 6: Run frontend checks.**

  Run `python -m pytest -q tests/test_resource_monitor_frontend.py` and `npx playwright test e2e/router_modem_controls.spec.mjs --reporter=line`.
  Expected: static contract and browser tests pass with no console errors.

- [ ] **Step 7: Commit the UI.**

  ```bash
  git add xkeen-ui/static/js/features/resource_monitor.js xkeen-ui/static/panel-operator.css tests/test_resource_monitor_frontend.py e2e/router_modem_controls.spec.mjs
  git commit -m "feat(ui): add scoped LTE modem controls"
  ```

### Task 5: Documentation, generated contracts and full verification

**Files:**
- Create: `docs/router-modem-controls.md`
- Generated: `docs/modular-panel-stage0-inventory.json`, `docs/modular-panel-stage0-inventory.md`, `docs/modular-panel-stage4.1-contract.json`, `docs/modular-panel-stage4.1-contract.md`, `docs/panel-operator-stage0-inventory.json`, `xkeen-ui/module-sizes.json`
- Test: `tests/test_modular_panel_stage0_inventory.py`, `tests/test_modular_panel_stage4_1_contract.py`, `tests/test_panel_operator_stage0_contract.py`, `tests/test_module_registry.py`

**Interfaces:**
- Consumes: completed backend/UI feature and the approved spec.
- Produces: operator documentation describing probe/reset semantics, safe failure states and the exact T2_STATIC test procedure; synchronized generated contracts.

- [ ] **Step 1: Write operator documentation.**

  Document that `Обновить` reads RCI, `Проверить транспорт` is read-only, reset requires confirmation, QMI is preferred, TTY requires IMEI match, and only `T2_STATIC` is authorized for the first hardware run. Explicitly state that Beeline is not to be reset and that no `:8080` service is installed.

- [ ] **Step 2: Regenerate inventory and module sizes.**

  Run:

  ```bash
  python scripts/generate_modular_panel_inventory.py --root .
  python scripts/generate_modular_panel_stage4_1_contract.py --root .
  python scripts/generate_panel_operator_inventory.py --root .
  python scripts/sync_module_sizes.py --root .
  ```

  Review that changes are limited to computed sizes, hashes, line locators and the new owned files; reject unrelated generated churn.

- [ ] **Step 3: Run the complete local verification set.**

  Run `git diff --check`, focused backend/frontend tests, `python -m pytest -q`, `npx playwright test e2e/router_modem_controls.spec.mjs e2e/mihomo_clash_diagnostics.spec.mjs --reporter=line`, `node --check xkeen-ui/static/js/features/resource_monitor.js`, and `python -m py_compile xkeen-ui/services/router_modem_control.py xkeen-ui/routes/system_resources.py`.

- [ ] **Step 4: Commit generated contracts and docs.**

  ```bash
  git add docs/router-modem-controls.md docs/modular-panel-stage0-inventory.json docs/modular-panel-stage0-inventory.md docs/modular-panel-stage4.1-contract.json docs/modular-panel-stage4.1-contract.md docs/panel-operator-stage0-inventory.json xkeen-ui/module-sizes.json
  git commit -m "docs(router): document LTE modem controls"
  ```

### Task 6: Read-only router probe and authorized T2_STATIC reset

**Files:**
- No production file changes expected.
- Evidence: local command output captured in the final report; optionally add a non-secret fixture only if the live payload reveals a stable normalization gap.

**Interfaces:**
- Consumes: deployed/local panel routes and router credentials already provided by the user.
- Produces: verified probe and reset/recovery result for `T2_STATIC` only.

- [ ] **Step 1: Run the read-only probe.**

  Query `/api/system/router/lte`, identify the exact item with `id == "UsbQmi1"` and name `T2_STATIC`, call its probe endpoint, and record only transport kind, availability code, model label and operation readiness. Stop if the exact id or IMEI-backed identity is absent.

- [ ] **Step 2: Confirm target isolation before reset.**

  Verify the probe response names `UsbQmi1`, the Beeline card has a different id, the reset endpoint is enabled only for `UsbQmi1`, and no command/path from the browser can select another device.

- [ ] **Step 3: Execute the authorized reset.**

  POST `{"confirmation":"UsbQmi1"}` to the reset endpoint only after the read-only checks pass. Poll the returned operation id until `recovered`, `failed`, or `timed_out`; do not retry automatically and do not call the endpoint for Beeline.

- [ ] **Step 4: Verify the post-reset state.**

  Refresh LTE telemetry, confirm `UsbQmi1` returns, compare technology/operator/address/SIM state with the pre-reset snapshot, and report whether the WAN route recovered. Treat a changed public IP or temporary signal loss as an observation, not as permission to reset again.

- [ ] **Step 5: Record completion evidence and final git state.**

  Run `git status --short --branch`, ensure no live credentials or raw device output entered tracked files, and report the operation id/status without exposing IMEI or secret command output.

## Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-04-router-modem-controls.md`.

Execution options:

1. **Subagent-driven** — dispatch a fresh subagent per task with review checkpoints.
2. **Inline execution** — execute this plan in the current session with `superpowers:executing-plans` and batch checkpoints.
