# Mihomo capability и контрактный baseline (Этап 0)

Этот документ фиксирует baseline для расширения существующего Mihomo facade.
Он не создаёт новый relay или transport: target discovery, allowlist,
same-origin, scoped token, bounded payload и текущий connections WS/HTTP
fallback остаются canonical owner-ами.

## Capability matrix

Машиночитаемая матрица хранится в
[`mihomo-capability-matrix.json`](mihomo-capability-matrix.json), а redacted
upstream shape — в `tests/fixtures/mihomo_clash/`. Версионный gate отделён от
runtime readiness: старый core даёт `static_supported: false`, неизвестная
версия — `null`. Read-only DNS query проверяется фактическим bounded-запросом
в фасаде, поэтому для vendor-сборок без semver она может быть доступна без
отдельного probe; mutating endpoints по-прежнему требуют известной версии.

Публичные ключи добавлены обратно совместимо: `traffic`,
`telemetry_stream`, `dns_query`, `dns_flush`, `fake_ip_flush`, `cache_etag`.
Значения имеют тип `boolean | null`; frontend включает новую возможность
только при строгом `=== true`. Если конкретная сборка не реализует
`/dns/query`, реальный запрос вернёт честный `501 Not supported`.

## Rollout flags

Telemetry Hub и DNS diagnostics включены по умолчанию. DNS query остаётся
строго allow-listed/read-only, а очистка DNS/Fake-IP cache требует явного
подтверждения и action guard. Остальные optional surfaces выключены и
включаются точечно через `XKEEN_MIHOMO_<CAPABILITY>_ENABLE=1`.
Для аварийного отключения DNS без перезапуска доступны
`XKEEN_MIHOMO_DNS_QUERY_ENABLE=0`, `XKEEN_MIHOMO_DNS_FLUSH_ENABLE=0` и
`XKEEN_MIHOMO_FAKE_IP_FLUSH_ENABLE=0`.
`XKEEN_MIHOMO_TELEMETRY_STREAM_ENABLE=0` возвращает прежний transport, а
аварийный `XKEEN_MIHOMO_TELEMETRY_KILL_SWITCH=1` отключает traffic/telemetry и
оставляет текущий connections WS/HTTP fallback без изменений. Runtime probe
включается отдельно переменной `XKEEN_MIHOMO_CAPABILITY_PROBE=1`; он выполняет
только bounded read-only probes и никогда не вызывает flush или rule mutation.

## Snapshot envelope

GET snapshot routes (`status`, `proxy-groups`, `rules`, `providers`,
`connections`) теперь возвращают единый v1 envelope:

```json
{
  "type": "mihomo-clash-connections",
  "schema_version": 1,
  "sequence": 1,
  "received_at_ms": 0,
  "state": "live",
  "payload": {"schema_version": 1},
  "connections": []
}
```

Старые top-level DTO fields сохранены, поэтому существующие consumers и
fallback не требуют миграции. `stale_since` и `source_age_ms` зарезервированы
для stale frames и не записываются на flash.

## Fixtures и failure contract

Fixtures покрывают Unix/loopback discovery, старый/неизвестный core,
controller unavailable, stale/reconnect envelope, malformed/oversized parser
payloads и optional traffic/DNS shapes. Секреты, subscription URL, private
credentials и filesystem paths в fixture не попадают.
