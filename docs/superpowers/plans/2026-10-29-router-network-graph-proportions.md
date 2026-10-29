# Точная загрузка канала — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Сеть отображается пропорционально тарифу и оперативно реагирует на нагрузку.
**Architecture:**40 сетевых5с отсчётов collector с сохранением в metadata существующей истории; дробное заполнение только mirror canvas; snapshot выбранного подключения для «Сейчас», история для среднего/пиков.
**Tech Stack:** Python, ES modules, Canvas, pytest, Playwright.
**Spec:** docs/superpowers/specs/2026-10-29-router-network-graph-proportions.md.

## Global Constraints

- Работать в существующем pre-release; чужие/личные файлы не трогать.
- JS CRLF; Python LF. Сборка перед Playwright.
- Только локальная реализация: без установки, коммита, пуша и выпуска.
- Остальные метрики, персистентная история и интервалы большого графика сохраняются.

## Review Focus

Пропуски/скачки часов и первый замер; смена WAN/тарифа; выбранный резервный WAN;
нет данных/устаревший snapshot; нули, малые значения, выше100%, зеркальные пики.

### Task 1: Оперативная сетевая история

Files: collector.py, tests/test_system_resources_collector.py.
Interface: cards.link.bars up/down values/zones length40, step_s5; другие cards прежние.
- [x] RED: ступень0→20→0 видна в соседних5с ячейках, не45с среднем;40точек, пропуски, backjump.
- [x] GREEN: bounded deque40 только сетевых метрик; timestamps позволяют пропуски, назад — сброс.
- [x] Verify: python -m pytest tests/test_system_resources_collector.py -q.

### Task 2: Пропорциональный mirror canvas

Files: canvas_charts.js, e2e/resource_monitor_charts.spec.mjs.
Interface: drawMirrorChart/drawMiniMirror: прежние API, дробное заполнение и точные пики; drawLevelChart прежний.
- [x] RED: пиксели4% mini не горят до25%;25/80/100/null/zero и пики обеих сторон.
- [x] GREEN: рисовать неактивный фон, затем часть сегмента до физической границы значения; peak по координате значения.
- [x] Verify: frontend:build, targeted Playwright.

### Task 3: Текущее и среднее

Files: dashboard.js, chart_data.js, chart_view.js; E2E router_resource_dashboard.spec.mjs.
Interface: chart.render получает summary snapshot; mirrorModel(..., snapshot) выдаёт upNow/downNow из него и upMean/downMean из последней ячейки истории.
- [x] RED: snapshot и history различаются, резервный WAN, отсутствующий/устаревший snapshot не выдаёт старую историю за «сейчас».
- [x] GREEN: передавать snapshot, форматировать выбранные values, отдельно подписать среднее и интервал.
- [x] Verify: оба resource E2E, targeted pytest, full pytest при готовом коде; описи после git add новых файлов только при необходимости генератора.

### Task 4: Завершение

- [x] Независимое read-only ревью, исправления с RED→GREEN; проверить CRLF/diff.
- [x] Результаты и ограничения записать в .superpowers/sdd/2026-10-29-router-network-graph-proportions/progress.md.

### Task 5: Восстановление короткой истории (просьба владельца на утро)

- [x] RED: перезапуск из tmp/flash сохраняет отсчёты, простой и первый новый замер остаются пропусками.
- [x] GREEN: до 40 отсчётов в meta.network_recent; необязательные metadata проверять отдельно от основной истории.
- [x] Проверить старые файлы, повреждённые metadata, устаревшую копию, NTP той же загрузки.
- [x] Полный pytest, сборка и целевые E2E, финальное ревью; перегенерировать описи.
