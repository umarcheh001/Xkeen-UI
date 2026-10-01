# Подэтап 4.5. Composition по активному набору модулей

Статус: **закрыт 1 октября 2026 года**.

Подэтап 4.5 перенёс выбор server-rendered UI из разрозненных Jinja-gates в
один allow-listed composition contract. Отключённый модуль больше не может
вернуть свой navigation, screen, shell-slot или modal markup только потому,
что в браузере осталась старая вкладка или `localStorage`.

## Контракт композиции

`xkeen-ui/routes/pages.py` владеет двумя упорядоченными immutable
manifest-ами:

- `PANEL_COMPOSITION` описывает owner requirements и partial для shell-slots,
  screens и modals;
- `PANEL_NAVIGATION` описывает owner requirements и неизменяемые DOM-данные
  top navigation: class, `data-view`, `data-xk-section`, id и endpoint.

`_build_panel_page_context(active_module_ids)` выбирает entry только когда
все его owners входят в рассчитанный Этапом 3 набор активных модулей. Вход
`None` означает Legacy fallback и включает полный allow-listed набор, сохраняя
совместимость старых установок. Композитные владельцы заданы явно:
`integration.happ AND engine.mihomo` для HWID и
`tool.files AND tool.editor` для редактора файлов.

Маршрут панели передаёт результат как единый `page_context`. `panel.html`,
`panel/navigation.html`, `panel/header.html` и `panel/shell.html` больше не
решают ownership самостоятельно: они перебирают уже отобранные коллекции.
Первый доступный in-panel navigation view получает класс `active`.

## Профильный результат

| Набор модулей | Navigation | Screens | Shell slots и modals |
| --- | --- | --- | --- |
| Legacy / Full | все разрешённые пункты | все screens | все slots и modals |
| Xray-minimal (`core`, `tool.editor`, `engine.xray`) | routing, xkeen, xray-logs, donate | routing, xkeen, xray-logs | Xray badge, routing focus и карточка источника ядра Xray; routing, shared, core-source Xray и editor modals |
| Mihomo-minimal (`core`, `tool.editor`, `engine.mihomo`) | mihomo, xkeen, mihomo-generator, donate | mihomo, xkeen | карточка источника ядра Mihomo; shared, core-source Mihomo, mihomo и editor modals |
| core-only | xkeen, donate | xkeen | только shared modal; нет Xray, Mihomo, diagnostics, terminal и files surfaces, включая карточки и окна источника ядра |

Таким образом серверная разметка является источником истины. Клиентский
маршрут может выбрать только уже отданный view и не восстанавливает HTML
отключённого модуля.

## Статический source graph

`scripts/panel_template_source.py` по-прежнему разворачивает literal Jinja
includes. Для composition loops он также знает только восемь конкретных имён
переменных (три `header_*_partial`, `control_partial`,
`core_source_control_partial`, `pre_screen_modal_partial`, `screen_partial` и
`modal_partial`) и раскрывает их через
`DYNAMIC_COMPOSITION_INCLUDE_PATHS`. Отдельный
`DYNAMIC_NAVIGATION_ITEMS` строит только Full/Legacy navigation для
source-only inventory. Оба каталога сравниваются с runtime manifest в тестах,
поэтому resolver не исполняет произвольный template path и не может
незаметно отстать от runtime contract.

## Проверка

Основные guardrails находятся в
`tests/test_modular_panel_stage4_5_composition.py`. Они проверяют точный
состав Full, Legacy, Xray-minimal, Mihomo-minimal и core-only, порядок,
детерминированность выбора, server-rendered отсутствие optional DOM и
синхронность static resolver с manifest.

После изменения source graph пересобраны Stage 0 inventory, Stage 4.1
contract, Operator inventory и module sizes. Проверка выполняется командами:

```bash
python -m pytest -q tests/test_modular_panel_stage4_1_contract.py tests/test_modular_panel_stage4_2_shell.py tests/test_modular_panel_stage4_3_routing_screen.py tests/test_modular_panel_stage4_3_xray_logs_screen.py tests/test_modular_panel_stage4_3_mihomo_screen.py tests/test_modular_panel_stage4_3_xkeen_screen.py tests/test_modular_panel_stage4_3_tool_screens.py tests/test_modular_panel_stage4_4_modals.py tests/test_modular_panel_stage4_5_composition.py
python -m pytest -q
```

Live smoke на локальном E2E fixture 1 октября подтвердил Full, Xray-only,
Mihomo-only и core-only: у каждого набора в DOM остались только его views и
module-owned shell surfaces; Full сохранил diagnostics modal перед screens.
После проверки стенд возвращён в Legacy/Full.

## Вне границ 4.5

Подэтап не меняет frontend bundles, `import()`, CSS loading, API requests или
инициализацию feature JavaScript. Их удаление, lazy loading и финальная
совместимость монолита относятся к Этапам 4.6 и 5.

## Критерий завершения

Критерий завершения **выполнен**: Full и Legacy сохраняют полный composed
surface, а Xray-only, Mihomo-only и core-only получают только navigation,
shell slots, screens и modals своих активных owners без отсутствующих template
variables и без server HTML отключённых модулей.
