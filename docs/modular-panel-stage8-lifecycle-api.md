# Этап 8.4: Lifecycle API

**Статус:** закрыт 6 октября 2026 года  
**Расширение:** full-scope операции подэтапа 8.5 описаны в
`modular-panel-stage8-panel-profile.md`

Lifecycle API связывает подписанный каталог Этапа 8.2 с транзакционным
движком Этапа 8.3. HTTP request только проверяет ввод, строит план и запускает
отдельный `scripts/module_transaction.py`; скачивание, замена файлов, restart,
health check и rollback не выполняются в процессе Flask.

## Маршруты

| Метод | Путь | Успех | Назначение |
| --- | --- | --- | --- |
| GET | `/api/modules/installed` | 200 | Фактически установленные модули и registry state |
| GET | `/api/modules/available` | 200 | Signed catalog установленной версии панели |
| POST | `/api/modules/operations/plan` | 200 | Read-only план и dependency diff |
| POST | `/api/modules/operations/apply` | 202 | Проверка `plan_id` и запуск detached runner |
| GET | `/api/modules/operations/status` | 200 | Текущий/последний status и упорядоченный log |
| POST | `/api/modules/operations/<operation_id>/cancel` | 202 | Безопасный запрос отмены активному runner |
| POST | `/api/modules/recovery` | 200 | Восстановление брошенной операции |
| POST | `/api/modules/restart` | 200 | Явный guarded restart панели |

Командные формы маршрутов: `GET /api/modules/installed`,
`GET /api/modules/available`, `POST /api/modules/operations/plan`,
`POST /api/modules/operations/apply`, `GET /api/modules/operations/status`,
`POST /api/modules/operations/<operation_id>/cancel`,
`POST /api/modules/recovery` и `POST /api/modules/restart`.

Успешные ответы содержат `ok: true` и `Cache-Control: no-store`. JSON body
ограничен 8 KiB, обязан быть объектом и не может содержать поля вне контракта.

## Plan и apply

Module-only plan принимает `install`, `repair` или `remove` и всегда затрагивает
ровно выбранный модуль. Full-scope `panel-update` и `profile-transition`
добавлены в 8.5 и описаны отдельным контрактом. Отсутствующие зависимости,
конфликты, dependants, активное ядро и нехватка места возвращаются как
`applicable: false` с `blockers`; зависимости не устанавливаются автоматически.

Для применимого плана сервер выдаёт `plan_id`: lowercase SHA-256 canonical JSON
полного transaction plan и dependency diff. Apply заново читает installed
state и exact-release catalog, повторно строит план и сравнивает digest. Любое
изменение даёт `module_plan_stale`; клиентские file lists, URL, checksum и
размеры не принимаются.

Версия модуля равна версии установленной панели. Независимой module version в
текущей модели релиза нет, поэтому module-only `update_available` всегда
`false`; версию всей панели меняет `panel-update` из подэтапа 8.5.

## Cancel, recovery и restart

Cancel отправляет `SIGTERM` только когда operation id совпадает с journal и
status, status равен `running`, PID жив и Linux
`/proc/<pid>/cmdline` указывает на `module_transaction.py run` с тем же id.
Linux pidfd удерживает проверенный процесс между чтением cmdline и сигналом,
поэтому повторно использованный PID не может получить отмену. Несовпадающий
или исчезнувший процесс не получает сигнал. Итог отмены
определяет transaction runner: ранняя отмена завершается как interrupted,
после начала mutation выполняется rollback, а защищённый commit может
завершиться штатно.

`POST /api/modules/recovery` отказывается работать при живом runner и вызывает
recovery с `panel_running=True`. Он сохраняет `restart_required`, но никогда не
перезапускает панель сам. `POST /api/modules/restart` сначала проверяет отсутствие
активной module transaction, self-update lock, abandoned journal и
`rollback_failed`, затем перезапускает саму панель через её службу
(`services/panel_service.py`, source `module-lifecycle`).

Перезапуск панели — это всегда init-скрипт панели
(`/opt/etc/init.d/S99xkeen-ui-umarcheh001 restart`), и для
`POST /api/modules/restart`, и для detached runner. `xkeen -restart`
перезапускает только прокси: процесс панели остаётся прежним, а health check
ответил бы старым кодом. Если служба панели не найдена, `apply` отказывает с
`503 panel_restart_unavailable` до любых изменений файлов.

Launcher атомарно захватывает общий с self-update lock до проверки journal и
передаёт владение detached runner без окна unlock. Поэтому два apply или apply
одновременно с panel update не могут создать параллельные транзакции.

## Ошибки

| HTTP | Примеры кодов |
| --- | --- |
| 400 | `invalid_payload`, `module_operation_invalid`, `module_plan_id_invalid` |
| 404 | `module_not_found`, `operation_not_found` |
| 409 | `module_plan_stale`, `operation_in_progress`, `operation_recovery_required` |
| 503 | `catalog_unavailable`, `module_restart_failed`, `panel_restart_unavailable` |
| 500 | `module_lifecycle_failed` без текста внутреннего исключения |

## Ручное восстановление

1. Получить `GET /api/modules/operations/status` и сохранить operation id,
   result, error code и log.
2. Если result остаётся `running`, сначала запросить cancel и дождаться
   терминального status. Не удалять journal и не посылать сигнал PID вручную.
3. Для погибшего runner вызвать `POST /api/modules/recovery`.
4. При `restart_required: true` отдельно вызвать `POST /api/modules/restart`.
5. При `rollback_failed` не накладывать новую установку. Сохранить каталог
   `<panel>.module-transactions`, восстановить недоступный файл или переустановить
   panel archive, затем повторить recovery.

Init/install path остаётся последней линией защиты: перед запуском панели он
также вызывает recovery незавершённой транзакции.
