# Mihomo Traffic Reconciliation Implementation Plan

**Goal:** Make traffic analytics totals authoritative, explain unmatched Mihomo traffic, and prevent impossible `total/outside/Mihomo` combinations.

**Architecture:** The collector remains the source of canonical totals. It will expose unmatched Mihomo bytes as coverage metadata, while the frontend will use `payload.summary` for the unfiltered view and only derive totals for filtered views. Regression fixtures will cover an IP identity mismatch and the existing Windows lab path will remain usable with an explicit database path.

**Tech Stack:** Python collector and pytest, browser E2E with Playwright, vanilla JavaScript frontend, SQLite aggregates.

**Spec:** `docs/mihomo-traffic-analytics.md`

## Scope

- Preserve the existing Connections screen as an operational live-flow view.
- Rename the residual label to `Оценочный остаток` without claiming it is proven bypass traffic.
- Add explicit unmatched-device coverage to the quality section and API payload.
- Keep route filtering scoped to observed Mihomo routes.
- Add deterministic mismatch coverage to tests and the traffic lab.

## Files

- Modify `xkeen-ui/services/mihomo_traffic_analytics.py` for canonical coverage metadata.
- Modify `xkeen-ui/services/mihomo_traffic_simulator.py` and `scripts/mihomo_traffic_lab.py` for mismatch fixtures.
- Modify `xkeen-ui/static/js/features/mihomo_clash/diagnostics.js` for server-authoritative summary rendering and labels.
- Modify `xkeen-ui/templates/panel/screens/mihomo.html` and `xkeen-ui/static/panel-operator.css` only if the coverage copy needs layout support.
- Modify `tests/test_mihomo_traffic_analytics.py` and `e2e/mihomo_clash_diagnostics.spec.mjs` with regression assertions.
- Update `docs/mihomo-traffic-analytics.md` with the reconciliation model.
