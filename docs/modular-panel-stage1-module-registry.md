# Этап 1. Базовый Module Registry

**Статус:** закрыт 29 сентября 2026 года.

Этап 1 добавляет версионируемый реестр официальных модулей и хранение
пользовательского набора включённых модулей. Runtime-gates намеренно ещё не
включены: Blueprint, frontend-бандлы и фоновые задачи продолжают запускаться
как раньше. Их подключение относится к Этапу 3 и следующим этапам.

## Реестр

Источник метаданных находится в
`xkeen-ui/services/module_registry.py`. В реестре зафиксированы:

- стабильный `id`;
- имя и описание;
- версия модуля и `api_version`;
- зависимости и конфликты;
- системные требования и их обнаружение;
- оценка размера в байтах по snapshot Этапа 0;
- `removable`, `can_disable` и `requires_restart`;
- `installed`, `enabled`, `effective_enabled`, `available` и `status`.

В реестр входят:

```text
core
engine.xray
engine.mihomo
tool.editor
tool.terminal
tool.files
tool.backups
integration.happ
tool.advanced-diagnostics
```

`core` нельзя отключить. Отключение зависимости с включёнными зависимыми
модулями отклоняется. При включении модуля его зависимости включаются
автоматически. Это пока только изменение конфигурации; удаления файлов нет.

## Хранение и миграция

Состояние хранится атомарно в:

```text
UI_STATE_DIR/modules.json
```

Текущая схема — `schema_version: 1`:

```json
{
  "schema_version": 1,
  "profile": "legacy-full",
  "restart_required": false,
  "modules": {
    "core": {"enabled": true}
  }
}
```

Отсутствующий файл создаётся как совместимый с прежней установкой
`legacy-full`: все поставляемые модули включены. Поддерживается миграция
предыдущих форм с `schemaVersion`, `active_modules`/`enabled_modules` и
булевыми значениями модулей. Неизвестные поля и неизвестные модули не
переносятся в нормализованное состояние.

## API

Добавлены стабильные endpoints:

```text
GET   /api/modules
GET   /api/modules/<module_id>
PATCH /api/modules/<module_id>              {"enabled": true|false}
POST  /api/modules/<module_id>/enable
POST  /api/modules/<module_id>/disable
```

Операции изменения требуют обычный глобальный auth/CSRF-контур панели,
сохраняют состояние атомарно и возвращают `restart_required`. Сам перезапуск
на Этапе 1 не выполняется.

`effective_module_ids` — результат проверки включённого состояния, зависимостей
и обязательных системных требований. Поле `runtime_gates_active: false`
явно показывает, что этот результат ещё не ограничивает регистрацию текущих
маршрутов и задач.

## Проверка

Контракт покрыт `tests/test_module_registry.py`:

- полный реестр и legacy-default;
- миграция схемы;
- статусы доступности и зависимостей;
- защита `core` и зависимостей;
- атомарно сохраняемые enable/disable операции;
- API list/detail/mutation/error responses;
- синхронность metadata с snapshot
  `docs/modular-panel-stage0-inventory.json`.

Критерий готовности Этапа 1: **выполнен**.

Этапы 2 и 3 закрыты 29 сентября 2026 года.

Следующий этап: **Этап 4 — разделение frontend shell и экранов**.
