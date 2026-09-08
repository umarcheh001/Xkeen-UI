# Mihomo Telemetry Hub (Этап 1)

Этап 1 реализован как расширение существующего Mihomo facade. Browser по-прежнему
не передаёт controller, path или upstream URL; target берётся только из safe
discovery, а новый endpoint использует same-origin и одноразовый scoped token.

## Контур и lifecycle

`TelemetryHub` ключуется SHA-256 fingerprint активного target. Fingerprint
учитывает transport, loopback endpoint/Unix socket и credential, но не раскрывает
их во frontend. Для одного fingerprint запускается по одному независимому reader:

- `/connections` — каждые 2 секунды;
- `/memory` — каждые 5 секунд;
- allow-listed `/traffic` — каждую секунду, только при включённом capability flag.

Первый subscriber запускает hub. После ухода последнего reader-ы останавливаются
через 4 секунды. Ошибка одного source публикуется как `error` или `stale`, но не
останавливает остальные reader-ы. Последний успешный payload и до 60 кадров
истории хранятся только в RAM.

## Bounded fan-out

Process ограничен 8 target, 32 subscriber на target, очередью 8 кадров на
subscriber и историей 60 кадров. Медленный subscriber отключается с
`slow_consumer`; публикация другим subscriber при этом не блокируется. Никаких
telemetry-файлов или постоянной истории не создаётся.

## WebSocket и fallback

Новый endpoint: `WS /ws/mihomo-clash/telemetry`. Token scope:
`mihomo-clash-telemetry`. Envelope сохраняет schema v1:

```json
{
  "type": "mihomo-clash-telemetry",
  "schema_version": 1,
  "sequence": 1,
  "received_at_ms": 0,
  "state": "live",
  "payload": {
    "schema_version": 1,
    "sources": {},
    "connections": {},
    "memory": {},
    "traffic": {},
    "rates": {}
  }
}
```

Для stale-кадров добавляются `stale_since` и `source_age_ms`. При отсутствии
`/traffic` rate вычисляется в hub по delta totals. Текущий connections WS и
HTTP snapshot polling не удалены: adapter переключается на них при выключенном
flag, отсутствии WebSocket или ошибке/reconnect exhaustion.

## Rollout

Hub остаётся opt-in в соответствии с Этапом 0:

```text
XKEEN_MIHOMO_TELEMETRY_STREAM_ENABLE=1
XKEEN_MIHOMO_TRAFFIC_ENABLE=1        # optional, после resource measurement
```

`XKEEN_MIHOMO_TELEMETRY_KILL_SWITCH=1` немедленно отключает новый stream и
optional traffic, оставляя прежний fallback. Frontend отображает состояния
`live`, `reconnecting`, `stale`, `paused`, `fallback`, `error` и timestamp
последнего полученного кадра.
