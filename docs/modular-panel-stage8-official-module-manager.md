# Этап 8: менеджер официальных модулей

**Статус:** подготовка плана, реализация после Этапов 6 и 7<br>
**Дата:** 2 октября 2026 года

Этот документ фиксирует implementation contract для Этапа 8. Полный roadmap
остаётся в [`README-modular-panel-plan.md`](../README-modular-panel-plan.md).

## Решение

Используем GitHub Releases официального репозитория Xkeen UI как immutable
дистрибутив. Один tagged release содержит подписанный `catalog.json`, единый
архив панели и отдельные self-contained архивы модулей. В core вшит публичный
Ed25519-ключ; catalog и archive проверяются до установки.

Это оставляет текущий единый архив пригодным для bootstrap, обновления core,
смены профиля и полного rollback, но позволяет обновлять один модуль без
перезаписи остальных. JSON в репозитории, GitHub Pages, OCI registry и
произвольные repos не входят в MVP.

## Границы ответственности

| Область | Владелец |
| --- | --- |
| Catalog fetch/cache, trust, version comparison | `core` |
| Package transaction, registry, backup, rollback | `core` + внешний supervisor |
| Installed/available modules, plan/apply/status API | `core` |
| Maintenance UI, notifications, operation log | `core` UI |
| Profile transitions | installer + `POST /api/modules/profile` |
| Advanced diagnostics | только опциональные сведения |

Core не должен выполнять установку внутри Flask request thread. Supervisor
должен уметь проверить HTTP health после рестарта и вернуть предыдущий pointer,
если новый payload не запускается.

## Артефакты release

```text
catalog.json
catalog.json.sig
xkeen-ui-panel-<version>.tar.gz
xkeen-module-<module-id>-<version>.tar.gz
```

Минимальная запись каталога:

```json
{
  "id": "tool.files",
  "version": "1.0.0",
  "channel": "stable",
  "panel_api": "1",
  "module_api": "1",
  "min_core": "1.0.0",
  "architectures": ["armv7", "aarch64"],
  "requires": ["core"],
  "conflicts": [],
  "requires_restart": true,
  "archive": "xkeen-module-tool.files-1.0.0.tar.gz",
  "size": 123456,
  "sha256": "...",
  "signing_key_id": "release-2026"
}
```

Внутри архива обязательны `schema_version`, module manifest и path ownership
allow-list. Абсолютные пути, `..`, symlink escape и файлы, принадлежащие core
или другому модулю, являются ошибкой до распаковки.

## Три операции обновления

### Module-only

`GET catalog -> plan -> stage -> verify -> atomic pointer -> registry ->
restart-if-needed -> health -> commit/rollback`.

Операция меняет только `modules/<id>/<version>/`, pointer и registry. Она не
перезаписывает конфигурацию пользователя, другие модули или ядра.

### Panel update

Единый panel archive обновляет core-owned payload. До переключения создаются
backup и snapshot registry. После health-check фиксируется новая версия либо
выполняется полный rollback. Профиль и enabled/disabled state сохраняются.

### Profile transition

Переход профиля может добавить и удалить несколько модулей, поэтому остаётся
транзакцией Этапа 7 с diff, свободным местом, backup и перезапуском. Нельзя
маскировать его как module-only update.

## Уведомления

Core выполняет тихий poll раз в сутки и поддерживает ручную проверку. Последний
успешный каталог кэшируется; offline и stale показываются явно, но не блокируют
панель. Новая или обновлённая версия создаёт локальное уведомление с module id,
версией, размером и требованием restart. `seen/dismissed/snoozed` не позволяют
повторять одно и то же уведомление. Пакет скачивается только после явного
действия пользователя.

## Подэтапы и контрольные точки

1. **8.0 Contracts:** ownership, topology, schema, compatibility и acceptance matrix.
2. **8.1 Artifacts:** deterministic module/panel archives, catalog generation и CI release assets.
3. **8.2 Trust:** allow-list, signatures, key rotation, cache/offline policy.
4. **8.3 Updater:** preflight, safe unpack, backup, atomic switch, supervisor и rollback.
5. **8.4 API:** list/plan/apply/status/cancel/recovery и operation log.
6. **8.5 Panel/profile:** panel archive update и связь с profile transaction.
7. **8.6 UI:** installed/available, update badge, dependency diff, progress и restart.
8. **8.7 Notifications:** daily/manual poll, deduplication и stale/error state.
9. **8.8 Recovery:** failure matrix, legacy migration, stable rollout и rollback runbook.

Каждая контрольная точка должна иметь тесты и ручной recovery сценарий до
перехода к следующей. Marketplace, arbitrary repos, delta updates и scripts
намеренно не входят в критерий MVP.

## Acceptance checklist

- [ ] каталог с неизвестным ключом, изменённым checksum или неподдерживаемым API отклонён;
- [ ] module-only update изменяет только выбранный модуль;
- [ ] panel update сохраняет profile/config/state;
- [ ] profile transition использует отдельный transaction path;
- [ ] crash после restart автоматически возвращает предыдущую версию;
- [ ] offline использует кэш и не блокирует старт;
- [ ] новая версия модуля даёт одно dismissible уведомление;
- [ ] архив с traversal/symlink/script hook не устанавливается;
- [ ] stable release можно воспроизвести из CI и откатить документированной командой.
