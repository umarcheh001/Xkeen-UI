# Этап 8.5: Panel update и profile transition

**Статус:** закрыт 7 октября 2026 года  
**Следующий подэтап:** 8.6, UI менеджера

Подэтап 8.5 расширяет Lifecycle API двумя full-scope операциями. Обновление
панели устанавливает строго более новый подписанный panel archive, а переход
профиля материализует уже сохранённый registry state из архива текущей версии.
Обе операции выполняет detached `scripts/module_transaction.py`; Flask только
строит authoritative plan и запускает runner.

## Panel archive и границы владения

Signed `catalog.json` содержит обязательный объект `panel` с полями `archive`,
`size`, `sha256`, `version`, `signing_key_id` и `architectures`. Клиент
скачивает архив только с immutable official release URL и проверяет размер и
SHA-256 до распаковки. Валидатор принимает один корень `xkeen-ui/`, только
directory/regular-file entries и точную `module-ownership.json`.

Panel archive не может содержать mutable user state: `modules.json`,
`install-profile.json`, `module-installed.json`, `secret.key`, `var/`, `bin/`,
конфигурации ядер и declared Mihomo paths. Shell hooks не исполняются.

## Plan и apply

Для full-scope запросов `module_id` запрещён. Сначала клиент показывает
read-only plan, затем передаёт обратно только server-generated `plan_id`.

Panel update:

```json
{"operation": "panel-update"}
```

Profile transition:

```json
{"operation": "profile-transition"}
```

Оба тела отправляются в `POST /api/modules/operations/plan`. Применение:

```json
{
  "operation": "panel-update",
  "plan_id": "<64 lowercase hex characters>"
}
```

Ответ plan содержит `scope`, `source_version`, `target_version`,
`target_profile`, `affected_module_ids`, `files_add`, `files_remove`,
`required_free_bytes`, `restart_required`, `installed_after`, `blockers`,
`applicable` и `plan_id`. Apply заново получает trusted catalog, проверяет
panel archive и строит тот же plan. Изменение версии, профиля, ownership или
physical install state возвращает `operation_plan_stale`.

`panel-update` имеет scope `panel`, требует `target_version > source_version`
и сохраняет текущий profile, Custom module set, editor variant и user state.
`profile-transition` имеет scope `profile`, требует архив ровно установленной
версии и применяет желаемый профиль без version transition.

## Pending profile

`POST /api/modules/profile` по-прежнему сохраняет желаемый registry state, но
теперь дополнительно возвращает:

```json
{
  "transition_required": true,
  "transition_target": {
    "profile": "xray-minimal",
    "module_ids": ["core", "engine.xray", "tool.editor"],
    "editor_variant": "light"
  }
}
```

Пока desired registry state не совпадает с `install-profile.json`,
`module-installed.json` и физическим payload, `POST /api/modules/restart`
возвращает `409 profile_transition_required`. Оператор должен выполнить
plan/apply с `operation: profile-transition`, дождаться `committed` и только
затем считать профиль установленным.

## Status, cancel и recovery

`GET /api/modules/operations/status` одинаков для scope `module`, `panel` и
`profile`. Нормальная последовательность full-scope runner:
`prepared -> downloading -> verifying -> applying -> state -> restarting ->
health -> committed`. При ошибке после mutation появляется `rolling_back`, а
результат становится `rolled_back` или `rollback_failed`.

Cancel через `POST /api/modules/operations/<operation_id>/cancel` проверяет
operation id, journal, status и точный live runner до SIGTERM. До `applying`
операция завершается без изменения панели; после начала mutation runner
откатывает весь свой scope. После успешного health check cancel уже не может
отменить commit.

Boot recovery вызывается init/install path до запуска панели. Для
`prepared`/`downloading`/`verifying` он удаляет незадействованный journal; для
`applying` и более поздних незавершённых шагов возвращает все изменённые
файлы и state. HTTP `POST /api/modules/recovery` не перезапускает работающую
панель сам и сообщает `restart_required`, когда после rollback нужен restart.

## Rollback scopes

| Scope | Что возвращается |
| --- | --- |
| `module` | Только файлы выбранного модуля и transaction state |
| `panel` | Все заменённые managed-файлы текущего профиля, BUILD и state |
| `profile` | Все добавленные/удалённые managed-файлы профиля и state |

Legacy DevTools rollback не является rollback транзакции: он работает с
историческим full-panel backup. Stable DevTools check/run/status делегируются
`ModuleLifecycleService` как `panel-update`; channel `main` сохраняет прежний
branch updater и явно возвращает `development_only: true`.

## Коды ошибок 8.5

| Граница | Коды |
| --- | --- |
| Request | `lifecycle_field_required`, `unsupported_lifecycle_fields`, `module_plan_id_invalid` |
| Panel descriptor | `catalog_panel_required_field`, `catalog_panel_field_unknown`, `catalog_panel_version_mismatch`, `catalog_panel_archive_not_filename`, `catalog_panel_size_invalid`, `catalog_panel_sha256_invalid`, `catalog_panel_architectures_invalid`, `catalog_panel_signing_key_invalid`, `catalog_signing_key_unknown`, `catalog_signing_key_mismatch` |
| Catalog asset | `catalog_panel_not_object`, `catalog_archive_unavailable`, `catalog_archive_size_mismatch`, `catalog_archive_checksum_mismatch` |
| Panel archive | `panel_archive_missing`, `panel_archive_size_mismatch`, `panel_archive_checksum_mismatch`, `panel_archive_path_unsafe`, `panel_archive_member_duplicate`, `panel_archive_root_invalid`, `panel_archive_member_type_forbidden`, `panel_archive_user_path_forbidden`, `panel_archive_expanded_too_large`, `panel_archive_ownership_missing`, `panel_archive_ownership_invalid`, `panel_archive_ownership_mismatch`, `panel_archive_invalid` |
| State/planning | `panel_version_unsupported`, `module_state_unavailable`, `module_ownership_unavailable`, `profile_state_unavailable`, `profile_installed_state_unavailable`, `profile_ownership_unavailable`, `panel_update_not_newer`, `profile_release_mismatch`, `profile_transition_not_required`, `profile_unknown`, `profile_modules_forbidden`, `profile_modules_invalid`, `profile_dependency_missing`, `profile_module_conflict`, `profile_editor_variant_invalid`, `module_free_space` |
| Runner verification | `operation_plan_stale`, `module_version_mismatch`, `module_ownership_conflict`, `archive_path_unsafe`, `archive_link_forbidden`, `archive_invalid`, `archive_member_missing` |
| Apply/restart | `operation_in_progress`, `operation_recovery_required`, `operation_rollback_failed`, `profile_transition_required`, `module_restart_failed` |

Compatibility/catalog errors сохраняют правила HTTP Lifecycle API: invalid
request получает 400, несовместимый или stale plan — 409, trust/transport
failure — 503. Внешний ответ не содержит traceback или внутренний exception.

## Ручное восстановление

1. Сохранить ответ `GET /api/modules/operations/status`, особенно
   `operation_id`, `scope`, `step`, `result`, `error_code`, `failed_path` и log.
2. При живом `running` запросить cancel и дождаться terminal result. Не удалять
   journal и не посылать сигнал PID вручную.
3. Для погибшего runner вызвать `POST /api/modules/recovery`. Если ответ
   содержит `restart_required: true`, отдельно вызвать
   `POST /api/modules/restart`.
4. При `rollback_failed` не запускать новую module/panel/profile операцию.
   Сохранить `<panel>.module-transactions`, восстановить указанный
   `failed_path` из backup либо переустановить проверенный panel archive и
   повторить recovery.
5. Командная граница для среды без HTTP:
   `python scripts/module_transaction.py recover --panel-root <panel> --state-dir <panel>`.
   Она выполняется только при остановленном runner; boot path вызывает её
   автоматически.

Операция считается завершённой только при `result: committed`. `rolled_back`
означает, что прежнее дерево восстановлено; `rollback_failed` требует ручного
вмешательства и блокирует новые операции.
