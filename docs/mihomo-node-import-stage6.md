# Mihomo node import — Этап 6: полный candidate, summary и сохранение/применение

**Статус:** закрыт 26 октября 2026 года.

Этап завершает работу из модала без имитации кликов главного toolbar. Один и тот
же подготовленный candidate используется для черновика, save-only и apply.

## Реализовано

- Добавлен единый `buildImportCandidate`: provider/static patch, `proxies`,
  `proxy-providers`, `use`/`groups`, unknown-group diagnostics и текущий
  editor snapshot собираются до действия.
- В модале доступны три действия:
  - **В черновик** — записывает candidate только в главный редактор, отмечает
    его dirty и не пишет файл, не делает backup и не запускает restart;
  - **Сохранить** — вызывает общий `/api/mihomo/import/commit` с явным
    `restart: false`, выполняет YAML + `mihomo -t`, создаёт backup и сохраняет;
  - **Сохранить и применить** — тот же pipeline, затем ставит существующий
    restart job и ждёт фактический результат `/api/restart-job/<id>`.
- Сохраняется `base_revision` активного `config.yaml`. При внешнем изменении
  backend отвечает `409 stale_config`, не валидирует и не перезаписывает файл.
- Save/apply status различает проверку, сохранение, queue/job, успех и partial
  outcome «файл сохранён, применение не удалось». Закрытие модала не отменяет
  server-side job; повторный импорт не требуется.
- Main editor помечается clean только когда его текст не изменился во время
  операции; новые параллельные правки не стираются и остаются dirty.
- Регистрация поддержанных автообновлений отделена от draft: она выполняется
  после успешного save candidate. Ошибка регистрации показывается отдельным
  warning, без повторной вставки и повторного импорта.
- Backend commit перед записью делает syntax validation и внешний `mihomo -t`,
  создаёт backup через существующий runtime helper, а apply использует текущий
  `command_job` restart pipeline.

## Проверки

- Route tests: validation, backup/apply job и stale file revision.
- Playwright: draft/save/apply controls, explicit `restart: false/true`, status
  summary и restart job completion.
- Full Mihomo import lifecycle/layout, unit/contracts, frontend build, static
  verification и inventories выполнены.

## Граница этапа

Автоматический rollback не заявляется: при partial apply показывается состояние
и существующий backup остаётся доступен штатному backup restore. Продвинутый
retry отдельных registration/restart steps и оптимизация остаются отдельными
улучшениями, но основной save/apply-flow v1 завершён.

**Следующий шаг:** Этап 7 — оптимизация и ограниченный рефакторинг.
