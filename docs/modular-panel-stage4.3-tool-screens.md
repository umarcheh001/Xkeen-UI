# Подэтап 4.3. Commands и Files screens

Статус: **закрыты 30 сентября 2026 года**.

Последние два экрана Этапа 4.3 вынесены из composition root в module-owned
partials:

```text
xkeen-ui/templates/panel/screens/commands.html
xkeen-ui/templates/panel/screens/files.html
```

## Владение

| Экран | Владелец | Gate в `panel.html` | Корень |
| --- | --- | --- | --- |
| commands | `tool.terminal` | `{% if has_terminal %}` | `#view-commands` |
| files | `tool.files` | `{% if has_files %}` | `#view-files` |

В legacy-пути без `active_module_ids` оба флага равны `true`, поэтому старые
установки получают прежний HTML.

## Mixed boundary: статус и обновление ядер

Строка статуса ядер (`#commands-status-row`, кнопки `#core-*-update-btn`)
находится в экране команд и уходит вместе с `tool.terminal`. Это соответствует
текущей реализации: обновление ядер выполняется через каталог команд и
`runTerminalCommand` (`features/cores_status.js`), то есть без терминала оно не
работает. Если профилю без терминала нужен просмотр версий ядер
(`/api/cores/versions` принадлежит core), строку нужно перенести в core-экран
отдельным решением — в 4.3 она не перемещалась.

## Сохранённый контракт

- DOM id и порядок не изменены: `#view-xkeen` → `#view-commands` →
  `#view-files` → `#view-xray-logs`;
- `{% set is_mips … %}` внутри экрана команд восстанавливается в том же
  partial и не влияет на остальной шаблон;
- терминальные и файловые модальные окна остались в `panel.html` до 4.4;
- HTML профиля Full после рендера совпадает с прежним, кроме пустых строк от
  Jinja-тегов.

## Проверка

- `tests/test_modular_panel_stage4_3_tool_screens.py` — владение partials,
  gate в composition root, DOM-порядок, восстановление `is_mips` и рендер для
  Full, Xray-minimal, Xray + terminal и Xray + files;
- browser smoke на E2E-стенде (Playwright, профили задаются через
  `modules.json`) для Full, Xray-minimal и Mihomo-minimal: в каждом профиле
  рендерятся только свои экраны, все видимые вкладки открываются;
- Stage 4.1 contract, Stage 0 и Operator inventories пересобраны.

## Console errors minimal-профилей

Smoke сравнён с baseline до выделения экранов (`435237e8`) на том же стенде.
Набор ошибок Xray-minimal до и после совпадает — выделение экранов новых
ошибок не добавило. Найденные frontend-вызовы API выключенных модулей
устранены:

- resource summary в header (`#xk-resource-monitor`) опрашивал
  `/api/system/*` модуля `tool.advanced-diagnostics`; кнопка теперь
  рендерится под `{% if has_diagnostics %}`, и без корня опрос не стартует;
- карточка GeoIP/GeoSite (`engine.xray`) использовала `/api/fs/*` модуля
  `tool.files`; теперь у неё собственные `/api/routing/dat/stat`, `/files`,
  `/upload` и `/download` (`routes/routing/dat_files.py`), проверенные
  `tests/test_routing_dat_files.py`.

Повторный smoke: в Xray-minimal и Mihomo-minimal нет `4xx/5xx`. Единственные
ошибки консоли — handshake `/ws/events`: на Windows-стенде нет
`gevent-websocket`, и он не работает и в Full.

## Критерий завершения

Критерий завершения **выполнен** для экранов commands и files: markup имеет
единственного владельца, отсутствует в физическом composition root и в initial
HTML профиля без соответствующего модуля, DOM/bootstrap contract сохранён.
Вместе с исправлениями выше подэтап 4.3 закрыт целиком.
