# Operator Console: Files

Дата закрытия: 29 июля 2026 года.

Статус: **задача «Files» Этапа 4 закрыта 29 июля 2026 года**.

## Результат

Файловый менеджер сохраняет двухпанельную рабочую модель, но больше не смешивает навигацию, глобальные команды и файловые операции в один визуально неразличимый набор. Header actions, navigation каждого источника и footer operations объявлены отдельными toolbar regions. Путь и фильтр остаются главными растущими полями, icon-actions имеют одинаковую геометрию, а mobile использует внутреннюю прокрутку toolbar и компактные строки без page overflow.

Список файлов теперь публикует доступную grid-семантику с column headers, `aria-sort`, `aria-selected`, `aria-posinset`, `aria-setsize` и `aria-activedescendant`. Selection и keyboard focus не смешаны: выбранные строки имеют постоянный marker, текущая keyboard row — отдельный focus outline, а их сочетание показывает оба состояния одновременно. Существующие click, checkbox, Ctrl/Meta, Shift-range, Arrow, Enter, context-menu и hotkey contracts сохранены.

Корректировка после визуальной проверки 29 июля 2026 года: основной шрифт путей, фильтров и строк увеличен с 10.5 до 13 px, заголовки колонок — с 10 до 12 px, строки стали не ниже 36 px. Активная панель получила accent-рамку и отдельную accent-подложку toolbar/list; отличие сохраняется в обеих темах и не зависит только от цвета текста.

Повторная корректировка 29 июля 2026 года: accent активной панели приглушён до смешанного border и 3 px soft-marker без неонового эффекта. В нижней центральной части окна добавлен отдельный вертикальный resize-grip, меняющий только высоту и сохраняющий её через существующий geometry contract. Drop в исходную папку теперь трактуется как отмена до открытия Move/Copy dialog.

Исправление ограничения resize 29 июля 2026 года: удалены presentation-лимиты `760px`/`90vh`, из-за которых центральный grip продолжал двигаться, но высота окна переставала расти. Пользовательская высота теперь может превышать viewport до защитного предела 4096 px; нижняя часть остаётся доступна через обычную прокрутку страницы.

Финальная корректировка active state 29 июля 2026 года: доля accent в рамке снижена до 24%, marker уменьшен до 2 px и больше не дублируется внутренним контуром; интенсивность подложки toolbar/list также уменьшена. Панель остаётся различимой, но рамка больше не воспринимается как свечение.

## State contract

- `loading` — панель публикует `data-state="loading"`, список использует `aria-busy="true"` и компактную строку «Загрузка папки…»;
- `ready` — header и data rows образуют непрерывную плоскую таблицу с разделителями;
- `empty` — пустая папка показывает inline-state «Папка пуста» без высокой декоративной карточки;
- `filtered-empty` — отсутствие совпадений объясняет применённый фильтр и предлагает keyboard-accessible действие «Сбросить фильтр»;
- `disconnected` — remote-панель без session показывает отдельное нейтральное состояние вместо пустой таблицы без объяснения;
- `error` — сообщение, hint и retry action используют тот же inline-state primitive с danger marker и `role="alert"`;
- active pane публикует `data-active`; list label уточняет активную панель, но не меняет файловую модель.

## Toolbar и table-row contract

- `.fm-toolbar` используется для header, двух navigation bars и footer operations; regions имеют доступные имена;
- `.fm-row-header` остаётся sticky, sortable headers работают мышью и Enter/Space и синхронизируют `aria-sort`;
- `.fm-row` остаётся нулевого radius, использует tabular figures и один separator вместо вложенных карточек;
- основной текст файлов и полей имеет базовый размер 13 px, заголовки колонок — 12 px, а высота data row — не менее 36 px;
- active pane выделяется accent-рамкой, внутренним marker и подложкой toolbar/list, поэтому его можно распознать без поиска курсора;
- `.is-selected`, `.is-focused` и их комбинация визуально различимы в dark/light;
- mobile скрывает второстепенные permission/time columns и сохраняет touch target без горизонтального page overflow.

## Drag/drop contract

- внутренний drag помечает все строки переносимой selection как `.is-dragging` и публикует `data-drag-count`;
- destination list публикует `data-drop-state="panel|directory"` и `data-drop-effect="Копировать|Переместить"`;
- directory target получает собственный row outline; panel target показывает компактную подсказку действия у нижнего края списка;
- OS file drop всегда показывает copy feedback; cleanup снимает source/target/effect state после `drop`, `dragend` и ухода из области;
- payload, Move/Copy dialog, Ctrl default, local/remote paths и backend operations не менялись.

## Сохранённые контракты

- runtime `id`, `.fm-*` hooks, local/remote/session state и endpoints не переименованы;
- two-pane navigation, sort, filter, selection, context menu, uploads, downloads, create/rename, terminal и operations footer продолжают использовать прежние handlers;
- desktop resize/fullscreen и lite-mode ограничения сохранены;
- corner grips сохраняют resize по двум осям, а центральный bottom grip позволяет изменять только высоту;
- scoped Files-layer использует общие `--op-*` tokens и не добавляет gradients, lift transforms или capsule rows.

## Автоматические проверки

Статический контракт:

```text
python3 -m pytest tests/test_panel_operator_stage4_files.py
```

Chromium-contract:

```text
npx playwright test e2e/panel_operator_stage4_files.spec.mjs --project=chromium
```

Chromium-проверка охватывает dark/light desktop, mobile 390 × 844, toolbar/table geometry, accessible selection/focus, drag source/destination metadata, empty state и отсутствие horizontal overflow.

Критерий задачи выполнен: toolbar, table rows, selection/focus/drag/drop и empty states используют один data-heavy язык, а двухпанельная файловая модель и все operation hooks сохранены.
