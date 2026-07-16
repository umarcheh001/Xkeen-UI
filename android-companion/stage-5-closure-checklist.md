# Закрытие этапа 5: реальный Pair/Login и восстановление сессии

Status: completed 2026-07-16
Updated: 2026-07-16

Этот документ фиксирует приемку этапа 5 из [next-practical-step-plan.md](next-practical-step-plan.md). Secure storage, реальный session slice, explicit auth fallback и обязательные проверки выполнены вместе: одного encrypted storage для закрытия этапа недостаточно.

## Граница alpha

В alpha Android использует browser-compatible сессию Xkeen UI: session cookie и CSRF token. Это сознательно не device pairing protocol и не mobile-native token contract.

- Пароль существует только во время `POST` login и не попадает ни в `CompanionUiState` после успеха, ни в persistent storage.
- Cookie и CSRF хранятся только в per-connection encrypted payload с неэкспортируемым ключом Android Keystore.
- Device pairing, refresh-token lifecycle, отзыв отдельных устройств и отдельный mobile-native auth contract остаются за пределами этапа 5.

## Контракт backend

| Endpoint | Назначение | Успешный результат |
| --- | --- | --- |
| `GET /api/mobile/v1/bootstrap` | Проверить setup и текущую server session | `configured`, `authenticated`, `user`, `contract_version` |
| `POST /api/mobile/v1/session` | Выполнить login по JSON `username` / `password` | browser session в `Set-Cookie`, `csrf_token`, `user` |
| `DELETE /api/mobile/v1/session` | Выполнить logout | Требует действующие cookie + CSRF и очищает server session |

Все ответы используют envelope `{ "ok": ..., "data" | "error": ... }` и `Cache-Control: no-store`. Ошибки setup, неверных credentials, rate limit и отсутствующей/истекшей сессии должны оставаться машиночитаемыми и не подменяться HTML-страницей логина.

## Целевой flow

```text
Launching
  ├─ нет выбранного connection ───────────────> Connections
  └─ выбран connection
       ├─ нет / поврежден / untrusted material -> Pair/Login
       └─ loadTrusted(connection.id)
            ├─ bootstrap: authenticated ------> Ready
            ├─ bootstrap: unauthenticated ----> clear material -> Pair/Login
            └─ 401 / 403 / 428 ---------------> clear material -> Pair/Login

Ready + любой authenticated read получает 401
  └─ clear material только выбранного connection -> Pair/Login
```

Оффлайн, timeout и server error не равны expiry: сохраненный material не следует уничтожать только из-за проблем сети. UI показывает понятную retryable ошибку; повторный вход требуется лишь после подтвержденной auth failure или явно невалидного local record.

## Checklist закрытия

- [x] Backend предоставляет versioned `bootstrap`, `login` и `logout` contract в `/api/mobile/v1/*`, совместимый с существующей Flask cookie/CSRF session.
- [x] `MobileSessionPort` использует этот contract; экран вызывает его suspend-методы из coroutine и не содержит `pairDemoDevice` или иной demo bypass.
- [x] Для уже установленных backend-версий, где `/api/mobile/v1/bootstrap` ошибочно закрыт общим auth guard, есть ограниченный compatibility adapter через `/api/auth/status` и CSRF-protected `/api/auth/login`; ошибки `invalid_credentials` не запускают fallback повторно.
- [x] После успешного login сохраняются только cookie и CSRF выбранного `connectionId` с `trustedForRestore = true`; пароль очищается из UI и никогда не сохраняется.
- [x] Trusted record проверяется сервером через bootstrap; только ответ `authenticated = true` переводит `Launching` в `Ready`.
- [x] Logout отправляет cookie и CSRF, а local material выбранного узла очищается даже если server logout завершился сетевой ошибкой.
- [x] `401` из `Ready` переводит пользователя в `Pair/Login`, очищает material выбранного узла и не оставляет UI в ложном `Ready`.
- [x] `SessionMaterialAuthHook` берет material только у выбранного `connectionId` и сверяет normalised `baseUrl`; два connection с одинаковым `baseUrl` не могут обменяться cookie/CSRF.
- [x] Есть backend contract tests для bootstrap, login, CSRF-protected logout, setup и invalid-credential ошибок; добавлены Android unit tests для login, restore, logout, 401 и isolation одинакового `baseUrl`.
- [x] При cold start с выбранным узлом, но без `loadTrusted()`-record (включая очищенный damaged/Keystore record), `Launching` сразу открывает `Pair/Login`; отсутствие выбранного узла по-прежнему открывает `Connections`.
- [x] Обязательная verification проходит полностью: на 2026-07-16 backend contract suite завершилась с `3 passed`, а `testDebugUnitTest assembleDebug` — успешно.

Этап 5 закрыт после повторного запуска обязательных проверок:

```powershell
python -m pytest -q tests/test_mobile_session_contract.py
cd android-companion
.\gradlew.bat testDebugUnitTest assembleDebug
```

## Минимальная ручная приемка

1. Новый или выбранный узел без trusted material открывает `Pair/Login`; без выбранного узла открывается `Connections`.
2. Валидные credentials дают `Ready`; после force stop/cold start серверный bootstrap восстанавливает `Ready` без ввода пароля.
3. Удаление cookie на сервере или expiry переводит приложение в `Pair/Login`, удаляет только material этого узла и сохраняет material другого узла, даже при одинаковом `baseUrl`.
4. `401` при обновлении dashboard или Routing из `Ready` выполняет тот же явный переход в `Pair/Login`.
5. Logout очищает local record независимо от доступности узла; после возврата в сеть старая локальная session не используется.
6. Узел с `200` на `/api/auth/status` и `401 unauthorized` на анонимном `/api/mobile/v1/bootstrap` автоматически использует совместимый вход без отдельной кнопки проверки и без перехода в браузер.
