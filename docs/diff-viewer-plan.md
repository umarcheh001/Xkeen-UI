# Diff Viewer — план реализации

## Назначение

Добавить во все редакторы конфигов возможность сравнения версий — по аналогии с
плагином Compare в Notepad++. Пользователь должен видеть, что именно он изменил
с момента загрузки файла, и быстро откатывать или сверять с предыдущим
снэпшотом.

Это новая, ещё не закрытая инициатива. Документ — рабочий implementation plan,
а не статус-документ. После закрытия фаз перевести его либо в README, либо
свернуть в краткий ADR.

## North Star

Пользователь редактора (Routing / Inbounds / Outbounds / Mihomo / File Manager)
может одной кнопкой:

1. увидеть side-by-side или inline-сравнение двух версий конфига;
2. выбрать, что именно сравнивать: текущий буфер, версия на диске, снэпшот,
   другой снэпшот, второй файл (для FM);
3. перейти к следующему/предыдущему изменению;
4. (необязательно) применить выбранную сторону хунка в свой буфер.

UX должен быть одинаковым на CodeMirror 6 и Monaco — пользователь не должен
переключать движок ради сравнения.

## Текущее состояние (точка отсчёта)

- Двухдвижковая архитектура редакторов уже есть: см.
  [editor_engine.js](../xkeen-ui/static/js/ui/editor_engine.js) и
  [editor_actions.js](../xkeen-ui/static/js/ui/editor_actions.js). Любая новая
  edit-фича подключается через этот фасад.
- Снэпшоты для Xray уже работают:
  [routes/backups.py](../xkeen-ui/routes/backups.py) — эндпоинты
  `/api/xray/snapshots`, `/api/xray/snapshots/read`,
  `/api/xray/snapshots/restore`.
- Снэпшотов на стороне Mihomo пока нет (`xkeen-ui/routes/mihomo.py` только
  load/save и validate). Это влияет на Phase 3.
- Dirty-state и baseline на клиенте отслеживается в
  [config_dirty_state.js](../xkeen-ui/static/js/features/config_dirty_state.js)
  — оттуда можно брать "сохранённую на диске" версию без повторного запроса.
- В шаблоне панели уже есть toolbar-хосты для каждого редактора:
  `#routing-toolbar-host`, `#mihomo-toolbar-host`, `#json-editor-toolbar` —
  туда же ставим кнопку "Сравнить".
- Никакого diff-кода в репозитории нет (поиск по `createDiffEditor`,
  `@codemirror/merge`, `MergeView` дал только vendored Monaco bundle).

## Архитектура

### Общий фасад

Расширяем `editor_actions.js` методом

```
XKeen.ui.editorActions.openDiff({
  left:    { source: 'buffer'|'disk'|'snapshot'|'file'|'text', ... },
  right:   { source: ..., ... },
  mode:    'split' | 'inline',
  language: 'json' | 'jsonc' | 'yaml' | 'text',
  readOnly: true,                  // Phase 1–4 — read-only
  applyTo: editorFacade | null,    // куда применять hunk (Phase 5)
});
```

Внутри фасад выбирает `diff_engine_monaco.js` или `diff_engine_cm.js` по
текущему `editorEngine`. Источники резолвятся в текст через единый набор
адаптеров (`source_adapters.js`) — чтобы не размазывать логику запросов по
движкам.

### Реализации

- **Monaco** — `monaco.editor.createDiffEditor(container, { renderSideBySide,
  readOnly, ... })`. Бесплатно: Monaco уже vendored.
- **CodeMirror 6** — пакет `@codemirror/merge` (`MergeView` для split,
  `unifiedMergeView` для inline). Лицензия MIT, размер ~15 KB gz, отдельный
  Vite chunk, чтобы не раздувать основной bundle.

### UI

- Кнопка "Сравнить" (иконка ⇄) в тулбаре каждого редактора, рядом с
  Save / Reload.
- Модальное окно `diff_modal.js`:
  - две dropdown-секции "Слева" / "Справа" с источниками;
  - переключатель Split / Inline;
  - навигация "← → к изменению" (берём из API движка);
  - (Phase 5) кнопки "← взять слева" / "→ взять справа" для текущего хунка;
  - кнопка "Закрыть".
- File Manager: пункт контекстного меню "Сравнить с…" над файлом — открывает
  picker второго файла, потом тот же `diff_modal`.

### Источники

| Источник     | Откуда берём                                        | Когда доступен                    |
|--------------|-----------------------------------------------------|-----------------------------------|
| `buffer`     | `getValue()` активного редактора                    | всегда                            |
| `disk`       | baseline из `config_dirty_state.js`                 | если редактор привязан к scope    |
| `snapshot`   | `GET /api/xray/snapshots/read?id=…`                 | только Xray-редакторы (Phase 3)   |
| `file`       | существующий FS-WS read                              | File Manager, Phase 4             |
| `text`       | сырой текст (для тестов и шаблонов)                  | всегда                            |

## Этапы

### Phase 1 — фасад + Monaco + базовый сценарий buffer↔disk — **закрыта**

- `diff_modal.js`, `diff_engine.js`, `diff_engine_monaco.js`, `source_adapters.js`.
- Кнопка "Сравнить" в тулбаре Routing / Inbounds / Outbounds / Mihomo.
- Только два источника: `buffer` и `disk`.
- Read-only.
- Smoke-тесты на одинаковых / пустых / разных файлах.

**Definition of done:** на Monaco-движке во всех 4 редакторах кнопка "Сравнить"
открывает модал и показывает корректный diff между текущим буфером и
сохранённой версией на диске.

Фактически: scope-registry в `diff_engine.js` + Monaco backend в
`diff_modal.js`; кнопка через `editor_toolbar.js` (`requiresDiffScope`) и
`editor_actions.openDiff()`. Routing/Inbounds/Outbounds/Mihomo сами
регистрируют свой scope при инициализации редактора.

### Phase 2 — паритет на CodeMirror 6 — **закрыта**

- Подключить `@codemirror/merge` в `package.json` и `vite.config.mjs`.
- `diff_engine_cm.js` с тем же API.
- Цель: ни одна кнопка не зависит от выбранного движка.
- E2E-тест Playwright: переключить движок CM6 ↔ Monaco — diff-modal работает в
  обоих случаях.

Фактически: `@codemirror/merge@6.12.1` подключён как dev-зависимость, добавлен
в importmap (`templates/_codemirror6_importmap.html`), в Vite externals и
синхронизирован в `static/vendor/npm/`. Отдельный файл `diff_engine_cm.js` не
делали — CM6-бэкенд (`MergeView` для split, `unifiedMergeView` для inline)
живёт прямо в `diff_modal.js` рядом с Monaco-бэкендом, переключение по
`pickBackend()` через `XKeen.ui.editorEngine.get()`. Все toolbar-операции
(setMode / navigateDiff / updateSummary / onSourceChanged) диспатчатся по
`_backendKind`. Стили под dark Monaco-палитру (`.cm-mergeView`,
`.cm-changedLine`, `.cm-deletedChunk`, `.cm-insertedLine`) добавлены в
`static/styles.css`.

### Phase 3 — снэпшоты как источник — **закрыта**

- В dropdown источников появляется группа "Снэпшоты" с реальным списком из
  `/api/xray/snapshots`.
- Загрузка содержимого через `/api/xray/snapshots/read`.
- Для Mihomo: либо отключить опцию "Снэпшот" в UI (если их нет), либо в
  отдельной мини-фазе 3a добавить snapshot-эндпоинты по аналогии с Xray
  (вне обязательного scope этого плана — решение принять при подходе к фазе).
- Логировать выбор источника в core.log как `diff.compare`, чтобы не терять
  observability.

Фактически: routing.js / json_editor_modal.js регистрируют `listSnapshots` +
`readSnapshot` в свой scope; модал подтягивает список асинхронно при открытии
и при смене источника пересчитывает текст через
`XKeen.ui.diff.resolveSourceText`. Mihomo не имеет snapshot-эндпоинтов —
просто не передаёт `listSnapshots`, и в дропдауне остаются только buffer/disk.
Логирование идёт через `XKeen.ui.diff.logDiff()` → `POST /api/log/event` →
`core.log` (`ui.event diff.compare | scope=…, left=…, right=…`).

### Phase 4 — File Manager — **закрыта**

- Пункт контекстного меню "Сравнить с…" над файлом.
- Picker второго файла — переиспользовать существующий FM-навигатор.
- Те же компоненты `diff_modal` / `diff_engine`.
- Защита от больших файлов: лимит ~2 MB, выше — confirm-модал с
  предупреждением.

Фактически: вместо отдельного file-picker используем парность панелей FM.
В `context_menu.js` добавлена единая запись «Сравнить…» с двумя режимами
доступности (`canCompareSelected` / `canCompareCross`). Если на активной
панели выбрано ровно два не-каталога — пункт называется «Сравнить
выделенные» и сравнивает эти два файла. Если выделен один файл —
«Сравнить с другой панелью», берётся focused/selected файл с другой панели.
Действие `compare` в диспетчере `file_manager.js` маршрутизируется на
`AC.openCompare(side, ctx)` (см. `static/js/features/file_manager/actions.js`).
Хэндлер читает оба файла через `/api/fs/read?target=…&path=…&sid=…`,
поддерживает кросс-панельный режим (local↔remote — разные target/sid),
показывает confirm-модал при размере >2 МБ
(`COMPARE_SOFT_LIMIT_BYTES = 2 MB`), уважает флаг `truncated`,
обрабатывает 415/`not_text` для бинарных файлов и подкидывает результат
в `XKeen.ui.diff.open()` с descriptor `{source: 'text'}` без scope —
из-за чего модал прячет dropdown'ы и показывает плоские лейблы. Подсказка
языка — по расширению (`json`/`yaml`/`js`/…).

### Phase 5 (опционально) — apply hunk — **закрыта**

- В модале появляются стрелки "взять слева" / "взять справа" текущего хунка.
- `applyTo: facade` целью применения — обычно левая сторона = текущий буфер.
- Только в side-by-side режиме.
- Учесть dirty-state: после apply редактор помечается dirty, baseline не
  меняется.

Фактически: scope-API расширен опциональным `applyText(newText)`. Wired
в `routing.js` (`setEditorTextAll`), `json_editor_modal.js` (`setCurrentValue`)
и `mihomo_panel.js` (`setEditorText`) — каждый вызывает свой существующий
writer, dirty-state и валидаторы срабатывают сами. Модал
(`diff_modal.js`) показывает кнопку «Применить хунк ←» в шапке, видна
только когда `scope.applyText` зарегистрирован, левая сторона привязана
к buffer (descriptor `source: 'buffer'`) и режим split. Поиск текущего
хунка — по позиции курсора (Monaco — `getOriginalEditor().getPosition()`,
CM6 — `view.state.selection.main.head`); fallback — первый хунк в
списке. Splice реализован отдельно для Monaco (1-based line numbers,
обработка чистых вставок при `originalEndLineNumber === 0`) и CM6
(character offsets `fromA/toA/fromB/toB`). После apply:
`scope.applyText(newText)` пишет в активный редактор, модал обновляет
свою левую сторону через `cm6SetText('left', …)` или
`_originalModel.setValue(…)`, и пересчитывает summary. FM-сравнения
кнопку не показывают — у них нет scope, applyText недоступен.

## Файлы

### Новые

| Путь                                                         | Назначение                       |
|--------------------------------------------------------------|----------------------------------|
| `xkeen-ui/static/js/ui/diff_modal.js`                        | модал, тулбар, навигация          |
| `xkeen-ui/static/js/ui/diff_engine.js`                       | диспетчер CM6 / Monaco            |
| `xkeen-ui/static/js/ui/diff_engine_monaco.js`                | Monaco diff editor                |
| `xkeen-ui/static/js/ui/diff_engine_cm.js`                    | CM6 MergeView / unifiedMergeView  |
| `xkeen-ui/static/js/ui/source_adapters.js`                   | резолверы источников в текст      |
| `xkeen-ui/static/css/diff_modal.css`                         | стили модала                      |
| `e2e/diff.spec.mjs`                                          | Playwright E2E                    |
| `tests/static/test_diff_modal.py` (или unit-эквивалент)      | smoke-тесты                       |

### Изменения

| Путь                                                              | Что меняем                                |
|-------------------------------------------------------------------|--------------------------------------------|
| `xkeen-ui/static/js/ui/editor_actions.js`                         | добавить `openDiff()`                      |
| `xkeen-ui/static/js/features/routing.js`                          | кнопка "Сравнить" в тулбаре                |
| `xkeen-ui/static/js/features/inbounds.js`                         | кнопка "Сравнить" в тулбаре                |
| `xkeen-ui/static/js/features/outbounds.js`                        | кнопка "Сравнить" в тулбаре                |
| `xkeen-ui/static/js/features/mihomo_panel.js`                     | кнопка "Сравнить" в тулбаре                |
| `xkeen-ui/static/js/features/config_dirty_state.js`               | публичный геттер baseline для diff         |
| `xkeen-ui/static/js/features/file_manager/editor.js`              | пункт контекстного меню (Phase 4)          |
| `xkeen-ui/templates/panel.html`                                   | при необходимости — слот под кнопку        |
| `package.json`                                                    | `@codemirror/merge` (Phase 2)              |
| `vite.config.mjs`                                                 | отдельный chunk для merge                  |
| `docs/frontend-page-inventory.md` / `.json`                       | обновить, если кнопки попадают в инвентарь |

### API

В рамках этого плана новых эндпоинтов не вводится. Phase 3a (Mihomo snapshots)
рассматривается отдельно.

## Tradeoffs

- **Две реализации diff (CM6 + Monaco) vs. только Monaco-diff с авто-свитчем
  движка.** Берём первый вариант — это соответствует существующей
  двухдвижковой архитектуре и не ломает выбор пользователя. Стоимость —
  ~150 строк фасада + один доп. dev-зависимости.
- **Read-only vs. apply-hunk сразу.** Сначала read-only (Phase 1–4) — не
  усложняет dirty-state и снимает риск случайной перезаписи буфера. Apply
  выносим в Phase 5 как отдельный шаг.
- **Modal vs. inline-вкладка в редакторе.** Modal — проще встроить в любой
  существующий редактор без перестройки layout, и привычно: снэпшоты тоже
  открываются модально.
- **Bundle size.** `@codemirror/merge` ~15 KB gz — подключаем как ленивый
  chunk, чтобы не раздувать первый рендер панели.

## Риски

- Большие файлы (Mihomo на сотни KB, snapshot-выгрузки) могут тормозить
  Monaco diff на роутерных сессиях через slow link. Митигируем лимитом + явным
  confirm.
- `@codemirror/merge` тянет дополнительные lezer-зависимости — проверить, что
  они не дублируются с уже установленными (`@lezer/*` в `package.json`).
- File Manager использует WebSocket-чтение — большой второй файл нужно читать
  стримом, не в одно сообщение, либо использовать лимит размера.

## Out of scope

- 3-way merge (как `git mergetool`).
- Полноценный history view с git-подобным логом изменений конфига.
- Diff бинарных артефактов (xray-core, geodat).
- Diff между шаблонами и буфером — только если найдётся явный источник
  community-эталона; пока вынесено в "опционально".

## Acceptance criteria по плану в целом

- Кнопка "Сравнить" видна и работает во всех 4 редакторах конфигов и в File
  Manager.
- Работает на обоих движках без переключения.
- Сценарий "что я изменил с момента загрузки" покрыт E2E-тестом для каждого
  редактора.
- Сценарий "сравнить с снэпшотом" покрыт E2E-тестом для Xray-редакторов.
- Bundle-size фронтенда не растёт более чем на ~20 KB gz относительно
  baseline.
- Документ обновлён: каждой закрытой фазе соответствует пометка "закрыта" или
  ссылка на PR.
