# Mihomo Clash contract fixtures

These fixtures are **redacted, deterministic contract data** shaped after the
official Mihomo External Control API. They are intentionally not a capture from
a particular router: no public address, credential, subscription URL, or
device identifier is included.

The fixture set is used by the PR 1 contract tests to pin the product DTO v1
without exposing raw Mihomo payloads to the browser. Before router acceptance,
extend it with a redacted capture from the active XKeen profile and
record the Mihomo version, architecture, transport, payload sizes, and stream
cadence in the implementation-plan README.

Files:

- `version.json` — `/version` probe.
- `configs.json` — read-only `/configs` runtime values.
- `proxies.json` — `/proxies` groups and nodes in operator order.
- `group.json` — `/group` policy-group collection shape.
- `providers-proxies.json` — `/providers/proxies` enrichment.
- `connections-01.json` through `connections-03.json` — bounded live snapshots.
- `errors.json` — representative status/error classes with sensitive details removed.
