# Этап 5: динамическая frontend-загрузка

**Статус:** закрыт 1 октября 2026 года.

Панель получает серверный allow-listed descriptor в `window.XKeen.pageConfig.frontendModules`. Локальный loader сопоставляет его ключи с фиксированными `import()`-фабриками; persisted state не может задавать browser import path.

`styles.css` и `panel-operator.css` остаются общими compatibility CSS. `xterm.css` принадлежит `terminal-lazy` и добавляется только при загрузке терминала.

`pageConfig.runtime.websocket` сообщает о фактической способности сервера принять WebSocket upgrade. Когда она выключена, журнал операций остаётся на HTTP-поллинге и не пытается открыть `/ws/events`.

## Матрица профилей

| Профиль | Startup bundles | Lazy bundles | Lazy CSS |
| --- | --- | --- | --- |
| `legacy-full` | panel-core, panel-routing, panel-mihomo | terminal-lazy, file-manager-lazy, diagnostics-panel, editor-runtime, editor-codemirror, editor-monaco, editor-diff | xterm |
| `full` | panel-core, panel-routing, panel-mihomo | terminal-lazy, file-manager-lazy, diagnostics-panel, editor-runtime, editor-codemirror, editor-monaco, editor-diff | xterm |
| `xray-minimal` | panel-core, panel-routing | editor-runtime, editor-codemirror | - |
| `mihomo-minimal` | panel-core, panel-mihomo | editor-runtime, editor-codemirror | - |
| `core-only` | panel-core | - | - |

## Проверки

- Python-контракт проверяет descriptor, allow-list, DOM guards, lazy CSS и generated snapshot.
- E2E fixture принимает `XKEEN_E2E_MODULE_PROFILE` (`full`, `xray-minimal`, `mihomo-minimal`, `core-only`) и записывает свой `modules.json` до запуска Flask.
- Browser profile tests наблюдают Network, WebSocket и console, не обращаясь к локальному рабочему стенду разработчика.
