# Итог: top-level navigation между `/`, `/devtools` и `/mihomo_generator`

## Статус

Документ больше не является активным implementation plan.

На 04.04.2026 эта инициатива закрыта полностью:

- top-level переходы между `/`, `/devtools` и `/mihomo_generator` переведены с full document navigation на in-app navigation;
- direct URL entry для всех трёх маршрутов сохранён;
- введены общий top-level shell/router и screen registry;
- `mihomo_generator` и `devtools` работают как top-level screen modules с lifecycle;
- состояние `mihomo_generator` сохраняется между переходами;
- `devtools` больше не поднимает тяжёлые секции прежним eager-способом;
- добавлены guardrails, inventory updates и проверки под новый runtime contract.

## Что было закрыто

Все этапы исходного плана считаются выполненными:

- `P0` — runtime contract cleanup и быстрые подготовительные улучшения;
- `P1` — общий top-level shell/router;
- `P2` — `mihomo_generator` как первый keep-alive screen;
- `P3` — `devtools` как второй keep-alive screen;
- `P4` — shared top-level host partials вместо дублирования общего host-каркаса;
- `P5` — guardrails, tests, cleanup и фиксация нового контракта.

## Практический итог

Задача "убрать подгрузки" для трёх основных top-level маршрутов закрыта.

Под "закрыта" здесь понимается именно следующее:

- внутри уже открытого UI переходы между этими экранами больше не должны менять HTML-документ;
- normal path теперь идёт через in-app router, а hard navigation остаётся fallback-only;
- текущее решение уже закреплено кодом, тестами и документацией.

## Follow-up scope: `/backups` и `/xkeen`

Ниже не переоткрываются уже закрытые `P0-P5`.

Это отдельный follow-up rollout для двух оставшихся canonical page entrypoints, которые пока не входят в тот же in-app top-level navigation contract, что `/`, `/devtools` и `/mihomo_generator`.

На 04.04.2026 в этом follow-up уже закрыты `P6-P7`; следующим рабочим объёмом остаются `P8-P10`.

### Почему эти два маршрута ещё не в том же контракте

На 04.04.2026 для `/backups` и `/xkeen` всё ещё видны конкретные отличия от уже закрытого top-level runtime:

- route map уже расширен до пяти canonical entrypoints, а templates `backups` и `xkeen` уже выровнены под shared host contract, но сами страницы всё ещё не зарегистрированы как полноценные top-level screen modules;
- `backups.entry.js` и `xkeen.entry.js` пока поднимают страницы как standalone page entrypoints, а не как thin wrappers над `bootTopLevelShell(...)`;
- top-level nav interception для внутренних ссылок уже включён, но на самих `/backups` и `/xkeen` normal path всё ещё завершается hard navigation fallback, потому что эти страницы пока не bootstrapped через общий shell/router lifecycle.

### Поэтапный rollout для `/backups` и `/xkeen`

#### `P6` — расширить route/screen contract до пяти canonical entrypoints

Цель этапа: сделать `/backups` и `/xkeen` частью того же top-level route registry, но пока без ломки direct entry.

Статус: выполнено на 04.04.2026.

Что входит:

- расширить `TOP_LEVEL_SCREEN_ROUTES` до пяти маршрутов: `/`, `/backups`, `/devtools`, `/xkeen`, `/mihomo_generator`;
- довести shared registration helper до канонического списка всех top-level screens, чтобы любой top-level entrypoint мог зарегистрировать весь экранный набор;
- заранее определить список внутренних ссылок и кнопок, которые должны перейти на `data-xk-top-nav="1"`/router path, не затрагивая logout, external links и download paths;
- сохранить hard navigation как fallback-only path для missing screen, direct URL entry и transition failure.

#### `P7` — выровнять `backups.html` и `xkeen.html` под top-level host contract

Цель этапа: сделать fetched HTML snapshot для `/backups` и `/xkeen` совместимым с тем же screen-host lifecycle, что уже работает для трёх существующих экранов.

Статус: выполнено на 04.04.2026.

Что входит:

- перевести `templates/backups.html` и `templates/xkeen.html` на shared partials `_top_level_host_head_assets.html`, `_top_level_host_theme_bootstrap.html` и `_top_level_global_spinner.html`;
- добавить canonical page runtime contract через `frontend_page_config('backups', ...)` и `frontend_page_config('xkeen', ...)`, чтобы `fetchTopLevelScreenSnapshot()` мог корректно восстановить `window.XKeen.pageConfig`;
- при необходимости стабилизировать `body` classes/title/host markers, чтобы определение активного экрана не зависело только от внутренних DOM-id;
- оставить source entrypoint canonical и не переносить page/runtime-логику в template.

#### `P8` — перевести `/backups` и `/xkeen` на top-level screen bootstrap

Цель этапа: убрать full document navigation как normal path и подключить оба маршрута к общему keep-alive screen host.

Что входит:

- вынести текущие imports/boot в `backups.screen.bootstrap.js` и `xkeen.screen.bootstrap.js`;
- превратить `backups.entry.js` и `xkeen.entry.js` в thin wrappers над `bootTopLevelShell({ initialScreen, bootstrap })`;
- добавить `top_level_backups_screen.js` и `top_level_xkeen_screen.js` по тому же паттерну, что уже используется для `panel`, `devtools` и `mihomo_generator`;
- использовать тот же capture/fetch/apply/attach lifecycle: `captureCurrentDocumentScreenSnapshot(...)`, `fetchTopLevelScreenSnapshot(...)`, `applyScreenDocumentState(...)`, `attachScreenRoot(...)`, `detachScreenRoot(...)`.

#### `P9` — добрать lifecycle и state retention для page-specific runtime

Цель этапа: сделать re-activation безопасным и предсказуемым, без двойной инициализации, лишних опросов и потери локального состояния.

Что входит для `/backups`:

- оформить top-level runtime API вокруг `backups` feature так, чтобы `init/load/refresh` не создавали повторную проводку обработчиков;
- отдельно проверить snapshot preview modal, editor runtime и view-state restore, потому что этот модуль уже живёт в двух режимах: `history` и `snapshots`;
- не допустить регрессию panel-side snapshots card при добавлении top-level history screen lifecycle.

Что входит для `/xkeen`:

- собрать composite screen API поверх `service_status` и `xkeen_texts`;
- убрать риск duplicate polling/listeners при повторных `activate()/deactivate()` циклах;
- сохранить editor/toggle/view state между переходами, чтобы возврат на `/xkeen` не вёл к повторной полной инициализации и лишней перезагрузке формы.

Общее требование этапа:

- direct URL entry и hard reload для `/backups` и `/xkeen` должны оставаться полностью рабочими.

#### `P10` — guardrails, verification и синхронизация docs/inventory

Цель этапа: зафиксировать новый контракт так же жёстко, как это уже сделано для `/`, `/devtools` и `/mihomo_generator`.

Что входит:

- проверить normal-path переходы между всеми five canonical page entrypoints без замены HTML-документа;
- добавить или обновить guardrails на route registry, pageConfig restore, idempotent re-activation и fallback navigation;
- обновить `frontend-page-inventory.md` и пересобрать `frontend-page-inventory.json`;
- обновить архитектурные docs там, где сейчас top-level router/shell описан только для `/`, `/devtools` и `/mihomo_generator`;
- зафиксировать, что hard navigation остаётся только fallback path, а не основной способ перехода между этими экранами.

### Признак завершения follow-up scope

Follow-up для `/backups` и `/xkeen` можно считать закрытым, когда одновременно выполняются все условия:

- route registry знает все пять canonical entrypoints;
- `backups` и `xkeen` зарегистрированы как top-level screens с тем же lifecycle contract, что и остальные экраны;
- переходы между зарегистрированными top-level маршрутами внутри уже открытого UI идут через router/screen host, а не через смену HTML-документа;
- состояние этих экранов не теряется на обычных переходах туда-обратно;
- page inventory, architecture docs и guardrails обновлены под новый охват.

## Как использовать этот файл дальше

Считать его одновременно:

- закрывающей заметкой по уже выполненному переводу `/`, `/devtools` и `/mihomo_generator`;
- рабочим follow-up outline для следующего rollout scope: `/backups` и `/xkeen`.
