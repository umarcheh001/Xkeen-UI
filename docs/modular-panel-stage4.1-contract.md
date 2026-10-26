# Этап 4.1. Контракт границ shell, экранов и модальных окон

Статус: **закрыт 29 сентября 2026 года**.

Документ был создан до физического переноса разметки и теперь остаётся актуальным contract source для composed document. Исторический монолит сохранён в baseline Этапа 3R.1, а `panel.html` работает как thin composition root.

## Артефакты и baseline

- исходный шаблон: `xkeen-ui/templates/panel.html`;
- роль entrypoint: thin composition root; screen и modal markup принадлежат partials;
- Stage 0 inventory: `docs/modular-panel-stage0-inventory.json`;
- machine-readable contract: `docs/modular-panel-stage4.1-contract.json`;
- пересборка: `python .\scripts\generate_modular_panel_stage4_1_contract.py --root .`;
- UTF-8 размер: `450722` байт;
- строк: `5849`;
- статических `id`: `1385`, дубликатов: `0`;
- SHA-256 текущего baseline: `9802e490212d79a34865a04aae064f84dfdc3fe747c11a5358d2092164265e8a`.

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
| head | core | xkeen-ui/templates/panel/head.html | 3 | `xk-panel-operator-paint-guard` |
| page_config | core | xkeen-ui/templates/panel/page_config.html | 12 | `window.XKeen.pageConfig`, `var pageConfig` |
| startup | core | xkeen-ui/templates/panel/shell.html | 75 | `global-xkeen-spinner`, `xk-panel-operator-paint-guard`, `xk-panel-operator-pending` |
| header | core | xkeen-ui/templates/panel/header.html | 96 | `xk-brand-logo`, `xkeen-service-lamp`, `xkeen-service-text`, `xkeen-core-text`, `xray-logs-badge` |
| navigation | core | xkeen-ui/templates/panel/navigation.html | 292 | `data-view=routing`, `data-view=mihomo`, `data-view=xkeen`, `data-view=xray-logs`, `data-view=commands` |
| global_controls | core | xkeen-ui/templates/panel/shell.html | 320 | `xkeen-start-btn`, `xkeen-stop-btn`, `xkeen-restart-btn`, `global-autorestart-xkeen` |

## Screen boundaries

| Screen | Владелец | Целевой partial | Корень | Frontend roots | API groups |
| --- | --- | --- | --- | --- | --- |
| routing | engine.xray | xkeen-ui/templates/panel/screens/routing.html | `#view-routing` / 557 | panel-routing | /api/routing/*, /api/xray/*, /api/dns/* |
| mihomo | engine.mihomo | xkeen-ui/templates/panel/screens/mihomo.html | `#view-mihomo` / 1282 | panel-mihomo | /api/mihomo/*, /api/mihomo/clash/* |
| xkeen | core | xkeen-ui/templates/panel/screens/xkeen.html | `#view-xkeen` / 2041 | panel-core | /api/service/*, /api/cores/*, /api/settings/* |
| xray-logs | engine.xray | xkeen-ui/templates/panel/screens/xray_logs.html | `#view-xray-logs` / 2523 | panel-core, panel-routing | /api/xray/logs, /api/xray/* |
| commands | tool.terminal | xkeen-ui/templates/panel/screens/commands.html | `#view-commands` / 2170 | panel-core, terminal-lazy | /api/run-command, /api/command-jobs/*, /ws/pty |
| files | tool.files | xkeen-ui/templates/panel/screens/files.html | `#view-files` / 2431 | panel-core, file-manager-lazy | /api/fs/*, /api/fileops/*, /api/remotefs/* |

Все дочерние `id`, `data-*`, `aria-*` и trigger selectors screen должны сохраниться при переносе. `mihomo_generator.html` не входит в эту таблицу: это отдельная canonical page с собственным entrypoint.

## Modal boundaries

В таблице отдельно показаны текущая классификация inventory и целевой владелец. Это позволяет безопасно исправить историческую классификацию file-manager/SSH modal, не теряя baseline Stage 0.

| Modal id | Inventory | Целевой владелец | Boundary | Целевой partial | Строка |
| --- | --- | --- | --- | --- | --- |
| xk-resource-dashboard-modal | tool.advanced-diagnostics | tool.advanced-diagnostics | owned | xkeen-ui/templates/panel/modals/diagnostics.html | 343 |
| xray-context-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 2664 |
| xray-devices-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 2681 |
| routing-dns-over-vless-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 2705 |
| inbounds-apply-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 2991 |
| routing-balancer-help-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3039 |
| xray-snapshot-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3204 |
| routing-template-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3235 |
| routing-template-save-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3288 |
| routing-template-edit-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3324 |
| outbounds-generator-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3378 |
| outbounds-pool-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3646 |
| routing-dat-contents-modal | engine.xray | engine.xray | owned | xkeen-ui/templates/panel/modals/routing.html | 3745 |
| terminal-history-modal | tool.terminal | tool.terminal | owned | xkeen-ui/templates/panel/modals/commands.html | 3988 |
| ssh-modal | core | tool.terminal | mixed-current-classification | xkeen-ui/templates/panel/modals/commands.html | 4009 |
| ssh-edit-modal | core | tool.terminal | mixed-current-classification | xkeen-ui/templates/panel/modals/commands.html | 4041 |
| ssh-confirm-modal | core | tool.terminal | mixed-current-classification | xkeen-ui/templates/panel/modals/commands.html | 4082 |
| ssh-transfer-modal | core | tool.terminal | mixed-current-classification | xkeen-ui/templates/panel/modals/commands.html | 4098 |
| core-modal | core | core | shared | xkeen-ui/templates/panel/modals/shared.html | 4120 |
| confirm-modal | core | core | shared | xkeen-ui/templates/panel/modals/shared.html | 4188 |
| github-export-modal | core | core | shared | xkeen-ui/templates/panel/modals/shared.html | 4204 |
| github-catalog-modal | core | core | shared | xkeen-ui/templates/panel/modals/shared.html | 4223 |
| donate-modal | core | core | shared | xkeen-ui/templates/panel/modals/shared.html | 4250 |
| ui-settings-modal | core | core | shared | xkeen-ui/templates/panel/modals/shared.html | 4306 |
| mihomo-dns-modal | engine.mihomo | engine.mihomo | owned | xkeen-ui/templates/panel/modals/mihomo.html | 4333 |
| mihomo-import-modal | engine.mihomo | engine.mihomo | owned | xkeen-ui/templates/panel/modals/mihomo.html | 4498 |
| mihomo-proxy-tools-modal | engine.mihomo | engine.mihomo | owned | xkeen-ui/templates/panel/modals/mihomo.html | 4626 |
| mihomo-validation-modal | engine.mihomo | engine.mihomo | owned | xkeen-ui/templates/panel/modals/mihomo.html | 4768 |
| mihomo-hwid-modal | integration.happ | integration.happ | owned | xkeen-ui/templates/panel/modals/happ.html | 4835 |
| fm-upload-conflict-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 4961 |
| fm-connect-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 4982 |
| fm-knownhosts-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5080 |
| fm-create-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5111 |
| fm-rename-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5148 |
| fm-archive-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5173 |
| fm-extract-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5212 |
| fm-folder-picker-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5269 |
| fm-archive-list-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5293 |
| fm-mask-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5329 |
| fm-props-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5353 |
| fm-hash-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5372 |
| fm-chmod-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5404 |
| fm-chown-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5457 |
| fm-dropop-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5490 |
| fm-conflicts-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5510 |
| fm-bookmarks-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5542 |
| fm-download-multi-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5570 |
| fm-progress-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5610 |
| fm-ops-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5631 |
| fm-volumes-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5662 |
| fm-help-modal | core | tool.files | mixed-current-classification | xkeen-ui/templates/panel/modals/files.html | 5684 |
| fm-editor-modal | tool.editor | tool.editor | owned | xkeen-ui/templates/panel/modals/files_editor.html | 5750 |
| json-editor-modal | tool.editor | tool.editor | owned | xkeen-ui/templates/panel/modals/editor.html | 5787 |

## Mixed boundaries и решения

### `navigation`

- текущая область: `xkeen-ui/templates/panel.html`;
- владельцы: `core`, `engine.xray`, `engine.mihomo`, `tool.terminal`, `tool.files`;
- решение: Core owns the navigation shell; individual buttons and sections are gated by their module owner.

### `global-controls`

- текущая область: `xkeen-ui/templates/panel.html`;
- владельцы: `core`;
- решение: Keep service controls in core shell.

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
| xray-minimal | core, tool.editor, engine.xray | routing, xkeen, xray-logs | mihomo, commands, files | 19 | 34 |
| mihomo-minimal | core, tool.editor, engine.mihomo | mihomo, xkeen | routing, xray-logs, commands, files | 11 | 42 |

## Критерий завершения Этапа 4.1

Критерий готовности **выполнен**:

- для каждого screen определены `module_id`, partial, root id, frontend roots и API groups;
- для каждого modal определены текущая классификация, целевой владелец, partial и DOM-контракт;
- shell, navigation и mixed-boundaries имеют явные решения;
- зафиксированы профили `legacy-full`, `full`, `xray-minimal` и `mihomo-minimal`;
- baseline защищён генератором и тестом синхронности.

Физическое создание partials и перенос markup относятся к подэтапу 4.2 и последующим.
