# Mihomo DNS diagnostics и общий bounded cache (Этап 2)

Этап 2 расширяет существующий Mihomo facade и не меняет владельца managed
DNS/fake-IP конфигурации из `services/mihomo_dns.py`. Новые read-only
диагностики используют тот же allow-listed client, target discovery и
same-origin auth-контур.

## DNS adapter

Фасад предоставляет:

- `GET /api/mihomo/clash/dns/query?name=example.com&type=A`;
- `GET /api/mihomo/clash/dns/route-check?name=example.com&type=A`;
- `POST /api/mihomo/clash/dns/flush` с JSON
  `{ "confirmed": true }`;
- `POST /api/mihomo/clash/fake-ip/flush` с JSON
  `{ "confirmed": true }`;
- read-only cache search endpoints, которые отвечают `501` с
  `code: "not_supported"`, если конкретный client/API не предоставляет
  соответствующий adapter;
- `GET /api/mihomo/clash/cache` для bounded in-memory cache counters.

DNS query принимает только `A`, `AAAA`, `CNAME` и `TXT`. Имя проверяется на
границе facade и повторно в low-level client; arbitrary controller, path,
upstream DNS и URL не передаются из браузера. DTO содержит `ttl`, `latency_ms`,
`dns_mode`, `rcode_name`, `answers`, нормализованный `error_reason`,
`answer_observation` и `route_check`. `answer_observation` описывает только
форму ответа самого controller API (адрес похож на Fake-IP CIDR или является
upstream-адресом). `route_check` намеренно имеет состояние `not-checked`:
`/dns/query` не является проверкой клиентского listener на порту 53. Кнопка
«Проверить listener 53» вызывает отдельный read-only route-check, который
посылает ограниченный UDP A/AAAA запрос на `127.0.0.1:53` и классифицирует
полученный адрес относительно Fake-IP CIDR. Это проверяет живой listener
роутера, но не заменяет проверку реального подключения клиента через
TUN/TProxy.

Flush — отдельное обслуживающее действие. Оно не вызывает managed DNS
configuration assistant, не меняет `config.yaml`, требует CSRF/session,
явного подтверждения, action guard/rate-limit и audit. После успешной очистки
DNS query cache инвалидируется.

## Общий cache

`services/mihomo_clash_cache.py` хранит только process-local redacted DTO:

- bounded LRU capacity — 128 entries по умолчанию;
- thread-safe single-flight для одинакового ключа;
- `hits`, `misses`, `waiters`, `evictions`, `invalidations`;
- ключ включает namespace, target fingerprint, schema version, config
  fingerprint и variant;
- target fingerprint — SHA-256 от backend-only target; secret не публикуется;
- config fingerprint — mtime/size/content hash, сам YAML в cache key не
  сохраняется;
- данные не записываются на flash.

Используемые TTL:

| Namespace | TTL |
| --- | ---: |
| status / config | 1.5 с для redacted config; version остаётся health probe |
| groups | 1 с |
| providers | 10 с |
| rules | 10 с |
| DNS query | 1 с |
| local YAML parse | до изменения fingerprint |

Cache инвалидируется после смены runtime mode, select/unfix группы, provider
update/healthcheck, `save_config`, restart и DNS flush. Config fingerprint
также автоматически отделяет содержимое после изменения файла.

## Rollout

DNS capabilities доступны по умолчанию и сохраняют Stage 0 rollout gates как
явные kill-switch переменные:

- `XKEEN_MIHOMO_DNS_QUERY_ENABLE=1` (default);
- `XKEEN_MIHOMO_DNS_FLUSH_ENABLE=1` (default);
- `XKEEN_MIHOMO_FAKE_IP_FLUSH_ENABLE=1` (default).

Все три настройки находятся в **DevTools → ENV → Mihomo и HWID** и
применяются сразу, без Restart UI. Для сборок Mihomo без semver кнопки flush
остаются доступными после явного подтверждения: endpoint allow-listed, а
совместимость проверяется самим запросом. Для старого core или отключённого
флага кнопка остаётся недоступной с объяснением причины.

`XKEEN_MIHOMO_CAPABILITY_PROBE=1` по-прежнему управляет только диагностическим
runtime probe в capability/status response; сам явный DNS query выполняется
через bounded allow-list и, при неизвестной runtime readiness, даёт честную
ошибку upstream вместо имитации успеха.

Route-check ограничен отдельной rate/concurrency policy (`dns-route-check`) и
не выполняет mutation или изменение `config.yaml`.

## Проверки

Contract/unit coverage находится в
`tests/test_mihomo_clash_stage2.py`: single-flight, bounded size, TTL,
invalidation during an in-flight load, secret-free fingerprints, DNS DTO,
strict facade query, confirmation/audit for flush и honest `not_supported`
cache search.
