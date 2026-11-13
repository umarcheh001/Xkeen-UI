# Логи Mihomo и подписи Xray — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Реализовать утверждённый экран логов Mihomo и согласованные подписи/цвета Xray.

**Architecture:** Mihomo получает собственные parser, model, view и сохраняет существующий контроллер WebSocket.
Виртуальное представление изолировано shadow DOM; сводка использует разметку и стили Xray.
Работающий контроллер Xray не обобщается; его изменения ограничены отображением.

**Tech Stack:** ES modules, CSS, Jinja, Node tests через pytest, Playwright, Python DTO без смены контракта.

**Spec:** `docs/superpowers/specs/2026-11-13-mihomo-logs-design.md` (утверждена владельцем).

## Global Constraints

- Подход А: отдельный экран Mihomo в существующей вкладке, без переписывания контроллера Xray.
- Подписи «Через прокси», «Напрямую», «Заблокировано», «DNS»; колонка «Маршрут / узел».
- Исходные строки и технические теги не переводить. Правило Xray отложено.
- Mihomo: лимит 500 событий, новые сверху по умолчанию, debug максимум пять минут.
- Стоп Mihomo отключает просмотр без изменения конфигурации/перезапуска ядра; Xray сохраняет свою семантику.
- Флаги SVG общего словаря. Сводка визуально идентична Xray, проценты относятся к событиям, не байтам.
- Windows, LF, тесты от Alex вне песочницы. Перед e2e собрать фронтенд.
- Не пушить, не выпускать, не устанавливать на роутеры без отдельной команды.
- Коммиты только после проверки, автор olmer2002; личные файлы исключить. Рутинные промежуточные
  коммиты не обязательны: фиксировать связные проверенные этапы в рамках разрешений владельца.

## Review Focus

1. IPv6 и скобки в именах узлов не должны смешиваться с синтаксисом маршрута — тест задачи 1.
2. Перезапуск соединения может повторить sequence; идентификаторы строк и выбор остаются однозначны — задача 2.
3. Пауза во время вытеснения буфера не должна подменять выбранные/читаемые события — задачи 2, 4.
4. Пустая таблица при активации скрытого экрана и потерянные клики под потоком — задачи 3, 4.
5. HTML в сообщении, имени устройства и полях отображается текстом, оригинал в clipboard сохраняется — задачи 1, 3.

## Файлы и границы

- Создать `xkeen-ui/static/js/features/mihomo_clash/log_parser.js`: чистый разбор DTO.
- Создать `.../mihomo_clash/log_model.js`: буфер, фильтры, сводка, выбор, снимок паузы.
- Создать `.../mihomo_clash/log_view.js`: виртуальная таблица, раскрытие, события пользователя.
- Изменить `.../mihomo_clash/logs.js`: подключить модель/представление к потоку и меню.
- Изменить `xkeen-ui/templates/panel/screens/mihomo.html`, `xkeen-ui/static/panel-operator.css`:
  шапка, сводка, чипы, меню и подвал. Строки таблицы — локальный CSS в shadow root.
- Изменить `xkeen-ui/static/js/features/xray_log_view.js`: только подписи и оформление.
- Создать `tests/fixtures/mihomo_clash/log-corpus.json`, `tests/test_mihomo_log_parser_js.py`,
  `tests/test_mihomo_log_model_js.py`, `e2e/mihomo_logs_redesign.spec.mjs`.
- Дополнить `tests/test_xray_log_parser_js.py` при необходимости проверки сохранения raw,
  `e2e/panel_operator_stage4_logs.spec.mjs`, скорректировать старые ожидания карточек
  в `e2e/mihomo_clash_rules.spec.mjs`.
- Документировать поведение в `docs/mihomo-logs-screen.md`; описи генерировать штатно.

### Task 1: Корпус и разбор сообщений Mihomo

**Files:** `log_parser.js`, `tests/fixtures/mihomo_clash/log-corpus.json`, `tests/test_mihomo_log_parser_js.py`.

**Interfaces:** `parseMihomoLogEntry(dto, id) -> record` возвращает
`{id, raw, time, level, fields, devices, type, kind, network, sourceIp, sourcePort,
destination, destinationPort, group, node, rule, search}`.
`type` = connection/dns/message; `kind` = proxy/direct/block/dns/null.
Поля отсутствующих данных — пустые строки; raw — исходный DTO.message без преобразований.

- [ ] Собрать корпус из имеющихся fixtures и первичных исходников Mihomo точной версии;
  записать происхождение каждой группы примеров. Доступ к роутеру только чтение, если действительно нужен;
  не включать debug и не менять конфиги без разрешения.
- [ ] Написать тесты `test_connection_variants`, `test_ipv6_and_nested_node_names`,
  `test_unknown_and_system_events_preserve_message`, `test_dns_requires_positive_evidence`,
  `test_html_stays_plain_data`. Проверить DIRECT/REJECT, группу с узлом и без страны,
  TCP/UDP, IPv6 с портом, вложенные OR-правила, неизвестную строку и port 53 без DNS-признака.
- [ ] Запустить `python -m pytest tests/test_mihomo_log_parser_js.py -q`: ожидается падение отсутствующего модуля.
- [ ] Реализовать чистый разбор. Прямые/заблокированные группы распознавать только однозначно;
  не угадывать конечный маршрут по названию пользовательской группы. Неразобранное оставить message.
  Если формат не позволяет выделить DNS достоверно, явно описать ограничение, сохранить фильтр со счётчиком 0.
- [ ] Повторить тесты: все pass. Зафиксировать корпус и поддержанные грамматики в документации.

### Task 2: Модель буфера, фильтров и сводки

**Files:** `log_model.js`, `tests/test_mihomo_log_model_js.py`.

**Interfaces:** `createMihomoLogModel({limit=500})` возвращает
`append(dto), clear(), setPaused(bool), setFilters(patch), setOrder(order), select(id,{toggle,range}),
clearSelection(), snapshot()`.
Snapshot содержит `records, visible, summary, counts, selected, pending, evictedWhilePaused, order, paused`.
Идентификаторы — монотонные локальные, не upstream sequence. append использует парсер задачи 1.

- [ ] Написать тесты `test_limit_500_and_repeated_sequences`, `test_pause_snapshot_and_eviction`,
  `test_filters_and_summary_exclude_dns`, `test_selection_range_and_evicted_ids`, `test_copy_uses_raw`.
  501-е событие вытесняет первое; повторение sequence не повторяет id; на паузе visible заморожен,
  после продолжения доступны последние 500. Выбор не переезжает на другую запись.
- [ ] Запустить `python -m pytest tests/test_mihomo_log_model_js.py -q`: ожидается fail.
- [ ] Реализовать модель с ограниченным буфером и отдельным снимком паузы, без мутации DTO.
  Сводка — только соединения после активных фильтров, исходные значения не переводятся.
- [ ] Повторить тесты: pass. Сверить правила агрегации со спецификацией и фактическим Xray.

### Task 3: Виртуальная таблица и утверждённый внешний вид

**Files:** `log_view.js`, шаблон Mihomo, `panel-operator.css`, новый e2e.

**Interfaces:** `createMihomoLogView({host, summary, chips, footer, onAction})` возвращает
`render(snapshot), destroy()`. `onAction({type,id,value})`: toggle-detail, filter, select,
copy-raw, copy-tsv, clear-selection, to-new. Контроллер владеет моделью.

- [ ] Написать e2e `table_renders_routes_rules_flags_protocols`, `summary_matches_xray`,
  `html_is_escaped_and_copy_is_original`, `selection_and_details`, `hidden_activation_and_mobile`.
  Проверить «Через прокси», зелёный direct и красный block, DNS, SVG, `443/tcp`, правило,
  полную raw-строку в раскрытии; те же четыре плитки и компактный интервал чипов, что у Xray.
- [ ] Выполнить frontend:build и новый e2e: ожидается fail на старых карточках.
- [ ] Реализовать представление: фиксированная высота 32 px для обычной строки, виртуальное окно
  с запасом; раскрытие учитывается в расчётах высот, не ломает якорь прокрутки. Локальные стили
  строк внутри shadow DOM. Общие цвета через переменные панели, все входные тексты экранировать.
- [ ] Перенести разметку/стили сводки Xray в scoped-вариант Mihomo без копирования всего CSS;
  воспроизвести утверждённый снимок. Временно неиспользуемые кнопки не вводить в продукт.
- [ ] Собрать фронтенд и повторить e2e: pass; снять desktop/mobile для визуальной сверки.

### Task 4: Поток, меню и жизненный цикл

**Files:** `mihomo_clash/logs.js`, шаблон, `e2e/mihomo_logs_redesign.spec.mjs`, старый e2e карточек.

**Interfaces:** сохранить `initMihomoClashLogs()`, `activateMihomoClashLogs(capabilities,runtime)`,
`deactivateMihomoClashLogs()` и `mihomoClashLogsApi`. Использовать модель задачи 2 и view задачи 3.

- [ ] Добавить тесты `pause_resume_and_stop_do_not_restart_core`, `buffer_eviction_on_pause`,
  `reconnect_generation_and_hidden_cleanup`, `upstream_level_and_debug_expiry`,
  `follow_edge_and_new_count`, `order_settings_migration`, `buttons_work_under_stream`.
  Стоп закрывает сокет, запросов изменения ядра нет; debug-expired возвращает info без бесконечного debug.
- [ ] Собрать/запустить целевой e2e: ожидается fail для новых сценариев.
- [ ] Подключить модель и view, сохранить получение токена/reconnect/AbortController и контроль поколения.
  Объединять события в один render за кадр, сводку обновлять не чаще раза в секунду.
  При открытии/скрытии корректно пересчитывать видимое окно; чистить слушатели/observer/timers.
- [ ] Реализовать меню, отдельную настройку upstream-уровня и локальный фильтр уровней,
  полноэкранный режим, копирование/очистку экрана, настройки порядка и свёртки.
- [ ] Обновить старый тест карточек, сохранив все его проверки потока, устройств, уровня и lifecycle.
  Повторить новый e2e и `e2e/mihomo_clash_rules.spec.mjs`: 0 failed.

### Task 5: Согласованные подписи Xray

**Files:** `xray_log_view.js`, `e2e/panel_operator_stage4_logs.spec.mjs`.

**Interfaces:** существующий публичный API view не меняется. KIND_LABEL определяет видимые
подписи; значения фильтров, outboundTag, inboundTag и raw сохраняются.

- [ ] Добавить e2e `translated_routes_preserve_tags_and_clipboard`: подписи во всех нужных местах,
  «Маршрут / узел», DNS, прокси перед SVG/узлом; исходная скопированная строка совпадает с fixture.
  Цвета фона/текста/границы фильтров и route pills совпадают с эталоном Mihomo.
- [ ] Собрать и запустить целевой тест: ожидается fail.
- [ ] Внести минимальные изменения подписей и оформления; не переводить технический тег только
  по совпадению подстроки, использовать уже определённый kind; не менять parser/controller.
- [ ] Повторить весь `e2e/panel_operator_stage4_logs.spec.mjs`: pass, включая выбор и оба порядка.

### Task 6: Проверка интеграции, производительности и документация

**Files:** документация экрана, описи, журнал progress, при необходимости module packaging tests.

- [ ] Проверить владение новыми файлами engine.mihomo в модульной упаковке; добавить контрактный тест,
  если автоопределение не покрывает новые parser/model/view. Версии модулей поднимать при выпуске
  по правилам проекта, без самовольного выпуска/тега.
- [ ] Провести perf-проверку: 500 строк, 50 событий/с, trace off, CPU x4, ограниченный DOM;
  зафиксировать кадры, длинные задачи и работу кнопок. При регрессии устранить до финального отчёта.
- [ ] Выполнить `npm.cmd run frontend:build`, новые parser/model tests и существующие stream/ws tests,
  целевые e2e Mihomo и Xray. Ожидается 0 failed. Падения e2e проверить на чистом HEAD в изолированной копии.
- [ ] Полный pytest — через Git Bash с проверкой доступности sh и выводом в локальный журнал.
  Итог и известные ограничения записать, не подменять проверку повторными узкими прогонами.
- [ ] Обновить документацию, progress, handoff и тематическую память. `git diff --check`, проверить LF.
  Описи обновлять `npm.cmd run inventory:refresh`, после включения новых файлов в индекс при подготовке коммита.
- [ ] Независимое итоговое ревью и исправление существенных замечаний; расширять тесты только по рискам.
  Передать владельцу результат, проверенные сценарии и ограничения DNS. Коммит/пуш/роутеры — по разрешениям.

## Самопроверка плана

Покрытие спецификации: визуальные решения — задачи 3/5; raw и грамматика — 1;
буфер и фильтры — 2; жизненный цикл и настройки — 4; производительность и упаковка — 6.
Все пять Review Focus закреплены тестами. Вызовы модели/представления единообразны;
чистый разбор не зависит от DOM. Не требуется расширять API или конфигурацию Xray.
