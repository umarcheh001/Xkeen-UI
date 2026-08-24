# Operator Console: контракт и матрица состояний

Статус: **Этап 0 закрыт 28 июля 2026 года**.

Этот документ фиксирует воспроизводимый baseline перед дальнейшим завершением редизайна панели. Канонический machine-readable snapshot находится в [`panel-operator-stage0-inventory.json`](panel-operator-stage0-inventory.json) и пересобирается только скриптом [`generate_panel_operator_inventory.py`](../scripts/generate_panel_operator_inventory.py).

## Зафиксированный presentation-контракт

- корневой scope редизайна — только `body.panel-page`;
- `xkeen-ui/static/panel-operator.css` подключается один раз и последним stylesheet в `panel.html`;
- все selectors в `panel-operator.css` содержат `body.panel-page`;
- `styles.css` остаётся legacy-источником и не принимает новые правила редизайна панели;
- `panel-operator.css` владеет только представлением: `id`, `data-*`, runtime-ноды и обработчики остаются DOM/JS-контрактом;
- скрываемые визуальные повторы не удаляются из DOM.

Эти условия проверяются статически в `tests/test_panel_operator_stage0_contract.py` и в реальном Chromium в `e2e/panel_operator_contract.spec.mjs` для dark/light.

## Сводка inventory

| Область | Зафиксировано |
| --- | ---: |
| Top-level views | 6 |
| Collapsible/accordion contracts | 12 |
| Editor engine selectors | 8 |
| Editor engines | CodeMirror, Monaco |
| Modal IDs | 51 |
| Inline `style` attributes | 209 |
| Уникальные DOM IDs | 1188 из 1188 |
| `data-*` attributes | 562 |
| Изначально скрытые runtime nodes с ID | 151 |
| DOM IDs со статической ссылкой из JS | 1116 |
| Dark/light viewport baselines | 12 |

Полные списки, начальные значения, locators и связи с JS-файлами хранятся в JSON snapshot. Любой дрейф заставляет тест inventory завершиться ошибкой до начала следующего визуального этапа.

## Матрица top-level views

| View | DOM target | Обязательные состояния последующих этапов |
| --- | --- | --- |
| Routing Xray | `#view-routing` | active, GUI focus, RAW focus, accordion open/closed, loading, loaded, error, narrow |
| Routing Mihomo | `#view-mihomo` | active, loading, loaded, error, narrow |
| Порты и исключения | `#view-xkeen` | active, save pending/success, error, narrow |
| Логи Xray | `#view-xray-logs` | active, loading, live, paused, empty, error, narrow |
| Команды | `#view-commands` | active, loading, loaded, error, narrow |
| Файлы | `#view-files` | active, loading, loaded, empty, error, selected, drag/drop, remote, narrow |

Route-action `Mihomo Генератор` и modal-action `Поддержать` учтены отдельно как top-level actions: они не объявлены внутренними `data-view` и поэтому не подменяют собой шесть panel views.

## Accordion/collapsible contract

Зафиксированы пары control → body и обе фазы `collapsed` / `expanded`:

| Control | Body | Начальное состояние |
| --- | --- | --- |
| `#xk-internet-check-dns-row` | `#xk-dns-guidance` | collapsed |
| `#routing-dat-header` | `#routing-dat-body` | collapsed |
| `#inbounds-header` | `#inbounds-body` | collapsed |
| `#routing-scenario-header` | `#routing-scenario-body` | collapsed |
| `#outbounds-header` | `#outbounds-body` | collapsed |
| `#routing-backups-header` | `#routing-backups-body` | collapsed |
| `#routing-help-header` | `#routing-help-body` | collapsed |
| `#routing-rules-header` | `#routing-rules-body` | collapsed |
| `#routing-header` | `#routing-body` | expanded |
| `#mihomo-clash-egress-toggle` | `#mihomo-clash-egress` | collapsed |
| `[data-xk-toggle="mihomo-card"]` | `#mihomo-body` | expanded |
| `[data-xk-toggle="xkeen-settings"]` | `#xkeen-body` | expanded |

В Chromium проверяются доступные пользователю клики. `#routing-rules-header` в текущем E2E fixture скрыт из-за недоступного GUI-focus, поэтому для него runtime guard проверяет установленный wiring-marker `data-xk-collapse-wired="1"`, не меняя состояние приложения искусственно.

## Editor engine contract

Глобальный runtime-контракт из `static/js/ui/editor_engine.js` фиксирует:

- допустимые значения: `codemirror`, `monaco`;
- default: `codemirror`;
- состояния визуальной проверки: CodeMirror, Monaco, loading, fallback, error;
- восемь selectors: Mihomo editor, Xray snapshot, routing template preview/edit, Mihomo import, Mihomo HWID preview, file editor и JSON editor.

## Матрица modal families

Все 50 ID распределены без остатка:

| Family | Количество | Обязательные состояния |
| --- | ---: | --- |
| Confirm / compact form | 22 | closed, open, validation error, narrow |
| Editor / workbench | 6 | closed, open, loading, loaded, error, narrow |
| Master / detail | 19 | closed, open, loading, loaded, empty, error, narrow |
| Drawer / help | 3 | closed, open, loaded, narrow |

### Confirm / compact form

`#core-modal`, `#confirm-modal`, `#inbounds-apply-modal`, `#routing-template-save-modal`, `#fm-upload-conflict-modal`, `#github-export-modal`, `#donate-modal`, `#ssh-edit-modal`, `#ssh-confirm-modal`, `#fm-connect-modal`, `#fm-create-modal`, `#fm-rename-modal`, `#fm-archive-modal`, `#fm-extract-modal`, `#fm-mask-modal`, `#fm-props-modal`, `#fm-hash-modal`, `#fm-chmod-modal`, `#fm-chown-modal`, `#fm-dropop-modal`, `#fm-download-multi-modal`, `#fm-progress-modal`.

### Editor / workbench

`#mihomo-hwid-modal` — YAML workbench: controls/diagnostics remain in the left scroll region; preview fills the right canvas and follows modal resize.

`#xray-snapshot-modal`, `#routing-template-edit-modal`, `#mihomo-import-modal`, `#fm-editor-modal`, `#json-editor-modal`, `#ssh-transfer-modal`.

### Master / detail

`#xray-context-modal`, `#xray-devices-modal`, `#routing-template-modal`, `#outbounds-generator-modal`, `#outbounds-pool-modal`, `#mihomo-proxy-tools-modal`, `#github-catalog-modal`, `#ui-settings-modal`, `#routing-dat-contents-modal`, `#mihomo-validation-modal`, `#ssh-modal`, `#fm-knownhosts-modal`, `#fm-folder-picker-modal`, `#fm-archive-list-modal`, `#fm-conflicts-modal`, `#fm-bookmarks-modal`, `#fm-ops-modal`, `#fm-volumes-modal`.

### Drawer / help

`#terminal-history-modal`, `#routing-balancer-help-modal`, `#fm-help-modal`.

## Классификация inline-style

Все 282 атрибута классифицированы по декларациям, а не только по наличию слова `display`:

| Категория атрибута | Количество | Правило миграции |
| --- | ---: | --- |
| State/visibility hook | 63 | оставить inline как runtime-контракт |
| Presentation/geometry | 213 | переносить в scoped CSS на соответствующих этапах |
| Mixed state + presentation | 6 | сначала разделить; inline оставить только state/visibility |

Всего зафиксировано 493 декларации: 69 state/visibility и 424 presentation/geometry. К state/visibility относятся только исходные `display: none` и `visibility: hidden/collapse`; `display: flex/grid`, размеры, отступы, цвет, opacity и типографика относятся к presentation/geometry.

## DOM и handler freeze

Snapshot хранит полный список из 971 уникального `id`, 365 экземпляров `data-*`, 156 изначально скрытых ID и mapping 942 DOM-якорей на JS-файлы, где они упоминаются. Это позволяет сравнивать контракт до и после каждого следующего этапа.

Особо защищены визуально скрытые, но runtime-доступные повторы:

- `#routing-focus-note`;
- `#json-editor-file-label`;
- `#inbounds-file-code` и его строка активного фрагмента;
- `#outbounds-file-code` и его строка активного фрагмента;
- `.xk-mihomo-topbar .xk-routing-active-inline`.

Chromium guard дополнительно выполняет реальные theme, view, accordion и JSON-modal handlers и проверяет attached/hidden состояние этих узлов.

## Visual baseline

Baseline снят для default Routing Xray / CodeMirror в обеих темах. Снимок фиксирует ровно viewport, а не переменную full-page высоту.

| Viewport | Dark | Light |
| --- | --- | --- |
| 1920×1080 | [PNG](panel-operator-stage0-baseline/routing-dark-1920x1080.png) | [PNG](panel-operator-stage0-baseline/routing-light-1920x1080.png) |
| 1440×900 | [PNG](panel-operator-stage0-baseline/routing-dark-1440x900.png) | [PNG](panel-operator-stage0-baseline/routing-light-1440x900.png) |
| 1280×720 | [PNG](panel-operator-stage0-baseline/routing-dark-1280x720.png) | [PNG](panel-operator-stage0-baseline/routing-light-1280x720.png) |
| 1024×768 | [PNG](panel-operator-stage0-baseline/routing-dark-1024x768.png) | [PNG](panel-operator-stage0-baseline/routing-light-1024x768.png) |
| 390×844 | [PNG](panel-operator-stage0-baseline/routing-dark-390x844.png) | [PNG](panel-operator-stage0-baseline/routing-light-390x844.png) |
| 360×800 | [PNG](panel-operator-stage0-baseline/routing-dark-360x800.png) | [PNG](panel-operator-stage0-baseline/routing-light-360x800.png) |

JSON snapshot хранит SHA-256 и PNG dimensions каждого файла. Обновлять baseline можно только осознанно:

```text
XKEEN_CAPTURE_STAGE0_BASELINE=1 npx playwright test e2e/panel_operator_baseline.spec.mjs --project=chromium
python3 scripts/generate_panel_operator_inventory.py --root . --json-out docs/panel-operator-stage0-inventory.json
```

## Проверка контракта перед и после этапа

```text
python3 scripts/generate_panel_operator_inventory.py --root . --json-out /tmp/panel-operator-stage0-inventory.json
pytest -q tests/test_panel_operator_stage0_contract.py
npx playwright test e2e/panel_operator_contract.spec.mjs --project=chromium
```

При легитимном изменении presentation markup сначала сравнивается временный snapshot с committed JSON. После подтверждения, что `id`, `data-*`, hidden runtime nodes и handler anchors сохранены, committed snapshot обновляется тем же генератором. Baseline PNG не перезаписываются обычной генерацией inventory.

## Закрытие Этапа 0

Критерий завершения выполнен: есть воспроизводимая карта экранов и состояний, зафиксированы обе темы и все шесть viewport-размеров, а статический и Chromium-тесты подтверждают scoped/last-loaded контракт и сохранность критической интерактивности.
