# Закрытие этапа 7: Routing Xray — реальный validate

Status: implementation and package ready; real-node retest pending
Updated: 2026-07-16

Этот документ фиксирует приемку этапа 7 из [next-practical-step-plan.md](next-practical-step-plan.md). Кнопка `validate` больше не принимает решение по строковой эвристике клиента: финальный результат приходит от Xray preflight на выбранном Xkeen UI.

## Результат первого device smoke-test

Первый тест 2026-07-16 вернул HTTP `404`, потому что на устройстве был новый APK, а на роутере оставался Xkeen UI из архива, собранного до добавления mobile validate endpoint. Сам draft до Xray preflight не дошёл; изменение только комментария не было причиной ошибки.

Rollout mismatch устранён на уровне поставки и диагностики:

- локальный `xkeen-ui-routing.tar.gz` пересобран и проверен на наличие `POST /api/mobile/v1/xray/routing/validate`;
- Android преобразует `404` именно этого запроса в transport diagnostic `validation_endpoint_unavailable` с явным требованием обновить Xkeen UI;
- fallback на старый `POST /api/routing` намеренно отсутствует, потому что этот endpoint сохраняет конфиг и может перезапустить сервис, то есть нарушает read-only границу этапа 7.

Финальное закрытие требует установить согласованные backend-архив и APK, затем получить server-confirmed `valid: true` или структурированный `valid: false` на реальном узле.

## Граница этапа

Этап добавляет только read-only проверку draft. Он работает во temporary confdir, не сохраняет routing-файл, не создаёт published revision, не синхронизирует DAT symlink assets и не перезапускает `xkeen`; эти persistent actions, revision/conflict handling и серверный preview остаются этапом 8.

| Направление | Контракт |
| --- | --- |
| Android → backend | `POST /api/mobile/v1/xray/routing/validate` с `{ "document": "05_routing.json", "content": "raw JSONC draft" }` |
| Авторизация | Действующие session cookie + `X-CSRF-Token`; используются тот же per-connection auth hook и Keystore material, что в этапе 5 |
| Реальная проверка | Backend разбирает JSON/JSONC и запускает существующий Xray temporary-confdir preflight с подменой только выбранного fragment и `sync_dat_assets = false` |
| Таймаут клиента | Production validate использует отдельный action transport с read timeout `90_000 ms`; обычные read/session timeout не расширены |

Ответ с ошибкой самого draft всё равно имеет HTTP `200` и mobile envelope, чтобы Android не потерял diagnostics в общем transport error path:

```json
{
  "ok": true,
  "data": {
    "valid": false,
    "message": "…",
    "diagnostics": [
      {
        "source": "server",
        "severity": "error",
        "code": "invalid_json",
        "message": "…",
        "path": "05_routing.json",
        "line": 12,
        "column": 8
      }
    ]
  }
}
```

Синтаксический JSON/JSONC error, semantic outbound reference, Xray preflight error и timeout возвращаются как `valid: false` с machine-readable `code`. Некорректный request, oversized body, auth и CSRF остаются обычными HTTP `4xx`; лимит request body совпадает с лимитом routing save. В backend diagnostic дополнительно могут приходить `hint` и `phase`; raw command, stdout и stderr не используются как user-facing fallback.

## Разделение diagnostics

`RoutingValidation` теперь хранит отдельные structured списки, а UI показывает их с источником и severity:

- `localSyntaxIssues` — быстрый conservative JSONC syntax check на устройстве; он помогает до round-trip, но не делает draft валидным или невалидным сам по себе.
- `serverDiagnostics` с `source = Server` — ответ backend/Xray preflight; только положительный server result может перевести draft в `Valid`.
- transport failure использует `source = Transport`, не маскируясь под server validation response.

Каждый diagnostic содержит как минимум `source`, `severity`, `code` и `message`; при наличии backend передаёт `hint`, `phase`, `path`, `line`, `column`. Состояние `Validating` блокирует повторный validate. Если пользователь отредактировал или переключил документ во время round-trip, поздний результат старого текста игнорируется и не может сделать новый draft валидным.

## Lifecycle

```text
Нажатие Validate
  -> local JSONC syntax feedback (informational, отдельный источник)
  -> Validating + repeat guard
  -> authenticated CSRF POST /api/mobile/v1/xray/routing/validate
       ├─ valid: true  -> Valid + server-confirmed message
       ├─ valid: false -> Invalid + structured server diagnostics
       ├─ 401          -> очистить material выбранного connection -> Pair/Login
       ├─ 404          -> validation_endpoint_unavailable -> обновить Xkeen UI на роутере
       └─ offline/timeout/invalid response -> Invalid + Transport diagnostic, без ложного success
```

`preview` больше не запускает бывшую локальную строковую эвристику. На момент закрытия этапа 7 `save/apply` оставались границей этапа 8; с 2026-07-16 этот follow-up реализован через отдельный revision-aware mobile write contract.

## Checklist закрытия

- [x] Backend предоставляет CSRF-protected `POST /api/mobile/v1/xray/routing/validate` и не вызывает save/restart/DAT-asset-sync path.
- [x] Endpoint проверяет только безопасное имя выбранного JSON/JSONC fragment, разбирает raw JSONC draft и использует реальный Xray preflight в temporary confdir.
- [x] Domain-invalid draft возвращает HTTP `200` / `data.valid = false` со structured diagnostics; malformed request, size/auth/CSRF failures не выдают ложный validation result.
- [x] Production Android composition использует `WebPanelRoutingValidationPort`, mobile-v1 endpoint и `90 s` transport, а не demo string heuristic.
- [x] `RoutingValidation` разделяет local syntax, server и transport diagnostics; UI показывает source/severity/code/location/hint в компактной editor surface.
- [x] Validate имеет pending/repeat guard и stale-result guard для изменённого/переключённого draft.
- [x] `401` сохраняет session contract этапа 5: очищается material только выбранного connection и приложение открывает `Pair/Login`.
- [x] Backend contract tests покрывают auth/CSRF, valid JSONC, syntax error, semantic/preflight error, отсутствие persistent write/DAT sync и request size limit.
- [x] Android unit tests покрывают endpoint/payload parsing, structured diagnostics, JSONC local syntax, stale/repeat guard, server result и `401` fallback.
- [x] Android распознаёт `404` отсутствующего validate endpoint как несовместимую версию backend, а не как ошибку JSONC draft.
- [x] Локальный backend-архив пересобран и содержит validate endpoint.
- [x] Обязательная backend и Android verification проходят.
- [ ] Согласованные backend-архив и APK установлены на реальном узле/устройстве, а validate возвращает server-confirmed result без `404`.

## Команды проверки

```powershell
python -m pytest -q tests/test_request_size_limit_contracts.py tests/test_xray_preflight_timeout_payload.py tests/test_mobile_session_contract.py tests/test_mobile_routing_validate_contract.py
python -m ruff check xkeen-ui/routes/mobile.py xkeen-ui/routes/routing/config.py xkeen-ui/services/request_limits.py tests/test_mobile_routing_validate_contract.py tests/test_xray_preflight_timeout_payload.py
cd android-companion
.\gradlew.bat testDebugUnitTest assembleDebug
```

## Минимальная ручная приемка на реальном узле

1. Установить на роутер актуальный `xkeen-ui-routing.tar.gz`, перезапустить Xkeen UI и только затем установить согласованный APK.
2. Открыть существующий Xray fragment с действующей mobile session, изменить JSONC и нажать `validate`: должен появиться pending, затем server-confirmed result без save/restart.
3. Вставить синтаксическую ошибку: увидеть отдельно локальный syntax issue и server `invalid_json` с позицией, если её вернул parser.
4. Сделать semantic ошибку, например сослаться на отсутствующий `outboundTag`: получить Xray diagnostic, а не клиентское предположение о валидности.
5. Во время долгой проверки изменить текст или выбрать другой документ: пришедший позже ответ не должен изменить validation нового draft.
6. Отключить сеть и истечь server session по отдельности: offline/timeout остаётся retryable transport diagnostic, а `401` очищает сессию выбранного узла и переводит в `Pair/Login`.

Ручная приемка дополняет unit/build verification и требует доступного Xkeen-узла с Xray; она не заменяется моками preflight.
