# Xray Subscription Request Profiles

## Context

Xray subscriptions are downloaded by the panel before their nodes are parsed
and written to generated outbound files. Some providers bind the returned
profile to client/device request headers. Happwner's subscription flow sends
`x-hwid` and `User-Agent`; Keenetic-oriented providers may also inspect
`x-device-os`, `x-ver-os`, and `x-device-model`. Happwner's Bridge passes the
URL, HWID, and User-Agent to a local fetch service and preserves provider
response metadata such as `x-hwid-*` markers.

The panel already has a router-derived HWID/device profile for Mihomo and an
adaptive Xray fallback that retries with that global profile when a response is
empty, a placeholder, or explicitly HWID-gated. The missing capability is a
per-Xray-subscription profile that a user can inspect and override.

## Goals

- Let every Xray subscription choose how its fetch request identifies the
  client/device.
- Preserve the existing adaptive behavior for old and new subscriptions by
  default.
- Allow a user-defined HWID, User-Agent, device OS, OS version, and model.
- Use the same normalized profile/header construction for Xray and Mihomo.
- Keep provider HWID response markers visible in preview and subscription
  status diagnostics.
- Migrate existing state without requiring manual file edits.

## Non-goals

- Changing Xray core runtime outbounds or node protocol settings.
- Supporting arbitrary user-defined HTTP headers in the first iteration.
- Automatically modifying Mihomo's current modal or provider application flow.
- Bypassing provider authorization or HWID limits; the panel only sends the
  profile selected by the user.

## User model

The Xray subscription modal gains a collapsible **Request profile** section
inside the existing advanced settings. It contains a three-way mode control:

- **Auto**: first perform the existing ordinary request. If the result is
  unusable or indicates an HWID gate, retry with the automatically detected
  router profile. This is the default for both existing and new subscriptions.
- **Custom profile**: send the saved values on every fetch. Blank fields omit
  the corresponding header. Editing is enabled for `x-hwid`, `User-Agent`,
  `x-device-os`, `x-ver-os`, and `x-device-model`.
- **Disabled**: do not send device/HWID headers and do not perform the automatic
  profile fallback.

The custom form is initialized from the current automatically detected profile
when the user first selects it. A reset action restores those detected values.
In Auto mode, detected values are displayed as read-only reference data. The
section also shows the last fetch mode and summarized HWID response diagnostics;
raw request values are not written to logs or exposed in list badges.

## Stored state and migration

Each subscription stores a `request_profile` object:

```json
{
  "mode": "auto",
  "hwid": "",
  "user_agent": "",
  "device_os": "",
  "os_version": "",
  "device_model": ""
}
```

Allowed modes are `auto`, `custom`, and `disabled`. The normalizer treats a
missing or invalid object as `{"mode": "auto"}` and clamps all field values
to the existing safe HTTP-header rules (trimmed printable ASCII and bounded
length). Existing state files therefore retain their current behavior without
a one-time migration command. Runtime metadata such as the last fetch mode,
response HWID markers, and limit summary remains separate from the request
profile.

## Request data flow

1. The preview, manual refresh, scheduled refresh, and due-refresh paths load
   the subscription's normalized request profile.
2. The shared request-profile helper obtains the router profile from the
   existing Mihomo device-info implementation for Auto mode, or validates the
   stored custom values for Custom mode.
3. The subscription transport sends only the supported headers:
   `x-hwid`, `User-Agent`, `x-device-os`, `x-ver-os`, and `x-device-model`.
   Header names are matched case-insensitively; empty values are omitted.
4. Auto mode keeps the current fast path and adaptive retry conditions. Custom
   mode starts with the selected profile and does not silently replace it with
   the router profile. Disabled mode performs only the ordinary request.
5. Response headers are normalized and passed to the existing parser and
   diagnostics. `x-hwid-*` response markers, limit information, warnings, and
   source/fetch mode are retained in preview and subscription state.

The helper must be used by all Xray fetch entry points so that preview and
background refresh cannot disagree. Happ deep-link resolution and decryption
continue to receive the same request headers through recursive fetches.

## Error handling and safety

- Reject control characters, non-ASCII header bytes, and overlong values with a
  field-level validation error.
- Preserve URL policy, redirect handling, body-size limits, and existing
  placeholder/decryption errors.
- Never include HWID or User-Agent values in ordinary server logs or exception
  text; diagnostics identify the selected mode and header names only.
- A provider response that explicitly reports an unsupported HWID or an
  exhausted limit remains a warning/error from the existing diagnostics path;
  the panel must not retry indefinitely.

## Components

- `services/mihomo_hwid_sub.py` or a small adjacent shared helper: normalize
  device profiles and construct supported request headers for both consumers.
- `services/xray_subscriptions.py`: normalize/persist `request_profile`, pass it
  through preview and refresh fetches, and expose runtime diagnostics.
- `routes/xray_subscriptions.py`: keep existing endpoints but accept the
  profile as part of the upsert/preview payload and return validation errors.
- `static/js/features/outbounds.js`: add controls, draft state, payload fields,
  profile reset/autofill, and diagnostic rendering to the Xray modal.
- Existing Mihomo code: consume the shared normalization/header helper without
  changing its current user-visible defaults.

## Verification

Backend tests should cover:

- state normalization and backward-compatible `auto` defaults;
- custom/disabled/auto header construction and omission of blank fields;
- per-subscription isolation during preview and scheduled refresh;
- adaptive fallback conditions and no fallback in disabled/custom modes;
- recursive Happ resolution receiving the selected headers;
- validation and redaction of invalid/overlong/control-character values;
- preservation of `x-hwid-*` response diagnostics.

Frontend contract tests should cover:

- all three modes and default values for new and existing subscriptions;
- copying/resetting the detected profile;
- round-tripping `request_profile` through list, preview, and upsert payloads;
- keeping drafts isolated when switching subscriptions;
- rendering fetch mode and HWID diagnostics without exposing raw secrets.

## External reference

The request-header behavior is based on the open-source Happwner implementation:
<https://github.com/Omegaplexx/Happwner>. Its Bridge fetches subscriptions with
`x-hwid` and `User-Agent`, then forwards provider response metadata needed by
clients.
