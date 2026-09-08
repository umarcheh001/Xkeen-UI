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
- `capabilities.json` — Stage 0 version matrix and default rollout flags.
- `configs.json` — read-only `/configs` runtime values.
- `proxies.json` — `/proxies` groups and nodes in operator order.
- `group.json` — `/group` policy-group collection shape.
- `providers-proxies.json` — `/providers/proxies` enrichment.
- `rules.json` — ordered read-only `/rules` contract.
- `providers-rules.json` — `/providers/rules` state without source URL/path.
- `connections-01.json` through `connections-03.json` — bounded live snapshots.
- `traffic-01.json` and `dns-query.json` — optional read-only endpoint shapes.
- `stale-snapshot.json` and `reconnect.json` — common envelope lifecycle states.
- `malformed.ndjson` and `oversized.ndjson` — malformed/oversized stream
  frames; the actual byte limits are exercised by `mihomo_clash_stream` tests.
- `errors.json` — representative status/error classes with sensitive details removed.
