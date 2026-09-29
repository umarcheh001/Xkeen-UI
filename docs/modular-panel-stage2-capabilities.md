# Этап 2. Расширение capabilities

**Статус:** закрыт 29 сентября 2026 года.

Этап 2 расширяет существующий `/api/capabilities`, сохраняя прежние ключи и
форматы среды (`runtime`, `terminal`, `files`, `remoteFs`, `storageUsb` и
прочие legacy-поля). В ответ добавлен registry-backed слой для построения
модульного меню и выбора frontend-бандлов.

## Новый контракт

В ответе появились:

```json
{
  "moduleRegistry": {
    "schema_version": 1,
    "api_version": 1,
    "registry_version": "1.0.0",
    "profile": "legacy-full",
    "restart_required": false,
    "runtime_gates_active": false,
    "available": true,
    "reason": null,
    "configured_module_ids": ["core"],
    "effective_module_ids": ["core"]
  },
  "modules": {
    "core": {
      "id": "core",
      "installed": true,
      "enabled": true,
      "available": true,
      "effective_available": true,
      "status": "enabled",
      "reason": null,
      "frontend": {
        "bundles": ["panel-core"],
        "navigation_views": ["xkeen"]
      }
    }
  }
}
```

Для каждого модуля разделены:

- `installed` — модуль поставлен в составе панели;
- `enabled` — сохранённое пользовательское состояние;
- `available` — обязательные системные требования доступны;
- `effective_available` — состояние с учётом зависимостей;
- `status` и `reason` — объяснимый результат (`enabled`, `disabled`,
  `unavailable`, `failed` и т.д.);
- `frontend.bundles` и `frontend.navigation_views` — данные для будущей
  сборки меню и ленивой загрузки.

На момент закрытия Этапа 2 `runtime_gates_active: false` обозначал
configuration-only контракт. Этап 3 закрыт 29 сентября 2026 года и использует
эти данные для backend gates; запущенное приложение теперь возвращает
`runtime_gates_active: true`.

## Реализация

- `xkeen-ui/services/capabilities.py` — registry projection с безопасным
  fallback при недоступном state-файле;
- `xkeen-ui/services/__init__.py` — передача Module Registry в facade;
- `xkeen-ui/routes/capabilities.py` и `xkeen-ui/routes/__init__.py` —
  публикация нового контракта в реальном Flask-приложении;
- `xkeen-ui/services/module_registry.py` — frontend bundle/view metadata;
- `tests/test_module_capabilities.py` — обратная совместимость, статусы,
  fallback и HTTP-контракт.

Если registry временно недоступен, старые capability-поля продолжают
возвращаться, а `moduleRegistry.available` становится `false` с причиной
`module_registry_unavailable`.

## Проверка

Проверено:

- 18 targeted tests для capabilities, registry и shell policy;
- Ruff для изменённых Python-файлов;
- старый capability payload остаётся без изменений;
- полный список модулей и frontend mapping совпадают с Module Registry.

Критерий готовности Этапа 2: **выполнен**.

Этап 3 закрыт 29 сентября 2026 года.

Следующий этап: **Этап 4 — разделение frontend shell и экранов**.
