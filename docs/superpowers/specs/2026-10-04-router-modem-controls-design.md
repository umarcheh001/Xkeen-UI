# LTE modem controls: read-only transport diagnostics

## Status

The original reset design was superseded after an authorised hardware run on a
Keenetic router showed that QMI operating-mode reset can leave both USB modems
in USB reinitialisation. The UI and API intentionally provide no modem reset.

## Goal

Expose useful, modem-specific diagnostics in `Диагностика роутера → LTE /
модемы` without changing modem state or duplicating the connection screen.

## User-visible behaviour

- `Обновить` reads current LTE inventory via RCI.
- `Проверить управление` establishes whether a safe QMI or AT transport can
  be identified for the exact RCI modem id.
- The section explains that panel reset is disabled because Keenetic manages
  the USB modem lifecycle. Recovery actions belong in the Keenetic web UI.
- A missing `qmi-utils` package is explained inline, including the install
  command; the panel does not install packages itself.

## Transport contract

1. Browser supplies only a strict `modem_id`.
2. Backend re-reads RCI inventory and finds the exact item.
3. QMI candidates are queried with fixed `qmicli --dms-get-ids` arguments and
   accepted only on IMEI match.
4. TTY candidates are queried with `AT` and `AT+CGSN`, also requiring the
   exact IMEI match.
5. Paths, IMEI values, command output and stderr remain private. Probe has a
   bounded wall-clock deadline.

## API

- `GET /api/system/router/lte`
- `POST /api/system/router/lte/<modem_id>/probe`

No reset route, operation registry, browser confirmation flow or operation
polling endpoint exists.

## Safety rationale

`qmicli --dms-set-operating-mode=reset` requests a modem power cycle. It is
not a safe generic reset primitive for Keenetic-managed multi-modem hardware:
the router owns USB re-enumeration and WAN recovery, and the observed device
did not return reliably after this command. The panel must not send this QMI
command or an `AT+RESET` fallback.

## Verification

- Unit tests cover strict ids, selected-modem matching, QMI priority, TTY
  fallback, time bounds, error redaction and absence of reset service methods.
- Route tests cover the read-only probe and assert the legacy reset path is
  absent.
- Browser tests cover desktop and mobile probe flow, absence of reset controls,
  safety copy and absence of horizontal overflow.
