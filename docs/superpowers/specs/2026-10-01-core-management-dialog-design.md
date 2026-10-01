# Core Management Dialog Design

## Goal

Keep routing editors as the first content of the Xray and Mihomo screens, and
make source selection and verified installation available from the existing
shared `Ядро` dialog.

## Requirements

- The core topology watcher must not reload a page merely because its initial
  module topology differs from the first physical-core probe.
- A local/dev environment with no `/opt/sbin/xray` or `/opt/sbin/mihomo` is a
  supported state: the panel remains usable and the core-management dialog
  still exposes the source/install flow for enabled engine modules.
- The Xray and Mihomo editor screens must not render the source-management
  card above their workspaces.
- The existing `core-modal` remains the single entry point for core switching,
  source selection and update preparation. It contains one compact source
  control per enabled engine.
- `Источник` and `Обновить` remain separate actions, use the existing verified
  profile/install flow, and render icon and label on one horizontal line.
- The light theme must use the operator surface variables rather than a dark
  card fallback. The core modal needs visibly larger content and edge padding.

## Non-goals

- Do not change the curated profile catalog, checksum verification or install
  transaction.
- Do not infer installed binaries from a local test stub.
- Do not add a second dialog or duplicate IDs/event handlers.

## Verification

- Focused regression tests prove the watcher primes from the first successful
  runtime probe, source controls are shared under `core-modal`, and the
  editor-screen includes no longer render them.
- The local review server is inspected in both the no-core state and the
  source-selection flow.
- The complete Python test suite is run before any completion claim.
