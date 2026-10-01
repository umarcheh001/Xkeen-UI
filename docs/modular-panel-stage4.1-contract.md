# Этап 4.1. Контракт границ shell, экранов и модальных окон

Статус: **закрыт 29 сентября 2026 года**.

Документ фиксирует границы до начала физического переноса разметки. На этом этапе `panel.html` остаётся монолитным baseline; следующие подэтапы будут переносить его блоки в partials без изменения DOM/API-контрактов.

## Артефакты и baseline

- исходный шаблон: `xkeen-ui/templates/panel.html`;
- Stage 0 inventory: `docs/modular-panel-stage0-inventory.json`;
- machine-readable contract: `docs/modular-panel-stage4.1-contract.json`;
- пересборка: `python .\scripts\generate_modular_panel_stage4_1_contract.py --root .`;
- UTF-8 размер: `423795` байт;
- строк: `5636`;
- статических `id`: `1341`, дубликатов: `0`;
- SHA-256 текущего baseline: `80caab6acb438cc84fd99a6ee7952875591cb6de8fca471025ce059def7ce71c`.

## Правила composition

- `panel.html` остаётся совместимой точкой входа и composition root.
- DOM id, data-view, data-xk-section, data-xk-shell и modal data-* считаются замороженным контрактом.
- screen и modal partials получают только используемые значения page_context.
- разметка отключённого модуля отсутствует в серверном initial HTML.
- загрузка frontend-бандлов и import() остаются задачей Этапа 5.

Порядок рендера:

```text
head → startup → header → navigation → global_controls → screens → modals
```

## Shell boundaries

| Область | Владелец | Целевой partial | Якорь, строка | DOM-контракт |
| --- | --- | --- | --- | --- |
| head | core | xkeen-ui/templates/panel/head.html | 3 | `xk-terminal-theme-link`, `xk-panel-operator-paint-guard` |
| page_config | core | xkeen-ui/templates/panel/page_config.html | 12 | `window.XKeen.pageConfig`, `var pageConfig` |
| startup | core | xkeen-ui/templates/panel/shell.html | 74 | `global-xkeen-spinner`, `xk-panel-operator-paint-guard`, `xk-panel-operator-pending` |
| header | core | xkeen-ui/templates/panel/header.html | 95 | `xk-brand-logo`, `xkeen-service-lamp`, `xkeen-service-text`, `xkeen-core-text`, `xray-logs-badge` |
| navigation | core | xkeen-ui/templates/panel/navigation.html | 251 | `data-view=routing`, `data-view=mihomo`, `data-view=xkeen`, `data-view=xray-logs`, `data-view=commands` |
| global_controls | core | xkeen-ui/templates/panel/shell.html | 286 | `xkeen-start-btn`, `xkeen-stop-btn`, `xkeen-restart-btn`, `global-autorestart-xkeen`, `routing-focus-switch` |

## Screen boundaries

| Screen | Владелец | Целевой partial | Корень | Frontend roots | API groups |
| --- | --- | --- | --- | --- | --- |
| routing | engine.xray | xkeen-ui/templates/panel/screens/routing.html | `#view-routing` / 473 | panel-routing | /api/routing/*, /api/xray/*, /api/dns/* |
| mihomo | engine.mihomo | xkeen-ui/templates/panel/screens/mihomo.html | `#view-mihomo` / 1174 | panel-mihomo | /api/mihomo/*, /api/mihomo/clash/* |
| xkeen | core | xkeen-ui/templates/panel/screens/xkeen.html | `#view-xkeen` / 1907 | panel-core | /api/service/*, /api/cores/*, /api/settings/* |
| xray-logs | engine.xray | xkeen-ui/templates/panel/screens/xray_logs.html | `#view-xray-logs` / 2357 | panel-core, panel-routing | /api/xray/logs, /api/xray/* |
| commands | tool.terminal | xkeen-ui/templates/panel/screens/commands.html | `#view-commands` / 2024 | panel-core, terminal-lazy | /api/run-command, /api/command-jobs/*, /ws/* |
| files | tool.files | xkeen-ui/templates/panel/screens/files.html | `#view-files` / 2262 | panel-core, file-manager-lazy | /api/fs/*, /api/fileops/*, /api/remotefs/* |

Все дочерние `id`, `data-*`, `aria-*` и trigger selectors screen должны сохраниться при переносе. `mihomo_generator.html` не входит в эту таблицу: это отдельная canonical page с собственным entrypoint.

## Modal boundaries

В таблице отдельно показаны текущая классификация inventory и целевой владелец. Это позволяет безопасно исправить историческую классификацию file-manager/SSH modal, не теряя baseline Stage 0.

| Modal id | Inventory | Целевой владелец | Boundary | Целевой partial | Строка |
| --- | --- | --- | --- | --- | --- |
| xk-resource-dashboard-modal | tool.advanced-diagnostics | tool.advanced-diagnostics | owned | xkeen-ui/templates/panel/modals/diagnostics.html | 313 |
| xray-context-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 2478 |
| xray-devices-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 2495 |
| routing-dns-over-vless-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 2519 |
| inbounds-apply-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 2803 |
| routing-balancer-help-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 2851 |
| xray-snapshot-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3016 |
| routing-template-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3047 |
| routing-template-save-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3100 |
| routing-template-edit-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3136 |
| outbounds-generator-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3190 |
| outbounds-pool-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3458 |
| routing-dat-contents-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3557 |
| terminal-history-modal | tool.terminal | tool.terminal | owned | xkeen-ui/templates/panel/modals/commands.html | 3802 |
| ssh-modal | core | tool.terminal | mixed-current-classification | xkeen-ui/templates/panel/modals/commands.html | 3823 |
| ssh-edit-modal | core | tool.terminal | mixed-current-classification | xkeen-ui/templates/panel/modals/commands.html | 3855 |
| ssh-confirm-modal | core | tool.terminal | mixed-current-classification | xkeen-ui/templates/panel/modals/commands.html | 3896 |
| ssh-transfer-modal | core | tool.terminal | mixed-current-classification | xkeen-ui/templates/panel/modals/commands.html | 3912 |
| core-modal | core | core | shared | xkeen-ui/templates/panel/modals/shared.html | 3936 |
| confirm-modal | core | core | shared | xkeen-ui/templates/panel/modals/shared.html | 3996 |
| github-export-modal | core | core | shared | xkeen-ui/templates/panel/modals/shared.html | 4012 |
| github-catalog-modal | core | core | shared | xkeen-ui/templates/panel/modals/shared.html | 4031 |
| donate-modal | core | core | shared | xkeen-ui/templates/panel/modals/shared.html | 4058 |
| ui-settings-modal | core | core | shared | xkeen-ui/templates/panel/modals/shared.html | 4114 |
| mihomo-dns-modal | engine.mihomo | engine.mihomo | owned | xkeen-ui/templates/panel/modals/mihomo.html | 4136 |
| mihomo-import-modal | engine.mihomo | engine.mihomo | owned | xkeen-ui/templates/panel/modals/mihomo.html | 4288 |
| mihomo-proxy-tools-modal | engine.mihomo | engine.mihomo | owned | xkeen-ui/templates/panel/modals/mihomo.html | 4410 |
| mihomo-validation-modal | engine.mihomo | engine.mihomo | owned | xkeen-ui/templates/panel/modals/mihomo.html | 4552 |
| mihomo-hwid-modal | integration.happ | integration.happ | owned | xkeen-ui/templates/panel/modals/happ.html | 4621 |
| fm-upload-conflict-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 4749 |
| fm-connect-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 4770 |
| fm-knownhosts-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 4868 |
| fm-create-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 4899 |
| fm-rename-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 4936 |
| fm-archive-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 4961 |
| fm-extract-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5000 |
| fm-folder-picker-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5057 |
| fm-archive-list-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5081 |
| fm-mask-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5117 |
| fm-props-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5141 |
| fm-hash-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5160 |
| fm-chmod-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5192 |
| fm-chown-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5245 |
| fm-dropop-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5278 |
| fm-conflicts-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5298 |
| fm-bookmarks-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5325 |
| fm-download-multi-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5353 |
| fm-progress-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5393 |
| fm-ops-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5414 |
| fm-volumes-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5445 |
| fm-help-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5467 |
| fm-editor-modal | tool.editor | tool.editor | owned | xkeen-ui/templates/panel/modals/editor.html | 5535 |
| json-editor-modal | tool.editor | tool.editor | owned | xkeen-ui/templates/panel/modals/editor.html | 5574 |

## Mixed boundaries и решения

### `navigation`

- текущая область: `xkeen-ui/templates/panel.html`;
- владельцы: `core`, `engine.xray`, `engine.mihomo`, `tool.terminal`, `tool.files`;
- решение: Core owns the navigation shell; individual buttons and sections are gated by their module owner.

### `global-controls`

- текущая область: `xkeen-ui/templates/panel.html`;
- владельцы: `core`, `engine.xray`;
- решение: Keep service controls in core shell; keep routing-focus markup as an engine.xray-owned slot.

### `routing-editor`

- текущая область: `#view-routing`;
- владельцы: `engine.xray`, `tool.editor`;
- решение: The screen belongs to engine.xray; editor widgets and schemas are delegated to tool.editor.

### `mihomo-editor`

- текущая область: `#view-mihomo and Mihomo modals`;
- владельцы: `engine.mihomo`, `tool.editor`;
- решение: The screen belongs to engine.mihomo; editor widgets and schemas are delegated to tool.editor.

### `mihomo-hwid`

- текущая область: `#mihomo-hwid-modal`;
- владельцы: `engine.mihomo`, `integration.happ`;
- решение: Happ-specific markup is integration.happ-owned and requires engine.mihomo at runtime.

### `file-editor`

- текущая область: `#fm-editor-modal`;
- владельцы: `tool.files`, `tool.editor`;
- решение: File manager owns the workflow; editor markup is a separate tool.editor modal partial.

### `ssh-file-manager`

- текущая область: `SSH and file-manager modals`;
- владельцы: `tool.terminal`, `tool.files`;
- решение: SSH belongs to tool.terminal; file operations belong to tool.files, despite the current inventory fallback to core.

## Profile baseline

| Профиль | Active modules | Ожидаемые screens | Запрещённые screens | Разрешено modal | Запрещено modal |
| --- | --- | --- | --- | --- | --- |
| legacy-full | core, engine.xray, engine.mihomo, tool.editor, tool.terminal, tool.files, tool.backups, integration.happ, tool.advanced-diagnostics | routing, mihomo, xkeen, xray-logs, commands, files | — | 53 | 0 |
| full | core, engine.xray, engine.mihomo, tool.editor, tool.terminal, tool.files, tool.backups, integration.happ, tool.advanced-diagnostics | routing, mihomo, xkeen, xray-logs, commands, files | — | 53 | 0 |
| xray-minimal | core, tool.editor, engine.xray | routing, xkeen, xray-logs | mihomo, commands, files | 20 | 33 |
| mihomo-minimal | core, tool.editor, engine.mihomo | mihomo, xkeen | routing, xray-logs, commands, files | 12 | 41 |

## Критерий завершения Этапа 4.1

Критерий готовности **выполнен**:

- для каждого screen определены `module_id`, partial, root id, frontend roots и API groups;
- для каждого modal определены текущая классификация, целевой владелец, partial и DOM-контракт;
- shell, navigation и mixed-boundaries имеют явные решения;
- зафиксированы профили `legacy-full`, `full`, `xray-minimal` и `mihomo-minimal`;
- baseline защищён генератором и тестом синхронности.

Физическое создание partials и перенос markup относятся к подэтапу 4.2 и последующим.
