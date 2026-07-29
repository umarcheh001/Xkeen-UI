# Завершение переезда панели на Operator Console

Дата аудита: 28 июля 2026 года.

Статус выполнения: **Этапы 0–3 закрыты 28 июля 2026 года; Этап 4 в работе: задачи «Порты», «Routing rules» и «Balancers» закрыты 28 июля 2026 года; задача «Commands» закрыта 29 июля 2026 года; остальные задачи Этапа 4 и Этапы 5–7 остаются открыты.** Контракт, state matrix и baseline Этапа 0 зафиксированы в [`panel-operator-stage0-contract.md`](panel-operator-stage0-contract.md), канонический snapshot — в [`panel-operator-stage0-inventory.json`](panel-operator-stage0-inventory.json). Система scoped-примитивов и проверки Этапа 1 зафиксированы в [`panel-operator-stage1-primitives.md`](panel-operator-stage1-primitives.md), контракт шапки, navigation rail и editor-first grid Этапа 2 — в [`panel-operator-stage2-shell-grid.md`](panel-operator-stage2-shell-grid.md), единый accordion/data-row/state contract инспектора Routing Этапа 3 — в [`panel-operator-stage3-routing-cards.md`](panel-operator-stage3-routing-cards.md). Контракты закрытых задач Этапа 4: [`panel-operator-stage4-ports.md`](panel-operator-stage4-ports.md), [`panel-operator-stage4-routing-rules.md`](panel-operator-stage4-routing-rules.md), [`panel-operator-stage4-balancers.md`](panel-operator-stage4-balancers.md) и [`panel-operator-stage4-commands.md`](panel-operator-stage4-commands.md).

## Цель и границы

Цель — закончить визуальный переезд основной панели XKeen в спокойную операторскую консоль: графитовые поверхности, один indigo-акцент, компактная навигация, строки данных вместо вложенных карточек и редактор как главный рабочий объект.

В рамках этой работы меняется только представление. Не меняются:

- маршруты, API и серверная логика;
- `id`, `data-*`, имена полей и DOM-узлы, используемые JavaScript;
- обработчики, сценарии сохранения, загрузки, импорта, терминала и файлового менеджера;
- выбор CodeMirror/Monaco и поведение самих редакторов.

Элементы, скрываемые ради устранения визуального повтора, остаются в DOM. Новый слой продолжает подключаться последним и каждый его селектор остаётся ограничен `body.panel-page`.

## Краткий вывод аудита

Основа миграции выбрана верно, но переезд ещё не завершён. `panel-operator.css` действительно подключён последним в `panel.html`, имеет собственные токены тёмной и светлой тем и не содержит градиентов. При этом старый дизайн продолжает проявляться через более узкие компоненты и псевдоэлементы из `styles.css`, которые новый слой пока не нейтрализует.

Вторая системная проблема: изолированный слой сам начал превращаться в новый каскад исправлений. На момент аудита:

- `styles.css`: 33 402 строки, 878 упоминаний градиентов, 661 декларация `box-shadow`, 202 радиуса `999px` и 455 `!important`;
- `panel-operator.css`: 3 779 строк, 0 градиентов, 104 декларации `box-shadow` (включая сбросы), 733 `!important`;
- эвристический статический подсчёт находит 762 разных селектора нового слоя, из них 162 встречаются более одного раза;
- `panel.html`: 4 496 строк, 50 модальных окон и 284 inline-атрибута `style`; часть inline-стилей является контрактом видимости, но часть всё ещё задаёт геометрию и мешает общей адаптивной системе.

Следовательно, завершать миграцию нужно не очередным блоком в конце CSS, а уплотнением и переиспользованием уже подключённого scoped-слоя.

## Что уже сделано и должно быть сохранено

- `panel-operator.css` подключён после `styles.css`, terminal theme и `xterm.css`.
- Корневой класс `body.panel-page` установлен только у панели.
- Введены токены поверхностей, текста, границ, accent/success/warning/danger, радиусов и теней для обеих тем.
- Базовая сетка «редактор + инспектор» и перестроение колонок на узких экранах уже существуют.
- Визуальный повтор GUI/RAW оставлен в DOM, но `#routing-focus-note` скрыт.
- Повтор выбранного имени файла в инспекторе скрыт, сам узел сохранён.
- `#json-editor-file-label` скрыт, имя файла остаётся в заголовке модального редактора.
- Повтор «Servers» / «узлы текущего фрагмента» и подсказки горячих клавиш файлового менеджера уже частично убраны из визуального потока.
- Файловый менеджер, терминал, DAT Explorer, core selector и настройки получили первый проход плоской компоновки.

Эти решения не следует откатывать во время последующих этапов.

## Эталонные принципы

Эталон используется как проверка решений, а не как внешний скин.

- [Linear: How we redesigned the Linear UI](https://linear.app/now/how-we-redesigned-the-linear-ui) — уменьшать визуальный шум, поддерживать выравнивание панелей и повышать плотность навигации.
- [Linear: UI refresh](https://linear.app/changelog/2026-03-12-ui-refresh) — приглушать навигационную оболочку, чтобы рабочая область была заметнее, и унифицировать заголовки и view-controls.
- [Vercel Geist: Colors](https://examples.vercel.com/geist/colors) — использовать ограниченное число фоновых уровней и предсказуемые состояния default/hover/active вместо отдельных декоративных палитр для каждого компонента.
- [Grafana Saga: Button](https://grafana.com/developers/saga/components/buttons/button) — один primary action в группе, остальные действия ниже по визуальному приоритету; базовая средняя высота control — 32 px.
- [Grafana Saga: Lists of Objects](https://grafana.com/developers/saga/templates/lists-of-objects/) — таблицы и строки подходят данным без богатой визуальной составляющей лучше, чем плиточная сетка карточек.
- [Cloudflare: Dark Mode for the Dashboard](https://blog.cloudflare.com/dark-mode/) — темы и консистентность должны исходить из общих токенов и одних и тех же базовых компонентов.

Из этих источников для XKeen следуют четыре правила: рабочая область важнее оболочки; цвет показывает состояние, а не украшает; данные представлены строками; один и тот же тип действия везде выглядит одинаково.

## Остатки старого дизайна по предоставленным скриншотам

| Скриншот | Наблюдение | Причина в текущем слое | Приоритет |
| --- | --- | --- | --- |
| 1. «Справка и ссылки» | Каждая ссылка выглядит большой синей пилюльной карточкой; восемь одинаково акцентных строк создают шум | В scoped-слое нет отдельного плоского контракта для `.routing-side-card .links`; наследуются старые правила `styles.css` около строк 27651–27826 | P0 |
| 2. GeoIP/GeoSite | Смешаны квадратные, круглые и pill-контролы; help выделен ярче главной операции; disabled-состояния слишком блеклые | Нормализация `button` не задаёт семантические варианты для toolbar/icon/status и не закрывает все старые псевдоэлементы | P1 |
| 3. Порты и исключения | Редакторы получают сотни пикселей пустоты, save растянут в пилюлю на всю карточку, карточки дублируют рамки редакторов | Сохраняются старые `height: clamp(360px, 42vh, 520px)`, `min-height: 220px` и `margin-top: auto` у `.xkeen-mini-editor`; новый слой меняет поверхность, но не компоновку | P0 |
| 4. Редактор источника подписки | Неодинаковая ширина полей, три icon-only action без ясной иерархии, круглая служебная кнопка, конкурирующие cyan/red подсказки | Специализированная форма не собрана из общего field/action/status pattern; используются старые `.xk-sub-*` варианты | P1 |
| 5. JSON-редактор | Старые pill-бэйджи «Комментарии» и «Schema», toolbar отделён случайными пустотами, footer выглядит как три независимые зоны | В scoped-слое для `#json-editor-modal` есть только общий modal frame и primary save; старые `.xk-comments-badge` всё ещё имеют `border-radius: 999px` | P0 |
| 6. Справка редактора | Правый drawer перекрывает часть редактора и footer, фон затемнён на всей ширине, образуется большая нерабочая зона | Drawer не участвует в адаптивной геометрии workbench и ведёт себя как отдельный полноэкранный overlay | P0 |
| 7. Правила маршрутизации | Переизбыток pills/tags/icon-кнопок, карточки в две колонки, слабая типографическая иерархия, много повторных рамок | Новый слой сбросил часть фона карточек, но оставил legacy grid, псевдоэлементы, badge-набор и карточную модель записи | P0 |

## Дополнительные результаты проверки текущей сборки

### Каскад и компоненты

1. Старый синий отблеск шапки имеет конкретный источник. `styles.css` задаёт градиентные `::before` для header actions около строк 25736, 27919, 28058 и 28176. Начальный reset `panel-operator.css` отключает `::after`, но не все `::before`. Поэтому даже при `background-image: none` на самой кнопке блик остаётся поверх неё.

2. Универсальный сброс `body.panel-page button` полезен как страховка, но слишком широк как конечная архитектура. После него semantic states восстанавливаются точечными ID и длинными списками селекторов. Это увеличивает `!important` и создаёт новые исключения.

3. Различие между action, status, filter, segmented control и tag пока не формализовано. Отсюда одинаковая capsule-форма у кликабельных команд, неинтерактивных меток и переключателей.

4. В светлой теме старые эффекты заметнее: бело-синие градиенты, холодные тени и светящиеся icon-кнопки конфликтуют со спокойными токенами `--op-*`. В тёмной теме те же компоненты уводят графитовую палитру обратно в navy/blue.

### Плотность и типографика

1. Основной размер панели — 13 px, но много служебного текста принудительно уменьшено до 9,5–10,5 px. На широком экране это создаёт впечатление «много мелких подписей», а не плотной профессиональной консоли.

2. Плотность достигается не только малым шрифтом. Нужны единая высота строк, выравнивание колонок и удаление повторных рамок. Сейчас часть экранов одновременно слишком мелкая и слишком высокая.

3. Верхний регистр, letter-spacing и разноцветные названия секций всё ещё используются в командах, routing rules и некоторых сложных модалах. Они должны остаться только у редких технических kicker, если тот действительно нужен.

### Экраны, которым нужен отдельный проход

- **Routing Xray:** shell и inspector приведены к общим accordion/data-row/state primitives; отдельный проход всё ещё нужен routing rules, журналам и сложным формам следующих этапов.
- **Routing Mihomo:** перенести тот же editor/workbench contract, не создавать отдельный набор геометрии.
- **Порты и исключения:** убрать фиксированное выравнивание высот карточек; высоту редактора определять содержимым в заданных min/max пределах; save сделать обычным action-row.
- **Команды:** заменить сетку capsule-команд на компактные строки/ячейки с названием команды, назначением и действием; не повторять префикс XKeen в каждой строке.
- **Правила маршрутизации:** balancer оставить компактным summary/form-блоком, правила перевести в одноколоночные data rows на средних ширинах; цветная левая метка допустима только как semantic target-state.
- **Логи Xray:** привести filters, counters, status labels и detail action к общим примитивам; terminal-like surface оставить главным.
- **Файлы:** сохранить удачную двухпанельную основу, завершить toolbar/icon states, empty/loading/error states и все file-manager dialogs.
- **Mihomo generator/profiles:** убрать вложенные карточки в таблицах профилей, применить общие формы и action bars.
- **Настройки UI:** проверить текущий плоский проход на живом контенте всех пяти разделов; недопустима прежняя схема «карточка секции → карточка настройки».

### Модальные окна

Общий frame покрывает не все 50 модальных окон. Нужны четыре явных семейства вместо индивидуальных max-width/min-height:

1. **Confirm/compact form:** auto-height, одна колонка, короткий footer.
2. **Editor/workbench:** 70–90 dVH, editor растёт, toolbar и footer фиксированы, нет пустого body.
3. **Master/detail:** две разделённые колонки без карточек внутри; на mobile — последовательный поток или fullscreen.
4. **Drawer/help:** не перекрывает ключевые действия; desktop либо сжимает рабочую область, либо накладывается только на неё без искусственной пустоты; mobile занимает весь экран.

Приоритетный порядок модалов:

- JSON/file/snapshot editors и editor help;
- outbounds subscriptions, generator, pool и Mihomo import/proxy/HWID;
- DAT Explorer, routing templates и balancer help;
- UI settings и core selector;
- SSH и 22 file-manager modal states;
- donate/GitHub/confirm как финальная низкорисковая партия.

### Адаптивность

- Текущий mobile smoke проверяет только отсутствие горизонтального overflow. Он не ловит чрезмерную вертикальную длину: экран портов при 390 × 844 превращается в длинную цепочку четырёх высоких редакторов.
- Горизонтально прокручиваемые top tabs допустимы, но активная вкладка должна быть всегда видна после переключения, а края должны подсказывать наличие продолжения.
- На desktop нужно проверять не только ширину, но и высоту 720 px: именно там toolbar/footer чаще всего вытесняют editor.
- Для модалов нужны отдельные height-breakpoints; одних `max-width` media queries недостаточно.

## Состояние автоматических проверок

28 июля 2026 года выполнен:

```text
XKEEN_CAPTURE_UI=1 npx playwright test e2e/panel_operator_ui.spec.mjs --project=chromium
```

Результат: 2 passed, 3 failed.

- isolation/last stylesheet — passed;
- mobile no-horizontal-overflow — passed;
- save в ports — 37 px при ожидаемых `<= 36px`;
- первая help link row — 38,453 px при ожидаемых `<= 38px`;
- JSON editor — тест получил высоту editor `0`, потому что выбирает первый совпавший, но не обязательно видимый host; скриншот показывает активный редактор, значит надо исправить locator и затем измерять реальную геометрию.

Нынешние проверки полезны как smoke, но недостаточны как критерий окончания редизайна: они не проверяют старые псевдоэлементы, запрещённые градиенты, цветные тени, 50 модалов, dark theme и смысловую иерархию actions.

## Поэтапный план работ

### Этап 0. Зафиксировать контракт и матрицу состояний — закрыт

Выполнено 28 июля 2026 года:

- [x] `panel-operator.css` сохранён последним; статический и Chromium guard запрещают потерю scope/порядка, а `styles.css` объявлен закрытым для новых panel redesign rules;
- [x] `scripts/generate_panel_operator_inventory.py` фиксирует 6 top-level views, 12 accordion/collapsible contracts, 8 editor engine selectors и все 50 modal IDs;
- [x] все 284 inline-style разделены на 63 state/visibility hooks, 215 presentation/geometry attributes и 6 mixed attributes;
- [x] сняты 12 baseline PNG: dark/light для 1920 × 1080, 1440 × 900, 1280 × 720, 1024 × 768, 390 × 844 и 360 × 800;
- [x] DOM-contract зафиксировал 970 уникальных `id`, 345 `data-*`, 156 hidden runtime IDs и mapping 942 JS-referenced handler anchors;
- [x] `tests/test_panel_operator_stage0_contract.py` и `e2e/panel_operator_contract.spec.mjs` проверяют snapshot, ownership, hidden runtime nodes и критичные runtime handlers.

Критерий завершения: **выполнен**. Воспроизводимая карта экранов/состояний и тесты scoped/last-loaded контракта находятся в [`panel-operator-stage0-contract.md`](panel-operator-stage0-contract.md). Этап повторно открывается только при нарушении зафиксированного контракта, а не при плановой работе следующих этапов.

### Этап 1. Уплотнить scoped-слой в систему примитивов — закрыт

Выполнено 28 июля 2026 года:

- [x] `panel-operator.css` реорганизован в каноническом порядке tokens → reset → shell → primitives → workspaces → modals → themes → responsive; после responsive нет добавочного слоя исправлений;
- [x] повторные selector definitions сокращены и сведены через `:is(...)`/`:where(...)`, в том числе для header, modal frame, file manager, terminal и settings;
- [x] базовые примитивы используют `:where(body.panel-page)`, а усиление специфичности и `!important` ограничено явно прокомментированной границей с замороженным legacy cascade;
- [x] существующие классы и атрибуты собраны в примитивы `surface`, `section`, `data-row`, `field`, `action-bar`, `button`, `icon-button`, `status`, `tag`, `segmented-control`, `empty-state`; DOM/JS-контракт не менялся;
- [x] legacy `::before/::after`, computed gradients, цветные glow и lift-transform нейтрализованы у panel chrome;
- [x] закреплены control 32 px, compact 28 px, mobile touch target не меньше 40 px, радиусы controls 5–6 px и surfaces 9–12 px;
- [x] единственный `999px` в scoped-файле относится к физическому `.fm-toggle-slider`; обычные controls, statuses, tags и data rows используют конечные радиусы.
- [x] с 29 июля 2026 года для следующих этапов действует living budget scoped-слоя: не более 925 selector definitions, 800 unique selectors, 145 повторных selectors и 190 дополнительных повторных instances; исторические метрики закрытия Этапа 1 остаются snapshot, а не потолком развития.

Критерий завершения: **выполнен**. Chromium-contract проходит в dark/light для всех шести top-level views, запрещает computed gradients, цветные blur-glow и lift-transform и проверяет общую геометрию representative primitives на desktop/mobile. Статический контракт и команды проверки описаны в [`panel-operator-stage1-primitives.md`](panel-operator-stage1-primitives.md). Этап повторно открывается только при нарушении этого контракта.

### Этап 2. Шапка, навигация и рабочая сетка — закрыт

Выполнено 28 июля 2026 года:

- [x] шапка собрана в две прямые зоны `identity` (branding/service/core) и `global-actions`; существующие runtime nodes и hooks сохранены;
- [x] ordinary header actions используют одну нейтральную поверхность без постоянной синей/красной подсветки, theme icon также нейтрален; danger появляется только у risk-hover;
- [x] indigo-иерархия закреплена за active navigation и primary save action текущего редактора;
- [x] top tabs приведены к compact content rail с 2 px active marker, отдельным `:focus-visible`, доступным именем и внутренним horizontal scroll;
- [x] service controls, routing focus и auto-restart выровнены одной плоской command row без третьей декоративной панели;
- [x] desktop grid сохраняет workspace + inspector до 1180 px, после чего editor-first перестраивается в одну колонку; mobile сохраняет 40 px touch targets;
- [x] dark/light Chromium-matrix охватывает 1920 × 1080, 1440 × 900, 1280 × 720, 1024 × 768, 390 × 844 и 360 × 800 без page overflow;
- [x] при 1280 × 720 полная шапка занимает 128 px, editor host начинается не ниже 250 px и оставляет не менее 460 px видимой высоты.

Критерий завершения: **выполнен**. Шапка и сетка одинаково читаются в обеих темах, не дают page overflow и не конкурируют с редактором по контрасту или площади. Статический и Chromium-контракты описаны в [`panel-operator-stage2-shell-grid.md`](panel-operator-stage2-shell-grid.md). Этап повторно открывается только при нарушении этого контракта.

### Этап 3. Пересобрать routing cards и operational blocks — закрыт

Выполнено 28 июля 2026 года:

- [x] GeoIP/GeoSite, inbounds, scenario, outbounds, backups и help используют единый accordion contract: один header/body pattern, `aria-controls`, синхронный `aria-expanded`, Enter/Space и одинаковый expanded surface;
- [x] help pills заменены плоскими строками с разделителями и единым hover/focus state;
- [x] GeoDAT controls получили явные disabled/loading/OK/warning/error states, `aria-busy`, live status и восстановление исходного disabled-state после операции;
- [x] outbounds nodes собраны в пять колонок name/protocol/endpoint/latency+state/action; полное имя узла и runtime hooks сохранены;
- [x] scenario options, backups table, subscription fragments и GeoDAT records больше не выглядят вложенными карточками;
- [x] повторы активного файла и вспомогательные runtime nodes остаются attached и скрываются только presentation-слоем;
- [x] status/meta строки используют общий плоский primitive и semantic color только для состояния;
- [x] selector layer уплотнён до 885 definitions / 720 unique и остаётся внутри канонической секции workspaces без добавочного блока после responsive;
- [x] статический и Chromium-контракты проверяют обе темы, keyboard accordion flow, GeoDAT busy/state flow, пять колонок proxy row и отсутствие horizontal overflow на 390 px.

Критерий завершения: **выполнен**. Открытие любого accordion сохраняет один визуальный язык, а operational information сканируется сверху вниз без capsule-сетки. Контракт и команды проверки описаны в [`panel-operator-stage3-routing-cards.md`](panel-operator-stage3-routing-cards.md). Этап повторно открывается только при нарушении этого контракта.

### Этап 4. Формы, таблицы и data-heavy экраны — в работе

Выполнено 28 июля 2026 года:

- [x] **Порты:** legacy fixed height перекрыт в scoped workspace-слое, карточки больше не растягиваются до единой высоты, редакторы списков/IP/policy получили диапазоны 156–220 / 168–240 / 220–320 px, status и компактный save собраны в общий footer row. Контракт: [`panel-operator-stage4-ports.md`](panel-operator-stage4-ports.md).
- [x] **Routing rules:** двухколоночные cards заменены единым вертикальным record list с постоянными summary-колонками; drag/drop, open/closed, disabled и target states сохранены, semantic color ограничен marker/state; primary Apply приведён к размеру соседних icon-actions. Контракт: [`panel-operator-stage4-routing-rules.md`](panel-operator-stage4-routing-rules.md).
- [x] **Balancers:** summary отделён от формы через disclosure на существующем `_balOpenSet`, selector ограничен первыми четырьмя chips с `Ещё N`, поля получили раздельный вертикальный ритм, secondary text стал контрастнее, delete-controls закреплены круглыми, а единственный compact primary apply принадлежит всей секции. Контракт: [`panel-operator-stage4-balancers.md`](panel-operator-stage4-balancers.md).
- [x] **Commands:** capsule-сетка заменена компактными строками «команда → назначение → Выполнить» в адаптивных 3/2/1 колонках групп, повторный prefix скрыт presentation-слоем, а запуск использует явный `data-action="run"`. Контракт: [`panel-operator-stage4-commands.md`](panel-operator-stage4-commands.md).

Осталось:

- [ ] **Logs:** унифицировать filters, counters, detail и error states;
- [ ] **Files:** завершить toolbar, table rows, selection/focus/drag/drop и empty states;
- [ ] **Mihomo profiles/generator:** применить те же table/form/action primitives;
- [ ] выровнять labels, hints, validation и units в формах подписок; advanced fields показывать progressive disclosure.

Критерий завершения Этапа 4: нет больших пустых областей, созданных фиксированной высотой; формы имеют один flow и один главный action; данные без визуальной составляющей не показаны плитками. Общий критерий пока не выполнен: следующие задачи этапа остаются открытыми.

### Этап 5. Редакторы и модальные семейства

Задачи:

- создать единый editor modal contract для JSON, file editor и snapshot: header 48–52 px, toolbar 40–44 px, растущий editor, footer 48–52 px;
- заменить comments/schema pills на компактные status labels без круглой capsule-формы;
- сохранить engine selector и все toolbar actions, но выровнять их одной сеткой;
- переработать editor help в responsive drawer/workbench без перекрытия save/cancel;
- применить четыре modal family ко всем 50 окнам в приоритетном порядке из аудита;
- убрать чисто презентационные inline max-width/gap/margin после переноса в scoped classes;
- для пустых/error состояний использовать auto-height вместо искусственно высокого body;
- на mobile переводить сложные модалы в fullscreen и оставлять header/footer доступными при прокрутке.

Критерий завершения: у каждого modal ID проверены open, loaded, empty, error и narrow states; editor всегда главный по площади, footer не перекрывается.

### Этап 6. Обе темы, responsive и доступность

Задачи:

- пройти dark/light по одной матрице компонентов, не создавать theme-specific геометрию;
- убрать остаточный navy tint из dark chrome и холодные glow/shadows из light chrome;
- проверить contrast обычного, muted, disabled, success, warning и danger текста;
- обеспечить видимый `:focus-visible`; icon-only actions должны иметь accessible name и tooltip;
- проверить keyboard navigation, Escape/return-focus у модалов, reduced motion;
- проверить zoom 125%/150% и длинные русские строки без обрезания ключевых действий;
- проверить low-end/MIPS профиль отдельно, не ухудшая базовый дизайн.

Критерий завершения: обе темы используют одну иерархию, mobile не является уменьшенным desktop, интерфейс остаётся рабочим с клавиатуры и при увеличенном масштабе.

### Этап 7. Visual regression, функциональный прогон и очистка

Задачи:

- исправить видимый locator JSON editor в `panel_operator_ui.spec.mjs`;
- параметризовать operator tests по dark/light и CodeMirror/Monaco там, где это влияет на layout;
- добавить сценарии для семи дефектов из исходных скриншотов;
- добавить computed-style guards: запрещённые gradient/background-image, цветной box-shadow, pill radius у обычных buttons/rows;
- добавить screenshot coverage всех top-level views и четырёх modal families на desktop/mobile;
- прогнать весь существующий E2E, чтобы подтвердить неизменность функционала;
- удалить из `panel-operator.css` перекрытые ранние блоки после переноса правил в канонические секции;
- обновить cache-buster только после зелёных проверок и финальных снимков.

Критерий завершения: полный E2E зелёный, visual snapshots приняты, в scoped-слое нет добавочного блока «final fixes» после responsive section.

## Предлагаемая матрица визуальной проверки

| Состояние | 1920×1080 | 1440×900 | 1280×720 | 1024×768 | 390×844 | 360×800 |
| --- | --- | --- | --- | --- | --- | --- |
| Routing Xray, оба engines | dark/light | dark/light | dark/light | light | dark/light | light |
| Routing Mihomo | dark/light | light | dark | light | dark/light | light |
| Порты | dark/light | light | dark/light | light | dark/light | light |
| Routing rules | dark/light | dark/light | light | light | dark/light | light |
| Logs / Commands / Files | dark/light | dark/light | light | light | dark/light | light |
| JSON editor + help | dark/light | dark/light | dark/light | light | fullscreen | fullscreen |
| Subscriptions / generator / DAT | dark/light | dark/light | light | light | fullscreen | fullscreen |
| Settings / compact confirm | dark/light | dark/light | light | light | fullscreen/auto | fullscreen/auto |

Для каждого состояния проверяются: no page overflow, отсутствие перекрытий, видимость primary action, доступность close/cancel, сохранение scroll area, focus-visible и отсутствие визуального дублирования.

## Definition of Done

Переезд можно считать завершённым, когда одновременно выполнены все условия:

- `panel-operator.css` остаётся последним и полностью scoped к `body.panel-page`;
- в `styles.css` больше не добавляются panel-specific redesign rules;
- все top-level views и все 50 modal IDs прошли inventory;
- у обычных buttons, links и data rows нет pill-геометрии, градиентов, бликов и цветных glow;
- indigo используется для focus/active и единственного primary action, semantic colors — только для состояния/риска;
- editors являются главным визуальным центром и не имеют необоснованной пустой высоты;
- строки данных не оформлены как вложенные карточки;
- RAW/JSONC, выбранный файл и другие runtime-повторы остаются в DOM, но не дублируются визуально;
- dark/light, desktop/tablet/mobile и CodeMirror/Monaco проверены реальным Chromium;
- все существующие функциональные E2E и новый visual regression suite проходят;
- финальные screenshots не показывают горизонтального overflow, перекрытых footer/actions или нерациональных пустот.

## Рекомендуемый порядок pull request / commit-партий

1. Guardrails, inventory и исправление тестового harness.
2. Scoped primitives и очистка legacy pseudo-effects.
3. Header/navigation/workspace grid.
4. Routing inspector и data rows.
5. Ports/rules/commands/logs/files/Mihomo forms and tables.
6. Editor modal и help drawer.
7. Остальные modal families.
8. Themes/responsive/accessibility.
9. Visual baselines, full E2E и удаление перекрытых правил.

Каждая партия должна оставаться откатываемой отдельно и завершаться снимками обеих тем, а не общим финальным полировочным коммитом.
