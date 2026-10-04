# Mihomo Protected DNS Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Extend the existing Mihomo protected-DNS assistant with non-duplicating bypass diagnostics, upstream health visibility, opt-in HTTP/3 preference, and rule-provider freshness reporting.

**Architecture:** Keep `/api/mihomo/dns` as the canonical status contract. The service will derive diagnostics from the live Mihomo YAML, Keenetic running configuration, provider metadata, and safe local probes; applying DNS remains transactional and unchanged by default. The existing modal will render additive status cards and an advanced H3 toggle, while dirty-editor and rollback behavior remain intact.

**Tech Stack:** Python service/Flask route, vanilla ES modules, existing Mihomo YAML-preserving builder, pytest contract tests.

**Spec:** Current protected-DNS behavior and official Mihomo DNS reference at https://wiki.metacubex.one/en/config/dns/.

## Global Constraints

- Do not create a second DNS ownership or override mechanism.
- Keep the default generated profile behavior unchanged except for additive diagnostics.
- Never use a direct fallback resolver when the selected protected route is unavailable.
- Do not enable `prefer-h3` by default; it is an explicit advanced option.
- Preserve transactional preflight, backup, rollback, watchdog, and editor-refresh behavior.
- Provider freshness is informational and must not silently rewrite user configuration.

---

### Task 1: Backend diagnostic contract

**Files:**
- Modify: `xkeen-ui/services/mihomo_dns.py`
- Modify: `xkeen-ui/routes/mihomo.py`
- Test: `tests/test_mihomo_dns.py`

**Interfaces:**
- Add `diagnose_dns_runtime(config_text, state, firmware_policy, override, config_file)` returning `bypass`, `upstreams`, `provider_freshness`, and `h3` dictionaries.
- Add `get_status()` fields `dns_diagnostics` and `prefer_h3` without removing existing fields.
- Add POST payload field `prefer_h3` and pass it through only to a managed reconfigure/enable; default remains `false`.

- [x] Write failing tests for IPv6/provider-DNS bypass risk, upstream URL classification, provider age, and `prefer-h3` round-trip. DHCP/client-side DNS remains explicitly `unknown` because the router does not expose a reliable panel-side fact.
- [x] Run the focused tests and verify they fail for missing fields.
- [x] Implement bounded parsing and diagnostics. Use existing `show running-config` cache; do not add an extra NDM session per status request.
- [x] Extend `_managed_dns_block` with `prefer-h3: true|false` and pass it through enable/reconfigure; the default remains `false`.
- [x] Run the focused backend tests.

### Task 2: Upstream health probe

**Files:**
- Modify: `xkeen-ui/services/mihomo_dns.py`
- Modify: `xkeen-ui/routes/mihomo.py`
- Test: `tests/test_mihomo_dns.py`

**Interfaces:**
- Add `POST /api/mihomo/dns/diagnostics` with `{ "confirmed": true }` returning per-upstream result, route, latency, and an aggregate verdict.
- Probe only configured tunneled endpoints and use the managed route metadata; never fall back directly to WAN DNS.

- [x] Add a read-only diagnostics endpoint and tests for its confirmation contract.
- [x] Implement a bounded local listener diagnostic with timeout and no config mutation. Per-upstream rows report configured route/transport; the live probe deliberately stays on Mihomo `:53` so it cannot bypass the protected route.
- [x] Keep diagnostics ephemeral; no new persistent cache format is created.
- [x] Run focused tests and verify the endpoint is deterministic.

### Task 3: Frontend diagnostic surface

**Files:**
- Modify: `xkeen-ui/templates/panel/modals/mihomo.html`
- Modify: `xkeen-ui/static/js/features/mihomo_dns.js`
- Modify: `xkeen-ui/static/styles.css`
- Test: `tests/test_mihomo_dns_layout.py`

**Interfaces:**
- Render additive blocks for bypass risk, provider freshness, H3 state, and upstream health.
- Add a `prefer-h3` switch in the advanced route controls; changing it uses the existing apply/reconfigure action.
- Add a “Проверить upstream” action that calls the diagnostic endpoint and never changes config.

- [x] Add DOM contract tests for the new IDs and safety copy.
- [x] Implement rendering with explicit `safe`, `warning`, and `unknown` states.
- [x] Keep controls disabled while an apply/reconfigure operation is busy.
- [x] Run frontend layout and JS syntax checks via the Vite build and focused pytest.

### Task 4: Documentation and verification

**Files:**
- Modify: `docs/mihomo-dns-one-click-analysis.md` or the current Mihomo DNS documentation page.
- Modify: `docs/README.md` only if a new document is added.
- Test: existing Mihomo DNS and layout suites.

- [x] Document that diagnostics detect router-side bypass risks but cannot inspect encrypted DNS chosen inside individual clients.
- [x] Document H3 as opt-in and explain why direct fallback is not used.
- [x] Run the focused Mihomo DNS/layout suites; generated Stage 0/4.1/operator inventories were refreshed after the new route and DOM contract.
- [x] Run `node --check` for modified modules and `git diff --check`.
- [ ] Exercise status and diagnostics on the router without changing the active profile.
