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
и сохраняет установленное: набор модулей и editor variant берутся из
`install-profile.json`, положение переключателей и user state не меняются.
`profile-transition` имеет scope `profile`, остаётся на установленной версии
и применяет запрошенный профиль без version transition.

## «Включён» и «установлен»

Это два разных состояния, и меняют их разные действия.

| Действие | Что меняет |
| --- | --- |
| Переключатель модуля (`PATCH /api/modules/<id>`, enable/disable) | только работает ли модуль; файлы остаются |
| `POST /api/modules/profile` | переключатели и запрос физического профиля |
| `PATCH /api/modules/editor` | настройку; запрос физического профиля — только при переходе с `light`, которому не хватает файлов |
| `profile-transition` | файлы на накопителе по запросу профиля |
| `install` / `remove` модуля | файлы одного модуля |
| `panel-update`, `install.sh` без заданного профиля | версию; установленный набор и переключатели сохраняются |

Запрос физического профиля хранится в `modules.json` отдельной записью:

```json
"physical_request": {
  "profile": "xray-minimal",
  "module_ids": ["core", "engine.xray", "tool.editor"],
  "editor_variant": "light"
}
```

Её пишет только явный запрос профиля. Переключатели её не создают и не
меняют. Любая завершённая операция — переход, обновление панели, установка
или удаление модуля — запись стирает: она либо исполнена, либо устарела.

Следствия:

- выключенный модуль ничего не блокирует: доступны перезапуск, операции с
  модулями и обновление панели;
- выключенный модуль обновляется вместе с панелью и остаётся выключенным —
  смеси версий на накопителе не бывает;
- убрать модуль с накопителя можно только явно: `remove`, запрос другого
  профиля с `profile-transition` или `install.sh` с заданным профилем;
- `profile-transition` без запроса отвечает `profile_transition_not_required`,
  как бы ни стояли переключатели.

`install.sh` поверх установленной панели без `XKEEN_UI_INSTALL_PROFILE` и
`XKEEN_UI_INSTALL_MODULES` спрашивает у helper `current`, что установлено
(или запрошено и ещё не применено), и ставит именно это с `--keep-switches`.
Явно заданный профиль исполняется как раньше и выставляет переключатели
по профилю.

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

Пока запрос физического профиля не совпадает с `install-profile.json` и
`module-installed.json`, `POST /api/modules/restart`, проверка и запуск
обновления и операции с модулями возвращают `409 profile_transition_required`.
Оператор должен выполнить plan/apply с `operation: profile-transition`,
дождаться `committed` и только затем считать профиль установленным. Без
запроса и при запросе, совпадающем с установленным, `transition_required`
равен `false`, а `transition_target` — `null`.

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

## Переход профиля — только разница

Релиз при `profile-transition` не меняется, поэтому файл, который уже лежит
на месте, и есть нужный файл. План содержит только разницу:

- `files_add` — пути целевого профиля, которых нет в `install-managed.json`
  или которых нет на накопителе;
- `files_remove` — управляемые пути, не входящие в целевой профиль.

Остальные файлы не перекладываются и не копируются в backup. Место нужно на
архив (если есть что добавлять), добавляемые файлы и копию заменяемых и
удаляемых, с тем же запасом 20 %.

Если добавлять нечего, `archive` в плане равен `null`: сервис строит такой план
по `module-ownership.json` установленной панели (`installed_panel_listing`),
архив не скачивает, а runner не обращается к сети вовсе. Убрать модуль можно
без интернета. Починка испорченных файлов остающихся модулей в переход не
входит — для неё есть `repair`.

## Стоимость проверки и плана

Архив панели — десятки мегабайт после распаковки, а временный каталог роутера
лежит в памяти, поэтому процесс панели архив не распаковывает никогда.

- `POST /api/devtools/update/check` на stable-канале вызывает
  `ModuleLifecycleService.panel_update_check()`: читается только подписанный
  каталог и сравниваются версии. Архив не скачивается ни когда обновление
  есть, ни когда его нет. Свежий каталог запрашивается только при
  `force_refresh`.
- `panel-update` plan сравнивает версии до скачивания: для актуальной панели
  ответ `panel_version_current` обходится одним каталогом.
- План строится по проверенному оглавлению архива (`payload_sizes` и
  `ownership` из `validate_panel_archive`), а не по распакованному дереву.
  `build_panel_update_plan` и `build_profile_transition_plan` принимают
  `target_archive` наравне с `target_panel_root` и дают один и тот же план.
- Проверенный архив лежит в `<update dir>/panel-archive/<sha256>.tar.gz` — на
  накопителе, вне дерева панели. Его читают plan, обе перепроверки в `apply`
  и runner (`--archive-cache`): на одно обновление одно скачивание. Runner
  переносит архив в свой staging и проверяет его заново; повреждённая копия
  заменяется скачиванием.
- Архив не залёживается: его убирают заблокированный plan, отклонённый
  `apply` и любая следующая проверка обновления.

## Коды ошибок 8.5

| Граница | Коды |
| --- | --- |
| Request | `lifecycle_field_required`, `unsupported_lifecycle_fields`, `module_plan_id_invalid` |
| Stable full-scope API | `panel_update_unavailable`, `panel_version_current`, `panel_archive_invalid`, `profile_transition_required`, `profile_transition_not_required`, `profile_payload_unavailable`, `profile_target_invalid`, `operation_free_space` |
| Existing apply/restart | `operation_plan_stale`, `operation_in_progress`, `operation_recovery_required`, `operation_rollback_failed`, `module_restart_failed` |

Внутренние validator diagnostics (`catalog_panel_*`, `panel_archive_*`,
`profile_*`, `archive_*`) сохраняются в тестах и локальных логах, но Lifecycle
API сворачивает их в стабильные full-scope codes выше. Existing catalog,
trust, concurrency, health, cancellation и rollback codes не переименовываются.

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
