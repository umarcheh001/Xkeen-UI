# LTE modem diagnostics follow-up plan

## Context

The initial plan included QMI/AT reset and recovery polling. The authorised
hardware experiment showed that this is unsafe on the target
Keenetic-managed multi-modem router: both modems could remain unavailable
during USB reinitialisation. That reset plan is retired.

## Retained implementation

1. Keep the RCI LTE inventory as the only source for modem cards.
2. Keep a bounded, modem-specific read-only transport probe.
3. Match QMI or TTY transports by RCI IMEI, never by path order.
4. Preserve redaction, fixed subprocess arguments and strict modem ids.
5. Explain in the UI that reset is unavailable from the panel and that
   Keenetic owns modem recovery.

## Removed implementation

- QMI operating-mode reset and `AT+RESET`;
- reset confirmation dialog;
- background workers, operation registry and status polling;
- reset and operation-status API routes;
- reset/recovery browser scenarios.

## Test plan

1. Unit test probe success, candidate matching, error redaction and total
   deadline.
2. Test that `ModemControlService` exposes no reset lifecycle methods.
3. Test that the legacy reset route returns `404`.
4. Exercise desktop and mobile cards: a probe changes only its selected card,
   the safety message is visible, no reset button is rendered and the page does
   not overflow horizontally.
5. Run the project validation suite before release.
