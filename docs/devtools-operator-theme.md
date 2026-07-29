# DevTools в теме Operator Console

Дата закрытия: 29 июля 2026 года.

Статус: **закрыт 29 июля 2026 года**.

## Scope

DevTools переведён со старой blue-glass темы на тот же визуальный контракт, что и основная панель:

- графитовые `--op-*` поверхности и нейтральные границы;
- один indigo-акцент для active/focus/primary;
- semantic success/warning/danger только для состояния и риска;
- control height 32 px, compact 28 px, mobile target 40 px;
- радиусы 6 px у controls, 9–12 px у surfaces;
- отсутствие градиентов, glow, blur-glass и lift-transform.

Изменён только presentation layer. Маршрут `/devtools`, API, `id`, `data-*`, формы, handlers, service/update/log/ENV flows и top-level screen lifecycle сохранены.

## Архитектура слоя

Новый `static/devtools-operator.css` подключён последним — после `styles.css`, исторического `devtools.css` и terminal theme. Все правила ограничены `body.devtools-page`.

`devtools.css` оставлен без переписывания как compatibility layer для существующих компонентов и runtime-created DOM. Поздний Operator layer:

1. публикует те же dark/light `--op-*` tokens, что основная панель;
2. связывает legacy variables с Operator palette;
3. нейтрализует gradients, colored shadows, pseudo-highlights и backdrop blur;
4. задаёт единую геометрию shell, controls, cards, data rows и modal families.

## Экран Tools

- шапка стала компактной плоской surface с нейтральными действиями;
- Tools/Logs собраны в navigation rail с 2 px active marker;
- рабочая сетка использует компактную левую колонку 300–360 px и растущий ENV workspace;
- service controls больше не имеют постоянной зелёной/красной/жёлтой заливки;
- collapsible cards используют один header/body contract без цветных glyph-карточек;
- ENV groups стали плоскими data rows, категория больше не задаёт отдельную палитру;
- ENV table имеет sticky header и собственный scroll-region.

## Экран Logs и модалы

- log list использует neutral/hover/active row states;
- toolbar и filters собраны из общих action/field primitives;
- log canvas остаётся главным объектом и использует `--op-editor`;
- ENV help, confirm и log context используют общий flat modal frame;
- на mobile модалы становятся fullscreen, header/body/footer остаются в рабочем потоке.

## Responsive и accessibility

- при ширине до 1180 px Tools и Logs перестраиваются в одну колонку;
- при 390/360 px страница не создаёт горизонтальный overflow, а широкая ENV table прокручивается внутри собственного контейнера;
- controls получают touch target 40 px;
- `:focus-visible` использует единый indigo outline;
- добавлен `prefers-reduced-motion` guard.

## Автоматические проверки

Статический контракт:

```text
.venv/bin/python -m pytest -q tests/test_devtools_operator_theme.py
```

Chromium-контракт:

```text
npx playwright test e2e/devtools_operator_theme.spec.mjs --project=chromium
```

Проверяются last-loaded/scoped ownership, отсутствие gradients/backdrop blur, dark/light geometry, Logs canvas, mobile overflow и отдельный ENV scroller.
