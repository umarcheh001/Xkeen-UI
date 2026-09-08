# План поэтапного расширения панели Mihomo

Статус: рабочий план расширений существующей панели Xkeen UI.

Этот документ не описывает разработку новой панели и не предполагает второй
generic relay поверх текущего кода. В репозитории уже есть собственный
операторский контур Mihomo: безопасное обнаружение controller, allow-listed
client, versioned facade, DTO, WebSocket/HTTP fallback, groups, connections,
rules, providers, logs, device enrichment, migration helper, backups и
существующий YAML-workbench. Ниже перечислено только то, чего этому контуру
не хватает, и то, что нужно расширить.

## Решение в одном абзаце

Сохраняем существующую архитектурную цепочку:

```text
ESM feature UI
      ↓
same-origin Mihomo facade
      ↓
allow-listed Mihomo client
      ↓
safe Unix/loopback target discovery
      ↓
локальный Mihomo controller
```

Новые функции подключаются к этим же точкам входа. Не создаём второй store,
второй transport, новый редактор конфигурации или универсальный Clash relay.
Если новая возможность не поддерживается конкретной версией Mihomo, facade
возвращает capability и безопасный fallback, а не имитирует успешную работу.

## Текущая база: уже реализовано

| Область | Что уже есть | Canonical owner | Решение в roadmap |
| --- | --- | --- | --- |
| Target и безопасность | Discovery активного config, Unix socket внутри Mihomo root, allow-listed loopback TCP, backend-only secret, same-origin, scoped WS token | `services/mihomo_clash_target.py`, `services/ws_tokens.py`, `services/mihomo_clash_ws.py` | Только расширять capability matrix и тесты; не переписывать transport |
| Mihomo facade | Явный endpoint allowlist, нормализованные ошибки, caps на payload, REST status/groups/rules/providers/connections, guarded mutating actions | `services/mihomo_clash_client.py`, `routes/mihomo_clash.py` | Добавлять только необходимые endpoint-ы и capabilities |
| DTO и stream envelope | `schema_version`, `sequence`, `received_at_ms`, `state`, `payload/error`, bounded/redacted DTO | `services/mihomo_clash_dto.py`, `services/mihomo_clash_ws.py` | Сохранить контракт и расширять обратно совместимыми полями |
| Groups и connections | Группы, selection/unfix, delay tests, provider enrichment, connections table/inspector, disconnect one/all, HTTP fallback | `routes/mihomo_clash.py`, `static/js/features/mihomo_clash/groups.js`, `connections.js` | Перевести источник данных на hub без изменения UX actions |
| Device enrichment | Короткий process-local Keenetic device map, используемый в connections/logs | `services/mihomo_clash_devices.py`, `services/xray_device_names.py` | Переиспользовать для будущего policy screen |
| Rules и providers | Bounded rules/providers DTO, read-only provider inspector, provider update/healthcheck и bounded cache inspector | `services/mihomo_clash_dto.py`, `services/mihomo_rule_provider_inspector.py` | Добавить counters, diff и cache invalidation |
| Logs | On-demand logs tab, redaction, reconnect, browser-side search/level filter, ограничение около 500 строк | `services/mihomo_clash_ws.py`, `static/js/features/mihomo_clash/logs.js` | Перенести выбор уровня в upstream allowlist; локальный поиск оставить |
| Config и backups | YAML editor, profiles, validation, save/restart, backup list/read/restore/clean, Zashboard launch | `services/mihomo_runtime.py`, `services/mihomo_backups.py`, `routes/mihomo.py` | Не дублировать; использовать в общем operation pipeline |
| Safe migration/listener | Preview → validate → backup → save → restart → verify для API migration; rollback для egress listener | `services/mihomo_clash_migration.py`, `services/mihomo_egress_setup.py` | Обобщить orchestration, не заменять эти flows |
| Managed DNS | DNS/fake-IP config assistant, port-53 guard, preflight, state, backup, restart, healthcheck и rollback | `services/mihomo_dns.py`, `routes/mihomo.py` | Добавить Clash DNS query/cache adapter поверх существующего слоя |
| Subscriptions | Managed Mihomo/Xray-JSON subscriptions, persisted state, schedule, due refresh, batch restart, last error/next update | `services/mihomo_subscriptions.py` | Добавить preview-diff и согласовать с pipeline |
| Diagnostics/resources | Router diagnostics, system resources, devtools logs, bounded operation diagnostic snapshots | `services/router_diagnostics.py`, `services/system_resources.py`, `services/operation_diagnostics.py` | Собрать redacted package; не создавать второй metrics backend |
| Frontend lifecycle | ESM feature registry, lazy subviews, abort/visibility handling, responsive connections/groups/rules/logs UI | `static/js/features/mihomo_clash/index.js` и feature modules | Добавить store/adapter только для telemetry; не вводить второй frontend framework |

Источник истины для статуса — текущий исходный код и тесты. Старый audit в
`docs/README_clash_api_implementation_plan.md` местами отстаёт от исходников:
например, текущий connections path уже передаёт device map в DTO.

## Базовые правила

1. Браузер обращается только к same-origin facade; controller, method и path не
   передаются из браузера в свободной форме.
2. Каждый endpoint имеет allowlist, capability, versioned DTO и безопасный
   отказ для старого или недоступного Mihomo.
3. Snapshot и stream используют единый envelope: `schema_version`, `sequence`,
   `received_at_ms`, `state`, `payload`, `error`; для устаревших данных
   указываются `stale_since` и `source_age_ms`.
4. История telemetry хранится только в RAM, имеет bounded size и очищается при
   остановке процесса.
5. Изменяющие действия требуют preview/confirmation, CSRF/session check,
   action guard, rate-limit, audit и rollback либо явно помечаются read-only.
6. Secret, subscription URL, private credentials, Unix path и лишние private
   addresses не попадают во frontend и diagnostic package.
7. Код из внешних проектов не переносится до проверки лицензии и third-party
   notices. Публичные API и UX-идеи можно использовать независимо от кода.

## Что изменилось относительно старого MVP-плана

Старый план уже закрыл базовые PR для status, groups, connections, rules,
providers, logs, migration, connections UX+ и provider inspector. В нём
`/traffic`, DNS/cache actions и rule disable были отложены; `/connections`
уже содержит totals и memory, поэтому rates можно получить delta-методом.

Новый roadmap не отменяет этот результат. Он добавляет архитектурные
улучшения для слабого роутера и новые диагностические сценарии. Отдельный
`/traffic` становится опциональным endpoint-ом: сначала проверяем версию API и
ресурсный эффект, затем включаем его capability-флагом. Переход на hub важнее
самого endpoint-а.

## Порядок релизов

```text
Этап 0: capability/contract baseline и feature flags
              |
Этап 1: общий Telemetry Hub и единый telemetry stream
              |
Этап 2: DNS diagnostics и общий bounded cache
              |
Этап 3: explainability, rule counters и server-side logs
              |
Этап 4: diagnostic package и operation pipeline
              |
Этап 5: provider/subscription diff и device policies
              |
Этап 6: listeners, optimizer и compact PWA mode (P2)
              |
Этап 7: compatibility, load tests и staged rollout
```

Этапы 0–2 — P0 для производительности и совместимости. Этапы 3–5 — P1.
Этап 6 выполняется только после подтверждения resource budget.

## Этап 0 — capability и контрактный baseline (P0)

Статус: **выполнен в baseline PR**. Матрица версий и runtime readiness,
tri-state capability keys, opt-in flags/kill-switch, единый v1 snapshot
envelope и redacted fixtures закреплены в
`docs/panel-operator-stage0-mihomo-contract.md` и тестах.

Это не повторная реализация safety foundation, а её формализация.

### Расширить существующий код

1. Зафиксировать матрицу поддерживаемых версий Mihomo и наличие `/traffic`,
   `/dns/query`, DNS/fake-IP flush, rule counters и `/rules/disable` в fixture
   и runtime probe.
2. Расширить текущий capability response ключами `traffic`,
   `telemetry_stream`, `dns_query`, `dns_flush`, `fake_ip_flush`, `cache_etag`.
   Capability должен отражать и статическую поддержку, и runtime readiness.
3. Добавить feature flags и kill-switch, позволяющие быстро вернуться к
   текущему connections WS/HTTP fallback.
4. Привести snapshot endpoints к тому же envelope, который уже используется
   текущими WS streams, не ломая `schema_version: 1` и существующие поля.
5. Дополнить mock fixtures сценариями: Unix/loopback, старый Mihomo, target
   unavailable, stale snapshot, reconnect, malformed/oversized payload.
6. Оставить неизменными уже действующие ограничения target discovery,
   allowlist, same-origin, scoped token, bounded payload, audit и guard.

### Выходной критерий

Матрица и DTO закреплены тестами; при отключённом flag текущая панель работает
как раньше; новый endpoint не принимает произвольный URL, upstream DNS,
controller или path.

## Этап 1 — Telemetry Hub (P0)

Статус: **выполнен**. Добавлен process-local hub по fingerprint target,
независимые readers для traffic/connections/memory, bounded fan-out/history,
idle shutdown, отдельный scoped telemetry WS и frontend adapter с сохранением
connections WS/HTTP fallback. Детали контракта и rollout описаны в
`docs/panel-operator-stage1-telemetry-hub.md`.

### Что есть сейчас

`/ws/mihomo-clash/connections` является per-browser poller: он последовательно
получает `/connections`, затем `/memory`, формирует DTO и повторяет цикл.
Скорость считается в `connections.js` по разнице totals. Это рабочий fallback,
но десять вкладок создают десять upstream циклов.

### Что добавить

1. Ввести внутренний `TelemetryHub`, ключуемый по fingerprint Mihomo target.
   Для одного target должен работать один reader/poller каждого типа, который
   fan-out-ит последний snapshot подписчикам.
2. Добавить allow-listed `/traffic` только если capability и замеры показывают
   пользу. При его отсутствии rates продолжают вычисляться из totals как
   совместимый fallback.
3. Разнести cadence: traffic около 1 с, connections около 2 с, memory 5–10 с.
   Ошибка одного источника не должна останавливать остальные.
4. Хранить последний успешный snapshot и короткую bounded history в RAM;
   публиковать `stale_since` и `source_age_ms`.
5. Запускать hub первым подписчиком и останавливать через 3–5 секунд после
   ухода последнего. Ограничить targets, subscribers, frames и queue size;
   медленного клиента отключать, не блокируя остальных.
6. Добавить `WS /ws/mihomo-clash/telemetry` с теми же origin/token rules и
   максимумом одного telemetry socket на browser client.
7. Сохранить текущий `/ws/mihomo-clash/connections` и HTTP snapshot polling как
   fallback при отсутствии WebSocket, hub или нужного capability.

### Frontend

Добавить небольшой telemetry adapter/store в существующий Mihomo feature API.
Перевести status card и summary connections на общий snapshot, но сохранить
нынешние filters, inspector, recently closed history и disconnect actions.
Показывать `live`, `reconnecting`, `stale`, `paused`, `fallback`, `error` и
время последнего успешного кадра.

### Приёмка

- десять открытых панелей дают один upstream poller каждого типа;
- connections и memory больше не ожидаются последовательно в одном цикле;
- остановка последнего клиента останавливает hub;
- slow consumer, reconnect storm, target unavailable и fallback не влияют на
  остальные подписчики;
- telemetry не пишется на flash.

## Этап 2 — DNS diagnostics и общий bounded cache (P0)

### 2.1. DNS adapter

Текущий `mihomo_dns.py` остаётся владельцем managed DNS/fake-IP конфигурации,
port-53 guard и rollback. Рядом с ним добавляется узкий Clash API adapter:

1. `/dns/query` с жёсткой валидацией имени, длины и типов только `A`, `AAAA`,
   `CNAME`, `TXT`;
2. ответ с TTL, latency, DNS mode и нормализованной причиной ошибки;
3. отдельные подтверждаемые `flush DNS cache` и `flush fake-IP` через POST,
   CSRF/session, capability, guard, rate-limit и audit;
4. read-only поиск в DNS/fake-IP cache только при наличии соответствующего API;
   иначе честный `not_supported`;
5. UI разделяет диагностику и обслуживающее действие. Flush не запускает
   автоматическое исправление конфигурации.

### 2.2. Общий cache

Выделить переиспользуемый потокобезопасный in-memory cache по образцу уже
существующего single-flight в geodata, но с общим контрактом:

| Данные | TTL по умолчанию | Инвалидация |
| --- | ---: | --- |
| status/config | 1–2 с | save config, mode, restart |
| proxies/groups | около 1 с | select/unfix, provider update, restart |
| providers/rules | 5–15 с | provider refresh, config save, restart |
| локальный YAML parse | до изменения файла | mtime/size/hash |

Ключ включает target fingerprint, schema version и config fingerprint. Cache
имеет bounded size, hit/miss/waiter metrics и single-flight на одинаковый ключ;
secret в нём нет, на flash он не сохраняется.

### Выходной критерий

Параллельные одинаковые GET-ы объединяются в один upstream request; cache
инвалидируется сразу после mutation; flush требует подтверждение и audit.

## Этап 3 — explainability и экономные server-side logs (P1)

### Routing explainability

Расширить существующие rules/connections DTO, не создавая новую routing
subsystem:

1. сохранять `hitCount`, `hitAt`, `missCount`, `missAt`, не теряя неизвестные
   optional fields;
2. представить цепочку
   `устройство Keenetic → host/sniffHost → правило → группа → выбранный узел`;
3. для каждого звена указывать source (`mihomo`, `keenetic-map`, `inferred`),
   timestamp и причину отсутствия данных;
4. не выдавать partial chain за подтверждённый маршрут;
5. оставить `rules/disable` поздним flag-only действием: preview, confirmation,
   audit и безопасное объяснение последствий после restart обязательны.

### Server-side log level

1. Расширить allowlisted `logs_stream`, чтобы upstream принимал только
   выбранный набор уровней; default — `info`, `debug` — явный и ограниченный.
2. При смене уровня закрывать старый stream и открывать новый с допустимым
   query. Browser-side search и filter оставить.
3. Сохранить bounded rows, backpressure, reconnect и lifecycle текущего logs
   feature.

### Выходной критерий

Обычный режим не создаёт debug-шум на Mihomo; inspector показывает доказуемую
или явно неполную цепочку; E2E покрывает counters, смену уровня и отмену
debug-stream.

## Этап 4 — diagnostic package и operation pipeline (P1)

### 4.1. Diagnostic package

Собрать read-only redacted package из уже существующих источников:

- версии XKeen, Mihomo и панели;
- runtime config без secret/subscription URL/private credentials;
- controller/listeners/ports и security posture;
- mode, groups и selected nodes;
- DNS/fake-IP state;
- Keenetic routes/policies, если источник доступен;
- RAM, CPU, free space и file descriptors;
- последние 100–200 очищенных logs.

Перед скачиванием показать состав, применить deterministic redaction, дать
отменить выдачу. Архив не хранить постоянно на flash; временный файл удалять
по TTL. `operation_diagnostics` остаётся журналом деталей операций, а не
заменяется этим package.

### 4.2. Общая оркестрация изменений

Создать тонкий orchestration layer поверх существующих preview/validate/
backup/restart/healthcheck callbacks:

```text
preview → validate → backup → apply → restart → API healthcheck → rollback
```

Операция получает `operation_id` и состояния
`queued`, `running`, `failed`, `rolled_back`, `completed`, `manual_recovery`.
Pipeline применяется поэтапно к config, subscription
refresh, GEO и core update. Для внешних артефактов нужны checksum/signature и
проверка до распаковки.

Не переписывать `mihomo_runtime`, DNS transaction code или migration routes.
Сначала вынести общий интерфейс шагов, затем подключать конкретные операции.
Отдельно закрыть технический долг: обычный `save_config` сейчас пишет active
file напрямую, поэтому pipeline должен либо использовать атомарную запись,
либо явно проверять целостность и иметь подтверждённый rollback.

### Выходной критерий

Невалидный config не применяется; failure после restart автоматически возвращает
последнюю рабочую копию или переводит операцию в понятный manual recovery;
пользователь видит уже выполненные шаги и доступный backup; diagnostic fixture
не содержит секретов.

## Этап 5 — providers, subscriptions и device policies (P1)

### 5.1. Provider/subscription manager

Расширить существующий `mihomo_subscriptions.py` и текущий provider workspace:

1. перед refresh показывать preview-diff: added/removed/renamed nodes,
   исчезнувшие active selections, quota/expiry, last error и next refresh;
2. сохранять source/region и добавить фильтр, regex, массовое переименование и
   явные `udp/tfo` изменения;
3. оставить существующий scheduler источником расписания;
4. проводить refresh через pipeline этапа 4 и сразу инвалидировать
   proxies/groups/providers cache;
5. chain/relay и сложные routing transformations выпускать позже, только после
   проверки совместимости версии Mihomo.

### 5.2. Device policies

Использовать существующую Keenetic device map только как источник идентичности:

`device/IP/MAC → direct/proxy/group`.

Добавляемый policy screen должен показывать effective policy, conflicts,
расписание, раздельные IPv4/IPv6 настройки и исключения портов. Источник
истины — штатные политики Keenetic/XKeen; OpenWrt nftables-скрипты не
переносятся. Любое изменение проходит dry-run, preview, backup/rollback и
healthcheck. При отсутствии RCI control отключается, а не имитируется UI.

### Выходной критерий

До refresh видны последствия для активных групп; policy screen показывает
effective state; scheduler, cache и rollback согласованы; IPv6 не получает
непреднамеренный обход proxy.

## Этап 6 — listeners, optimizer и compact PWA mode (P2)

Этот этап начинается только после resource budget и стабилизации этапов 0–5.

### Read-only runtime/listeners

Добавить отдельный экран без записи по умолчанию: mixed/redir/tproxy/TUN/DNS/
controller, bind address, port, конфликт портов, IPv6 и источник значения
(config или runtime). Будущая запись идёт только через pipeline этапа 4.
Существующий loopback egress listener остаётся отдельным диагностическим
сценарием.

### Optimizer

Только проверять и предлагать:

- `find-process-mode: off`;
- `geodata-loader: memconservative`;
- lite GeoIP/GeoSite;
- ETag provider/GEO;
- разумные health-check intervals/lazy режим;
- отсутствие лишнего debug logging;
- согласованный IPv6 без обхода proxy.

Результат — `pass/warn/fail`, объяснение эффекта и безопасная apply-кнопка
через preview/rollback. Автоматически config не менять.

### Compact/PWA UI

Добавить локальные static assets, cache version check и компактный режим
`status / groups / connections` для старых телефонов и браузеров. Тяжёлые
editor/diagnostic views должны lazy-load-иться. Не добавлять CDN, обязательные
шрифты, внешнюю telemetry или второй UI framework.

## Этап 7 — совместимость, нагрузка и rollout

Перед включением новых возможностей по умолчанию:

1. Contract tests для каждого нового endpoint и DTO schema.
2. E2E для light/dark, desktop/mobile, Unix/loopback, старого Mihomo,
   WebSocket-disabled и unavailable controller.
3. Нагрузочный mock: несколько browser clients, slow consumer, reconnect storm,
   provider refresh во время telemetry, DNS flush и rollback failures.
4. Resource budget: CPU, RSS, upstream sockets, RAM history, idle shutdown и
   отсутствие telemetry на flash.
5. Security review: origin/token, path allowlist, URL policy, redaction,
   CSRF/confirmation, audit и license inventory.
6. Rollout: capability → opt-in flag → ограниченная beta → default; kill-switch
   и текущий fallback оставить минимум на один релиз.
7. Обновить `docs/README.md`, frontend API contract и release notes после
   стабилизации публичных DTO.

## Definition of Done для расширения

- используется существующий canonical owner, либо явно обоснован новый слой;
- backend endpoint/service и DTO имеют version, capability и safe failure;
- frontend показывает loading/live/stale/error и не ломает fallback;
- есть unit/contract/E2E fixture для upstream failure;
- resource budget измерен на слабом роутере или помечен как hardware gate;
- mutation имеет preview/confirmation, rate-limit, audit и rollback либо
  объявлена read-only;
- документация и известные ограничения обновлены.

## Что не добавляем

- `/debug/pprof` и другие отладочные поверхности из панели;
- произвольный `/configs` PATCH/PUT из браузера;
- generic relay любых Clash/Mihomo endpoint-ов;
- произвольный upstream DNS, URL, controller или filesystem path от клиента;
- бессрочную историю telemetry/logs на накопителе роутера;
- второй YAML editor, второй backup manager, второй subscription scheduler;
- перенос OpenWrt firewall/nftables-слоя в Mihomo UI;
- копирование исходного кода внешних dashboard без license review.

## Рекомендуемые pull requests

1. **Contract/capability baseline** — matrix, DTO compatibility, feature flags и
   fixtures; без новой панели.
2. **Telemetry Hub** — internal hub, optional `/traffic`, telemetry WS и
   adapter текущего connections UI.
3. **DNS adapter + common cache** — query/flush capabilities, single-flight,
   invalidation и fallback.
4. **Explainability/logs** — rule counters, chain evidence и upstream level.
5. **Diagnostic package + operation interface** — orchestration поверх текущих
   migration/DNS/runtime flows.
6. **Provider diff + device policies** — scheduler/cache/pipeline integration.
7. **P2 listeners/optimizer/compact mode** — только после hardware/resource
   acceptance.
8. **Compatibility and rollout** — load, failure, security, docs и staged flags.

Каждый PR должен быть обратимо отключаемым и не менять существующие IDs,
handlers и пользовательские сценарии YAML-workbench, groups, connections,
rules и logs.

## Референсы

- [Mihomo API](https://wiki.metacubex.one/en/api/) — traffic, DNS, connections,
  memory, rules и providers.
- [MetaCubeXD](https://github.com/MetaCubeX/metacubexd) — API-ориентир.
- [Zashboard](https://github.com/MetaCubeX/zashboard) и
  [Yacd-meta](https://github.com/MetaCubeX/Yacd-meta) — UX и lifecycle идеи.
- [OpenClash](https://github.com/vernesong/OpenClash) — lifecycle подписок/GEO.
- [OpenWrt Nikki](https://github.com/nikkinikki-org/OpenWrt-nikki) — только
  идеи device access control, без переноса firewall-кода.
- [BROray](https://github.com/BROadmin/BROray) — snapshots/checksum/rollback.

Референсы задают идеи и внешние API-контракты; реализация остаётся частью
текущей архитектуры Xkeen UI.
