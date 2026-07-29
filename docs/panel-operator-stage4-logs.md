# Operator Console: Logs

Дата закрытия: 29 июля 2026 года.

Статус: **задача «Logs» Этапа 4 закрыта 29 июля 2026 года**.

## Результат

Экран онлайн-логов Xray и расположенный рядом журнал операций приведены к одному data-heavy контракту. Терминальная поверхность остаётся главным рабочим объектом, а источник, текстовый фильтр, live-controls и дополнительные действия образуют компактные плоские action rows. Существующие API, `id`, `data-xk-*`, режимы polling/WebSocket, фильтрация и действия контекстного меню сохранены.

Счётчики больше не представлены одной неструктурированной строкой: количество строк, транспорт и очередь рендерятся отдельными парами label/value с табличными цифрами. Detail у записи журнала операций открывается через явный disclosure с синхронным `aria-expanded`, а контекст выбранной строки показывает фокусную строку без изменения текста, копируемого в буфер.

## State contract

- `ready` — журнал содержит записи; терминальная поверхность остаётся нейтральной;
- `empty` — пустой журнал или отсутствие совпадений показываются компактной inline-строкой без искусственно высокой ка��точки состояния;
- `warning` — loglevel, переключение источника и транспортные промежуточные состояния используют общий warning/state row;
- `error` — ошибки загрузки онлайн-лога и журнала операций используют одинаковую danger-soft строку с левой semantic marker и понятным следующим действием;
- status Xray публикует `data-phase`, `data-tone`, `data-transport` и `data-file`; контейнер журнала операций публикует `data-state`;
- контекстная строка имеет `data-context-focus="1"`, а исходный plain text хранится отдельно для точного копирования.

## Filter, counter и detail contract

- `.xk-log-filter-bar` — единый search region с плоским полем и компактным clear action;
- `.xk-log-control-bar` — горизонтальный ряд live/follow/pause/more; на узких экранах он прокручивается внутри себя и не создаёт page overflow;
- `.xk-log-counters` содержит структурированные `.xk-log-counter` с label/value вместо pills;
- `.restart-log-details-toggle` сохраняет keyboard/button semantics и сообщает состояние через `aria-expanded`/`aria-controls`;
- `.restart-log-details` — таблицеподобный список detail rows, на mobile переходящий в одну колонку;
- modal контекста больше не содержит presentation inline styles, имеет bounded workbench geometry и доступное имя.

## Сохранённые контракты

- runtime hooks онлайн-лога и журнала операций не переименованы и не удалены;
- фильтрация, pause/follow, число строк, download/copy, fullscreen, device names и context actions работают через прежние обработчики;
- terminal-like surface сохраняет ручной vertical resize на desktop и читаемую высоту на mobile;
- dark/light используют общие `--op-*` tokens; в scoped logs-layer нет gradients, lift-transform и pill radius.

## Автоматические проверки

Статический контракт:

```text
python3 -m pytest tests/test_panel_operator_stage4_logs.py
```

Chromium-contract:

```text
npx playwright test e2e/panel_operator_stage4_logs.spec.mjs --project=chromium
```

Chromium-проверка охватывает dark/light desktop, mobile 390 × 844, structured counters, detail disclosure, фокус строки контекста, Xray/restart error states и отсутствие horizontal overflow.

Критерий задачи выполнен: filters, counters, detail и error states используют единый плоский язык, а терминальный вывод остаётся главным объектом экрана.
