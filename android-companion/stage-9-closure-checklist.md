# Stage 9 closure checklist — Logs transport and reconnect

Status: implementation and automated verification completed 2026-07-16. Device smoke-test remains an operational follow-up.

## Contract

- [x] `GET /api/mobile/v1/logs` is authenticated by the existing mobile session cookie.
- [x] The endpoint returns the versioned `{ ok, data: { contract_version, streams } }` envelope.
- [x] `error` and `access` are the only exposed sources; no arbitrary server path is accepted from Android.
- [x] Each source has a separate opaque cursor and returns either `snapshot` or `append`.
- [x] Cursor mismatch, log truncation or rotation returns a fresh `snapshot`, not an error or stale append.
- [x] Entries have opaque ids, time, source, level and bounded message text.

## Android behavior

- [x] `WebPanelLogsTransport` goes through `CompanionHttpTransport`, including per-node auth headers and typed transport errors.
- [x] `Логи Xray` renders real history/live entries, transport state and filters; its initial data is not `demoLogsState()`.
- [x] `connected`, `reconnecting`, `auth required` and background `disconnected` are explicit state values in both logs UI and diagnostics.
- [x] Polling remains foreground-scoped. Backgrounding preserves buffered entries, filter and cursors; foregrounding restarts from those cursors.
- [x] Retry backoff is bounded at 15 seconds and does not duplicate server entries.
- [x] `401` stops reconnecting and uses the established per-connection session-expiry transition to `Pair/Login`.

## Verification

- [x] `python -m pytest tests/test_mobile_logs_contract.py` — `3 passed` on 2026-07-16.
- [x] `cd android-companion; .\gradlew.bat testDebugUnitTest` — successful on 2026-07-16.
- [ ] Device smoke-test on a node running this backend and matching APK: initial history, appended line, temporary offline, `background -> foreground`, reconnect and expired session.
