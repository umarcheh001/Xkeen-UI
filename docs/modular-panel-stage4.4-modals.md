# Подэтап 4.4. Модальные окна по владельцам

Статус: **закрыт 30 сентября 2026 года**.

Все 53 модальных окна и оверлей терминала вынесены из `panel.html` в partials
`xkeen-ui/templates/panel/modals/`. `panel.html` стал тонким composition root
(73 строки): shell, screens, modal partials, toast, footer и entrypoint.

## Владение и gates

| Partial | Владелец | Gate в `panel.html` | Окна |
| --- | --- | --- | --- |
| `diagnostics.html` | `tool.advanced-diagnostics` | `has_diagnostics` | `xk-resource-dashboard-modal` |
| `routing.html` | `engine.xray` | `has_xray` | 12 окон Xray, включая DNS-over-VLESS, шаблоны, генератор и пул outbounds, DAT contents |
| `commands.html` | `tool.terminal` | `has_terminal` | `terminal-overlay`, история команд, 4 окна SSH |
| `shared.html` | `core` | — | выбор ядра, подтверждение, GitHub export/catalog, donate, UI settings |
| `mihomo.html` | `engine.mihomo` | `has_mihomo` | DNS, импорт, инструменты прокси, validation |
| `happ.html` | `integration.happ` | `has_happ and has_mihomo` | `mihomo-hwid-modal` |
| `files.html` | `tool.files` | `has_files` | 22 окна файлового менеджера, включая подключения к удалённой ФС и known hosts |
| `files_editor.html` | `tool.files` + `tool.editor` | `has_files and has_editor` | `fm-editor-modal` |
| `editor.html` | `tool.editor` | `has_editor` | `json-editor-modal` |

Флаги `has_editor` и `has_happ` добавлены в page context
(`routes/pages.py`); в legacy-пути без `active_module_ids` они, как и
остальные, равны `true`.

Mixed-current-классификация контракта 4.1 разрешена в пользу целевого
владельца: окна `fm-*` принадлежат `tool.files`, окна `ssh-*` —
`tool.terminal`.

## Mixed boundary: кнопка HWID

Кнопка `#mihomo-hwid-sub-btn` находится в экране Mihomo, а окно — в
`happ.html`. Чтобы без `integration.happ` не оставалась кнопка без окна, она
обёрнута в `{% if has_happ %}` внутри `panel/screens/mihomo.html`. Это
единственное module-условие внутри screen partial; `has_mihomo` для неё
обеспечен gate самого экрана.

## Долг: окна источника ядра внутри экранов

После закрытия подэтапа в ветку пришла фича выбора источника ядра. Её макрос
`panel/core_source.html` рисует карточку и два окна сразу — `*-core-source-modal`
и `*-core-install-modal` — и вызывается из `panel/screens/routing.html`
(`xray`) и `panel/screens/mihomo.html` (`mihomo`). Эти четыре окна лежат не в
`panel/modals/`, а внутри экранов движков.

Требование «окно есть только при активном владельце» при этом соблюдается:
окна следуют gate своего экрана (`has_xray`, `has_mihomo`). Нарушено только
расположение разметки. Перенос в `modals/routing.html` и `modals/mihomo.html`
оставлен отдельной задачей: `core_source.js` ищет окна по `id` через
`document`, так что перенос не потребует правки JS. До тех пор
`tests/test_modular_panel_stage4_4_modals.py` держит список исключений и
следит, чтобы других окон вне `panel/modals/` не появилось.

## Порядок и расположение

- Внутри каждого partial окна идут в исходном порядке.
- Все окна теперь внутри корневого контейнера `.container.container-wide`, до
  `#toast-container` и footer; раньше 28 окон стояли после entrypoint-скрипта
  прямо в `body`. Замер в браузере: контейнер имеет только
  `position: relative` без `z-index`, по цепочке до `body` нет `transform`,
  `filter`, `contain` и других свойств, создающих stacking context, так что
  `position: fixed` окон не меняется.
- Взаимный порядок окон разных владельцев изменился. Все окна имеют
  `position: fixed` и почти все `z-index: 60`; порядок важен только для окон,
  открытых одновременно. `confirm-modal` при открытии переносится в конец
  `body` и остаётся сверху; `json-editor-modal` по-прежнему идёт после окон
  Xray.

## Проверка

- `tests/test_modular_panel_stage4_4_modals.py`: каждое окно ровно в одном
  partial, в partials нет gates, gate каждого include объявлен в
  `panel.html`, состав окон по профилям (Full, Xray-minimal, Mihomo-minimal),
  оба составных gate и кнопка HWID;
- server-side рендер Full до и после: тот же набор из 1350 `id` и тот же
  набор строк, изменился только порядок окон;
- браузерный замер вычисленных стилей: каждое из 54 окон (53 модальных и
  оверлей терминала) открыто в Full до и после переноса — размеры, позиция,
  `z-index`, отступы, цвета и сетки совпадают во всех 54 случаях; замер
  предварительно повторён дважды на исходном коде и стабилен;
- browser smoke Full, Xray-minimal и Mihomo-minimal: набор ошибок совпадает с
  состоянием до 4.4, в minimal-профилях нет `4xx/5xx`;
- Stage 4.1 contract, Stage 0 и Operator inventories пересобраны.

## Критерий завершения

Критерий завершения **выполнен**: модальные окна присутствуют только у своего
владельца или в общем shell, отключение `engine.xray`, `engine.mihomo`,
`tool.terminal` или `tool.files` удаляет соответствующий modal markup из
initial HTML, а shared-окна и контейнеры не затронуты.
