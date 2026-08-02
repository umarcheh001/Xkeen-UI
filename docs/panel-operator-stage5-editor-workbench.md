# Operator Console — Этап 5: editor/workbench и status labels

Даты частичного закрытия: **2 и 3 августа 2026 года**.

Статус: **четыре связанные задачи Этапа 5 закрыты 2 и 3 августа 2026 года**. Это не закрывает весь Этап 5: остальные семейства модалов, empty/error states и полный matrix состояний остаются отдельной работой.

## 1. Общий editor/workbench contract — закрыто

Три модала с главным кодовым полотном — `#json-editor-modal`, `#fm-editor-modal` и `#xray-snapshot-modal` — используют единый scoped contract `editor-workbench`:

- frame построен как `50px / minmax(0, 1fr) / 50px`: header и footer остаются видимыми, editor body — единственный растущий регион;
- desktop frame имеет ширину до 1180 px и высоту `clamp(520px, 82dvh, 900px)`; у него нет второй внешней области прокрутки;
- JSON и snapshot используют одинаковую operational toolbar высотой не менее 42 px; selector движка не удалён;
- file editor сохраняет selector в header, но title/subtitle, selector и close собраны в ту же сетку, а download/save — в общий action row;
- CodeMirror 5/6, Monaco и fallback textarea растут в пределах body и не получают legacy `max-height`;
- существующие `id`, `data-*`, inline visibility hooks и обработчики открытия, сохранения, скачивания, copy и смены движка не менялись.

## 2. Comments/schema status labels — закрыто

`#json-editor-comments-status` и `#json-editor-schema-status` больше не используют legacy `.xk-comments-badge` pill. Оба runtime-узла сохранены, но являются `role="status"` labels:

- нейтральное состояние — плоский текст с двухпиксельным левым marker;
- `xk-comments-on` использует success marker/color, `xk-schema-on` — indigo marker/color;
- capsule radius, фон, декоративная точка и box-shadow отменены;
- `xk-comments-on/off` и `xk-schema-on/off` продолжают переключаться существующим `json_editor_modal.js`, поэтому source of truth и tooltip не менялись.

## 3. Responsive editor help drawer/workbench — закрыто

Динамический CodeMirror help (`#xkeen-cm-help-drawer`) теперь работает как scoped workbench sidecar:

- на широком экране drawer имеет нейтральную поверхность и ширину до 420 px; открытый JSON/file/snapshot workbench сдвигается в свободную область, поэтому drawer не перекрывает его `save/cancel` footer;
- на tablet drawer становится нижней панелью, а workbench занимает оставшуюся верхнюю область, сохраняя доступными header, editor и action row;
- на mobile help сам становится fullscreen workbench с фиксированным 50 px header и собственной прокручиваемой body;
- overlay больше не затемняет всю рабочую область и не перехватывает клики вне drawer; закрытие доступно кнопкой и `Escape`, после закрытия фокус возвращается на исходный toolbar action.

## 4. Fullscreen сложных модалов на mobile — закрыто

На ширине до 720 px сложные семейства `editor-workbench`, `master-detail` и `drawer-help` используют fullscreen frame. Их `.modal-content` не прокручиваетс�� целиком: scrolling находится только в `.modal-body`, поэтому header и footer остаются в viewport. `confirm-compact-form` сознательно остаётся короткой bottom-sheet формой, а не превращается в искусственно высокий fullscreen dialog.

## Сохранённые контракты

- `data-operator-modal-family="editor-workbench"` не переопределяет API/modal lifecycle и остаётся общим family hook;
- close/cancel nodes остаются в DOM; presentation-слой по-прежнему скрывает только визуальные дубликаты;
- editor engine selectors и все toolbar actions остаются доступными по прежним ID и `aria-label`;
- CSS находится в секции `6. MODALS` `xkeen-ui/static/panel-operator.css`, полностью scoped к `body.panel-page`; `styles.css` не менялся.

## Проверка

```text
python -m pytest -q tests/test_panel_operator_stage5_editors.py \
  tests/test_panel_operator_stage0_contract.py \
  tests/test_panel_operator_editor_menus.py
npx playwright test e2e/panel_operator_stage5_editors.spec.mjs --project=chromium
```

Static contract проверяет общий frame, все три modal IDs, отсутствие JSON pills, workbench-sidecar help и документированный partial closure. Chromium-contract проверяет 50 px header/footer, доминирующую область editor и flat status labels в dark/light, включая fullscreen narrow geometry JSON modal, sidecar без перекрытия footer и fullscreen help на mobile.

Критерий этих четырёх задач выполнен: JSON, file editor и snapshot имеют общий bounded workbench frame, comments/schema больше не конкурируют с editor как декоративные pills, help не закрывает save/cancel и mobile не теряет header/footer сложных модалов. Полный критерий Этапа 5 остаётся открытым.
