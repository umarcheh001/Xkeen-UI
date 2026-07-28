# Operator Console: порты и исключения

Дата закрытия: 28 июля 2026 года.

Статус: **задача «Порты» Этапа 4 закрыта 28 июля 2026 года**.

## Результат

Экран «Порты и Исключения» больше не наследует равные карточки высотой `clamp(360px, 42vh, 520px)`. Каждый блок растёт по своему header, editor и footer; grid выравнивает блоки по верху, а не растягивает их до самой высокой карточки в ряду.

Изменение остаётся в канонической секции `5. WORKSPACES` файла `panel-operator.css` и scoped к `body.panel-page #view-xkeen`. После responsive-секции не добавлен ещё один слой исправлений.

## Геометрия редакторов

| Тип | Файлы | `min-height` | `max-height` |
| --- | --- | ---: | ---: |
| Список портов | `port_proxying.lst`, `port_exclude.lst` | 156 px | 220 px |
| IP и подсети | `ip_exclude.lst` | 168 px | 240 px |
| Policy JSONC | `xkeen.json` | 220 px | 320 px |

Внутри диапазона рабочая высота зависит от высоты viewport: 20 dVH для списков портов, 22 dVH для IP и 28 dVH для policy. CM6 host, его scroller и textarea fallback используют одинаковые границы; прокрутка остаётся внутри editor surface.

## Footer row

В каждой из четырёх форм status и action теперь находятся в одном `.xkeen-mini-footer`:

- status занимает свободное место слева, имеет `role="status"` и `aria-live="polite"`;
- save остаётся action естественной ширины с видимой меткой «Сохранить»;
- полное имя файла остаётся в `aria-label` и tooltip, поэтому доступное имя кнопки не сокращено;
- desktop action сохраняет 32 px control height, mobile наследует общий 40 px touch target.

Footer больше не прижимается к низу искусственно высокой карточки через `margin-top: auto`.

## Сохранённые контракты

- все четыре textarea `id`, save button `id` и status `id` сохранены;
- endpoints, payload, async restart flow и обработчики `xkeen_texts.js` не менялись;
- CodeMirror/CM6 selection, line wrapping, validation mode `application/jsonc` и editor state restore не менялись;
- toggle `#xkeen-body`, restart log и `global-autorestart-xkeen` остались прежними runtime-контрактами;
- standalone-страница `xkeen.html` не затронута: новый presentation-контракт принадлежит только `body.panel-page`.

## Автоматические проверки

Статический контракт:

```text
python3 -m pytest tests/test_panel_operator_stage4_ports.py
```

Chromium-contract:

```text
npx playwright test e2e/panel_operator_stage4_ports.spec.mjs --project=chromium
```

Проверка охватывает dark/light на 1440 × 900 и mobile 390 × 844, editor min/max, естественную высоту карточек, одну строку status/save, desktop/mobile action height, отсутствие page overflow и успешный save-сценарий.

Критерий задачи выполнен: legacy fixed height не влияет на панель, каждый editor ограничен по назначению, а save/status читаются как один компактный footer row. Остальные задачи Этапа 4 остаются открытыми.
