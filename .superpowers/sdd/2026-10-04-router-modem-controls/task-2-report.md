# Task 2 report: safe LTE modem transport service

## Status

Implemented and verified. The change is limited to `xkeen-ui/services/router_modem_control.py`.

## Implementation

- Added `ModemControlService`, `ModemControlProbe`, `ModemControlError`, and strict `validate_modem_id`.
- Reuses `sample_router_lte` for live inventory and supports the Task 1 injected seams for RCI, device enumeration, subprocess execution, TTY exchange, clock, sleep, and worker start.
- Selects the exact RCI modem id and requires a non-empty matching IMEI before reset is enabled.
- Enumerates only character devices under `/dev/cdc-wdm*` and `/dev/ttyUSB*` in the router default path. Browser supplied paths never reach a transport call.
- Probes QMI using fixed argv, `shell=False`, bounded timeout, and `--dms-get-ids`; QMI is preferred over TTY.
- Falls back to TTY only after `AT` returns `OK` and `AT+CGSN` matches the selected RCI IMEI. The real TTY adapter configures 115200 8N1 and closes its descriptor in `finally`.
- Provides a daemon worker for fixed QMI reset or matched `AT+RESET`, then polls the exact RCI id for disappearance and return. States are `queued`, `running`, `waiting_for_modem`, `recovered`, `failed`, and `timed_out`.
- Enforces one active operation per modem and retains operation records for at most 15 minutes.
- Public probe/operation DTOs omit IMEI, SIM, transport paths, command argv, stdout, stderr, and raw exception text.

## Tests

Task 1 supplied the RED contract before this implementation (`d22cffe7`, `63e31e12`, `1fe54535`). The implementation turns that contract GREEN:

```text
python -m pytest -q tests/test_router_modem_control.py
31 passed in 0.14s

python -m pytest -q tests/test_router_diagnostics.py -k lte tests/test_system_resources.py -k router
28 passed, 12 deselected in 0.38s
```

Additional checks:

- `python -m compileall -q xkeen-ui/services/router_modem_control.py`
- `git diff --check`
- Windows import is supported when `termios` is unavailable; the live TTY adapter remains Unix-only.

## Files

- `xkeen-ui/services/router_modem_control.py` — new service implementation.
- `tests/test_router_modem_control.py` — existing Task 1 executable contract, unchanged by this task.

## Self-review and concerns

- No route or frontend code was changed; routes must instantiate/inject this service in the next task.
- The compatibility path for an injected already-normalised RCI fixture is kept internal and does not alter the shared router normalizer.
- Real router reset was not executed in this task because the service is not exposed by a route yet; the later route/integration task should run a read-only probe first and limit reset validation to `T2_STATIC`.

## Review fixes

- `start_reset` now returns the redacted `before` snapshot alongside the operation id, modem id, status, and transport.
- Inventory reads now return an availability flag. Recovery marks disappearance only after a successful `available=true` inventory; transient RCI errors cannot produce a false `recovered` result.
- Worker execution has a `finally` release path and a terminal safe error for a missing target or unexpected worker failure, so the per-modem active slot cannot remain stuck.
- Added an explicit injectable `sampler` constructor dependency while retaining `sample_router_lte` as the live default. The compatibility path for already-normalised test fixtures is bounded by the public snapshot sanitizer.
- Public snapshots keep only bounded scalar fields and a bounded allowlist of carrier fields; arbitrary nested containers are omitted. A nonzero QMI probe has the stable public code `qmi_probe_failed`.
- Added coverage for the `before` response, transient RCI failure, target cleanup, and sampler injection.

Fix verification:

```text
python -m pytest -q tests/test_router_modem_control.py tests/test_router_diagnostics.py -k lte tests/test_system_resources.py -k router
61 passed, 12 deselected in 0.46s
```

## Empty-inventory review fix

`sample_router_lte` now emits `rci_available=true` after a successful RCI read even when normalization produces zero modems. The modem service uses that metadata to confirm a real disappearance; transport/RCI errors remain unavailable and cannot advance recovery. Public snapshots accept bounded scalar fields and a bounded carrier allowlist only, and `qmi_probe_failed` is the stable code for a nonzero QMI probe.

```text
python -m pytest -q tests/test_router_modem_control.py
35 passed in 0.18s

python -m pytest -q tests/test_router_diagnostics.py -k lte tests/test_system_resources.py -k router
29 passed, 12 deselected in 0.38s
```
