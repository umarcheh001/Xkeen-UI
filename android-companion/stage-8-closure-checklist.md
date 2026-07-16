# Закрытие этапа 8: Routing Xray — save/apply и conflict handling

Status: implementation verified; real-node smoke-test pending
Updated: 2026-07-16

Этот документ фиксирует приемку этапа 8 из [next-practical-step-plan.md](next-practical-step-plan.md). Routing write больше не моделируется локально: server draft, published document, revision conflicts, file write и restart принадлежат backend.

## Контракт

| Операция | Endpoint | Гарантия |
| --- | --- | --- |
| Load | `GET /api/mobile/v1/xray/routing/document?document=...` | Один snapshot возвращает раздельные published/saved content, SHA-256 revisions, timestamps и conflict metadata |
| Validate | `POST /api/mobile/v1/xray/routing/validate` | Read-only Xray preflight без persistent write/restart |
| Save | `POST /api/mobile/v1/xray/routing/save` | Проверяет обе expected revisions и raw JSONC; preflight + app-private server draft, без изменения live fragment |
| Apply | `POST /api/mobile/v1/xray/routing/apply` | Применяет exact saved revision; preflight + backup + atomic clean JSON/JSONC write + confirmed restart |

Все mutating endpoints требуют действующую session cookie и `X-CSRF-Token`. `published_revision` защищает от внешнего изменения live fragment; `saved_revision` — от перезаписи более нового draft другим клиентом.

## State machine

```text
Load document
  -> published revision P + saved revision S

Validate local text
  -> Valid
  -> Save(P, S, content)
       ├─ revisions match -> preflight -> private server draft S2 -> backend snapshot
       ├─ external live edit -> 409 published_revision_conflict + current snapshot
       └─ newer server draft -> 409 saved_revision_conflict + current snapshot

Apply(P, S2)
  ├─ saved base == published -> preflight -> backup -> atomic write -> restart confirmed
  │    -> published P2, saved P2, no server draft -> backend snapshot
  ├─ published changed since save -> 409 saved_published_conflict
  └─ restart failed -> restore previous files, keep server draft, return failure
```

Android хранит отдельный `RoutingWritePhase` (`Idle`, `Saving`, `Applying`, `Success`, `Failure`, `Conflict`). `Conflict` не переводит документ в общую validation error: UI показывает code/message и сохраняет локальный editor text. Apply заблокирован, пока конфликт не разрешён новой загрузкой/редактированием/validate/save.

Если пользователь меняет текст во время `save/apply`, backend result всё равно обновляет только server metadata, а новый локальный text остаётся `Dirty`; поздний ответ не выдаёт новый текст за проверенный или сохранённый.

## Failure semantics

- `401` очищает trusted material выбранного connection и возвращает в `Pair/Login`.
- `403/428`, offline, timeout и malformed response не создают локальный success.
- `404` write/document endpoint означает rollout mismatch: нужно обновить Xkeen UI на роутере вместе с APK.
- `409` — отдельный revision conflict с актуальным server snapshot.
- `422` — server syntax/preflight rejection; live fragment и runtime не меняются.
- Failed restart восстанавливает прежние live JSON/JSONC files и оставляет saved draft для повторной попытки.

## Checklist

- [x] Load возвращает published/saved states и opaque SHA-256 revision tokens.
- [x] Save хранит draft отдельно и не пишет live Xray fragment, не вызывает restart и не выдаёт local-only success.
- [x] Apply использует exact saved revision, повторяет preflight, создаёт backup и ждёт подтверждения restart.
- [x] External update, stale saved draft и saved/published mismatch возвращают разные HTTP `409` codes.
- [x] Restart failure восстанавливает прежние файлы и сохраняет draft.
- [x] Production Android использует `WebPanelRoutingWritePort`; backend response — единственный источник published/saved state после write.
- [x] Pending/repeat/stale-editor guards реализованы для save/apply.
- [x] Conflict показывается отдельно от validation diagnostics.
- [x] Backend tests покрывают persistence boundary, conflicts, auth/CSRF и rollback.
- [x] Android tests покрывают endpoint payload/parsing, typed conflict и server-authoritative controller updates.
- [x] Полный Android unit suite и backend verification проходят.
- [ ] На реальном узле установлен согласованный backend archive и APK; выполнен smoke-test save/apply/conflict.

## Команды проверки

```powershell
python -m pytest -q tests/test_mobile_routing_write_contract.py tests/test_mobile_routing_validate_contract.py tests/test_mobile_session_contract.py tests/test_request_size_limit_contracts.py
python -m ruff check xkeen-ui/services/mobile_routing.py xkeen-ui/routes/mobile.py xkeen-ui/services/request_limits.py tests/test_mobile_routing_write_contract.py
cd android-companion
.\gradlew.bat testDebugUnitTest assembleDebug
```

## Минимальная device-приемка

1. Одновременно установить backend archive этапа 8 и согласованный APK.
2. Открыть существующий fragment и убедиться, что отображается hash revision.
3. Изменить JSONC, выполнить validate и save: UI показывает server saved draft, Xray не перезапускается.
4. Нажать apply и подтвердить: UI принимает новую published revision только после server-confirmed restart.
5. Сохранить новый draft, затем изменить live fragment из web/SSH: mobile apply должен показать `Conflict`, не перезаписав внешний edit.
6. С двумя клиентами сохранить разные drafts от одной saved revision: второй stale write должен получить `saved_revision_conflict`.
