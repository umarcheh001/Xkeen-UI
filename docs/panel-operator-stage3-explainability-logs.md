# Explainability и экономные Mihomo logs (Этап 3)

Статус: **Этап 3 реализован**.

Этап расширяет существующие `rules`, `connections` и `logs_stream` контракты.
Новый transport или routing subsystem не добавляется: источник доказательств
по-прежнему локальный Mihomo controller, а имя устройства берётся из
process-local Keenetic map.

## Объяснение маршрута

Каждая нормализованная connection row получает bounded
`routing_explanation`:

```text
device → host → rule → group → selected_node
```

У каждого звена есть `value`, `source` (`mihomo`, `keenetic-map` или
`inferred`) и `timestamp`. Если значение не сообщено upstream, звено содержит
короткий machine-readable `reason`, а весь объект получает
`status: "partial"`, `confirmed: false` и список `missing`. Частичная цепочка
никогда не показывается как подтверждённый маршрут.

`device` подтверждается только совпадением source IP с Keenetic map. `host`
предпочитает `sniffHost`, затем использует Mihomo `host`. `group` и
`selected_node` выводятся только из порядка Mihomo `chains`; при одном hop
группа не выдумывается.

В HTTP snapshot полная evidence-цепочка остаётся в versioned `payload`. Для
совместимости старые top-level connection rows сохраняются в компактной форме
без дублирования optional evidence, поэтому 250-row snapshot остаётся ниже
512 KiB. Frontend использует `payload` и показывает в inspector доказанные и
неполные звенья с их источником.

## Rule counters

Нормализатор сохраняет, если они присутствуют в Mihomo `/rules`:

- `hitCount` и `missCount` как bounded неотрицательные числа;
- `hitAt` и `missAt` как bounded RFC3339/Unix scalar;
- неизвестные scalar-поля `extra` в небольшом bounded словаре.

Счётчики не создаются искусственно. DTO добавляет `rule_counters.available`
и список реально полученных полей. В facade feature flag
`XKEEN_MIHOMO_RULE_COUNTERS_ENABLE` включён по умолчанию; при его отключении
counter fields удаляются из ответа, а capability становится `false`.

`rules/disable` остаётся flag-only capability из Stage 0 и не превращён в
раннее действие: для его будущего включения всё ещё обязательны preview,
confirmation, audit, объяснение эффекта после restart и rollback.

## Экономный upstream log level

`logs_stream` открывает только фиксированный structured endpoint:

```text
GET /logs?level=<debug|info|warning|error>&format=structured
```

По умолчанию используется `level=info`, поэтому обычная панель не создаёт
debug-шум в Mihomo. Query level проверяется в WS facade и low-level client;
произвольные значения и дополнительные query-поля не проходят.

Смена уровня закрывает старый browser socket и открывает новый с разрешённым
значением. Browser-side search/filter, redaction, 500-row ring buffer,
backpressure, reconnect и visibility lifecycle сохранены. Debug — явный режим
с пятиминутным server-side окном; после окончания stream сообщает
`debug_window_expired`, а frontend возвращается к upstream `info`.

## Проверки

Контрактные проверки находятся в `tests/test_mihomo_clash_stage3.py` и
покрывают counters/unknown scalar fields, confirmed/partial routing chain,
allow-listed log levels, default `info`, передачу уровня через WS и отказ для
произвольного `trace`.

