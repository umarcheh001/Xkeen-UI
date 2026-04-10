# Актуализированный аудит XKeen UI

Сверка выполнена по состоянию репозитория на `2026-04-11`, включая последние декомпозиции по `PR-08`.

Источники:
- текущая ветка `main` в `/Users/umar/xkeen-test`;
- предыдущая версия этого плана;
- последние PR-08/PR-12/PR-15 изменения в рабочем дереве и истории `main`;
- актуальные unit/contract tests и browser smoke через Playwright.

## Что изменилось с прошлого пересмотра

Главное: ещё один крупный техдолговый блок можно убирать из активной очереди.

- [x] **PR-15** — закрыт. Санитизация exception detail доведена до route-слоя, добавлен общий helper в `routes/common/errors.py`, усилены `test_exception_detail_sanitization*`.
- [x] **PR-12** — закрыт. В `app_factory.py` подключены app-wide request size guards, в `request_limits.py` появился явный `MAX_CONTENT_LENGTH` и path-based JSON ceiling, `geodat` больше не пишет upload напрямую без лимита.
- [x] **PR-08** — закрыт. Монолиты `run_server.py`, `mihomo_server_core.py` и `mihomo_config_generator.py` разрезаны на service-модули и перестали быть oversized.
- [~] **NEW-01** — частично закрыт. Есть Playwright scaffold и базовые self-update регрессии, но ещё нет полноценного автоматизированного smoke на `update/info` + `update/check` как единый поток.

## Короткий вывод

На текущий момент верхушка плана смещается так:

1. **PR-11** — insecure config-server default.
2. **PR-05** — отсутствие app-wide security headers baseline.
3. **NEW-01** — недоведённый smoke для self-update/devtools.
4. **PR-06** — checksum policy ещё не доведена до жёсткого baseline.

`PR-15`, `PR-12` и `PR-08` больше не стоит держать в активных блокерах: они уже закрыты кодом и тестами.

## Закрытые этапы

- [x] **PR-01** — Remotefs delete safety.
- [x] **PR-02** — Shell disabled by default.
- [x] **PR-03** — Login rate limiting.
- [x] **PR-08** — Oversized modules.
- [x] **PR-09** — Legacy backup traversal.
- [x] **PR-10** — URL policy hardening.
- [x] **PR-12** — Request-size hardening.
- [x] **PR-13** — WS auth bypass.
- [x] **PR-14** — Mihomo same-origin proxy hardening.
- [x] **PR-15** — API exception detail sanitization.
- [x] **AUX-LOG** — race в `xray_log_api.py`.
- [x] **AUX-GH** — race в `config_exchange_github.py`.

## Новый порядок приоритетов

| # | ID | Статус | Приоритет | Суть |
|---|----|--------|-----------|------|
| 1 | PR-11 | Открыто | **High** | plaintext `http://` default и дублирование `CONFIG_SERVER_BASE` |
| 2 | PR-05 | Частично закрыто | **Medium** | нет общего baseline security headers |
| 3 | NEW-01 | Частично закрыто | **Medium** | self-update/devtools smoke есть не полностью |
| 4 | PR-06 | Открыто | **Medium** | `require_sha` по default всё ещё `"0"` |
| 5 | PR-04 | Открыто | **Low** | `GET /logout` остаётся рядом с POST API logout |
| 6 | PR-16 | Открыто | **Low** | cleanup WS tokens всё ещё opportunistic |
| 7 | PR-07 | Бэклог | **Low** | frontend/DOM hardening без нового repro |

## Подробности по активным пунктам

### PR-11. Insecure config-server default

**Подтверждено кодом:**
- `app_factory.py` по-прежнему держит default `http://144.31.17.58:8000`.
- `services/config_exchange_github.py` держит тот же default второй раз.
- `devtools/env.py` продолжает подсказывать этот же `http://`-адрес как baseline.

**Почему теперь это пункт №1:**
- это единственный оставшийся `High`, связанный не с техдолгом, а с небезопасным production default;
- проблема точечная и относительно дёшевая в исправлении;
- дублирование в двух местах повышает шанс рассинхрона при следующей правке.

**Что делать:**
- вынести `CONFIG_SERVER_BASE` в один source of truth;
- default сменить на `https://...` или на пустое значение `""` до явной настройки;
- обновить ENV hints, чтобы UI не рекламировал insecure baseline.

### PR-05. Browser security headers

**Что есть сейчас:**
- на Mihomo proxy path выставляются `Referrer-Policy`, `X-Content-Type-Options`, `CSP`;
- на статике есть `X-Content-Type-Options: nosniff`;
- `app_factory.py` в `after_request` всё ещё занимается только cache policy.

**Чего нет:**
- app-wide `X-Frame-Options`;
- app-wide `Permissions-Policy`;
- app-wide `Referrer-Policy` baseline;
- общего security-header hook для всех HTML/API response paths.

**Что делать:**
- добавить общий baseline в `after_request`;
- оставить более строгий CSP/точечные исключения только там, где это реально нужно.

### NEW-01. Smoke coverage на self-update/devtools

**Что уже сделано:**
- добавлен Playwright scaffold и `e2e/smoke.spec.mjs`;
- есть browser smoke на рендер `DevTools` и `update` card;
- есть unit/regression tests: `test_self_update_github_fallback.py`, `test_self_update_security_snapshot.py`, `test_self_update_status_recovery.py`.

**Чего ещё не хватает:**
- автоматизированного сценария, который проходит `load info` и `check update` как связанный поток;
- явной проверки, что `/api/devtools/update/info` и `/api/devtools/update/check` не отдают `500` в штатной среде.

**Что делать:**
- добавить минимальный API smoke на оба endpoint;
- отдельно, если нужно, закрепить browser-клик по `Check` как стабильный e2e сценарий.

### PR-06. Self-update checksum policy

**Подтверждено кодом:**
- `sha_strict` уже по default `"1"`;
- `require_sha` по default всё ещё `"0"`.

**Контекст:**
- панель уже умеет работать с `.sha256`;
- packaging sidecar тоже уже используется на практике;
- update pipeline после последних фиксов стал заметно аккуратнее, поэтому baseline можно ужесточать.

**Что делать:**
- решить, переводим ли `require_sha` в `"1"` по умолчанию;
- если нет, явно задокументировать, почему default остаётся мягким.

### PR-04. GET /logout

**Подтверждено кодом:**
- `GET /logout` остаётся в `routes/auth.py`;
- API logout через `POST /api/auth/logout` уже есть и защищён CSRF.

**Что делать:**
- убрать `GET /logout` совсем;
- либо оставить только безопасный redirect-flow без очистки сессии по GET.

### PR-16. WS token cleanup

**Подтверждено кодом:**
- cleanup просроченных токенов вызывается только opportunistic в `issue_ws_token()` при `len(_WS_TOKENS) > 1024`;
- в `validate_ws_token()` cleanup всё ещё не происходит.

**Что делать:**
- добавить cleanup на validate;
- либо сделать предсказуемый периодический cleanup.

### PR-07. Frontend / DOM hardening

Нового воспроизводимого security repro после последних работ нет. Пункт разумно оставить в бэклоге, а не тянуть наверх “на всякий случай”.

## Что можно снять с повестки

### PR-08. Oversized modules

Пункт закрыт.

Что подтверждает закрытие:
- `run_server.py` сокращён до `143` строк; PTY и websocket bootstrap вынесены в `services/ws_pty.py` и `services/ws_wsgi.py`;
- `mihomo_config_generator.py` сокращён до `138` строк; логика разделена между `services/mihomo_generator_meta.py`, `services/mihomo_generator_providers.py`, `services/mihomo_generator_proxies.py`, `services/mihomo_generator_rules.py`;
- `mihomo_server_core.py` сокращён до `109` строк и стал compatibility-facade над `services/mihomo_runtime.py`, `services/mihomo_proxy_config.py`, `services/mihomo_proxy_parsers.py`;
- contract tests в `tests/test_service_concurrency_contracts.py` фиксируют этот разрез, а целевые Mihomo pytest и Playwright smoke проходят зелёно.

Дальнейшая локальная чистка этих сервисов возможна как обычный maintenance, но держать `PR-08` открытым как аудит-блокер больше не нужно.

### PR-15. API exception detail sanitization

Пункт закрыт.

Что подтверждает закрытие:
- централизованный helper в `routes/common/errors.py`;
- усиленные `test_exception_detail_sanitization.py` и `test_exception_detail_sanitization_contracts.py`;
- дочищены `mihomo`, `xray_configs`, `fs/*`, `remotefs/*` route paths.

Оставшиеся `str(e)` в логах и локальных debug-path не являются основанием держать `PR-15` открытым как API-risk.

### PR-12. Request-size hardening

Пункт закрыт.

Что подтверждает закрытие:
- `install_request_size_guards(app)` подключён в `app_factory.py`;
- в `request_limits.py` есть явный `MAX_CONTENT_LENGTH` и per-route JSON guard;
- `geodat` переведён на `read_uploaded_file_bytes_limited()`;
- есть `test_request_size_limits.py` и `test_request_size_limit_contracts.py`.

Дальнейшее ужесточение лимитов возможно как hardening wave, но это уже не незакрытый аудит-блокер.

## Рекомендуемый порядок работ

1. **PR-11** — убрать insecure default и дублирование `CONFIG_SERVER_BASE`.
2. **PR-05** — добавить app-wide security headers baseline.
3. **NEW-01** — добить self-update smoke на `info/check`.
4. **PR-06** — принять решение по `require_sha=1` как default.
5. **PR-04** — убрать `GET /logout`.
6. **PR-16** — сделать cleanup WS tokens предсказуемым.
7. **PR-07** — держать в бэклоге до нового repro.

## Итог

По сравнению с прошлой версией плана:
- `PR-15`, `PR-12` и `PR-08` переведены в завершённые и больше не должны тянуть приоритетную очередь;
- `NEW-01` тоже переведён в частичный прогресс благодаря Playwright и self-update regression tests;
- новый приоритетный фронт теперь: `PR-11` -> `PR-05` -> `NEW-01` -> `PR-06`.
