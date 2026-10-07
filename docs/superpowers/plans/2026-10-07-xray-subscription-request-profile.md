# Xray Subscription Request Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-subscription HWID/device request profiles to Xray subscriptions while preserving the current adaptive automatic fallback.

**Architecture:** Introduce a small shared request-profile helper that normalizes the five supported headers and derives the automatic router profile from the existing Mihomo device-info provider. Extend Xray subscription state and fetch paths with `auto`, `custom`, and `disabled` modes, then expose the profile in the existing modal and preview diagnostics. Mihomo keeps its current UI/defaults but uses the same normalization/header construction code.

**Tech Stack:** Python 3 standard library, Flask JSON routes, vanilla JavaScript generated modal UI, pytest contract tests.

**Spec:** `docs/superpowers/specs/2026-10-07-xray-subscription-request-profile-design.md`

## Global Constraints

- Existing subscriptions without `request_profile` must normalize to mode `auto`.
- Supported request headers are only `x-hwid`, `User-Agent`, `x-device-os`, `x-ver-os`, and `x-device-model`.
- Auto mode performs the ordinary request first and retries with the detected profile only for existing unusable/HWID-gated conditions.
- Custom mode sends the saved profile first and never silently replaces it with the detected profile.
- Disabled mode sends no device/HWID headers and never performs profile fallback.
- Header values reject control characters, non-ASCII bytes, and overlong input; values are omitted when blank.
- HWID/User-Agent values must not appear in ordinary logs or exception text.
- Preserve existing URL policy, redirect handling, body-size limits, Happ decryption, and `x-hwid-*` diagnostics.

---

### Task 1: Shared request-profile normalization and header builder

**Files:**
- Create: `xkeen-ui/services/subscription_request_profile.py`
- Test: `tests/test_subscription_request_profile.py`
- Modify: `xkeen-ui/services/mihomo_hwid_sub.py` (replace local header assembly with the shared helper while preserving return shape)

**Interfaces:**
- Produces `REQUEST_PROFILE_MODES`, `REQUEST_PROFILE_FIELDS`, `normalize_request_profile(raw, *, detected=None) -> dict`, `detected_request_profile(device_info=None) -> dict`, and `request_headers_for_profile(profile, *, detected=None) -> dict`.
- `normalize_request_profile` always returns `{mode, hwid, user_agent, device_os, os_version, device_model}` with safe printable values; missing/invalid mode becomes `auto`.
- `detected_request_profile` maps the existing `get_device_info()` result to the five field names without changing the existing device-info response.
- `request_headers_for_profile` emits only non-empty supported headers and maps `user_agent` to `User-Agent`, `device_os` to `x-device-os`, `os_version` to `x-ver-os`, and `device_model` to `x-device-model`.

- [x] **Step 1: Write failing normalization/header tests**

```python
from services.subscription_request_profile import (
    detected_request_profile,
    normalize_request_profile,
    request_headers_for_profile,
)


def test_missing_profile_defaults_to_auto_with_empty_fields():
    assert normalize_request_profile(None) == {
        "mode": "auto",
        "hwid": "",
        "user_agent": "",
        "device_os": "",
        "os_version": "",
        "device_model": "",
    }


def test_custom_profile_maps_supported_headers_and_omits_blanks():
    profile = normalize_request_profile({"mode": "custom", "hwid": "ABC", "user_agent": "Client/1"})
    assert request_headers_for_profile(profile) == {"x-hwid": "ABC", "User-Agent": "Client/1"}


def test_invalid_mode_and_header_bytes_are_rejected_or_defaulted():
    normalized = normalize_request_profile({"mode": "other", "hwid": "bad\nvalue"})
    assert normalized["mode"] == "auto"
    assert normalized["hwid"] == ""


def test_detected_profile_uses_existing_mihomo_device_info_shape():
    result = detected_request_profile({
        "hwid": "ABC", "user_agent": "Mihomo/1", "headers": {
            "x-device-os": "Keenetic OS", "x-ver-os": "5.0", "x-device-model": "KN"
        }
    })
    assert result == {
        "mode": "auto", "hwid": "ABC", "user_agent": "Mihomo/1",
        "device_os": "Keenetic OS", "os_version": "5.0", "device_model": "KN",
    }
```

- [x] **Step 2: Run the focused tests and verify they fail**

Run: `pytest -q tests/test_subscription_request_profile.py`

Expected: FAIL because the shared module and functions do not exist yet.

- [x] **Step 3: Implement the shared helper**

Use one field map and one printable-value validator. Keep the HWID length limit compatible with the existing Mihomo override (128 characters), use a bounded 256-character limit for the other fields, trim whitespace, and never log rejected values. Treat `None`, non-mapping input, and invalid mode as `auto` rather than raising during state loading.

- [x] **Step 4: Integrate Mihomo's existing header result**

Make `get_device_info()` continue returning its current `headers` dictionary, but build that dictionary through `request_headers_for_profile(detected_request_profile(info))` or an equivalent shared mapping. Preserve its current HWID source/diagnostic keys and all existing UA defaults.

- [x] **Step 5: Run the focused tests and the existing Mihomo contracts**

Run: `pytest -q tests/test_subscription_request_profile.py tests/test_mihomo_hwid_sub.py`

Expected: PASS with no changes to the current Mihomo modal/API behavior.

- [x] **Step 6: Commit**

```bash
git add xkeen-ui/services/subscription_request_profile.py xkeen-ui/services/mihomo_hwid_sub.py tests/test_subscription_request_profile.py
git commit -m "Добавить общий профиль заголовков подписок"
```

### Task 2: Persist profiles and apply them to every Xray fetch path

**Files:**
- Modify: `xkeen-ui/services/xray_subscriptions.py`
- Test: `tests/test_xray_subscription_request_profiles.py`
- Extend: `tests/test_xray_subscriptions.py`

**Interfaces:**
- `upsert_subscription` and state normalization preserve a normalized `request_profile` object.
- `fetch_subscription_body_for_xray(url, *, request_profile=None) -> (body, headers, meta)` accepts the normalized profile while remaining backward-compatible for callers omitting it.
- `preview_subscription(payload)` reads `payload["request_profile"]`; scheduled/manual refresh reads `sub["request_profile"]`.

- [x] **Step 1: Write failing state and transport tests**

```python
def test_old_state_gets_auto_request_profile(tmp_path):
    state = {"subscriptions": [{"id": "one", "url": "https://example.test/sub", "tag": "one"}]}
    write_state(tmp_path, state)
    loaded = subs.list_subscriptions(str(tmp_path))
    assert loaded[0]["request_profile"]["mode"] == "auto"


def test_custom_profile_is_sent_without_auto_retry(monkeypatch):
    calls = []

    def fake_fetch(url, request_headers=None):
        calls.append(dict(request_headers or {}))
        return "vless://id@example.test:443", {},

    monkeypatch.setattr(subs, "fetch_subscription_body", fake_fetch)
    subs.fetch_subscription_body_for_xray(
        "https://example.test/sub",
        request_profile={"mode": "custom", "hwid": "KNOWN", "user_agent": "Happ/3"},
    )
    assert calls == [{"x-hwid": "KNOWN", "User-Agent": "Happ/3"}]


def test_disabled_profile_does_not_use_detected_fallback(monkeypatch):
    calls = []
    monkeypatch.setattr(subs, "fetch_subscription_body", lambda url, request_headers=None: (calls.append(dict(request_headers or {})) or ("", {},)))
    subs.fetch_subscription_body_for_xray("https://example.test/sub", request_profile={"mode": "disabled"})
    assert calls == [{}]
```

- [x] **Step 2: Run the focused tests and verify they fail**

Run: `pytest -q tests/test_xray_subscription_request_profiles.py`

Expected: FAIL because state and fetch functions do not accept `request_profile` yet.

- [x] **Step 3: Normalize and persist `request_profile`**

Add a canonical state field in `_normalize_state` and `upsert_subscription`. Preserve it when updating an existing subscription, drop unsupported aliases only after reading them, and ensure the default is `auto`. Do not include raw profile values in existing summary/log paths.

- [x] **Step 4: Add profile-aware transport selection**

Update `fetch_subscription_body_for_xray` so that:

1. `disabled` calls the ordinary fetch once with `{}`.
2. `custom` calls the ordinary fetch first with `request_headers_for_profile(profile)` and returns its normal result/diagnostics without global fallback.
3. `auto` preserves the current ordinary fetch and `_subscription_request_variants()` retry behavior, but obtains its detected headers through the shared helper.

Pass `request_headers` through `_resolve_happ_subscription_source` recursion and preserve current decryption/redirect metadata.

- [x] **Step 5: Thread the profile through preview and refresh**

Pass the payload profile from `preview_subscription` and the stored subscription profile from the refresh/update path. Ensure all paths use the same fetch function, including due refresh and Happ deep-link resolution.

- [x] **Step 6: Run focused and regression tests**

Run: `pytest -q tests/test_xray_subscription_request_profiles.py tests/test_xray_subscriptions.py tests/test_xray_subscriptions_pause.py`

Expected: PASS, including all pre-existing no-argument fetch callers.

- [x] **Step 7: Commit**

```bash
git add xkeen-ui/services/xray_subscriptions.py tests/test_xray_subscription_request_profiles.py tests/test_xray_subscriptions.py
git commit -m "Применять профиль устройства к подпискам Xray"
```

### Task 3: Expose profile validation and diagnostics through Xray routes

**Files:**
- Modify: `xkeen-ui/routes/xray_subscriptions.py`
- Test: `tests/test_xray_subscription_routes.py` (extend existing route contract file if present)

**Interfaces:**
- Existing `POST /api/xray/subscriptions` and `POST /api/xray/subscriptions/preview` accept `request_profile` in JSON.
- Invalid profile fields return the existing 400 error format without leaking the rejected value.
- List/preview/refresh responses return normalized `request_profile`, `fetch_mode`, `hwid_response_headers`, and `hwid_limit_info` through existing service results.

- [x] **Step 1: Write failing route contract tests**

```python
def test_xray_subscription_upsert_round_trips_request_profile(client, monkeypatch):
    response = client.post("/api/xray/subscriptions", json={
        "url": "https://example.test/sub",
        "request_profile": {"mode": "custom", "hwid": "KNOWN", "user_agent": "Happ/3"},
    })
    assert response.status_code == 200
    assert response.get_json()["subscription"]["request_profile"]["mode"] == "custom"


def test_xray_preview_rejects_control_character_in_profile(client):
    response = client.post("/api/xray/subscriptions/preview", json={
        "url": "https://example.test/sub",
        "request_profile": {"mode": "custom", "hwid": "bad\nvalue"},
    })
    assert response.status_code == 400
    assert "bad" not in response.get_data(as_text=True)
```

- [x] **Step 2: Run route tests and verify they fail**

Run: `pytest -q tests/test_xray_subscription_routes.py`

Expected: FAIL until route/service validation and response round-tripping are wired.

- [x] **Step 3: Wire request-profile payloads through existing route handlers**

Keep the existing endpoint paths and error helpers. Let the service normalizer validate the object, catch `ValueError` using the existing 400 response shape, and do not add a parallel endpoint.

- [x] **Step 4: Verify diagnostics are returned without raw request values**

Add assertions that preview contains `fetch_mode` and normalized `hwid_response_headers`/`hwid_limit_info`, while response JSON and captured logs do not contain the custom HWID or User-Agent beyond the normalized subscription object returned to the owner.

- [x] **Step 5: Run route and service regressions**

Run: `pytest -q tests/test_xray_subscription_routes.py tests/test_xray_observatory_routes.py tests/test_xray_subscriptions.py`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add xkeen-ui/routes/xray_subscriptions.py tests/test_xray_subscription_routes.py
git commit -m "Принять профиль запроса в API подписок Xray"
```

### Task 4: Add the request-profile editor to the Xray modal

**Files:**
- Modify: `xkeen-ui/static/js/features/outbounds.js`
- Modify: `xkeen-ui/static/panel-operator.css`
- Test: `tests/test_xray_subscription_filters_contract.py` (extend existing modal contract assertions)

**Interfaces:**
- Add stable `SUB_IDS` entries for mode, five inputs, reset button, detected summary, and last diagnostics.
- `subsReadFormState()` and `subsFillForm()` round-trip `request_profile` without losing drafts when switching subscriptions.
- Preview and upsert payloads include `request_profile`.

- [x] **Step 1: Write failing frontend contract assertions**

```python
def test_xray_subscription_modal_exposes_request_profile_controls():
    outbounds_src = Path("xkeen-ui/static/js/features/outbounds.js").read_text(encoding="utf-8")
    assert "outbounds-subscriptions-request-profile-mode" in outbounds_src
    assert "outbounds-subscriptions-request-hwid" in outbounds_src
    assert "outbounds-subscriptions-request-user-agent" in outbounds_src
    assert "outbounds-subscriptions-request-device-os" in outbounds_src
    assert "outbounds-subscriptions-request-os-version" in outbounds_src
    assert "outbounds-subscriptions-request-device-model" in outbounds_src
    assert "request_profile" in outbounds_src
```

- [x] **Step 2: Run the contract test and verify it fails**

Run: `pytest -q tests/test_xray_subscription_filters_contract.py -k request_profile`

Expected: FAIL because the modal has no request-profile controls yet.

- [x] **Step 3: Add the collapsible profile section**

Place it inside the existing advanced settings after the filters and before routing controls. Use the existing segmented-control/switch/input styling, explanatory tooltips, and a reset icon button. Auto mode renders detected values read-only; custom mode enables inputs; disabled mode hides or disables the profile values while showing that no device headers will be sent.

- [x] **Step 4: Wire form state and draft behavior**

Extend `subsReadFormState`, `subsFillForm`, reset/copy behavior, dirty-state comparison, and carried settings. On first switch to custom, copy the current detected profile into the draft. Reset replaces custom values with the detected profile and leaves mode custom. Switching subscriptions must restore that subscription's saved profile.

- [x] **Step 5: Include profile in preview/upsert payloads and diagnostics**

Include the normalized draft object in preview and save requests. Render the last fetch mode, whether a profile retry was used, and the existing HWID limit/warning summary without rendering raw header values in list badges.

- [x] **Step 6: Add responsive styles**

Extend `panel-operator.css` for the profile grid, read-only values, mode control, diagnostic line, and compact mobile layout. Keep inputs inside their parent at the existing modal breakpoints.

- [x] **Step 7: Run frontend contracts and the full Xray modal suite**

Run: `pytest -q tests/test_xray_subscription_filters_contract.py tests/test_xray_subscription_displacement.py`

Expected: PASS with existing filters, routing, draft protection, and diagnostics intact.

- [x] **Step 8: Commit**

```bash
git add xkeen-ui/static/js/features/outbounds.js xkeen-ui/static/panel-operator.css tests/test_xray_subscription_filters_contract.py
git commit -m "Добавить профиль запроса в модалку Xray подписок"
```

### Task 5: End-to-end regression and documentation checks

**Files:**
- Modify: `tests/test_xray_subscriptions.py` and/or `tests/test_xray_subscription_routes.py` only when a missing regression assertion is discovered.
- Inspect: `README-modular-panel-plan.md`, `docs/superpowers/specs/2026-10-07-xray-subscription-request-profile-design.md`

- [x] **Step 1: Run the focused complete suite**

Run: `pytest -q tests/test_subscription_request_profile.py tests/test_xray_subscription_request_profiles.py tests/test_xray_subscriptions.py tests/test_xray_subscription_routes.py tests/test_xray_subscription_filters_contract.py tests/test_mihomo_hwid_sub.py`

Expected: PASS.

- [ ] **Step 2: Run the repository test suite**

Run: `pytest -q`

Expected: PASS, or a documented unrelated baseline failure with its exact test name and output.

- [x] **Step 3: Run static checks used by the repository**

Run the project-provided lint/type/compile commands from `README.md` or CI configuration. At minimum run `python -m compileall -q xkeen-ui` and `git diff --check`.

- [x] **Step 4: Review migration and log safety**

Inspect a normalized old state and a custom state, confirm empty fields are omitted from requests, and search changed Python files for logging of raw `hwid`/`user_agent` values.

- [x] **Step 5: Commit final test-only adjustments**

```bash
git add tests
git commit -m "Проверить профили запросов Xray сквозным набором тестов"
```
