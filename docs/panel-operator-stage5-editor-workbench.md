# Operator Console — Этап 5: editor/workbench, status labels и modal families

Даты частичного закрытия: **2–4 августа 2026 года**.

Статус: **семь связанных задач Этапа 5 закрыты 2–4 августа 2026 года**. Это не закрывает весь Этап 5: полный responsive matrix состояний остаётся отдельной работой.

## 1. Общий editor/workbench contract — закрыто

Три модала с главным кодовым полотном — `#json-editor-modal`, `#fm-editor-modal` и `#xray-snapshot-modal` — используют единый scoped contract `editor-workbench`:

- frame построен как `50px / minmax(0, 1fr) / 50px`: header и footer остаются видимыми, editor body — единственный растущий регион;
- desktop frame имеет ширину до 1180 px и высоту `clamp(520px, 82dvh, 900px)`; у него нет второй внешней области прокрутки;
- JSON и snapshot используют одинаковую operational toolbar высотой не менее 42 px; selector движка не удалён;
- file editor сохраняет selector в header, но title/subtitle, selector и close собраны в ту же сетку, а download/save — в общий action row;
- CodeMirror 5/6, Monaco и fallback textarea растут в пределах body и не получают legacy `max-height`;
- существующие `id`, `data-*`, inline visibility hooks и обработчики открытия, сохранения, скачивания, copy и смены движка не менялись.

3 августа также восстановлено визуальное покрытие Monaco IntelliSense для
Xray и Mihomo: список вариантов, окно документации (`suggest-details`) и
parameter hints получают непрозрачную operator surface, контрастный текст,
границу и тень. Это устраняет сценарий, когда у autocomplete оставалась
видна только пустая тёмная рамка при работающем provider.

## 2. Comments/schema status labels — закрыто

`#json-editor-comments-status` и `#json-editor-schema-status` больше не используют legacy `.xk-comments-badge` pill. Оба runtime-узла сохранены, но являются `role="status"` labels:

- нейтральное состояние — компактный muted text в runtime-строке под editor;
- `xk-comments-on` использует success color, `xk-schema-on` — indigo color;
- capsule radius, фон, декоративная точка и box-shadow отменены;
- `xk-comments-on/off` и `xk-schema-on/off` продолжают переключаться существующим `json_editor_modal.js`, поэтому source of truth и tooltip не менялись.

3 августа расположение меток уточнено по рабочему образцу главного Xray editor: `Комментарии` и `Schema` перенесены из верхней toolbar в компактную runtime-строку непосредственно под полотном JSON. Верхняя строка оставляет только selector движка, а нижняя мета-строка получает общий разделитель с editor; так статусы остаются видимыми, но не создают пустоты над рабочей областью.

## 3. Responsive editor help drawer/workbench — закрыто

Динамический CodeMirror help (`#xkeen-cm-help-drawer`) теперь работает как scoped workbench sidecar:

- на широком экране drawer имеет нейтральную поверхность и ширину до 420 px; открытый JSON/file/snapshot workbench сдвигается в свободную область, поэтому drawer не перекрывает его `save/cancel` footer;
- на tablet drawer становится нижней панелью, а workbench занимает оставшуюся верхнюю область, сохраняя доступными header, editor и action row;
- на mobile help сам становится fullscreen workbench с фиксированным 50 px header и собственной прокручиваемой body;
- overlay больше не затемняет всю рабочую область и не перехватывает клики вне drawer; закрытие доступно кнопкой и `Escape`, после закрытия фокус возвращается на исходный toolbar action.

## 4. Fullscreen сложных модалов на mobile — закрыто

На ширине до 720 px сложные семейства `editor-workbench`, `master-detail` и `drawer-help` используют fullscreen frame. Их `.modal-content` не прокручивается целиком: scrolling находится только в `.modal-body`, поэтому header и footer остаются в viewport. `confirm-compact-form` сознательно остаётся короткой bottom-sheet формой, а не превращается в искусственно высокий fullscreen dialog.


## 5. Четыре modal family применены ко всем 50 окнам — закрыто

Каждый статический `modal` ID в `panel.html` имеет ровно один
`data-operator-modal-family`; generated Stage 0 inventory подтверждает полное
покрытие без пропущенных или устаревших IDs:

| Family | Окон | Порядок прохода из аудита |
| --- | ---: | --- |
| `editor-workbench` | 6 | JSON/file/snapshot editors, затем routing template, Mihomo import и SSH transfer |
| `master-detail` | 19 | subscriptions/generator/pool/Mihomo, DAT/templates, UI settings/core, SSH и file-manager lists |
| `drawer-help` | 3 | editor help, balancer help, terminal/file-manager help |
| `confirm-compact-form` | 22 | core/confirm, SSH и все короткие file-manager действия, GitHub/donate |

Все четыре family получают один scoped frame и не меняют feature markup,
`id`, `data-*` или runtime handlers:

- `confirm-compact-form` остаётся одноколоночным auto-height диалогом с
  ограниченной прокруткой body;
- `editor-workbench` использует растущий body между 50 px header/footer;
- `master-detail` даёт bounded рабочую область без вложенной рамки и сохраняет
  scroll только у body;
- `drawer-help` занимает правый край на desktop и не создаёт нерабочую
  полноэкранную поверхность.

На ширине до 720 px editor/master-detail/drawer-help становятся fullscreen с
доступными header/footer, тогда как compact form остаётся коротким bottom
sheet. Chromium guard открывает каждый из 50 static modals, проверяет family
counts `22 / 6 / 19 / 3`, grid frame, видимый header/body и границы viewport.

## 6. Presentation geometry и empty/error auto-height — закрыто

4 августа статические presentation-значения `max-width`, `gap` и `margin`
убраны из `panel.html`: им соответствуют scoped-классы `xk-modal-width-*`,
`xk-modal-max-width-*`, `xk-modal-gap-*` и `xk-modal-m*`. Динамические
visibility/state inline hooks не менялись.

Крупные `editor-workbench` и `master-detail` сохраняют рабочую высоту только
когда отображают данные. Если открыт непустой `.empty-state`, `.fm-empty`,
`.xk-pt-empty`, `.xk-pool-empty`, `.error`, `.is-error` или runtime-узел с
суффиксом `-error`, frame переключается на `height: auto`; body получает
ограниченную прокрутку. Пустые error placeholders, `.hidden`, `[hidden]` и `display:none` не активируют этот режим. У коротких `confirm-compact-form` auto-height остаётся базовым contract.

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

Static contract проверяет общий frame, все три editor IDs, отсутствие JSON pills, workbench-sidecar help, точное распределение всех 50 modal IDs по четырём families и документированное закрытие задачи. Chromium-contract проверяет 50 px header/footer, доминирующую область editor и flat status labels в dark/light, включая реальные schema autocomplete Xray (`type`) и Mihomo (`vless`), непрозрачную Monaco documentation surface, fullscreen narrow geometry JSON modal, sidecar без перекрытия footer, fullscreen help на mobile и grid frame/границы viewport каждого static modal. Отдельно проверяются реальные modal frames с видимыми error и empty states: они сжимаются, а скрытые пустые placeholders не меняют рабочую высоту.

Критерий этих семи задач выполнен: JSON, file editor и snapshot имеют общий bounded workbench frame, comments/schema больше не конкурируют с editor как декоративные pills, help не закрывает save/cancel, все 50 static modal IDs получают один из четырёх family contracts, presentation geometry вынесена из template inline styles, empty/error не резервируют высокий canvas, а mobile не теряет header/footer сложных модалов. Полный критерий Этапа 5 остаётся открытым.
